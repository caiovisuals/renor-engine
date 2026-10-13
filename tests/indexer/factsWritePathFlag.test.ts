import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { indexVault } from '../../src/indexer/pipeline';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { readCurrentRowsForNotes } from '../../src/context/rowStore';
import { defaultDecisionModel, type DecisionModel, type DecisionRequest } from '../../src/extraction/decision-model';

let vault: string;

const DATED_NOTE = `---
date: 2024-03-01
kind: note
---
# Marathon Prep

Ran the marathon in 3:45. Felt strong.
`;

const UNDATED_NOTE = `---
kind: note
---
# Training Log

Weekly mileage was 80 km.
`;

function writeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-vault-'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', '2024-03-01-run.md'), DATED_NOTE);
  fs.writeFileSync(path.join(dir, 'notes', 'training.md'), UNDATED_NOTE);
  return dir;
}

function freshDb() {
  const dbPath = path.join(vault, '.semantic-memory', `index-${Math.random().toString(36).slice(2)}.db`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  runMigrations(db);
  return db;
}

function spyModel() {
  const base = defaultDecisionModel();
  const calls: DecisionRequest[] = [];
  const model: DecisionModel = {
    async decide(request) {
      calls.push(request);
      return base.decide(request);
    },
  };
  return { model, calls };
}

/** Deterministic dump of the derived index (ids included; created_at excluded — wall-clock). */
function dump(db: ReturnType<typeof openDb>): string {
  const tables = ['notes', 'chunks', 'entities', 'facts', 'relations', 'write_events'];
  const parts: string[] = [];
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as any[])
      .map((c) => c.name)
      // Wall-clock columns (facts.valid_from = now by shipped design) are excluded;
      // content-date validity of structured rows is asserted in structuredDump.
      .filter((c) => c !== 'created_at' && c !== 'updated_at' && !(t === 'facts' && c === 'valid_from'));
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY 1`).all();
    parts.push(`${t}: ${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

function structuredDump(db: ReturnType<typeof openDb>): string {
  const rows = db.prepare(
    `SELECT id, row_kind, source_path, source_hash, source_chunk_id, scope, extraction_version,
            valid_from, valid_to, payload_json, dedupe_key, confirm_count
     FROM structured_rows ORDER BY id`
  ).all();
  return JSON.stringify(rows);
}

describe('SCR-C2 product path: flag-gated facts write through indexVault()', () => {
  let prevFlag: string | undefined;
  beforeEach(() => {
    vault = writeVault();
    prevFlag = process.env.RENOR_FACTS_WRITE_PATH;
    process.env.RENOR_FACTS_WRITE_PATH = '1'; // flag-ON product-path tests
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env.RENOR_FACTS_WRITE_PATH;
    else process.env.RENOR_FACTS_WRITE_PATH = prevFlag;
  });

  it('flag OFF: zero decision calls, zero structured rows, byte-identical derived index across runs', async () => {
    delete process.env.RENOR_FACTS_WRITE_PATH; // the kill-switch case, explicitly
    const { model, calls } = spyModel();
    const db = freshDb();
    const stats = await indexVault(db, vault, { decisionModel: model }, 1);
    expect(stats.errors).toBe(0);
    expect(calls).toHaveLength(0); // zero new calls
    expect((db.prepare('SELECT COUNT(*) c FROM structured_rows').get() as { c: number }).c).toBe(0); // zero new writes
    const offDump = dump(db);
    db.close();

    const db2 = freshDb();
    await indexVault(db2, vault, {}, 1);
    expect(dump(db2)).toBe(offDump); // identical output, run to run
    db2.close();
  });

  it('flag ON: structured rows + provenance appear; everything else is byte-identical to the flag-off baseline', async () => {
    const offDb = freshDb();
    await indexVault(offDb, vault, {}, 1);
    const offDump = dump(offDb);

    const { model, calls } = spyModel();
    const db = freshDb();
    await indexVault(db, vault, { decisionModel: model }, 1);
    expect(calls.filter((c) => c.task === 'capture_gate').length).toBeGreaterThan(0); // decisions flowed through the seam

    const notes = ['notes/2024-03-01-run.md', 'notes/training.md'].map((p) => path.join(vault, p));
    const rows = readCurrentRowsForNotes(db, notes);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Provenance resolves to exact source chunks (the required C2 proof)
    for (const row of rows) {
      expect(row.sourceChunkId).toBeGreaterThan(0);
      const chunk = db.prepare('SELECT note_path FROM chunks WHERE id = ?').get(row.sourceChunkId) as { note_path: string } | undefined;
      expect(chunk?.note_path).toBe(row.sourcePath);
    }
    // Content dates: dated note gets its frontmatter date; undated stays NULL — never now
    const dated = rows.find((r) => r.sourcePath.endsWith('2024-03-01-run.md'))!;
    expect(dated.validFrom).toBe('2024-03-01');
    const undated = rows.find((r) => r.sourcePath.endsWith('training.md'))!;
    expect(undated.validFrom).toBe(null);
    expect(dated.payload).toMatchObject({ value: '3:45', object: 'Marathon Prep' });

    // The markdown bitemporal ledger is untouched (lifecycle semantics stay `_mcp_`-only)
    expect(fs.existsSync(path.join(vault, 'System', 'Memory Events Ledger.md'))).toBe(false);

    // No perturbation of the shipped write path outside structured_rows
    expect(dump(db)).toBe(offDump);
    offDb.close();
    db.close();
  });

  it('flag ON: unchanged re-index → zero decisions (hash-keyed skip) and unchanged rows', async () => {
    const db = freshDb();
    const first = spyModel();
    await indexVault(db, vault, { decisionModel: first.model }, 1);
    const after1 = structuredDump(db);
    const second = spyModel();
    await indexVault(db, vault, { decisionModel: second.model }, 1);
    expect(second.calls).toHaveLength(0);
    expect(structuredDump(db)).toBe(after1);
    db.close();
  });

  it('flag ON: edit → stale rows gone, new rows present with fresh provenance', async () => {
    const db = freshDb();
    await indexVault(db, vault, { decisionModel: defaultDecisionModel() }, 1);
    fs.writeFileSync(path.join(vault, 'notes', '2024-03-01-run.md'), DATED_NOTE.replace('3:45', '3:30'));
    await indexVault(db, vault, { decisionModel: defaultDecisionModel() }, 1);
    const notePath = path.join(vault, 'notes', '2024-03-01-run.md');
    const rows = readCurrentRowsForNotes(db, [notePath]);
    const values = rows.filter((r) => r.sourcePath === notePath).map((r) => (r.payload as any).value);
    expect(values).toContain('3:30');
    expect(values).not.toContain('3:45');
    for (const row of rows.filter((r) => r.sourcePath === notePath)) {
      const chunk = db.prepare('SELECT note_path FROM chunks WHERE id = ?').get(row.sourceChunkId) as { note_path: string };
      expect(chunk.note_path).toBe(notePath);
    }
    db.close();
  });


  it('flag ON: identical corpus indexed twice into fresh DBs → identical structured rows (index determinism)', async () => {
    const dbA = freshDb();
    await indexVault(dbA, vault, { decisionModel: defaultDecisionModel() }, 1);
    const dbB = freshDb();
    await indexVault(dbB, vault, { decisionModel: defaultDecisionModel() }, 1);
    expect(structuredDump(dbA)).toBe(structuredDump(dbB));
    dbA.close();
    dbB.close();
  });
});