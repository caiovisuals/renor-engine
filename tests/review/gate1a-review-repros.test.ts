import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import { remember, replayLedger, factsFor, appendLedgerEvent } from '../../src/memory/lifecycle';
import type Database from '../../src/db/sqlite';

/**
 * Gate1A repair-pass regressions, adapted with provenance from the reviewer
 * repro scripts (imports/assertions adapted only; no invariant weakened):
 *  - Astra probe  A1/A2/A3: gate1a-astra-probe.cjs (3 invariant violations at 61d4d0f)
 *  - Kimi K3/K1/K2/K5: gate1a-review a12a859 docs/build-1/review-repros/
 *    r1-extraction-single-current.cjs, r2-legacy-note-entity-b5.cjs,
 *    r4-legacy-loss-to-rebuild-brick.cjs, r3-eisdir-replay.cjs,
 *    r5-crlf-ledger.cjs
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

function writeLedger(v: string, blocks: string[]): string {
  const p = path.join(v, LEDGER);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    '---', 'type: memory-ledger', '---', '', '# Memory Events Ledger', '',
    ...blocks,
  ].join('\n'));
  return p;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('A1/K3: single-current-value scoped to lifecycle facts only', () => {
  it('R1: two same-predicate extracted facts for one entity are both retained', async () => {
    const v = mkvault('gate1a-r1-');
    const db = freshDb(path.join(v, 'index.db'));
    const notePath = path.join(v, 'SynthPerson.md');
    fs.writeFileSync(notePath, '# SynthPerson\n\nBody text.\n');
    const extractor = async () => ([
      { subject: 'SynthPerson', predicate: 'works_at', object: 'SynthCorp', confidence: 0.9 },
      { subject: 'SynthPerson', predicate: 'works_at', object: 'SynthCorp Labs', confidence: 0.8 },
    ]);
    await indexFile(db, notePath, { factExtractor: extractor });
    const worksAt = db.prepare(`SELECT object_text FROM facts WHERE predicate = 'works_at' ORDER BY id`).all() as any[];
    expect(worksAt).toHaveLength(2); // base retained both; candidate must not silently discard
    db.close();
  });

  it('Astra probe: distinct-subject same-predicate extracted facts are both retained', async () => {
    const v = mkvault('gate1a-astra1-');
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'Team.md');
    fs.writeFileSync(note, '# Team\nSynthetic team members.\n');
    await indexFile(db, note, { factExtractor: async () => [
      { subject: 'SyntheticAlice', predicate: 'works_at', object: 'ExampleOne', confidence: 0.8 },
      { subject: 'SyntheticBob', predicate: 'works_at', object: 'ExampleTwo', confidence: 0.8 },
    ] });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM facts WHERE source_path=?').get(note) as any).n;
    expect(count).toBe(2); // old-uniqueness control also retained 2 (index-rule regression, not extractor behavior)
    db.close();
  });

  it('upgrade migration: lifecycle duplicates repaired, extracted duplicates preserved, index scoped', async () => {
    const v = mkvault('gate1a-a1mig-');
    const db = freshDb(path.join(v, 'index.db'));
    // Rewind to pre-fix v5 schema.
    db.prepare('DROP INDEX IF EXISTS idx_facts_current').run();
    db.exec('DROP TABLE IF EXISTS applied_ledger_events');
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (5)').run();

    // Note + note-derived entity (like indexFile) holding BOTH extracted
    // duplicate currents AND legacy lifecycle duplicate currents.
    const notePath = path.join(v, 'Note.md');
    fs.writeFileSync(notePath, '# Note\n');
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES (?, 'Note', 'note', 'h', '2026-01-01T00:00:00.000Z', '{}')`).run(notePath);
    const noteEntity = (db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', 'Note', '[]', ?, 1.0, '2026-01-01T00:00:00.000Z') RETURNING id`
    ).get(notePath) as any).id;
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-01-01T00:00:00.000Z', '{}')`
    ).run();
    const lifecycleEntity = (db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'SynthLife', '[]', '_mcp_', 1.0, '2026-01-01T00:00:00.000Z') RETURNING id`
    ).get() as any).id;

    const ins = db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id) VALUES (?, ?, ?, ?, 1.0, ?, NULL, ?, ?)`
    );
    // Two legitimate extracted current facts, same (entity, predicate), distinct subjects in object data.
    ins.run(noteEntity, 'works_at', 'ExtractedOne', notePath, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', null);
    ins.run(noteEntity, 'works_at', 'ExtractedTwo', notePath, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', null);
    // Two legacy lifecycle duplicate currents (B2-race shape, source_path='_mcp_').
    ins.run(lifecycleEntity, 'wants', 'X1', '_mcp_', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', 'MEM_M1');
    ins.run(lifecycleEntity, 'wants', 'X2', '_mcp_', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', 'MEM_M2');

    expect(() => runMigrations(db)).not.toThrow();

    // Lifecycle duplicates: deterministic keep-newest repair.
    const openLife = db.prepare(
      `SELECT object_text FROM facts WHERE subject_entity_id = ? AND predicate = 'wants' AND valid_to IS NULL`
    ).all(lifecycleEntity) as any[];
    expect(openLife).toHaveLength(1);
    expect(openLife[0].object_text).toBe('X2');
    // Extracted duplicates: BOTH retained, untouched by the repair.
    const openExt = db.prepare(
      `SELECT object_text FROM facts WHERE subject_entity_id = ? AND predicate = 'works_at' AND valid_to IS NULL`
    ).all(noteEntity) as any[];
    expect(openExt.map(r => r.object_text).sort()).toEqual(['ExtractedOne', 'ExtractedTwo']);

    // The single-current invariant is enforced ONLY on lifecycle rows.
    expect(() => db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'wants', 'X3', '_mcp_', 1.0, '2026-01-02T00:00:00.000Z', NULL, '2026-01-02T00:00:00.000Z')`
    ).run(lifecycleEntity)).toThrow(/UNIQUE/);
    expect(() => db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at) VALUES (?, 'works_at', 'ExtractedThree', ?, 1.0, '2026-01-02T00:00:00.000Z', NULL, '2026-01-02T00:00:00.000Z')`
    ).run(noteEntity, notePath)).not.toThrow();
    db.close();
  });
});

describe('A2/K1: legacy canonical facts re-homed to stable lifecycle ownership', () => {
  // The legacy shape: a ledger-backed fact (event_id, source_path='_mcp_')
  // attached to a NOTE-derived entity — what the base engine produced when
  // its generic lookupEntity resolved the subject to a same-named note.
  function seedLegacyState(v: string, db: Database.Database, subject: string, evId: string, at: string) {
    const notePath = path.join(v, `${subject}.md`);
    fs.writeFileSync(notePath, `# ${subject}\n\nOriginal body.\n`);
    return indexFile(db, notePath).then(() => {
      const noteEntity = db.prepare(`SELECT id FROM entities WHERE source_note = ?`).get(notePath) as any;
      db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id)
         VALUES (?, 'lives_in', 'Synthville', '_mcp_', 1.0, ?, NULL, ?, ?)`
      ).run(noteEntity.id, at, at, evId);
      return appendLedgerEvent(v, LEDGER, { id: evId, at, kind: 'store', subject, predicate: 'lives_in', object: 'Synthville', closedEvent: null, source: 'synthetic' });
    });
  }

  it('R2/Astra-A2: replay re-homes the legacy fact; it survives note reindex', async () => {
    const v = mkvault('gate1a-r2-');
    const db = freshDb(path.join(v, 'index.db'));
    await seedLegacyState(v, db, 'SynthAlice', 'MEM_LEGACY01', '2026-09-09T00:00:00.000Z');

    // Startup replay: must reconcile ownership BEFORE readiness and later writes.
    const replayed = await replayLedger(db, v, LEDGER);
    expect(replayed).toBe(0); // already projected (legacy shortcut) — but now re-homed
    const owner = db.prepare(
      `SELECT e.source_note AS n FROM facts f JOIN entities e ON f.subject_entity_id = e.id WHERE f.event_id = 'MEM_LEGACY01'`
    ).get() as any;
    expect(owner.n).toBe('_mcp_');
    expect(factsFor(db, 'SynthAlice')).toHaveLength(1);

    // Reindex the note: the fact must survive (no cascade loss window).
    fs.writeFileSync(path.join(v, 'SynthAlice.md'), '# SynthAlice\n\nEdited body — triggers reindex.\n');
    await indexFile(db, path.join(v, 'SynthAlice.md'));
    const after = factsFor(db, 'SynthAlice') as any[];
    expect(after).toHaveLength(1);
    expect(after[0].object_text).toBe('Synthville');
    db.close();
  });

  it('R4 full chain: cascade loss -> user-repair store -> full rebuild does not brick', async () => {
    const v = mkvault('gate1a-r4-');
    const db = freshDb(path.join(v, 'live.db'));
    await seedLegacyState(v, db, 'SynthAlice', 'MEM_LEGACY01', '2026-09-09T00:00:00.000Z');

    // R2 trigger WITHOUT an intervening replay (live loss window): the note
    // reindex cascade-deletes the legacy fact while the engine is running.
    fs.writeFileSync(path.join(v, 'SynthAlice.md'), '# SynthAlice\n\nEdited — triggers reindex.\n');
    await indexFile(db, path.join(v, 'SynthAlice.md'));
    expect(factsFor(db, 'SynthAlice')).toHaveLength(0);

    // User "repairs" by remembering the new value. No current fact is visible,
    // so a kind:store event is appended (the base-engine asymmetry).
    const receipt = await remember(db, v, LEDGER, {
      subject: 'SynthAlice', predicate: 'lives_in', object: 'Newtown', source: 'user-repair',
    });
    expect(receipt.action).toBe('store');

    // Full rebuild: wipe derived state exactly like `osm rebuild`, then replay.
    // At 61d4d0f this threw UNIQUE constraint failed (idx_facts_current) and
    // bricked rebuild/startup. The validated store-reconciliation policy must
    // apply the repair store without dropping the legacy event's history.
    db.transaction(() => {
      ['facts', 'relations', 'entities', 'chunks', 'notes', 'applied_ledger_events'].forEach(t =>
        db.prepare(`DELETE FROM ${t}`).run());
    })();
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(2);

    const current = factsFor(db, 'SynthAlice') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Newtown');
    const history = factsFor(db, 'SynthAlice', { includeHistory: true }) as any[];
    expect(history).toHaveLength(2); // both accepted events survive, whole stream preserved
    db.close();
  });

  it('R4 live variant: replay re-home first -> user remember is a supersede with correct history', async () => {
    const v = mkvault('gate1a-r4b-');
    const db = freshDb(path.join(v, 'index.db'));
    await seedLegacyState(v, db, 'SynthAlice', 'MEM_LEGACY01', '2026-09-09T00:00:00.000Z');
    await replayLedger(db, v, LEDGER); // startup re-home

    fs.writeFileSync(path.join(v, 'SynthAlice.md'), '# SynthAlice\n\nEdited.\n');
    await indexFile(db, path.join(v, 'SynthAlice.md')); // reindex no longer loses the fact
    expect(factsFor(db, 'SynthAlice')).toHaveLength(1);

    const receipt = await remember(db, v, LEDGER, {
      subject: 'SynthAlice', predicate: 'lives_in', object: 'Newtown', source: 'user-repair',
    });
    expect(receipt.action).toBe('supersede'); // current visible -> explicit supersede
    expect((receipt.closed as any).object).toBe('Synthville');

    const current = factsFor(db, 'SynthAlice') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Newtown');
    expect(factsFor(db, 'SynthAlice', { includeHistory: true })).toHaveLength(2);
    db.close();
  });

  it('out-of-order store (older than the current it would close) fails loudly, never silently masks corruption', async () => {
    const v = mkvault('gate1a-order-');
    const db = freshDb(path.join(v, 'index.db'));
    writeLedger(v, [
      `## MEM_ORDER1 · 2026-09-09T10:00:00.000Z`,
      `- kind: store`,
      `- subject: SynthOrder`,
      `- predicate: p`,
      `- object: newer`,
      `- source: poc`,
      ``,
      // A store whose event time predates the current fact it would close is
      // arbitrary corrupt ordering — explicit failure, not last-write-wins.
      `## MEM_ORDER2 · 2026-09-09T09:00:00.000Z`,
      `- kind: store`,
      `- subject: SynthOrder`,
      `- predicate: p`,
      `- object: older`,
      `- source: poc`,
      ``,
    ]);
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/out-of-order|older than/i);
    // The newer current fact was not concealed or closed.
    const facts = db.prepare(`SELECT object_text, valid_to FROM facts WHERE event_id = 'MEM_ORDER1'`).all() as any[];
    expect(facts).toHaveLength(1);
    expect(facts[0].valid_to).toBeNull();
    db.close();
  });

  it('legacy B2-race ledger (consecutive stores) reconciles without loss', async () => {
    const v = mkvault('gate1a-b2leg-');
    const db = freshDb(path.join(v, 'index.db'));
    // The base engine's race wrote concurrent kind:store events for the same
    // subject+predicate. Replay must preserve all events and end with exactly
    // one current value.
    const at = '2026-09-09T00:00:00.000Z';
    writeLedger(v, ['X1', 'X2', 'X3'].map((o, i) => [
      `## MEM_B2${i} · ${at}`,
      `- kind: store`,
      `- subject: SynthRaceLegacy`,
      `- predicate: wants`,
      `- object: ${o}`,
      `- source: poc`,
      ``,
    ].join('\n')));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(3);
    const history = factsFor(db, 'SynthRaceLegacy', { includeHistory: true }) as any[];
    expect(history).toHaveLength(3);
    const current = factsFor(db, 'SynthRaceLegacy') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('X3');
    db.close();
  });
});

describe('A3/K2: ledger I/O failures propagate; only ENOENT means empty', () => {
  it('R3: a directory at the ledger path (EISDIR) blocks replay instead of returning 0', async () => {
    const v = mkvault('gate1a-r3-');
    const db = freshDb(path.join(v, 'index.db'));
    fs.mkdirSync(path.join(v, LEDGER), { recursive: true });
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/EISDIR|read failed/i);
    db.close();
  });

  it('ENOENT on a known-new empty vault still replays zero events', async () => {
    const v = mkvault('gate1a-enoent-');
    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    db.close();
  });

  it('ENOENT while canonical events are already projected is not silently an empty vault', async () => {
    const v = mkvault('gate1a-enoent2-');
    const db = freshDb(path.join(v, 'index.db'));
    // Index projects canonical events, but the authoritative ledger file is gone.
    db.prepare(`INSERT INTO applied_ledger_events (event_id, digest, applied_at) VALUES ('MEM_GONE1', 'd', ?)`).run('2026-09-09T00:00:00.000Z');
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/missing.*projected|projected/i);
    db.close();
  });

  it('R5: a hand-edited CRLF ledger replays (line-ending tolerance, values keep no stray \\r)', async () => {
    const v = mkvault('gate1a-r5-');
    const db = freshDb(path.join(v, 'index.db'));
    const p = path.join(v, LEDGER);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      '---', 'type: memory-ledger', '---', '', '# Memory Events Ledger', '',
      '## MEM_CRLF1 · 2026-09-09T00:00:00.000Z',
      '- kind: store', '- subject: SynthCRLF', '- predicate: p', '- object: ok', '- source: poc', '',
    ].join('\r\n'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(1);
    const facts = factsFor(db, 'SynthCRLF') as any[];
    expect(facts).toHaveLength(1);
    expect(facts[0].object_text).toBe('ok'); // no trailing \r smuggled into values
    db.close();
  });
});