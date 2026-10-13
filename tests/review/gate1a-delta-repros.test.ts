import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import { remember, replayLedger, factsFor, appendLedgerEvent } from '../../src/memory/lifecycle';
import type Database from 'better-sqlite3';

/**
 * Gate1A repair-pass-2 regressions, adapted with provenance from the round-2
 * reviewer repros (imports/assertions adapted only; no invariant weakened):
 *  - Kimi K9:  gate1a-review 953a18a review-repros/r6-rehome-unique-violation.cjs
 *  - Kimi K11: review-repros/d1-outoforder-live-poison.cjs (controlled clock,
 *    RELATIVE future time — the regression does not expire after calendar 2030)
 *  - Kimi K10: review-repros/d2-v5-noledger-guard-gap.cjs
 *  - Astra delta probe: gate1a-astra-delta-probe.cjs (mixed-owner replay; pre-digest missing ledger)
 * All data synthetic (mkdtemp). Original reviewer scripts remain available
 * in Git history; durable regressions live here as normal Vitest tests.
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

function insertFact(db: Database.Database, entityId: number, ev: {
  predicate: string; object: string; at: string; validTo?: string | null; evId?: string | null;
}) {
  db.prepare(
    `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id)
     VALUES (?, ?, ?, '_mcp_', 1.0, ?, ?, ?, ?)`
  ).run(entityId, ev.predicate, ev.object, ev.at, ev.validTo ?? null, ev.at, ev.evId ?? null);
}

function ensureLifecycleEntity(db: Database.Database, name: string, at: string): number {
  db.prepare(`INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`).run(at);
  return (db.prepare(
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`
  ).get(name, at) as any).id;
}

function eventBlock(id: string, at: string, obj: string, subject = 'SynthBob', predicate = 'lives_in'): string {
  return [`## ${id} · ${at}`, `- kind: store`, `- subject: ${subject}`, `- predicate: ${predicate}`, `- object: ${obj}`, `- source: poc`, ``].join('\n');
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('K9/A2.1: re-home reconciles in a constraint-safe statement order', () => {
  // The mixed-owner shape: a ledger-backed CURRENT fact owned by a note entity
  // PLUS a lifecycle-owned CURRENT fact for the same (subject, predicate) —
  // producible by the round-1 candidate (its remember() saw only the
  // lifecycle entity, so a live store/supersede opened a second current while
  // the note-owned projection persisted).
  function mixedOwnerFixture(v: string, db: Database.Database, legacyAt: string, liveAt: string) {
    const notePath = path.join(v, 'SynthBob.md');
    fs.writeFileSync(notePath, '# SynthBob\n\nBody.\n');
    return indexFile(db, notePath).then(() => {
      const noteEntity = (db.prepare(`SELECT id FROM entities WHERE source_note = ?`).get(notePath) as any).id;
      insertFact(db, noteEntity, { predicate: 'lives_in', object: 'Oldtown', at: legacyAt, evId: 'MEM_LEGACY1' });
      const lifeId = ensureLifecycleEntity(db, 'SynthBob', liveAt);
      insertFact(db, lifeId, { predicate: 'lives_in', object: 'Newtown', at: liveAt, evId: 'MEM_LIVE1' });
      fs.mkdirSync(path.join(v, 'System'), { recursive: true });
      fs.writeFileSync(path.join(v, LEDGER),
        '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n' +
        eventBlock('MEM_LEGACY1', legacyAt, 'Oldtown') +
        eventBlock('MEM_LIVE1', liveAt, 'Newtown'));
      return lifeId;
    });
  }

  it('r6 shape: existing lifecycle current is newer — replay re-homes without UNIQUE failure, full history kept', async () => {
    const v = mkvault('gate1a-r6-');
    const db = freshDb(path.join(v, 'index.db'));
    await mixedOwnerFixture(v, db, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0); // both already projected: re-home + dedup only
    const history = factsFor(db, 'SynthBob', { includeHistory: true }) as any[];
    expect(history).toHaveLength(2); // both legitimate events remain in canonical history
    const current = factsFor(db, 'SynthBob') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Newtown'); // newest wins, per the explicit (valid_from, id) rule
    expect(current[0].valid_to).toBeNull();
    // The older moving row was closed at the winner's valid_from — no arbitrary drop.
    const legacyRow = db.prepare(`SELECT valid_to, subject_entity_id FROM facts WHERE event_id = 'MEM_LEGACY1'`).get() as any;
    expect(legacyRow.valid_to).toBe('2026-01-02T00:00:00.000Z');
    db.close();
  });

  it('inverse: moving row\'s event is LATER in the ledger — it becomes current and the existing lifecycle current is closed', async () => {
    const v = mkvault('gate1a-r6inv-');
    const db = freshDb(path.join(v, 'index.db'));
    // Canonical ledger order (the only ordering input, K12): MEM_LIVE1 (A) is
    // FIRST and already homed as current; MEM_LEGACY1 (B) is SECOND and still
    // note-owned — so the moving row must win, matching a fresh replay.
    const notePath = path.join(v, 'SynthBob.md');
    fs.writeFileSync(notePath, '# SynthBob\n\nBody.\n');
    await indexFile(db, notePath);
    const noteEntity = (db.prepare(`SELECT id FROM entities WHERE source_note = ?`).get(notePath) as any).id;
    const lifeId = ensureLifecycleEntity(db, 'SynthBob', '2026-01-01T00:00:00.000Z');
    insertFact(db, lifeId, { predicate: 'lives_in', object: 'Oldtown', at: '2026-01-01T00:00:00.000Z', evId: 'MEM_LIVE1' });
    insertFact(db, noteEntity, { predicate: 'lives_in', object: 'Newtown', at: '2026-01-02T00:00:00.000Z', evId: 'MEM_LEGACY1' });
    fs.mkdirSync(path.join(v, 'System'), { recursive: true });
    fs.writeFileSync(path.join(v, LEDGER),
      '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n' +
      eventBlock('MEM_LIVE1', '2026-01-01T00:00:00.000Z', 'Oldtown') +
      eventBlock('MEM_LEGACY1', '2026-01-02T00:00:00.000Z', 'Newtown'));

    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    const history = factsFor(db, 'SynthBob', { includeHistory: true }) as any[];
    expect(history).toHaveLength(2);
    const current = factsFor(db, 'SynthBob') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Newtown'); // the ledger-later moving row wins
    expect(current[0].event_id).toBe('MEM_LEGACY1');
    const closedLive = db.prepare(`SELECT valid_to FROM facts WHERE event_id = 'MEM_LIVE1'`).get() as any;
    expect(closedLive.valid_to).toBe('2026-01-02T00:00:00.000Z'); // closed at the winner's valid_from
    db.close();
  });

  it('equal timestamps: canonical ledger-later event wins (K12), exactly one current, both events kept', async () => {
    const v = mkvault('gate1a-r6eq-');
    const db = freshDb(path.join(v, 'index.db'));
    const at = '2026-01-01T00:00:00.000Z';
    await mixedOwnerFixture(v, db, at, at); // same millisecond (base-engine race shape)

    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    expect(factsFor(db, 'SynthBob', { includeHistory: true })).toHaveLength(2);
    const current = factsFor(db, 'SynthBob') as any[];
    expect(current).toHaveLength(1);
    // Winner: the event that appears LATER in the canonical ledger — MEM_LIVE1
    // — independent of SQL row ids and of note reindex order. (Fixture inserts
    // MEM_LIVE1 with the LOWER row id: the row-id rule would pick the other.)
    expect(current[0].event_id).toBe('MEM_LIVE1');
    expect(current[0].object_text).toBe('Newtown');
    const loser = db.prepare(`SELECT valid_to FROM facts WHERE event_id = 'MEM_LEGACY1'`).get() as any;
    expect(loser.valid_to).not.toBeNull(); // closed at the winner's valid_from (zero-width, same instant)
    db.close();
  });

  it('closed historical moving row re-homes freely with no current interference', async () => {
    const v = mkvault('gate1a-r6hist-');
    const db = freshDb(path.join(v, 'index.db'));
    const notePath = path.join(v, 'SynthHist.md');
    fs.writeFileSync(notePath, '# SynthHist\n\nBody.\n');
    await indexFile(db, notePath);
    const noteEntity = (db.prepare(`SELECT id FROM entities WHERE source_note = ?`).get(notePath) as any).id;
    // Historical (already closed) note-owned canonical fact + an unrelated open lifecycle current.
    insertFact(db, noteEntity, { predicate: 'lives_in', object: 'Oldtown', at: '2026-01-01T00:00:00.000Z', validTo: '2026-01-02T00:00:00.000Z', evId: 'MEM_HIST1' });
    const lifeId = ensureLifecycleEntity(db, 'SynthHist', '2026-01-03T00:00:00.000Z');
    insertFact(db, lifeId, { predicate: 'lives_in', object: 'Current', at: '2026-01-03T00:00:00.000Z', evId: 'MEM_CUR1' });
    fs.mkdirSync(path.join(v, 'System'), { recursive: true });
    fs.writeFileSync(path.join(v, LEDGER),
      '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n' +
      eventBlock('MEM_HIST1', '2026-01-01T00:00:00.000Z', 'Oldtown', 'SynthHist') +
      eventBlock('MEM_CUR1', '2026-01-03T00:00:00.000Z', 'Current', 'SynthHist'));

    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    const history = factsFor(db, 'SynthHist', { includeHistory: true }) as any[];
    expect(history).toHaveLength(2);
    const current = factsFor(db, 'SynthHist') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Current'); // historical row does not displace the live current
    const histRow = db.prepare(`SELECT subject_entity_id, valid_to FROM facts WHERE event_id = 'MEM_HIST1'`).get() as any;
    expect(histRow.subject_entity_id).toBe(lifeId); // re-homed
    // K12: the closed row's valid_to is recomputed from canonical order — the
    // cache's stale 01-02 close has no basis in the ledger (no such event
    // exists); the canonical successor MEM_CUR1 begins at 01-03, exactly what a
    // fresh replay produces.
    expect(histRow.valid_to).toBe('2026-01-03T00:00:00.000Z');
    db.close();
  });

  it('complete path: mixed owner -> startup replay -> note reindex -> user remember -> full rebuild', async () => {
    const v = mkvault('gate1a-r6path-');
    const db = freshDb(path.join(v, 'index.db'));
    await mixedOwnerFixture(v, db, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

    // Startup replay re-homes BEFORE readiness.
    await replayLedger(db, v, LEDGER);
    expect(factsFor(db, 'SynthBob')).toHaveLength(1);

    // Note reindex must not cascade-delete either canonical fact now.
    fs.writeFileSync(path.join(v, 'SynthBob.md'), '# SynthBob\n\nEdited.\n');
    await indexFile(db, path.join(v, 'SynthBob.md'));
    expect(factsFor(db, 'SynthBob', { includeHistory: true })).toHaveLength(2);

    // Subsequent user write supersedes the current value.
    const receipt = await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Uptown', source: 'user' });
    expect(receipt.action).toBe('supersede');
    expect(factsFor(db, 'SynthBob')).toHaveLength(1);

    // Full rebuild (wipe derived state exactly like `osm rebuild`) replays clean.
    db.transaction(() => {
      ['facts', 'relations', 'entities', 'chunks', 'notes', 'applied_ledger_events'].forEach(t =>
        db.prepare(`DELETE FROM ${t}`).run());
    })();
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(3);
    const history = factsFor(db, 'SynthBob', { includeHistory: true }) as any[];
    expect(history).toHaveLength(3); // whole stream preserved
    const current = factsFor(db, 'SynthBob') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Uptown');
    db.close();
  });
});

describe('K11: a rejected live write never reaches the ledger', () => {
  it('d1 (controlled clock, relative future): clock-regressed remember throws pre-publish; ledger byte-identical; fresh replay clean', async () => {
    const v = mkvault('gate1a-d1-');
    const db = freshDb(path.join(v, 'index.db'));

    // Phase 1: the clock runs AHEAD (relative future — no fixed calendar date,
    // so this regression still exercises in 2031 and beyond). The engine
    // legitimately records a future-dated event, exactly as it would then.
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(realNow + 365 * 24 * 3600 * 1000));
    await remember(db, v, LEDGER, { subject: 'SynthClock', predicate: 'p', object: 'one', source: 'd1' });
    expect(factsFor(db, 'SynthClock')).toHaveLength(1);

    // Phase 2: the clock corrects back (NTP-style). A new write is now
    // out-of-order relative to the future-dated current fact.
    vi.setSystemTime(new Date(realNow));
    const ledgerBefore = fs.readFileSync(path.join(v, LEDGER), 'utf-8');
    await expect(remember(db, v, LEDGER, { subject: 'SynthClock', predicate: 'p', object: 'two', source: 'd1' }))
      .rejects.toThrow(/out-of-order|older than|precedes/i);

    // The rejected write must leave the canonical ledger byte-identical —
    // never poison every future replay with a self-rejected event.
    expect(fs.readFileSync(path.join(v, LEDGER), 'utf-8')).toBe(ledgerBefore);

    // Phase 3: a fresh replay of the intact ledger succeeds.
    const db2 = freshDb(path.join(v, 'rebuild.db'));
    await expect(replayLedger(db2, v, LEDGER)).resolves.toBe(1);
    const history2 = factsFor(db2, 'SynthClock', { includeHistory: true }) as any[];
    expect(history2).toHaveLength(1);
    expect(history2[0].object_text).toBe('one');
    // The fact's valid_from is the (future) write time. An explicit point-in-time
    // read at real-now is still honest (the fact is not yet valid then), but the
    // DEFAULT read judges a lifecycle fact by open rows — the same rule the write
    // path uses (streamCurrentFacts) — so a backward clock step cannot hide a value
    // the user already gave. The K11 contract this test names is the write refusal
    // above (and the byte-identical ledger), which is unchanged.
    expect(factsFor(db2, 'SynthClock', { asOf: new Date(realNow + 365 * 24 * 3600 * 1000).toISOString() })).toHaveLength(1);
    expect(factsFor(db2, 'SynthClock', { asOf: new Date(realNow).toISOString() })).toHaveLength(0);
    expect(factsFor(db2, 'SynthClock')).toHaveLength(1);
    db2.close();
    db.close();
  });

  it('normal writes still publish and supersede after the pre-publish check', async () => {
    const v = mkvault('gate1a-d1ok-');
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: 'SynthClock', predicate: 'p', object: 'one', source: 'd1' });
    const receipt = await remember(db, v, LEDGER, { subject: 'SynthClock', predicate: 'p', object: 'two', source: 'd1' });
    expect(receipt.action).toBe('supersede');
    expect(factsFor(db, 'SynthClock', { includeHistory: true })).toHaveLength(2);
    db.close();
  });
});

describe('K10/A3.1: missing-ledger guard covers pre-digest legacy projections', () => {
  function seedLegacyNoDigest(v: string, withWriteEvent = false): Database.Database {
    const db = freshDb(path.join(v, 'index.db'));
    const at = '2026-01-01T00:00:00.000Z';
    const e = ensureLifecycleEntity(db, 'SynthOrphan', at);
    insertFact(db, e, { predicate: 'p', object: 'orphaned-value', at, evId: 'MEM_ORPHAN1' });
    if (withWriteEvent) {
      db.prepare(`INSERT INTO write_events (note_path, action, summary, created_at) VALUES ('_memory_ledger_', 'store', 's', ?)`).run(at);
    }
    return db; // applied_ledger_events intentionally empty (base-v5 shape, digest backfill never ran)
  }

  it('d2: ENOENT with an event_id-backed fact and empty digest table fails closed', async () => {
    const v = mkvault('gate1a-d2-');
    const db = seedLegacyNoDigest(v);
    expect((db.prepare('SELECT COUNT(*) c FROM applied_ledger_events').get() as any).c).toBe(0);
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/missing.*projected|projected/i);
    db.close();
  });

  it('write_events ledger evidence alone also blocks the silent-empty path', async () => {
    const v = mkvault('gate1a-d2we-');
    const db = seedLegacyNoDigest(v, true);
    db.prepare(`DELETE FROM facts WHERE event_id IS NOT NULL`).run(); // facts pruned, write_events remain
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/missing.*projected|projected/i);
    db.close();
  });

  it('genuinely empty new vault still replays zero and starts cleanly (no regression of the A3 policy)', async () => {
    const v = mkvault('gate1a-d2empty-');
    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    db.close();
  });

  it('real CLI: legacy pre-digest state with a missing ledger blocks startup before any destructive work', async () => {
    const v = mkvault('gate1a-d2cli-'); // no ledger was ever written to this vault
    const db = seedLegacyNoDigest(v); // pre-seed the CLI's DB_PATH with the legacy state
    db.close();

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['OPENAI_API_KEY', 'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS', 'LLM_EXTRACTION', 'MEMORY_LEDGER', 'DB_PATH', 'VAULT_PATH']) delete env[k];
    env.VAULT_PATH = v;
    env.DB_PATH = path.join(v, '.semantic-memory', 'index.db');
    env.EMBEDDING_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'sk-test-dummy-key-not-real';

    // Move the pre-seeded DB to the CLI's expected path first.
    fs.mkdirSync(path.join(v, '.semantic-memory'), { recursive: true });
    fs.copyFileSync(path.join(v, 'index.db'), env.DB_PATH);

    const res = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(path.join(path.resolve(__dirname, '..', '..'), 'node_modules', '.bin', 'tsx'),
        ['src/cli.ts', 'rebuild'], { cwd: path.resolve(__dirname, '..', '..'), env, timeout: 90_000 },
        (err: any, _out: string, stderr: string) => resolve({
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stderr: String(stderr),
        }));
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/missing.*projected|ledger/i);
    // The legacy canonical projection was NOT wiped by the rebuild's clear step:
    // readiness failed before any destructive work.
    const db2 = openDb(env.DB_PATH as string);
    expect((db2.prepare(`SELECT COUNT(*) c FROM facts WHERE event_id = 'MEM_ORPHAN1'`).get() as any).c).toBe(1);
    db2.close();
  }, 120_000);
});