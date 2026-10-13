import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { buildAgentContext, replyTokens } from '../../src/mvp/agentMemory';
import type { Engine } from '../../src/mvp/engine';
import { namedConflicts } from '../../src/memory/factConflicts';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { seedFacts } from '../helpers/seedFacts';
import { traceStatements } from '../helpers/traceStatements';
import { indexVault } from '../../src/indexer/pipeline';
import { retireMemory, restoreMemory } from '../../src/memorymap/memoryMap';
import { buildImportPlan } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';
import { BUNDLE_FORMAT, type ImportBundle } from '../../src/importing/types';

const cleanups: Array<() => void> = [];
const engine: Engine = { provider: null, vectorIndex: null, dims: null };
const candidateSql = 'SELECT f.id, e.canonical_name';
const scans = (plans: Array<{ sql: string }>) => plans.filter(p => p.sql.includes(candidateSql)).length;

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-free-context-'));
  const file = path.join(dir, '.memory-index/index.db');
  const db = openDb(file);
  runMigrations(db);
  cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ask = (maxTokens = 4000, scope?: string, query?: string) => buildAgentContext(db, engine, dir, {
    maxTokens, scope, query, env: { RENOR_READ_HONESTY: '0', RENOR_CONTEXT_RELEVANCE: '0' },
  });
  const put = (subject: string, object: string) => remember(db, dir, DEFAULT_LEDGER_REL, {
    subject, predicate: 'owner', object,
  });
  return { dir, file, db, ask, put };
}

it('adds no guard queries to an empty workspace', async () => {
  const w = workspace();
  const { result, plans } = traceStatements(w.db, () => w.ask());
  expect((await result).facts).toEqual([]);
  expect(scans(plans)).toBe(0);
  expect(plans.some(p => p.sql.includes('total_changes()'))).toBe(false);
});

it('scans the full conflict-free candidate set once even when the budget cuts it', async () => {
  const w = workspace();
  seedFacts(w.db, 1000, i => ({ subject: `Project ${i}`, predicate: 'owner', object: 'Ready' }));
  for (const budget of [128, 800, 4000]) {
    const { result, plans } = traceStatements(w.db, () => w.ask(budget));
    const body = await result;
    expect(scans(plans)).toBe(1); // Original scans again for the kept facts.
    expect(body.conflicts).toBeUndefined();
    expect(replyTokens(JSON.stringify(body))).toBeLessThanOrEqual(budget);
  }
});

it('keeps every conflict, including transitive names, Unicode identities and scope spellings', async () => {
  const w = workspace();
  const facts = [
    { subject: 'Atlas', object: 'One', scope: 'global' },
    { subject: 'Atlas project', object: 'Two', scope: 'global' },
    { subject: 'Atlas project team', object: 'Three', scope: 'global' },
    { subject: 'Café', object: 'Four', scope: 'project:one' },
    { subject: 'CAFE\u0301', object: 'Five', scope: 'scope:two' },
    { subject: 'Atlas', object: 'Six', scope: 'scope:one' },
  ];
  seedFacts(w.db, facts.length, i => ({ ...facts[i], predicate: 'owner' }));
  for (const scope of [undefined, 'global', 'project:one', 'scope:one', 'project:two']) {
    for (const budget of [128, 512, 4000]) {
      const body = await w.ask(budget, scope);
      const expected = namedConflicts(w.db, body.facts as Array<{ subject: string; predicate: string }>, scope ?? null);
      expect(body.conflicts ?? []).toEqual(expected);
      expect(replyTokens(JSON.stringify(body))).toBeLessThanOrEqual(budget);
    }
  }
  expect((await w.ask()).conflicts).toBeDefined();
});

function writeDuringFirstScan(w: ReturnType<typeof workspace>, write: () => void) {
  const proto = Object.getPrototypeOf(w.db.prepare('SELECT 1'));
  const original = proto.all;
  let fired = false;
  vi.spyOn(proto, 'all').mockImplementation(function (this: { source: string }, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (!fired && this.source.includes(candidateSql)) {
      fired = true;
      write(); // Old scan returned; the next assembly must see the newly committed data.
    }
    return result;
  });
}

