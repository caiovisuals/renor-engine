import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, replayLedger, factsFor, appendLedgerEvent } from '../../src/memory/lifecycle';
import type Database from 'better-sqlite3';

/**
 * Gate1A repair-pass-5 regressions for the ChatGPT/Sol review (source-analysis
 * findings S1/S2 on candidate 067ad28; reproduced here before the fixes):
 *  - S1: timestamp semantics mixed raw-string ordering (apply/live checks),
 *    instant ordering (reconciliation) and SQL textual ordering (asOf). An
 *    offset timestamp (valid Date.parse, lexically earlier but later as an
 *    instant) made replay reject valid chronological order and made asOf reads
 *    wrong. Contract chosen: ONE canonical sortable timestamp format — the
 *    exact UTC-ISO representation the writer emits (YYYY-MM-DDTHH:mm:ss.sssZ).
 *  - S2: the ledger containment base was computed from dirname(ledgerRelPath),
 *    so '../outside/ledger' escaped the vault on append; replay had no
 *    confinement at all.
 * All fixtures synthetic.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(prefix: string): string {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(v);
  return v;
}

function freshDb(file: string): Database.Database {
  const db = openDb(file);
  runMigrations(db);
  return db;
}

function writeLedgerFile(v: string, blocks: string[]): string {
  const p = path.join(v, LEDGER);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n` + blocks.join('\n') + '\n');
  return p;
}

function eventBlock(id: string, at: string, obj: string, subject = 'SynthTs', predicate = 'p'): string {
  return [`## ${id} · ${at}`, `- kind: store`, `- subject: ${subject}`, `- predicate: ${predicate}`, `- object: ${obj}`, `- source: sol`, ``].join('\n');
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('S1: one canonical timestamp contract (exact writer UTC-ISO format)', () => {
  it('an offset timestamp — later instant, lexically EARLIER — is rejected as an unsupported representation BEFORE any mutation', async () => {
    // Sol's exact case: 2026-09-09T00:00:00.000Z then 2026-09-08T23:30:00.000-01:00
    // (the second is 30 minutes LATER as an instant but sorts before the first
    // lexically). Old behavior: string-ordering rejected valid chronological
    // order (or, worse, diverged between apply, reconcile and asOf).
    const v = mkvault('gate1a-s1off-');
    writeLedgerFile(v, [
      eventBlock('MEM_TS1', '2026-09-09T00:00:00.000Z', 'first'),
      eventBlock('MEM_TS2', '2026-09-08T23:30:00.000-01:00', 'second'),
    ]);
    const db = freshDb(path.join(v, 'cache.db'));
    // Seed one projected row so "cache untouched" is observable.
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-01-01T00:00:00.000Z', '{}')`).run();
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/canonical|format/i);

    // Pre-mutation rejection: nothing was applied or altered.
    expect((db.prepare('SELECT COUNT(*) c FROM facts').get() as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM applied_ledger_events').get() as any).c).toBe(0);
    db.close();
  });

  it('the SAME logical sequence in the writer\'s canonical format replays in chronological order (normal writer format unchanged)', async () => {
    // The offset event 2026-09-08T23:30:00.000-01:00 denotes 2026-09-09T00:30:00.000Z:
    // canonicalized, the sequence is chronologically increasing and must apply.
    const v = mkvault('gate1a-s1canon-');
    writeLedgerFile(v, [
      eventBlock('MEM_TS1', '2026-09-09T00:00:00.000Z', 'first'),
      eventBlock('MEM_TS2', '2026-09-09T00:30:00.000Z', 'second'),
    ]);
    const db = freshDb(path.join(v, 'cache.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(2);
    const current = factsFor(db, 'SynthTs') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('second');
    const history = factsFor(db, 'SynthTs', { includeHistory: true }) as any[];
    expect(history).toHaveLength(2);
    expect(history.find(r => r.object_text === 'first').valid_to).toBe('2026-09-09T00:30:00.000Z');
    db.close();
  });

  it('inverse actual-time order in canonical format is still rejected (monotonicity unchanged)', async () => {
    const v = mkvault('gate1a-s1inv-');
    writeLedgerFile(v, [
      eventBlock('MEM_TS1', '2026-09-09T02:00:00.000Z', 'later-first'),
      eventBlock('MEM_TS2', '2026-09-09T01:00:00.000Z', 'earlier-second'),
    ]);
    const db = freshDb(path.join(v, 'cache.db'));
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/out-of-order/i);
    db.close();
  });

  it('equivalent instants: the offset form is rejected as unsupported, never silently applied or deduped against its canonical twin', async () => {
    const v = mkvault('gate1a-s1eq-');
    writeLedgerFile(v, [
      eventBlock('MEM_TS1', '2026-09-09T00:00:00.000Z', 'canonical'),
      eventBlock('MEM_TS2', '2026-09-08T23:00:00.000-01:00', 'same-instant-offset-form'),
    ]);
    const db = freshDb(path.join(v, 'cache.db'));
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/canonical|format/i);
    expect((db.prepare('SELECT COUNT(*) c FROM facts').get() as any).c).toBe(0);
    db.close();
  });

  it('fresh replay and populated-cache upgrade agree on a canonical two-event chain', async () => {
    const blocks = [
      eventBlock('MEM_TS1', '2026-09-09T00:00:00.000Z', 'first'),
      eventBlock('MEM_TS2', '2026-09-09T00:30:00.000Z', 'second'),
    ];
    const vFresh = mkvault('gate1a-s1fa-');
    writeLedgerFile(vFresh, blocks);
    const dbF = freshDb(path.join(vFresh, 'fresh.db'));
    await replayLedger(dbF, vFresh, LEDGER);

    const vCache = mkvault('gate1a-s1fb-');
    writeLedgerFile(vCache, blocks);
    const dbC = freshDb(path.join(vCache, 'cache.db'));
    dbC.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-09-09T00:00:00.000Z', '{}')`).run();
    const noteFile = path.join(vCache, 'n.md');
    fs.writeFileSync(noteFile, '# n\n');
    dbC.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES (?, 'n', 'note', 'h', '2026-09-09T00:00:00.000Z', '{}')`).run(noteFile);
    const e = (dbC.prepare(`INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'SynthTs', '[]', '_mcp_', 1.0, '2026-09-09T00:00:00.000Z') RETURNING id`).get() as any).id;
    // Legacy cache: SECOND event projected current on the lifecycle entity,
    // FIRST event still note-owned — a mixed-owner shape for the same chain.
    const noteId = (dbC.prepare(`INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', 'SynthTs', '[]', ?, 1.0, '2026-09-09T00:00:00.000Z') RETURNING id`).get(path.join(vCache, 'n.md')) as any).id;
    dbC.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, 'p', 'second', '_mcp_', 1.0, '2026-09-09T00:30:00.000Z', NULL, '2026-09-09T00:30:00.000Z', 'MEM_TS2')`).run(e);
    dbC.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, 'p', 'first', '_mcp_', 1.0, '2026-09-09T00:00:00.000Z', NULL, '2026-09-09T00:00:00.000Z', 'MEM_TS1')`).run(noteId);
    await expect(replayLedger(dbC, vCache, LEDGER)).resolves.toBe(0);

    const sig = (db: Database.Database) => JSON.stringify(
      (db.prepare(`SELECT f.event_id, f.object_text, f.valid_from, f.valid_to FROM facts f JOIN entities e ON f.subject_entity_id = e.id WHERE e.source_note = '_mcp_' AND e.canonical_name = 'SynthTs' ORDER BY f.event_id`).all() as any[])
    );
    expect(sig(dbC)).toBe(sig(dbF));
    dbF.close();
    dbC.close();
  });

  it('factsFor asOf: consistent instant semantics, correct exclusive boundary, offset inputs normalized, garbage rejected', async () => {
    const v = mkvault('gate1a-s1asof-');
    const db = freshDb(path.join(v, 'cache.db'));
    await remember(db, v, LEDGER, { subject: 'SynthAsOf', predicate: 'p', object: 'first', source: 'sol' });
    await remember(db, v, LEDGER, { subject: 'SynthAsOf', predicate: 'p', object: 'second', source: 'sol' });
    const rows = factsFor(db, 'SynthAsOf', { includeHistory: true }) as any[];
    const t1 = rows.find(r => r.object_text === 'first').valid_from;   // opened at t1
    const t2 = rows.find(r => r.object_text === 'second').valid_from;  // closed t1, opened t2

    // Boundary: valid_to is EXCLUSIVE — at exactly t2 the first fact is no
    // longer current and the second is.
    let atBoundary = factsFor(db, 'SynthAsOf', { asOf: t2 }) as any[];
    expect(atBoundary).toHaveLength(1);
    expect(atBoundary[0].object_text).toBe('second');
    let justBefore = factsFor(db, 'SynthAsOf', { asOf: new Date(Date.parse(t2) - 1).toISOString() }) as any[];
    expect(justBefore[0].object_text).toBe('first');

    // The SAME boundary expressed with a -01:00 offset must give the SAME
    // answer (instant semantics, not lexical SQL ordering — the old code
    // compared '...23:30:00.000-01:00' textually against '...00:30:00.000Z').
    const tMinus1h = new Date(Date.parse(t2) - 3600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const offsetT2 = `${tMinus1h.getUTCFullYear()}-${pad(tMinus1h.getUTCMonth() + 1)}-${pad(tMinus1h.getUTCDate())}T${pad(tMinus1h.getUTCHours())}:${pad(tMinus1h.getUTCMinutes())}:${pad(tMinus1h.getUTCSeconds())}.${String(tMinus1h.getUTCMilliseconds()).padStart(3, '0')}-01:00`;
    atBoundary = factsFor(db, 'SynthAsOf', { asOf: offsetT2 }) as any[];
    expect(atBoundary).toHaveLength(1);
    expect(atBoundary[0].object_text).toBe('second'); // same instant, same answer
    justBefore = factsFor(db, 'SynthAsOf', { asOf: new Date(Date.parse(t2) - 1).toISOString() }) as any[];
    expect(justBefore[0].object_text).toBe('first');

    // Garbage asOf fails with a clear error, not a silent empty/wrong answer.
    expect(() => factsFor(db, 'SynthAsOf', { asOf: 'not-a-date' })).toThrow(/timestamp/i);
    db.close();
  });
});

describe('S2: shared vault-rooted ledger path resolver (append AND replay)', () => {
  it('rejects ../outside/ledger on append BEFORE any filesystem side effect', async () => {
    const v = mkvault('gate1a-s2a-');
    const db = freshDb(path.join(v, 'cache.db'));
    const sibling = `outside-s2a-${process.pid}`;
    const outside = path.resolve(path.join(v, '..', sibling));
    await expect(appendLedgerEvent(v, `../${sibling}/ledger`, {
      id: 'MEM_ESC1', at: '2026-09-09T00:00:00.000Z', kind: 'store',
      subject: 'SynthEsc', predicate: 'p', object: 'x', closedEvent: null, source: 'sol',
    })).rejects.toThrow(/escape|vault root/i);
    expect(fs.existsSync(outside)).toBe(false); // nothing was created outside the vault
    await expect(replayLedger(db, v, `../${sibling}/ledger`)).rejects.toThrow(/escape|vault root/i);
    db.close();
  });

  it('rejects ../../x and ../vault-evil/x on both append and replay', async () => {
    const v = mkvault('gate1a-s2b-');
    const db = freshDb(path.join(v, 'cache.db'));
    const uniq = `s2b-${process.pid}`; for (const evil of [`../../${uniq}`, `../${uniq}-evil/x`]) {
      await expect(appendLedgerEvent(v, evil, {
        id: 'MEM_ESC2', at: '2026-09-09T00:00:00.000Z', kind: 'store',
        subject: 'SynthEsc', predicate: 'p', object: 'x', closedEvent: null, source: 'sol',
      })).rejects.toThrow(/escape|vault root/i);
      await expect(replayLedger(db, v, evil)).rejects.toThrow(/escape|vault root/i);
    }
    expect(fs.existsSync(path.resolve(path.join(v, '..', `${uniq}.md`)))).toBe(false);
    expect(fs.existsSync(path.resolve(path.join(v, '..', `${uniq}-evil`)))).toBe(false);
    db.close();
  });

  it('rejects an ABSOLUTE ledger path on both paths (fail-closed double-join resolution)', async () => {
    const v = mkvault('gate1a-s2c-');
    const db = freshDb(path.join(v, 'cache.db'));
    const abs = path.join(v, 'elsewhere.md');
    await expect(appendLedgerEvent(v, abs, {
      id: 'MEM_ESC3', at: '2026-09-09T00:00:00.000Z', kind: 'store',
      subject: 'SynthEsc', predicate: 'p', object: 'x', closedEvent: null, source: 'sol',
    })).rejects.toThrow(/escape|vault root|absolute/i);
    await expect(replayLedger(db, v, abs)).rejects.toThrow(/escape|vault root|absolute/i);
    db.close();
  });

  it('rejects an empty/vault-root ledger path', async () => {
    const v = mkvault('gate1a-s2d-');
    const db = freshDb(path.join(v, 'cache.db'));
    await expect(appendLedgerEvent(v, '', {
      id: 'MEM_ESC4', at: '2026-09-09T00:00:00.000Z', kind: 'store',
      subject: 'SynthEsc', predicate: 'p', object: 'x', closedEvent: null, source: 'sol',
    })).rejects.toThrow(/escape|vault root/i);
    await expect(replayLedger(db, v, '.')).rejects.toThrow(/escape|vault root/i);
    db.close();
  });

  it('preserves the normal relative path and the .md-suffix behavior on both append and replay', async () => {
    const v = mkvault('gate1a-s2e-');
    const db = freshDb(path.join(v, 'cache.db'));
    // No .md suffix: the suffix is appended exactly like before.
    const written = await appendLedgerEvent(v, 'System/Memory Events Ledger', {
      id: 'MEM_OK1', at: '2026-09-09T00:00:00.000Z', kind: 'store',
      subject: 'SynthOk', predicate: 'p', object: 'ok', closedEvent: null, source: 'sol',
    });
    expect(written).toBe(path.join(v, LEDGER));
    // remember round-trips through the same resolver.
    await expect(remember(db, v, 'System/Memory Events Ledger', {
      subject: 'SynthOk', predicate: 'p', object: 'ok2', source: 'sol',
    })).resolves.toBeTruthy();
    const db2 = freshDb(path.join(v, 'fresh.db'));
    await expect(replayLedger(db2, v, 'System/Memory Events Ledger')).resolves.toBe(2);
    expect(factsFor(db2, 'SynthOk')).toHaveLength(1);
    db2.close();
    db.close();
  });
});