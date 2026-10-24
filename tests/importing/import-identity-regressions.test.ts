import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { hashContent } from '../../src/indexer/hasher';
import { appendLedgerEvent, replayLedger } from '../../src/memory/lifecycle';
import { readRenorIndexSource } from '../../src/importing/source';
import { buildImportPlan, streamKey } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';
import { readExistingStreams } from '../../src/importing/existing';

/**
 * Import/lifecycle subject-identity regressions (scout finding F1).
 *
 * All data is SYNTHETIC. The bug: the planner decided "the destination already
 * represents this stream" with `subject.toLowerCase()` and `predicate.toLowerCase()`,
 * while the lifecycle decides it with `identityNames(subject)` (explicit aliases) plus
 * an exact predicate. Two rules for one question:
 *   - an ALIASED subject was never recognized as represented, so an older carried value
 *     failed the whole import at replay, and a newer one silently superseded the
 *     destination's owner-stated value;
 *   - a predicate that differed only in CASE was collapsed by the planner even though
 *     the lifecycle holds both, so a real stream was dropped and counted as a skip.
 *
 * The repair routes the planner through the same single identity primitive the
 * lifecycle now uses, and keeps the predicate exact. Emitted bytes, event ids and
 * replay are untouched, so a pre-fix ledger still re-runs as a no-op.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function mkdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

interface SyntheticNote {
  rel: string;
  title: string;
  content: string;
  chunks: Array<{ headingPath: string; text: string; startLine: number; endLine: number; tokenCount: number }>;
}

const NOTE: SyntheticNote = {
  rel: 'Projects/Alpha/plan.md',
  title: 'Alpha plan',
  content: '# Alpha plan\n\nShip the first slice.\n',
  chunks: [{ headingPath: 'Alpha plan', text: '# Alpha plan\n\nShip the first slice.', startLine: 0, endLine: 3, tokenCount: 7 }],
};

/** A synthetic source workspace: content tree + an index over it. */
function buildSyntheticSource() {
  const root = mkdir('import-identity-source-');
  const contentRoot = path.join(root, 'content');
  const dbPath = path.join(root, 'store', '.memory-index', 'index.db');
  const db = openDb(dbPath);
  runMigrations(db);
  const absolute = path.join(contentRoot, NOTE.rel);
  write(absolute, NOTE.content);
  db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES (?, ?, NULL, ?, ?, '{}')`,
  ).run(absolute, NOTE.title, hashContent(NOTE.content), '2026-01-02T03:04:05.000Z');
  for (const chunk of NOTE.chunks) {
    db.prepare(
      `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(absolute, chunk.headingPath, chunk.text, chunk.startLine, chunk.endLine, chunk.tokenCount, hashContent(chunk.text));
  }
  // The lifecycle sentinel owns lifecycle entities, exactly as the engine's own
  // `resolveLifecycleEntity` does. It is never importable as a document.
  db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'lifecycle', 'system', 'synthetic', '2026-01-01T00:00:00.000Z', '{}')`,
  ).run();
  db.close();
  return { contentRoot, dbPath, sourceRoot: contentRoot };
}

/** A current lifecycle fact in the SOURCE index, the way `renor-index` holds one. */
function insertFact(
  dbPath: string,
  fact: { subject: string; predicate: string; object: string; validFrom: string; scope?: string },
): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('_mcp_', 'lifecycle', 'system', 'synthetic', '2026-01-01T00:00:00.000Z', '{}')`,
    ).run();
    const found = db.prepare('SELECT id FROM entities WHERE canonical_name = ? LIMIT 1').get(fact.subject) as { id: number } | undefined;
    const entityId = found
      ? found.id
      : Number(db.prepare(
          `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
           VALUES ('concept', ?, '[]', '_mcp_', 1, '2026-01-01T00:00:00.000Z')`,
        ).run(fact.subject).lastInsertRowid);
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, scope)
       VALUES (?, ?, ?, '_mcp_', 1, ?, NULL, ?, ?)`,
    ).run(entityId, fact.predicate, fact.object, fact.validFrom, fact.validFrom, fact.scope ?? 'global');
  } finally {
    db.close();
  }
}

/**
 * A synthetic destination workspace, seeded the way the engine itself writes: a ledger
 * event projected by replay, never a bare `facts` row.
 */
async function buildDestination(seeds: Array<{ subject: string; predicate: string; object: string; validFrom: string; scope?: string }> = []) {
  const memoryDir = mkdir('import-identity-dest-');
  const dbPath = path.join(memoryDir, '.memory-index', 'index.db');
  const db = openDb(dbPath);
  runMigrations(db);
  db.close();
  for (const [index, seed] of seeds.entries()) {
    await appendLedgerEvent(memoryDir, LEDGER, {
      id: `mem_seed${String(index).padStart(6, '0')}`,
      at: seed.validFrom,
      kind: 'store',
      subject: seed.subject,
      predicate: seed.predicate,
      object: seed.object,
      closedEvent: null,
      source: 'fixture',
      scope: seed.scope ?? 'global',
    });
  }
  if (seeds.length > 0) {
    const replayDb = openDb(dbPath);
    try {
      await replayLedger(replayDb, memoryDir, LEDGER);
    } finally {
      replayDb.close();
    }
  }
  return { memoryDir, dbPath };
}

/** Reads the destination the way the CLI does, through the production helper. */
function existingStreamsAt(dbPath: string, memoryDir: string): Set<string> {
  return readExistingStreams(dbPath, path.join(memoryDir, ...LEDGER.split('/')));
}

function lifecycleEntities(dbPath: string): Array<{ id: number; canonical_name: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT id, canonical_name FROM entities WHERE source_note = '_mcp_' ORDER BY id`).all() as Array<{ id: number; canonical_name: string }>;
  } finally {
    db.close();
  }
}

