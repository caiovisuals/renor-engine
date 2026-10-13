import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  retrieveContext,
  parseQueryDateRef,
  asofPastLike,
} from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import fs from 'fs';
import os from 'os';
import path from 'path';

const EVAL_NOW = Date.parse('2026-01-01T00:00:00Z');

afterEach(() => {
  delete process.env.RENOR_TEMPORAL_ASOF;
});

function seedFjordVault(dir: string) {
  const db = openDb(path.join(dir, 'idx.db'));
  db.pragma('foreign_keys = OFF');
  runMigrations(db);
  // Newest note describes the CURRENT world (SQLite); older note holds the
  // dated historical record (Postgres era + 2025 mentions).
  const status = path.join(dir, 'Fjord-status.md');
  const timeline = path.join(dir, 'Fjord-timeline.md');
  db.prepare("INSERT INTO notes VALUES (?, 'Fjord','project','h','2025-12-30','{\"kind\":\"project\"}')").run(status);
  db.prepare("INSERT INTO notes VALUES (?, 'Fjord','project','h','2025-12-02','{\"kind\":\"project\"}')").run(timeline);
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run(status, '', 'Fjord current status: running fine on SQLite. Deploys are weekly.', 0, 2, 14, 'status');
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run(timeline, '', 'Fjord started in March 2025 with Postgres as its database. As of February 2026, Fjord runs on SQLite.', 0, 2, 22, 'timeline');
  const statusChunk = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('status') as any).id;
  const timelineChunk = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('timeline') as any).id;

  const idx = new VectorIndex(db, 4); idx.initTable();
  // Semantic slightly prefers the timeline (richer query overlap) — the bug
  // is that the newest-first presentation rerank buries it anyway.
  idx.upsert(statusChunk, [0.99, 0.01, 0, 0]);
  idx.upsert(timelineChunk, [1, 0, 0, 0]);
  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
  return { db, idx, provider };
}

describe('as-of lane parser (RENOR_TEMPORAL_ASOF)', () => {
  it('parses month+year, seasons, bare years, ISO dates, origin markers', () => {
    expect(parseQueryDateRef('What database did Fjord use in April 2025?')).toMatchObject({ year: 2025, month: 4, originMarker: false });
    expect(parseQueryDateRef('What did Fjord use in late 2025?')).toMatchObject({ year: 2025, month: 9, originMarker: false });
    expect(parseQueryDateRef('At the end of 2025, what ran?')).toMatchObject({ year: 2025, month: 12, originMarker: false });
    expect(parseQueryDateRef('What happened in 2024?')).toMatchObject({ year: 2024, originMarker: false });
    expect(parseQueryDateRef('State on 2025-03-15?')).toMatchObject({ year: 2025, month: 3, originMarker: false });
    expect(parseQueryDateRef('What was the original language?')).toMatchObject({ originMarker: true });
    expect(parseQueryDateRef('What language was Fjord v1 written in?')).toMatchObject({ originMarker: true });
    expect(parseQueryDateRef('What is Ava building?')).toBeUndefined();
  });

  it('is past-like for past dates, inert for present/future or now-override', () => {
    process.env.RENOR_TEMPORAL_ASOF = '1';
    expect(asofPastLike('What database did Fjord use in April 2025?', EVAL_NOW)).toBe(true);
    expect(asofPastLike('What was the original language?', EVAL_NOW)).toBe(true);
    expect(asofPastLike('What database does Fjord use now, in early 2026?', EVAL_NOW)).toBe(false);
    expect(asofPastLike('What is Ava building?', EVAL_NOW)).toBe(false);
  });

  it('is fully inert when the flag is off', () => {
    expect(asofPastLike('What database did Fjord use in April 2025?', EVAL_NOW)).toBe(false);
    expect(parseQueryDateRef('What database did Fjord use in April 2025?')).toBeTruthy(); // parser is pure; gating is elsewhere
  });
});

describe('as-of lane ranking', () => {
  it('flag off: newest-first buries the dated record (bug demonstration)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asof-'));
    const { db, idx, provider } = seedFjordVault(dir);
    const result = await retrieveContext(db, idx, provider, 'What database did Fjord use in April 2025?', 5, [], { nowMs: EVAL_NOW });
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits[0].notePath).toContain('Fjord-status');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flag on: explicit past-date query surfaces the dated record', async () => {
    process.env.RENOR_TEMPORAL_ASOF = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asof-'));
    const { db, idx, provider } = seedFjordVault(dir);
    const result = await retrieveContext(db, idx, provider, 'What database did Fjord use in April 2025?', 5, [], { nowMs: EVAL_NOW });
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    expect(result.hits[0].notePath).toContain('Fjord-timeline');
    expect(result.hits[0].reason).toContain('asof-year');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flag on: now-override keeps the current note first', async () => {
    process.env.RENOR_TEMPORAL_ASOF = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asof-'));
    const { db, idx, provider } = seedFjordVault(dir);
    const result = await retrieveContext(db, idx, provider, 'What database does Fjord use now, in early 2026?', 5, [], { nowMs: EVAL_NOW });
    expect(result.hits[0].notePath).toContain('Fjord-status');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
