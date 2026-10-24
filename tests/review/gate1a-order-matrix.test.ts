import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import { replayLedger, factsFor } from '../../src/memory/lifecycle';
import type Database from '../../src/db/sqlite';

/**
 * K12 differential matrix: an UPGRADED legacy cache projection must be
 * equivalent to a FRESH replay of the IDENTICAL canonical ledger — same current
 * value and same event/history validity — for every realistic cache shape.
 * Canonical ledger order (and its supported time semantics) is the only
 * ordering input; disposable SQLite row ids and cache ownership must never
 * change the outcome (Astra gate1a-replay-order-probe.cjs, Kimi
 * p3-rehome-tiebreak-not-canonical.cjs at 7424587 — adapted with provenance;
 * all fixtures synthetic).
 */

const LEDGER = 'System/Memory Events Ledger.md';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
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

interface LedgerEventSpec { id: string; at: string; obj: string; kind?: string }
interface CacheRowSpec { obj: string; at: string; evId: string | null; owner: 'stable' | 'note'; validTo?: string | null }

function writeLedger(v: string, subject: string, events: LedgerEventSpec[]) {
  const p = path.join(v, LEDGER);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const blocks = events.map(e => [
    `## ${e.id} · ${e.at}`,
    `- kind: ${e.kind ?? 'store'}`,
    `- subject: ${subject}`,
    `- predicate: lives_in`,
    `- object: ${e.obj}`,
    `- source: matrix`,
    ``,
  ].join('\n'));
  fs.writeFileSync(p, `---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n` + blocks.join(''));
}

/** Signature of the canonical projection for (subject, 'lives_in'): rows by event id + current values. */
function signature(db: Database.Database, subject: string, canonicalOnly = false) {
  const rows = db.prepare(
    `SELECT f.event_id, f.object_text, f.valid_from, f.valid_to
     FROM facts f JOIN entities e ON f.subject_entity_id = e.id
     WHERE e.source_note = '_mcp_' AND e.canonical_name = ? COLLATE NOCASE AND f.predicate = 'lives_in'
       ${canonicalOnly ? "AND f.event_id IS NOT NULL" : ''}
     ORDER BY f.event_id`
  ).all(subject) as any[];
  const current = db.prepare(
    `SELECT f.object_text, f.event_id FROM facts f JOIN entities e ON f.subject_entity_id = e.id
     WHERE e.source_note = '_mcp_' AND e.canonical_name = ? COLLATE NOCASE AND f.predicate = 'lives_in' AND f.valid_to IS NULL
     ORDER BY f.event_id`
  ).all(subject) as any[];
  return JSON.stringify({ rows, current });
}

