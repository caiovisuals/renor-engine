import { describe, it, expect, afterEach, vi } from 'vitest';
import { retrieveContext, hasPastIntent, frontmatterMarksHistorical } from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import fs from 'fs';
import os from 'os';
import path from 'path';

afterEach(() => {
  delete process.env.RENOR_TEMPORAL_RANKING;
});

function seedSupersessionVault(dir: string) {
  const db = openDb(path.join(dir, 'idx.db'));
  // The real system writes '_mcp_'-sourced entities via paths that pre-date the
  // FK pragma on some writers; the lifecycle contract tolerates them (see
  // gate1a order-matrix). Mirror that here for the synthetic seed only.
  db.pragma('foreign_keys = OFF');
  runMigrations(db);
  const current = path.join(dir, 'Ava-current.md');
  const history = path.join(dir, 'Ava-previous.md');
  // Current note: NOT marked historical. History note: kind: history (corpus signal).
  db.prepare("INSERT INTO notes VALUES (?, 'Ava','person','h','2026-09-17','{\"kind\":\"person\"}')").run(current);
  db.prepare("INSERT INTO notes VALUES (?, 'Ava — previous','history','h','2025-09-17','{\"kind\":\"history\"}')").run(history);
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run(current, '', "Ava's current favorite drink is passion fruit juice.", 0, 2, 12, 'cur');
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run(history, '', "Before changing preferences, Ava's favorite drink was mango juice.", 0, 2, 12, 'hist');
  const curChunk = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('cur') as any).id;
  const histChunk = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('hist') as any).id;

  const idx = new VectorIndex(db, 4); idx.initTable();
  idx.upsert(curChunk, [1, 0, 0, 0]);
  idx.upsert(histChunk, [0.99, 0.01, 0, 0]); // near-identical semantic score
  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };

  // Entities: one per note + the MCP-write entity sharing the canonical name.
  const mkEntity = (note: string) => (db.prepare(
    "INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('person','Ava','[]',?,1.0,'2026-09-17T00:00:00Z') RETURNING id"
  ).get(note) as any).id;
  const curEntity = mkEntity(current);
  const histEntity = mkEntity(history);
  const mcpEntity = mkEntity('_mcp_');
  void curEntity; void histEntity;

  // Lifecycle: mango superseded 2026-09-01, passion fruit current. Facts live on
  // the _mcp_ entity (how remember_fact writes them) — reachable only via
  // canonical-name expansion, which is exactly what the implementation must do.
  const ins = db.prepare(
    "INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,valid_from,valid_to,updated_at) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run(mcpEntity, 'favorite_drink', 'mango juice', '_mcp_', '2025-01-01T00:00:00Z', '2026-09-01T00:00:00Z', '2025-01-01T00:00:00Z');
  ins.run(mcpEntity, 'favorite_drink', 'passion fruit juice', '_mcp_', '2026-09-01T00:00:00Z', null, '2026-09-01T00:00:00Z');

  return { db, idx, provider, current, history };
}

describe('temporal ranking (RENOR_TEMPORAL_RANKING)', () => {
  it('demotes the historical note for present-tense queries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-'));
    const { db, idx, provider } = seedSupersessionVault(dir);
    const result = await retrieveContext(db, idx, provider, "What is Ava's favorite drink?", 5, []);
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits[0].notePath).toContain('Ava-current');
    expect(result.hits[0].reason).not.toContain('historical-intent');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('promotes the historical note for explicit past-intent queries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-'));
    const { db, idx, provider } = seedSupersessionVault(dir);
    const result = await retrieveContext(db, idx, provider, 'What drink did Ava previously call the favorite before changing it?', 5, []);
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits[0].notePath).toContain('Ava-previous');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('superseded lifecycle facts demote stale-value chunks via canonical-name expansion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-'));
    const { db, idx, provider } = seedSupersessionVault(dir);
    // Corpus signal REMOVED (current note has kind: person, history has kind:
    // history) — wait, both are fixed in the seed; here we assert the facts-only
    // path by checking the history hit carries the stale-fact demotion reason
    // when ranked despite the note signal.
    const result = await retrieveContext(db, idx, provider, 'favorite drink', 5, []);
    const historyHit = result.hits.find(h => h.notePath.includes('Ava-previous'));
    expect(historyHit).toBeTruthy();
    expect(historyHit!.reason).toContain('stale-fact');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('kill switch restores pre-temporal behavior (no temporal reasons)', async () => {
    process.env.RENOR_TEMPORAL_RANKING = '0';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-'));
    const { db, idx, provider } = seedSupersessionVault(dir);
    const result = await retrieveContext(db, idx, provider, 'favorite drink', 5, []);
    for (const hit of result.hits) {
      expect(hit.reason).not.toContain('stale-fact');
      expect(hit.reason).not.toContain('historical-note');
      expect(hit.reason).not.toContain('current-fact');
      expect(hit.reason).not.toContain('historical-intent');
    }
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('temporal helpers', () => {
  it('hasPastIntent matches explicit past-intent words only', () => {
    expect(hasPastIntent('What drink did Ava previously like before changing it?')).toBe(true);
    expect(hasPastIntent('Where did Ava live before moving to Seattle?')).toBe(true);
    expect(hasPastIntent("What is Ava's favorite drink right now?")).toBe(false);
    expect(hasPastIntent('What project is Ava building?')).toBe(false);
  });

  it('frontmatterMarksHistorical accepts explicit declarations only', () => {
    expect(frontmatterMarksHistorical(JSON.stringify({ kind: 'history' }))).toBe(true);
    expect(frontmatterMarksHistorical(JSON.stringify({ type: 'historical' }))).toBe(true);
    expect(frontmatterMarksHistorical(JSON.stringify({ historical: true }))).toBe(true);
    expect(frontmatterMarksHistorical(JSON.stringify({ archived: true }))).toBe(true);
    expect(frontmatterMarksHistorical(JSON.stringify({ kind: 'person' }))).toBe(false);
    expect(frontmatterMarksHistorical(JSON.stringify({ title: 'was mentioned once' }))).toBe(false);
    expect(frontmatterMarksHistorical(undefined)).toBe(false);
    expect(frontmatterMarksHistorical('not-json')).toBe(false);
  });
});