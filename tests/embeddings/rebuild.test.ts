import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { embeddingSpace } from '../../src/embeddings/space';
import { rebuildEmbeddings, chunksWithoutVectors } from '../../src/embeddings/rebuild';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

/**
 * An index whose vectors are in another model's space, or in none anyone can vouch for, must not be searched with
 * the configured model's query vectors, and a note edit must not leave the untouched notes' old vectors beside the
 * new ones. The rebuild clears every vector, names the index, embeds every chunk again and marks the index whole;
 * it can be stopped and resumed, and it survives a provider that fails. Synthetic notes, hash embeddings (no model).
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The stub's model, counting what it is asked to embed. */
class ModelA extends EvalHashEmbeddingProvider {
  calls: string[][] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** Fail a request for which this returns true. */
  refuse: (texts: string[]) => boolean = () => false;
  /** Runs after each request is computed, with the number of requests so far. */
  afterRequest: (n: number) => void = () => {};
  /** Runs before each request answers, with the request's texts. */
  beforeAnswer: (texts: string[]) => void = () => {};
  protected transform(v: number[]): number[] { return v; }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve)); // lets requests overlap
      this.beforeAnswer(texts);
      if (this.refuse(texts)) throw new Error('synthetic provider failure');
      const vectors = (await super.embed(texts)).map((v) => this.transform(v));
      this.afterRequest(this.calls.length);
      return vectors;
    } finally {
      this.inFlight--;
    }
  }
}

/** Another model of the same dimensions, whose every vector points the opposite way: whose vector a chunk holds is plain to see. */
class ModelB extends ModelA {
  readonly identity = { kind: 'eval-hash', model: 'opposite-model' };
  protected transform(v: number[]): number[] { return v.map((x) => -x); }
}

/** A note of `sections` chunks; `extra` is in the first section, or in every one. */
const note = (title: string, sections: number, extra = '', everySection = false) =>
  `# ${title}\n\n` + Array.from({ length: sections }, (_, k) => `## ${title} section ${k}\nbody ${title} ${k} alpha beta gamma ${k === 0 || everySection ? extra : ''}\n`).join('\n');

/** A vault and an index of it built by `provider`, which names the index after itself. */
async function builtBy(provider: ModelA, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const db = openDb(path.join(dir, 'index.db'));
  dbs.push(db);
  runMigrations(db);
  const vectors = new VectorIndex(db, provider.dimensions);
  vectors.initTable();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await indexVault(db, dir, { embeddingProvider: provider, vectorIndex: vectors }, 1);
  log.mockRestore();
  provider.calls = [];
  return { dir, db, vectors };
}

const FILES = { 'a.md': note('Alpha', 4), 'b.md': note('Bravo', 4), 'c.md': note('Charlie', 3) };

/** Every chunk, in every file, has exactly the vector `reference` makes of its text; and there is no vector for anything else. */
async function everyVectorIs(db: Database.Database, vectors: VectorIndex, reference: ModelA) {
  const chunks = db.prepare('SELECT id, note_path, text FROM chunks ORDER BY id').all() as Array<{ id: number; note_path: string; text: string }>;
  const wanted = await reference.embed(chunks.map((c) => c.text));
  const wrong = chunks.filter((c, i) => {
    const stored = vectors.get(c.id);
    return !stored || stored.some((x, j) => Math.abs(x - wanted[i][j]) > 1e-5);
  }).map((c) => `${path.basename(c.note_path)}#${c.id}`);
  const stored = (db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids').pluck().get() as number);
  return { chunks: chunks.length, stored, wrong, files: new Set(chunks.map((c) => path.basename(c.note_path))).size };
}

describe('VectorIndex records a rebuild', () => {
  it('beginRebuild clears every vector, names the index and marks it unfinished; finishRebuild marks it whole; a table made afresh forgets both', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-vi-'));
    tmpDirs.push(dir);
    const db = openDb(path.join(dir, 'index.db'));
    dbs.push(db);
    runMigrations(db);
    const vectors = new VectorIndex(db, 4);
    vectors.initTable();
    vectors.setSpace('space-a');
    vectors.upsert(1, [1, 0, 0, 0]);
    vectors.upsert(2, [0, 1, 0, 0]);
    expect(vectors.rebuilding()).toBe(false);

    vectors.beginRebuild('space-b');
    expect(vectors.hasVectors()).toBe(false);
    expect(vectors.space()).toBe('space-b');
    expect(vectors.rebuilding()).toBe(true);
    vectors.beginRebuild('space-b'); // twice is the same as once
    expect(vectors.rebuilding()).toBe(true);

    vectors.upsert(3, [0, 0, 1, 0]);
    vectors.finishRebuild();
    expect(vectors.rebuilding()).toBe(false);
    expect(vectors.space()).toBe('space-b');
    expect(vectors.hasVectors()).toBe(true);

    vectors.beginRebuild('space-c');
    db.prepare('DROP TABLE chunk_embeddings').run();
    vectors.initTable(); // created afresh: no vectors, so nothing is recorded about them
    expect(vectors.space()).toBeNull();
    expect(vectors.rebuilding()).toBe(false);
  });
});