function currentLifecycleFacts(dbPath: string): Array<{ subject: string; predicate: string; object: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(
      `SELECT e.canonical_name AS subject, f.predicate, f.object_text AS object
         FROM facts f JOIN entities e ON e.id = f.subject_entity_id
        WHERE f.valid_to IS NULL AND f.source_path = '_mcp_'
        ORDER BY f.predicate`,
    ).all() as Array<{ subject: string; predicate: string; object: string }>;
  } finally {
    db.close();
  }
}

function planFor(
  source: { dbPath: string; sourceRoot: string; contentRoot: string },
  destination: { dbPath: string; memoryDir: string },
) {
  const bundle = readRenorIndexSource({ dbPath: source.dbPath, sourceRoot: source.sourceRoot, contentRoot: source.contentRoot, include: [], exclude: [] });
  const plan = buildImportPlan(bundle, {
    namespace: 'Imported/src',
    label: 'src',
    eventSource: 'import:src',
    existingStreams: existingStreamsAt(destination.dbPath, destination.memoryDir),
  });
  return { bundle, plan };
}

describe('importer stream identity is the lifecycle identity rule', () => {
  it('unifies explicit aliases and case/normalization form, and keeps the predicate exact', () => {
    // Alias equivalence: one identity for the importer and the lifecycle (the F1 divergence).
    expect(streamKey('Rowan', 'dog_name', 'global')).toBe(streamKey('Rowan Vale', 'dog_name', 'global'));
    expect(streamKey('Rowan Vale Holm', 'dog_name', 'global')).toBe(streamKey('ROWAN VALE', 'dog_name', 'global'));
    // Predicate case is a different stream: the lifecycle's predicate match is exact.
    expect(streamKey('Renor', 'Primary Goal', 'global')).not.toBe(streamKey('Renor', 'primary goal', 'global'));
    // Case and Unicode normalization form close.
    expect(streamKey('José', 'x', 'global')).toBe(streamKey('JOSÉ', 'x', 'global'));
    expect(streamKey('José', 'x', 'global')).toBe(streamKey('José'.normalize('NFD'), 'x', 'global'));
    expect(streamKey('Пётр', 'x', 'global')).toBe(streamKey('пётр', 'x', 'global'));
    expect(streamKey('Αθήνα', 'x', 'global')).toBe(streamKey('ΑΘΉΝΑ', 'x', 'global'));
    // Distinct names stay distinct: accents, tonos, ё/е, ß/ss, scripts, empty-fold inputs.
    expect(streamKey('José', 'x', 'global')).not.toBe(streamKey('Jose', 'x', 'global'));
    expect(streamKey('Αθήνα', 'x', 'global')).not.toBe(streamKey('Αθηνα', 'x', 'global'));
    expect(streamKey('Пётр', 'x', 'global')).not.toBe(streamKey('Петр', 'x', 'global'));
    expect(streamKey('Straße', 'x', 'global')).not.toBe(streamKey('STRASSE', 'x', 'global'));
    expect(streamKey('İstanbul', 'x', 'global')).not.toBe(streamKey('Istanbul', 'x', 'global'));
    expect(streamKey('東京', 'x', 'global')).not.toBe(streamKey('大阪', 'x', 'global'));
    expect(streamKey('🙂', 'x', 'global')).not.toBe(streamKey('🎉', 'x', 'global'));
    expect(streamKey('!!!', 'x', 'global')).not.toBe(streamKey('???', 'x', 'global'));
    // Scope keying is unchanged: a project stream never merges with the global one.
    expect(streamKey('Renor', 'goal', 'project:x')).not.toBe(streamKey('Renor', 'goal', 'global'));
  });

  it('keys a named scope by its slug: scope:x, project:x and x are one stream, as the lifecycle holds them', () => {
    expect(streamKey('Renor', 'goal', 'project:x')).toBe(streamKey('Renor', 'goal', 'scope:x'));
    expect(streamKey('Renor', 'goal', 'project:x')).toBe(streamKey('Renor', 'goal', ' X '));
    // Another slug and global stay other streams.
    expect(streamKey('Renor', 'goal', 'project:x')).not.toBe(streamKey('Renor', 'goal', 'project:y'));
    expect(streamKey('Renor', 'goal', 'scope:x')).not.toBe(streamKey('Renor', 'goal', 'global'));
  });
});