/** Build a legacy cache DB with the given rows, in the given SQL insertion order. */
function buildCache(v: string, subject: string, rows: CacheRowSpec[]): Database.Database {
  const db = freshDb(path.join(v, 'cache.db'));
  db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`).run(T1);
  const stableId = (db.prepare(
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`
  ).get(subject, T1) as any).id;
  const notePath = path.join(v, 'note.md');
  db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES (?, ?, 'note', 'h', ?, '{}')`).run(notePath, subject, T1);
  const noteId = (db.prepare(
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', ?, '[]', ?, 1.0, ?) RETURNING id`
  ).get(subject, notePath, T1) as any).id;
  const ins = db.prepare(
    `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id)
     VALUES (?, 'lives_in', ?, '_mcp_', 1.0, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    ins.run(r.owner === 'stable' ? stableId : noteId, r.obj, r.at, r.validTo ?? null, r.at, r.evId);
  }
  return db;
}

/** Fresh replay of the identical ledger into an empty index. */
async function freshReplaySignature(v: string, subject: string, events: LedgerEventSpec[]): Promise<string> {
  writeLedger(v, subject, events);
  const db = freshDb(path.join(v, 'fresh.db'));
  await replayLedger(db, v, LEDGER);
  const sig = signature(db, subject);
  db.close();
  return sig;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// The matrix: (name, ledger, cache rows). Cache rows are listed in SQL
// insertion order, so later entries carry higher row ids — exactly the
// disposable quantity that must never decide canonical outcome.
const equalLedger: LedgerEventSpec[] = [
  { id: 'MEM_FIRST', at: T1, obj: 'A' },
  { id: 'MEM_SECOND', at: T1, obj: 'B' },
];
const incrLedger: LedgerEventSpec[] = [
  { id: 'MEM_FIRST', at: T1, obj: 'A' },
  { id: 'MEM_SECOND', at: T2, obj: 'B' },
];

const matrix: Array<{ name: string; ledger: LedgerEventSpec[]; cache: CacheRowSpec[] }> = [
  {
    // The Astra/Kimi probe shape: reversed SQL insertion (B stable, lower id;
    // A note-owned, higher id) with EQUAL timestamps.
    name: 'equal timestamps, reversed SQL insertion (probe shape)',
    ledger: equalLedger,
    cache: [
      { obj: 'B', at: T1, evId: 'MEM_SECOND', owner: 'stable' },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
    ],
  },
  {
    name: 'equal timestamps, matching SQL insertion (A note first, B stable second)',
    ledger: equalLedger,
    cache: [
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
      { obj: 'B', at: T1, evId: 'MEM_SECOND', owner: 'stable' },
    ],
  },
  {
    name: 'increasing timestamps, reversed SQL insertion',
    ledger: incrLedger,
    cache: [
      { obj: 'B', at: T2, evId: 'MEM_SECOND', owner: 'stable' },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
    ],
  },
  {
    name: 'increasing timestamps, matching SQL insertion',
    ledger: incrLedger,
    cache: [
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
      { obj: 'B', at: T2, evId: 'MEM_SECOND', owner: 'stable' },
    ],
  },
  {
    name: 'equal timestamps, inverted ownership (A stable, B note-owned)',
    ledger: equalLedger,
    cache: [
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'stable' },
      { obj: 'B', at: T1, evId: 'MEM_SECOND', owner: 'note' },
    ],
  },
  {
    name: 'increasing timestamps, inverted ownership (A stable, B note-owned)',
    ledger: incrLedger,
    cache: [
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'stable' },
      { obj: 'B', at: T2, evId: 'MEM_SECOND', owner: 'note' },
    ],
  },
  {
    // Old-candidate wrong winner: both rows already re-homed, but the
    // higher-id A stayed current and B was closed at A's valid_from.
    name: 'already-homed, old candidate wrong winner, equal timestamps',
    ledger: equalLedger,
    cache: [
      { obj: 'B', at: T1, evId: 'MEM_SECOND', owner: 'stable', validTo: T1 },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'stable' },
    ],
  },
  {
    name: 'already-homed, old candidate wrong winner, increasing timestamps',
    ledger: incrLedger,
    cache: [
      { obj: 'B', at: T2, evId: 'MEM_SECOND', owner: 'stable', validTo: T1 },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'stable' },
    ],
  },
  {
    // Partially migrated: the ledger-later event B was re-homed but closed;
    // the earlier A is still note-owned and open.
    name: 'partially migrated: B homed+closed, A note-owned current',
    ledger: equalLedger,
    cache: [
      { obj: 'B', at: T1, evId: 'MEM_SECOND', owner: 'stable', validTo: T1 },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
    ],
  },
];

describe('K12: upgraded cache ≡ fresh replay of the identical canonical ledger', () => {
  for (const { name, ledger, cache } of matrix) {
    it(name, async () => {
      const subject = 'SynthMatrix';
      const v = mkvault('gate1a-k12-');
      const freshSig = await freshReplaySignature(v, subject, ledger);
      // sanity: the fresh replay has exactly one current row
      expect(JSON.parse(freshSig).current).toHaveLength(1);

      const cache2 = mkvault('gate1a-k12cache-');
      writeLedger(cache2, subject, ledger);
      const db = buildCache(cache2, subject, cache);
      await expect(replayLedger(db, cache2, LEDGER)).resolves.toBeDefined();
      const upgradedSig = signature(db, subject);
      expect(upgradedSig).toBe(freshSig);

      // Replay twice: reconciliation is idempotent.
      await replayLedger(db, cache2, LEDGER);
      expect(signature(db, subject)).toBe(freshSig);
      expect(factsFor(db, subject)).toHaveLength(1);
      db.close();
    });
  }

  it('three-event chain with mixed cache states converges on the fresh signature', async () => {
    const subject = 'SynthChain';
    const ledger: LedgerEventSpec[] = [
      { id: 'MEM_C1', at: T1, obj: 'A' },
      { id: 'MEM_C2', at: T2, obj: 'B' },
      { id: 'MEM_C3', at: T3, obj: 'C' },
    ];
    const v = mkvault('gate1a-k12chain-');
    const freshSig = await freshReplaySignature(v, subject, ledger);

    const cache2 = mkvault('gate1a-k12chain2-');
    writeLedger(cache2, subject, ledger);
    // Cache: a realistic scrambled legacy projection — at most one open row
    // per (entity, pair): B stable closed at T1 (wrong close time), A
    // note-owned open, C stable open (old candidate kept the ledger-earliest
    // chain wrong). Reversed insertion order vs the ledger.
    const db = buildCache(cache2, subject, [
      { obj: 'B', at: T2, evId: 'MEM_C2', owner: 'stable', validTo: T1 },
      { obj: 'A', at: T1, evId: 'MEM_C1', owner: 'note' },
      { obj: 'C', at: T3, evId: 'MEM_C3', owner: 'stable' },
    ]);
    await replayLedger(db, cache2, LEDGER);
    expect(signature(db, subject)).toBe(freshSig);
    db.close();
  });

  it('note reindex after upgrade replay preserves the canonical projection', async () => {
    const subject = 'SynthReindex';
    const v = mkvault('gate1a-k12re-');
    const freshSig = await freshReplaySignature(v, subject, equalLedger);

    // Rebuild the cache with a REAL note so indexFile can reindex it.
    writeLedger(v, subject, equalLedger);
    const db = freshDb(path.join(v, 'cache.db'));
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`).run(T1);
    const notePath = path.join(v, `${subject}.md`);
    fs.writeFileSync(notePath, `# ${subject}\n\nBody.\n`);
    await indexFile(db, notePath); // note entity + note-derived facts
    const stableId = (db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`
    ).get(subject, T1) as any).id;
    const noteId = (db.prepare(`SELECT id FROM entities WHERE source_note = ?`).get(notePath) as any).id;
    const ins = db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, 'lives_in', ?, '_mcp_', 1.0, ?, ?, ?, ?)`
    );
    ins.run(stableId, 'B', T1, null, T1, 'MEM_SECOND'); // B stable, lower id
    ins.run(noteId, 'A', T1, null, T1, 'MEM_FIRST');    // A note-owned, higher id

    await replayLedger(db, v, LEDGER);
    expect(signature(db, subject)).toBe(freshSig);

    fs.writeFileSync(notePath, `# ${subject}\n\nEdited body.\n`);
    await indexFile(db, notePath);
    expect(signature(db, subject)).toBe(freshSig); // canonical rows untouched by the reindex
    db.close();
  });

  it('unrelated extracted (non-lifecycle) rows are preserved untouched', async () => {
    const subject = 'SynthExtract';
    const v = mkvault('gate1a-k12ex-');
    const freshSig = await freshReplaySignature(v, subject, equalLedger);

    const cache2 = mkvault('gate1a-k12ex2-');
    writeLedger(cache2, subject, equalLedger);
    const db = buildCache(cache2, subject, [
      { obj: 'B', at: T1, evId: 'MEM_SECOND', owner: 'stable' },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
    ]);
    // Unrelated extracted rows: same note entity, different predicate and/or
    // source_path — must not be closed or altered by lifecycle reconciliation.
    const noteId = (db.prepare(`SELECT id FROM entities WHERE source_note LIKE '%note.md'`).get() as any).id;
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, 'works_at', 'ExtractedCorp', ?, 1.0, ?, NULL, ?, NULL)`
    ).run(noteId, path.join(cache2, 'note.md'), T1, T1);
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, 'lives_in', 'ExtractedPlace', ?, 1.0, ?, NULL, ?, NULL)`
    ).run(noteId, path.join(cache2, 'note.md'), T1, T1);

    await replayLedger(db, cache2, LEDGER);
    expect(signature(db, subject)).toBe(freshSig);
    const extracted = db.prepare(
      `SELECT object_text, valid_to FROM facts WHERE source_path = ? ORDER BY object_text`
    ).all(path.join(cache2, 'note.md')) as any[];
    expect(extracted).toHaveLength(2);
    expect(extracted.every(r => r.valid_to === null)).toBe(true); // untouched
    db.close();
  });

  it('non-event-backed open lifecycle row (pre-canonical MCP write shape) is closed by the canonical event and kept in history', async () => {
    const subject = 'SynthNonEvent';
    const v = mkvault('gate1a-k12ne-');
    const freshSig = await freshReplaySignature(v, subject, incrLedger);

    const cache2 = mkvault('gate1a-k12ne2-');
    writeLedger(cache2, subject, incrLedger);
    const db = buildCache(cache2, subject, [
      // A NULL-event current row on the lifecycle entity: the legacy non-event
      // MCP write path wrote facts WITHOUT event_id — non-canonical by construction.
      { obj: 'PreCanonical', at: T1, evId: null, owner: 'stable' },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
    ]);
    await replayLedger(db, cache2, LEDGER);
    // Canonical stream equals the fresh signature (the extra non-canonical row
    // is intentionally outside this comparison and asserted below).
    expect(signature(db, subject, true)).toBe(freshSig);
    // The non-canonical row survives in history, closed — never a current
    // winner against canonical events, but not dropped either.
    const nonEvent = db.prepare(
      `SELECT valid_to FROM facts f JOIN entities e ON f.subject_entity_id = e.id
       WHERE e.source_note = '_mcp_' AND e.canonical_name = ? COLLATE NOCASE AND f.predicate = 'lives_in' AND f.event_id IS NULL`
    ).get(subject) as any;
    expect(nonEvent).toBeTruthy();
    expect(nonEvent.valid_to).not.toBeNull();
    const current = factsFor(db, subject) as any[];
    expect(current).toHaveLength(1);
    expect(current[0].event_id).toBe('MEM_SECOND');
    db.close();
  });

  it('a time-decreasing (invalid) canonical ledger is rejected by upgraded replay exactly like fresh replay', async () => {
    // Supersedes the pass-2 time-based winner rule (Kimi p2 scenario (a)): its
    // fixture ledger is [MEM_P2L LegacyTown @ 01-03, MEM_P2V LifeTown @ 01-02]
    // — the later ledger event has an EARLIER timestamp, which the fresh-apply
    // monotonicity rule rejects on any fresh rebuild. Canonical equivalence
    // means the upgrade replay over an already-projected cache must reject the
    // same ledger too, never produce a state a fresh replay could not.
    const subject = 'SynthInvalid';
    const invalidLedger: LedgerEventSpec[] = [
      { id: 'MEM_P2L', at: T3, obj: 'LegacyTown' },
      { id: 'MEM_P2V', at: T2, obj: 'LifeTown' },
    ];
    const v = mkvault('gate1a-k12inv-');
    writeLedger(v, subject, invalidLedger);
    const dbFresh = freshDb(path.join(v, 'fresh.db'));
    await expect(replayLedger(dbFresh, v, LEDGER)).rejects.toThrow(/out-of-order/i);
    dbFresh.close();

    const cache2 = mkvault('gate1a-k12inv2-');
    writeLedger(cache2, subject, invalidLedger);
    const db = buildCache(cache2, subject, [
      { obj: 'LifeTown', at: T2, evId: 'MEM_P2V', owner: 'stable' },
      { obj: 'LegacyTown', at: T3, evId: 'MEM_P2L', owner: 'note' },
    ]);
    await expect(replayLedger(db, cache2, LEDGER)).rejects.toThrow(/out-of-order/i);
    // No rows were silently reordered or dropped while failing.
    const open = db.prepare(
      `SELECT COUNT(*) c FROM facts f JOIN entities e ON f.subject_entity_id = e.id
       WHERE e.canonical_name = ? AND f.predicate = 'lives_in' AND f.valid_to IS NULL`
    ).get(subject) as any;
    expect(open.c).toBe(2); // the two rows remain exactly as the cache held them
    db.close();
  });

  it('K13/p4: a FULLY ORPHANED stream (its only event removed from the ledger) fails the upgrade replay before any mutation', async () => {
    // Adapted with provenance from Kimi p4-orphan-stream-equiv.cjs (report
    // 5317a9d): the ledger holds only MEM_PRESENT1; the cache additionally
    // holds an event-backed stream whose event was hand-removed. Stream-scoped
    // refusal never touches it, so the orphan was served as current canonical
    // truth with false provenance while a clean rebuild of the SAME ledger
    // served nothing (upgrade != rebuild). The global preflight must fail
    // closed before any cache mutation.
    const v = mkvault('gate1a-k13-');
    writeLedger(v, 'SynthPresent', [{ id: 'MEM_PRESENT1', at: T1, obj: 'keeper', kind: 'store' }]);
    // Overwrite the ledger's subject/predicate for this fixture: writeLedger
    // emits 'lives_in'; the p4 shape uses a different untouched stream, which
    // is the point (the orphan stream's predicate never appears in the ledger).
    const ledgerPath = path.join(v, LEDGER);
    fs.writeFileSync(ledgerPath, fs.readFileSync(ledgerPath, 'utf-8').replaceAll('lives_in', 'role'));
    const db = freshDb(path.join(v, 'cache.db'));
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`).run(T1);
    const insEntity = db.prepare(`INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`);
    const e1 = (insEntity.get('SynthPresent', T1) as any).id;
    const e2 = (insEntity.get('SynthGhost', T1) as any).id;
    const inF = db.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, ?, ?, '_mcp_', 1.0, ?, NULL, ?, ?)`);
    inF.run(e1, 'role', 'keeper', T1, T1, 'MEM_PRESENT1');
    inF.run(e2, 'secret', 'orphan-value', T1, T1, 'MEM_GHOST1');
    const before = signature(db, 'SynthGhost');
    const presentBefore = signature(db, 'SynthPresent');

    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/absent from the ledger|MEM_GHOST1/i);

    // No partial mutation: the rejected replay left the cache exactly as held.
    expect(signature(db, 'SynthGhost')).toBe(before);
    expect(signature(db, 'SynthPresent')).toBe(presentBefore);

    // A clean rebuild of the identical ledger serves nothing for the ghost —
    // the upgraded replay must not silently diverge from it.
    const v2 = mkvault('gate1a-k13f-');
    fs.mkdirSync(path.join(v2, 'System'), { recursive: true });
    fs.copyFileSync(ledgerPath, path.join(v2, LEDGER));
    const db2 = freshDb(path.join(v2, 'fresh.db'));
    await replayLedger(db2, v2, LEDGER);
    expect(factsFor(db2, 'SynthGhost')).toHaveLength(0);
    db2.close();
    db.close();
  });

  it('K13: orphan detection is global — a DIFFERENT untouched stream is caught, and an empty ledger file with event-backed rows fails closed', async () => {
    // Global preflight, not only streams the replay touches: two cache streams,
    // the ledger references only one of them. Also the degenerate whole-index
    // case: a ledger file with NO events at all while event-backed rows exist.
    const v = mkvault('gate1a-k13b-');
    writeLedger(v, 'SynthTouched', [{ id: 'MEM_T1', at: T1, obj: 'a' }]);
    const ledgerPath = path.join(v, LEDGER);
    const db = freshDb(path.join(v, 'cache.db'));
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`).run(T1);
    const insEntity = db.prepare(`INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`);
    const e1 = (insEntity.get('SynthTouched', T1) as any).id;
    const e2 = (insEntity.get('SynthUntouched', T1) as any).id;
    const inF = db.prepare(`INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, 'p', ?, '_mcp_', 1.0, ?, NULL, ?, ?)`);
    inF.run(e1, 'a', T1, T1, 'MEM_T1');
    inF.run(e2, 'b', T1, T1, 'MEM_U1');
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/absent from the ledger|MEM_U1/i);

    // Degenerate case: an EMPTY ledger file (parses to zero events) with
    // event-backed rows is the same contradiction — every projected event is
    // orphaned. (Distinct from K10's missing FILE, which keeps its own guard.)
    fs.writeFileSync(ledgerPath, '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n');
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/absent from the ledger/i);
    db.close();
  });

  it('K13: a genuinely empty vault and an empty ledger with NO event-backed rows still replay cleanly', async () => {
    const v = mkvault('gate1a-k13ok-');
    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0); // no ledger file at all
    const ledgerPath = path.join(v, LEDGER);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n');
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0); // empty file, no projections
    db.close();
  });

  it('an event-backed current row whose event is absent from the ledger fails explicitly (never guessed)', async () => {
    const subject = 'SynthForeign';
    const v = mkvault('gate1a-k12for-');
    writeLedger(v, subject, [
      { id: 'MEM_FIRST', at: T1, obj: 'A' },
    ]);
    const db = buildCache(v, subject, [
      { obj: 'Ghost', at: T1, evId: 'MEM_NOT_IN_LEDGER', owner: 'stable' },
      { obj: 'A', at: T1, evId: 'MEM_FIRST', owner: 'note' },
    ]);
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/absent from the ledger/i);
    // Nothing was silently reordered or dropped while failing.
    const ghost = db.prepare(`SELECT valid_to FROM facts WHERE event_id = 'MEM_NOT_IN_LEDGER'`).get() as any;
    expect(ghost.valid_to).toBeNull();
    db.close();
  });
});