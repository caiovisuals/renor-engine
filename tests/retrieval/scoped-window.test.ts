import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex, KNN_MAX_K } from '../../src/embeddings/vectorIndex';
import { semanticSearch, type ChunkScope } from '../../src/retrieval/semantic';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { remember } from '../../src/memory/lifecycle';
import { createReadScope } from '../../src/mvp/readScope';
import { tmpPath } from '../helpers/tmpPath';

/**
 * A read that shows only some chunks (a scoped read: memory scout, finding 7) judges them before every cut of its
 * window, never after: the nearest chunks it shows are found however many chunks it does not show are nearer, and a
 * chunk it does not show never takes the place of one it does. Explicit vectors; the query embeds to [1, 0, 0, 0].
 */

const opened: Array<{ db: Database.Database; file: string }> = [];
afterEach(() => {
  for (const { db, file } of opened.splice(0)) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }
  delete process.env.RENOR_NEWEST_FIRST;
});

let dbCount = 0;
function freshIndex(dims = 4): { db: Database.Database; idx: VectorIndex } {
  const file = tmpPath(`scoped-window-${process.pid}-${dbCount++}.db`);
  const db = openDb(file);
  runMigrations(db);
  opened.push({ db, file });
  const idx = new VectorIndex(db, dims);
  idx.initTable();
  return { db, idx };
}

/** One chunk of its own note (the note row too), with a vector when one is given; returns its row id. */
function addChunk(db: Database.Database, idx: VectorIndex, note: string, text: string, vector?: number[], tokens = 5): number {
  db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2025-01-01T00:00:00.000Z', '{}')").run(note, note);
  const id = Number(db.prepare(
    'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, 0, 1, ?, ?)',
  ).run(note, '', text, tokens, `${note}#${text}`).lastInsertRowid);
  if (vector) idx.upsert(id, vector);
  return id;
}

const provider = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
const NOW = { nowMs: Date.parse('2026-10-03T00:00:00Z') };
const mine = (hit: { notePath: string }) => hit.notePath.startsWith('/v/mine/');
/** The read of `/v/mine/`: which chunks it shows, and their ids. */
const mineScope = (db: Database.Database): ChunkScope => ({
  shows: mine,
  chunkIds: () => db.prepare("SELECT id FROM chunks WHERE note_path LIKE '/v/mine/%'").pluck().all() as number[],
});
/** A read that shows every chunk. */
const everything = (db: Database.Database): ChunkScope => ({
  shows: () => true,
  chunkIds: () => db.prepare('SELECT id FROM chunks').pluck().all() as number[],
});

describe('semanticSearch with a filter finds the nearest chunks it shows', () => {
  it('however many chunks it does not show are nearer, in the order it always used', async () => {
    const { db, idx } = freshIndex();
    db.transaction(() => {
      for (let i = 0; i < 200; i++) addChunk(db, idx, `/v/other/o${i}.md`, `other ${i}`, [1, 0.001 * (i + 1), 0, 0]);
    })();
    addChunk(db, idx, '/v/mine/m0.md', 'mine zero', [0.2, 1, 0, 0]);
    addChunk(db, idx, '/v/mine/m1.md', 'mine one', [0.3, 1, 0, 0]);
    addChunk(db, idx, '/v/mine/m2.md', 'mine two', [0.1, 1, 0, 0]);

    const found = await semanticSearch(db, idx, provider, 'q', 2, undefined, mineScope(db));
    expect(found.map(h => h.notePath)).toEqual(['/v/mine/m1.md', '/v/mine/m0.md']);
    // Without a scope, and with one that shows everything, the answer is the plain nearest chunks.
    const plain = await semanticSearch(db, idx, provider, 'q', 2);
    expect(plain.map(h => h.notePath)).toEqual(['/v/other/o0.md', '/v/other/o1.md']);
    expect(await semanticSearch(db, idx, provider, 'q', 2, undefined, everything(db))).toEqual(plain);
  });

  it('reads the scope\'s own chunks when the nearest hold some of them, but too few', async () => {
    const { db, idx } = freshIndex();
    db.transaction(() => {
      for (let i = 0; i < 200; i++) addChunk(db, idx, `/v/other/o${i}.md`, `other ${i}`, [1, 0.001 * (i + 1), 0, 0]);
    })();
    addChunk(db, idx, '/v/mine/near.md', 'mine, nearest of all', [1, 0.0005, 0, 0]);
    addChunk(db, idx, '/v/mine/far.md', 'mine, far', [0.2, 1, 0, 0]);
    expect((await semanticSearch(db, idx, provider, 'q', 2, undefined, mineScope(db))).map(h => h.notePath))
      .toEqual(['/v/mine/near.md', '/v/mine/far.md']);
  });

  it('reads only the nearest chunks when they hold enough that it shows', async () => {
    const { db, idx } = freshIndex();
    addChunk(db, idx, '/v/mine/m0.md', 'mine zero', [1, 0.01, 0, 0]);
    addChunk(db, idx, '/v/mine/m1.md', 'mine one', [1, 0.02, 0, 0]);
    addChunk(db, idx, '/v/other/o0.md', 'other zero', [0, 1, 0, 0]);
    const scope = mineScope(db);
    let listed = 0;
    const found = await semanticSearch(db, idx, provider, 'q', 2, undefined, { ...scope, chunkIds: () => { listed++; return scope.chunkIds(); } });
    expect(found.map(h => h.notePath)).toEqual(['/v/mine/m0.md', '/v/mine/m1.md']);
    expect(listed).toBe(0); // the scope's chunks are never listed
  });

  it('finds them past what one nearest-neighbour query returns', async () => {
    const { db, idx } = freshIndex();
    db.transaction(() => {
      for (let i = 0; i < KNN_MAX_K + 100; i++) addChunk(db, idx, `/v/other/o${i}.md`, `other ${i}`, [1, 0.0001 * (i + 1), 0, 0]);
    })();
    addChunk(db, idx, '/v/mine/far.md', 'mine, farther than every other chunk', [0, 1, 0, 0]);
    expect((await semanticSearch(db, idx, provider, 'q', 3, undefined, mineScope(db))).map(h => h.notePath)).toEqual(['/v/mine/far.md']);
  });
});