describe('importing a stream the destination holds under another spelling of its scope', () => {
  it('skips it instead of carrying a second current value into the scope', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'goal', object: 'imported value', validFrom: '2026-01-05T00:00:00.000Z', scope: 'project:atlas' });
    const destination = await buildDestination([
      { subject: 'Renor', predicate: 'goal', object: 'owner value', validFrom: '2026-01-09T00:00:00.000Z', scope: 'scope:atlas' },
    ]);

    const { bundle, plan } = planFor(source, destination);
    // Keyed by spelling, the importer carried the fact, and the scope then held two current values: a conflict.
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped.events.some(s => /already represents/.test(s.reason))).toBe(true);
    await applyImportPlan(plan, bundle, destination);
    expect(currentLifecycleFacts(destination.dbPath)).toEqual([
      { subject: 'Renor', predicate: 'goal', object: 'owner value' },
    ]);
  });
});

describe('importing an aliased or normalization-variant stream the destination holds', () => {
  it('skips an OLDER aliased value instead of carrying it into a rejected import', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'Rowan Vale', predicate: 'dog_name', object: 'Rex', validFrom: '2026-01-01T00:00:00.000Z' });
    const destination = await buildDestination([
      { subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit', validFrom: '2026-01-09T00:00:00.000Z' },
    ]);

    const { bundle, plan } = planFor(source, destination);
    // Before the fix this carried one event, and the whole import was refused at replay
    // because the carried value predates the destination's current fact.
    expect(plan.events).toHaveLength(0);
    expect(plan.skipped.events.some(s => /already represents/.test(s.reason))).toBe(true);

    await expect(applyImportPlan(plan, bundle, destination)).resolves.toBeTruthy();
    expect(currentLifecycleFacts(destination.dbPath)).toEqual([
      { subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit' },
    ]);
    expect(lifecycleEntities(destination.dbPath)).toHaveLength(1);
  });

  it('cannot silently supersede the owner-stated value with a NEWER aliased value', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'Rowan Vale', predicate: 'dog_name', object: 'Rex', validFrom: '2026-01-20T00:00:00.000Z' });
    const destination = await buildDestination([
      { subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit', validFrom: '2026-01-09T00:00:00.000Z' },
    ]);

    const { bundle, plan } = planFor(source, destination);
    // Before the fix this carried one event and replay closed Biscuit: the destination's
    // own value was replaced by the import's.
    expect(plan.events).toHaveLength(0);
    await applyImportPlan(plan, bundle, destination);
    expect(currentLifecycleFacts(destination.dbPath)).toEqual([
      { subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit' },
    ]);
  });

  it('skips an NFC/NFD variant of a stream the destination holds', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'José'.normalize('NFD'), predicate: 'lives_in', object: 'São Paulo', validFrom: '2026-01-01T00:00:00.000Z' });
    const destination = await buildDestination([
      { subject: 'José', predicate: 'lives_in', object: 'Recife', validFrom: '2026-01-09T00:00:00.000Z' },
    ]);

    const { bundle, plan } = planFor(source, destination);
    expect(plan.events).toHaveLength(0);
    await applyImportPlan(plan, bundle, destination);
    expect(currentLifecycleFacts(destination.dbPath)).toEqual([
      { subject: 'José', predicate: 'lives_in', object: 'Recife' },
    ]);
  });

  it('carries an accent-distinct name as its own stream', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'Jose', predicate: 'lives_in', object: 'Madrid', validFrom: '2026-01-05T00:00:00.000Z' });
    const destination = await buildDestination([
      { subject: 'José', predicate: 'lives_in', object: 'Recife', validFrom: '2026-01-09T00:00:00.000Z' },
    ]);

    const { bundle, plan } = planFor(source, destination);
    expect(plan.events.map(e => e.subject)).toEqual(['Jose']);
    const result = await applyImportPlan(plan, bundle, destination);
    expect(result.eventsAppended).toBe(1);
    expect(currentLifecycleFacts(destination.dbPath)).toHaveLength(2);
  });

  it('carries a predicate-case variant: the lifecycle holds it as a distinct stream', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'primary goal', object: 'exact case', validFrom: '2026-01-05T00:00:00.000Z' });
    const destination = await buildDestination([
      { subject: 'Renor', predicate: 'Primary Goal', object: 'durable memory', validFrom: '2026-01-09T00:00:00.000Z' },
    ]);

    const { bundle, plan } = planFor(source, destination);
    // Before the fix the planner lowercased the predicate, saw the stream as already
    // represented, and silently dropped the source's fact.
    expect(plan.events.map(e => e.predicate)).toEqual(['primary goal']);
    await applyImportPlan(plan, bundle, destination);
    expect(currentLifecycleFacts(destination.dbPath)).toEqual([
      { subject: 'Renor', predicate: 'Primary Goal', object: 'durable memory' },
      { subject: 'Renor', predicate: 'primary goal', object: 'exact case' },
    ]);
  });

  it('treats a legacy-split destination as represented instead of importing a third identity', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'José'.normalize('NFD'), predicate: 'lives_in', object: 'Niterói', validFrom: '2026-01-01T00:00:00.000Z' });
    // A pre-fix destination: two spellings of one person, each with its own current value.
    const destination = await buildDestination();
    insertFact(destination.dbPath, { subject: 'José', predicate: 'lives_in', object: 'Recife', validFrom: '2026-01-02T00:00:00.000Z' });
    insertFact(destination.dbPath, { subject: 'JOSÉ', predicate: 'lives_in', object: 'São Paulo', validFrom: '2026-01-03T00:00:00.000Z' });

    const { bundle, plan } = planFor(source, destination);
    expect(plan.events).toHaveLength(0);
    await expect(applyImportPlan(plan, bundle, destination)).resolves.toBeTruthy();
    expect(lifecycleEntities(destination.dbPath).map(e => e.canonical_name)).toEqual(['José', 'JOSÉ']);
  });

  it('stays idempotent: a second apply appends no event and leaves the ledger untouched', async () => {
    const source = buildSyntheticSource();
    insertFact(source.dbPath, { subject: 'Rowan Vale', predicate: 'dog_name', object: 'Rex', validFrom: '2026-01-01T00:00:00.000Z' });
    insertFact(source.dbPath, { subject: 'Renor', predicate: 'mission', object: 'durable memory', validFrom: '2026-01-04T00:00:00.000Z' });
    const destination = await buildDestination([
      { subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit', validFrom: '2026-01-09T00:00:00.000Z' },
    ]);

    const first = planFor(source, destination);
    expect(first.plan.events.map(e => e.subject)).toEqual(['Renor']);
    const applied = await applyImportPlan(first.plan, first.bundle, destination);
    expect(applied.eventsAppended).toBe(1);
    const ledgerPath = path.join(destination.memoryDir, ...LEDGER.split('/'));
    const ledgerAfterFirst = fs.readFileSync(ledgerPath, 'utf8');

    const second = planFor(source, destination);
    expect(second.plan.events).toHaveLength(0);
    const again = await applyImportPlan(second.plan, second.bundle, destination);
    expect(again.eventsAppended).toBe(0);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(ledgerAfterFirst);
    expect(currentLifecycleFacts(destination.dbPath)).toHaveLength(2);
  });
});