describe('rebuildEmbeddings', () => {
  it('rewrites an index built by another model: every chunk of every file holds the new model\'s vector, none the old one\'s', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    expect(vectors.space()).toBe(embeddingSpace(a));
    const before = await everyVectorIs(db, vectors, new ModelA());
    expect(before.wrong).toEqual([]); // the fixture: model A's vectors everywhere

    const b = new ModelB();
    const result = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!);
    expect(result).toEqual({ done: true, embedded: before.chunks });

    const after = await everyVectorIs(db, vectors, new ModelB());
    expect(after).toEqual({ chunks: before.chunks, stored: before.chunks, wrong: [], files: 3 });
    expect(vectors.space()).toBe(embeddingSpace(b));
    expect(vectors.rebuilding()).toBe(false);
    expect(chunksWithoutVectors(db)).toBe(0);
  });

  it('does the same for an index that records no model at all (built before models were recorded)', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    db.prepare("DELETE FROM chunk_embedding_meta WHERE key = 'space'").run();
    expect(vectors.space()).toBeNull();
    expect(vectors.hasVectors()).toBe(true);

    // Even when the new model is the same one: nothing says the vectors are its, so it writes them all again.
    const again = new ModelA();
    const result = await rebuildEmbeddings(db, vectors, again, embeddingSpace(again)!);
    expect(result.done).toBe(true);
    expect(again.calls.flat().length).toBe(result.embedded);
    expect(await everyVectorIs(db, vectors, new ModelA())).toMatchObject({ stored: result.embedded, wrong: [], files: 3 });
    expect(vectors.space()).toBe(embeddingSpace(again));
  });

  it('leaves an index that is whole in the space alone: nothing is cleared or embedded', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    const ids = () => (db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all() as number[]).join(',');
    const before = { ids: ids(), vector: vectors.get(1) };
    const result = await rebuildEmbeddings(db, vectors, a, embeddingSpace(a)!);
    expect(result).toEqual({ done: true, embedded: 0 });
    expect(a.calls).toEqual([]);
    expect({ ids: ids(), vector: vectors.get(1) }).toEqual(before);
  });

  it('can be stopped and resumed: a stopped rebuild is named, partial and unfinished, and the next call embeds only what is missing', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    const b = new ModelB();
    const controller = new AbortController();
    b.afterRequest = (n) => { if (n === 2) controller.abort(); };

    const stopped = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { batchSize: 4, concurrency: 1, signal: controller.signal });
    expect(stopped.done).toBe(false);
    expect(vectors.rebuilding()).toBe(true);
    expect(vectors.space()).toBe(embeddingSpace(b));
    const partial = (db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids').pluck().get() as number);
    expect(partial).toBe(8); // two requests of four
    expect(chunksWithoutVectors(db)).toBe((db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number) - 8);
    // Every vector there is already the new model's: a stopped rebuild never serves the old one's.
    const some = (db.prepare('SELECT id, text FROM chunks WHERE id IN (SELECT rowid FROM chunk_embeddings_rowids)').all() as Array<{ id: number; text: string }>);
    const wanted = await new ModelB().embed(some.map((c) => c.text));
    some.forEach((c, i) => expect(vectors.get(c.id)!.every((x, j) => Math.abs(x - wanted[i][j]) < 1e-5)).toBe(true));

    const resumed = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { batchSize: 4, concurrency: 1 });
    expect(resumed.done).toBe(true);
    const chunks = (db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number);
    expect(resumed.embedded).toBe(chunks - 8);
    expect(b.calls.flat().length).toBe(chunks); // each chunk embedded once, across both calls
    expect(await everyVectorIs(db, vectors, new ModelB())).toMatchObject({ stored: chunks, wrong: [], files: 3 });
    expect(vectors.rebuilding()).toBe(false);
  });

  it('tries a failing request again', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    const b = new ModelB();
    let failures = 2;
    b.refuse = () => failures-- > 0;
    const result = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { retryDelayMs: () => 0 });
    expect(result.done).toBe(true);
    expect((await everyVectorIs(db, vectors, new ModelB())).wrong).toEqual([]);
  });

  it('throws when the provider is down, leaving a named, empty, unfinished index that the next call completes', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    const b = new ModelB();
    b.refuse = () => true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { retryDelayMs: () => 0 })).rejects.toThrow('synthetic provider failure');
    expect(vectors.rebuilding()).toBe(true);
    expect(vectors.space()).toBe(embeddingSpace(b));
    expect(vectors.hasVectors()).toBe(false); // nothing of the old model is left to be read

    b.refuse = () => false;
    const result = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { retryDelayMs: () => 0 });
    expect(result.done).toBe(true);
    expect((await everyVectorIs(db, vectors, new ModelB())).wrong).toEqual([]);
  });

  const missingTexts = (db: Database.Database) =>
    db.prepare('SELECT text FROM chunks WHERE id NOT IN (SELECT rowid FROM chunk_embeddings_rowids) ORDER BY id').pluck().all() as string[];

  it('never marks the index whole with a chunk missing its vector: a chunk the provider refuses leaves it unfinished, every other chunk embedded, until the provider takes it', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, { ...FILES, 'd.md': note('Delta', 3, 'POISONED') });
    const b = new ModelB();
    b.refuse = (texts) => texts.some((t) => t.includes('POISONED'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Twice: the second call shows that a stopped rebuild is resumed, and still does not finish.
    for (let call = 0; call < 2; call++) {
      await expect(rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { retryDelayMs: () => 0 }))
        .rejects.toThrow(/chunk \d+ of .*d\.md could not be embedded: synthetic provider failure/);
      expect(vectors.rebuilding()).toBe(true);
      expect(vectors.space()).toBe(embeddingSpace(b));
      expect(chunksWithoutVectors(db)).toBe(1); // what the provider takes is stored: only the refused chunk is missing
      expect(missingTexts(db)).toHaveLength(1);
      expect(missingTexts(db)[0]).toContain('POISONED');
    }

    b.refuse = () => false; // the provider takes it now
    const result = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { retryDelayMs: () => 0 });
    expect(result.done).toBe(true);
    expect(vectors.rebuilding()).toBe(false);
    expect(chunksWithoutVectors(db)).toBe(0);
    expect(await everyVectorIs(db, vectors, new ModelB())).toMatchObject({ wrong: [], files: 4 });
  });

  it('holds back nothing else when many chunks are refused: all the others are embedded, those few are named as missing, the index stays unfinished', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, { ...FILES, 'd.md': note('Delta', 14, 'POISONED', true) });
    const b = new ModelB();
    b.refuse = (texts) => texts.some((t) => t.includes('POISONED'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { retryDelayMs: () => 0 })).rejects.toThrow('synthetic provider failure');
    expect(vectors.rebuilding()).toBe(true);
    expect(missingTexts(db)).toHaveLength(14);
    expect(missingTexts(db).every((text) => text.includes('POISONED'))).toBe(true);
    expect(chunksWithoutVectors(db)).toBe(14);
  });

  it('is marked whole only when no chunk lacks a vector: a vector that goes missing while the rebuild runs is written again', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    const chunks = (db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number);
    const b = new ModelB();
    let victim = 0;
    b.afterRequest = (n) => {
      if (n !== 2) return;
      // as if something removed a vector the rebuild had already written
      victim = (db.prepare('SELECT MIN(rowid) FROM chunk_embeddings_rowids').pluck().get() as number);
      db.prepare('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(victim));
    };
    const result = await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { batchSize: 4, concurrency: 1 });
    expect(victim).toBeGreaterThan(0);
    expect(result).toEqual({ done: true, embedded: chunks + 1 }); // one chunk had to be embedded a second time
    expect(chunksWithoutVectors(db)).toBe(0);
    expect(vectors.get(victim)).not.toBeNull();
    expect((await everyVectorIs(db, vectors, new ModelB())).wrong).toEqual([]);
  });

  it('stores nothing for a chunk that a save replaced while its vector was being fetched', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, FILES);
    const b = new ModelB();
    const victim = (db.prepare("SELECT id FROM chunks WHERE note_path LIKE '%b.md' ORDER BY id LIMIT 1").pluck().get() as number);
    let replaced = false;
    b.beforeAnswer = () => {
      if (replaced) return;
      replaced = true;
      db.prepare('DELETE FROM chunks WHERE id = ?').run(victim); // as a save replacing the note's chunks does
    };
    await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!);
    const orphans = (db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids r WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = r.rowid)').pluck().get() as number);
    expect(orphans).toBe(0);
    expect(vectors.get(victim)).toBeNull();
    expect((await everyVectorIs(db, vectors, new ModelB())).wrong).toEqual([]);
  });

  it('keeps several requests in flight at once, no more than asked', async () => {
    const a = new ModelA();
    const { db, vectors } = await builtBy(a, { 'big.md': note('Big', 40) });
    const b = new ModelB();
    await rebuildEmbeddings(db, vectors, b, embeddingSpace(b)!, { batchSize: 4, concurrency: 3 });
    expect(b.maxInFlight).toBe(3);
    expect((await everyVectorIs(db, vectors, new ModelB())).wrong).toEqual([]);
  });
});