describe('VectorIndex.search among the vectors it is given', () => {
  it('returns the nearest of them, nearest first, and a tie at the edge whole', () => {
    const { idx } = freshIndex(2);
    for (let i = 0; i < 50; i++) idx.upsert(1 + i, [1, 0.001 * (i + 1)]); // nearer, not among them
    idx.upsert(100, [0.8, 0.6]);
    for (const id of [103, 101, 102]) idx.upsert(id, [0.6, 0.8]); // tied
    idx.upsert(104, [0, 1]);
    const among = [104, 103, 102, 101, 100];
    expect(idx.search([1, 0], 1, among).map(r => r.chunkId)).toEqual([100]);
    expect(idx.search([1, 0], 2, among).map(r => r.chunkId).sort()).toEqual([100, 101, 102, 103]);
    expect(idx.search([1, 0], 9, among).map(r => r.chunkId).sort()).toEqual([100, 101, 102, 103, 104]);
    expect(idx.search([1, 0], 3, [])).toEqual([]);
    // Each answer is the score a search among all gives the same vector.
    const all = new Map(idx.search([1, 0], 60).map(r => [r.chunkId, r.score]));
    for (const r of idx.search([1, 0], 1, [7])) expect(r.score).toBe(all.get(7));
  });
});

describe('retrieveContext with a filter judges what it shows before it cuts the window', () => {
  it('a related note it does not show takes no place, and one it shows is not cut behind them', async () => {
    process.env.RENOR_NEWEST_FIRST = '0';
    const { db, idx } = freshIndex();
    const entity = (note: string) => Number(db.prepare(
      "INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', ?, '[]', ?, 1, '2025-01-01')",
    ).run(note, note).lastInsertRowid);
    addChunk(db, idx, '/v/mine/hub.md', 'Hub plan for the mine.', [1, 0, 0, 0]);
    addChunk(db, idx, '/v/mine/w1.md', 'First weak match.', [0.12, 1, 0, 0]);
    addChunk(db, idx, '/v/mine/w2.md', 'Second weak match.', [0.11, 1, 0, 0]);
    addChunk(db, idx, '/v/mine/w3.md', 'Third weak match.', [0.1, 1, 0, 0]);
    const hub = entity('/v/mine/hub.md');
    // Related through links (score 0.3 each), no vector: other notes first by path, then one of the mine.
    for (const note of ['/v/a1.md', '/v/a2.md', '/v/a3.md', '/v/a4.md', '/v/a5.md', '/v/mine/zz.md']) {
      addChunk(db, idx, note, `Related section of ${note}.`);
      db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id, source_note, confidence) VALUES (?, 'links_to', ?, '/v/mine/hub.md', 1)")
        .run(hub, entity(note));
    }

    const shown = await retrieveContext(db, idx, provider, 'q', 4, [], NOW, { scope: mineScope(db) });
    expect(shown.hits.map(h => `${h.notePath}:${h.reason}`)).toEqual([
      '/v/mine/hub.md:semantic',
      '/v/mine/zz.md:graph',
      '/v/mine/w1.md:semantic',
      '/v/mine/w2.md:semantic',
    ]);
    // A filter that shows everything changes nothing.
    const plain = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(plain.hits.map(h => `${h.notePath}:${h.reason}`)).toEqual([
      '/v/mine/hub.md:semantic', '/v/a1.md:graph', '/v/a2.md:graph', '/v/a3.md:graph',
    ]);
    expect(await retrieveContext(db, idx, provider, 'q', 4, [], NOW, { scope: everything(db) })).toEqual(plain);
  });

  it('a first-person read offers the scope\'s fact, not the newer ones of other scopes it does not show', async () => {
    const dir = tmpPath(`scoped-window-vault-${process.pid}-${dbCount}`);
    fs.mkdirSync(dir, { recursive: true });
    const { db, idx } = freshIndex();
    const ledger = 'System/Memory Events Ledger.md';
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'location', object: 'WORKLOC', source: 'test', scope: 'scope:work' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'current_project', object: 'GLOBALPROJ', source: 'test' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'dog_name', object: 'GLOBALDOG', source: 'test' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'location', object: 'GLOBALLOC', source: 'test' });
    const scope = createReadScope(db, 'scope:work');
    const work: ChunkScope = {
      shows: hit => scope.has(hit, path.relative(dir, hit.notePath)),
      chunkIds: () => scope.chunkIds(stored => path.relative(dir, stored)),
    };

    const query = 'what is my current project, location and dog name?';
    const shown = await retrieveContext(db, idx, provider, query, 3, [], NOW, { scope: work });
    expect(shown.hits.map(h => h.text)).toEqual(['Rowan\'s location is WORKLOC.']);
    // Without the filter the three newest facts fill the window, all three of other scopes.
    const plain = await retrieveContext(db, idx, provider, query, 3, [], NOW);
    expect(plain.hits.map(h => h.text).sort()).toEqual([
      'Rowan\'s current_project is GLOBALPROJ.', 'Rowan\'s dog_name is GLOBALDOG.', 'Rowan\'s location is GLOBALLOC.',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