it.each(['same', 'other'] as const)('invalidates an empty proof after the %s connection commits during assembly', async which => {
  const w = workspace();
  seedFacts(w.db, 1, () => ({ subject: 'Atlas', predicate: 'owner', object: 'One' }));
  const writer = which === 'same' ? w.db : openDb(w.file);
  try {
    writeDuringFirstScan(w, () => seedFacts(writer, 1, () => ({ subject: 'Atlas project', predicate: 'owner', object: 'Two' })));
    const body = await w.ask();
    expect(body.conflicts).toEqual(namedConflicts(w.db, body.facts as Array<{ subject: string; predicate: string }>, null));
    expect(body.conflicts).toBeDefined();
  } finally {
    vi.restoreAllMocks();
    if (writer !== w.db) writer.close();
  }
});

it('does not reuse an empty proof inside a transaction, including one that rolls back', async () => {
  const w = workspace();
  seedFacts(w.db, 1, () => ({ subject: 'Atlas', predicate: 'owner', object: 'One' }));
  w.db.exec('BEGIN');
  try {
    const { result, plans } = traceStatements(w.db, () => w.ask());
    expect((await result).conflicts).toBeUndefined();
    expect(scans(plans)).toBe(2);
    seedFacts(w.db, 1, () => ({ subject: 'Atlas project', predicate: 'owner', object: 'Two' }));
    expect((await w.ask()).conflicts).toBeDefined();
  } finally { w.db.exec('ROLLBACK'); }
  expect((await w.ask()).conflicts).toBeUndefined();
});

it('starts a fresh proof after a write and a real import between calls', async () => {
  const w = workspace();
  await w.put('Atlas', 'One');
  expect((await w.ask()).conflicts).toBeUndefined();
  await w.put('Atlas project', 'Two');
  expect((await w.ask()).conflicts).toBeDefined();
  await w.put('Atlas project', 'One');
  expect((await w.ask()).conflicts).toBeUndefined();
  const bundle: ImportBundle = {
    format: BUNDLE_FORMAT, sourceLabel: 'Synthetic conflict import', notes: [],
    facts: [{ subject: 'Atlas project team', predicate: 'owner', object: 'Three', scope: 'global',
      validFrom: '2099-01-01T00:00:00.000Z', sourcePath: 'Synthetic.md', origin: 'note' }],
    stats: { notesAvailable: 0, notesSelected: 0, notesFilteredOut: 0, notesWithOriginalBytes: 0,
      chunksSelected: 0, factsAvailable: 1, factsSelected: 1 },
  };
  await applyImportPlan(buildImportPlan(bundle, { namespace: 'Imported/check', label: 'check', eventSource: 'import:check' }),
    bundle, { memoryDir: w.dir, dbPath: w.file });
  const body = await w.ask();
  expect(body.conflicts).toEqual(namedConflicts(w.db, body.facts as Array<{ subject: string; predicate: string }>, null));
  expect(body.conflicts).toBeDefined();
});

it('rescans after actual note retirement and restoration between calls', async () => {
  const w = workspace();
  await w.put('Atlas', 'One');
  fs.writeFileSync(path.join(w.dir, 'Checklist.md'), '# Checklist\n\nUniquequokka verification plan.\n');
  await indexVault(w.db, w.dir, {});
  const ctx = { db: w.db, memoryDir: w.dir, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
  const read = async () => {
    const { result, plans } = traceStatements(w.db, () => w.ask());
    expect((await result).conflicts).toBeUndefined();
    expect(scans(plans)).toBe(1);
  };
  await read();
  expect((await w.ask(4000, undefined, 'Uniquequokka')).memories).not.toEqual([]);
  await retireMemory(ctx, 'note:Checklist.md');
  await read();
  expect((await w.ask(4000, undefined, 'Uniquequokka')).memories).toEqual([]);
  await restoreMemory(ctx, 'note:Checklist.md');
  await read();
  expect((await w.ask(4000, undefined, 'Uniquequokka')).memories).not.toEqual([]);
});
