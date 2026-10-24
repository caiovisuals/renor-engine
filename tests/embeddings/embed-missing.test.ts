import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { chunksWithoutVectors, embedMissingVectors } from '../../src/embeddings/rebuild';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

/**
 * The patient half of an interactive save: embed the chunks a save kept for keyword search because the service would
 * not answer in time. It holds no lock, so a chunk may change while its text is out for embedding.
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

class Counting extends EvalHashEmbeddingProvider {
  calls: string[][] = [];
  /** Runs before a request answers, with its texts and the request number. */
  beforeAnswer: (texts: string[], n: number) => void = () => {};
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    this.beforeAnswer(texts, this.calls.length);
    return super.embed(texts);
  }
}

/** Twelve one-chunk notes indexed with no provider: every chunk is without a vector. */
async function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-missing-'));
  tmpDirs.push(dir);
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `n${i}.md`), `# Note ${i}\n\nbody ${i} alpha beta gamma\n`);
  const db = openDb(path.join(dir, 'index.db'));
  dbs.push(db);
  runMigrations(db);
  const vectors = new VectorIndex(db, 256);
  vectors.initTable();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await indexVault(db, dir, {}, 1);
  expect(chunksWithoutVectors(db)).toBe(12);
  return { db, vectors };
}

describe('embedMissingVectors', () => {
  it('embeds every chunk that has no vector, in batches, each with the vector of its own text, and then has nothing to do', async () => {
    const { db, vectors } = await workspace();
    const provider = new Counting();
    expect(await embedMissingVectors(db, vectors, provider, { batchSize: 5 })).toBe(12);
    expect(provider.calls.map(c => c.length)).toEqual([5, 5, 2]);
    expect(chunksWithoutVectors(db)).toBe(0);
    const chunks = db.prepare('SELECT id, text FROM chunks').all() as Array<{ id: number; text: string }>;
    const wanted = await new EvalHashEmbeddingProvider().embed(chunks.map(c => c.text));
    chunks.forEach((c, i) => {
      const stored = vectors.get(c.id)!;
      expect(stored.every((x, j) => Math.abs(x - wanted[i][j]) < 1e-5)).toBe(true);
    });
    expect(await embedMissingVectors(db, vectors, provider)).toBe(0);
    expect(provider.calls).toHaveLength(3);
  });

  it('stores no vector for a chunk that changed while its text was out, and embeds the chunk as it is now', async () => {
    const { db, vectors } = await workspace();
    const provider = new Counting();
    const target = (db.prepare('SELECT id FROM chunks ORDER BY id LIMIT 1').pluck().get() as number);
    provider.beforeAnswer = (_texts, n) => {
      if (n === 1) db.prepare('UPDATE chunks SET text = ? WHERE id = ?').run('replaced by a later save, now about kestrel', target);
    };
    await embedMissingVectors(db, vectors, provider, { batchSize: 32 });
    expect(chunksWithoutVectors(db)).toBe(0);
    expect(provider.calls).toHaveLength(2); // the stale answer was dropped; the chunk went round again
    const [now] = await new EvalHashEmbeddingProvider().embed(['replaced by a later save, now about kestrel']);
    expect(vectors.get(target)!.every((x, j) => Math.abs(x - now[j]) < 1e-5)).toBe(true);
  });

  it('keeps what it embedded when the provider fails, throws what it threw, and a later call carries on with the rest', async () => {
    const { db, vectors } = await workspace();
    const provider = new Counting();
    provider.beforeAnswer = (_texts, n) => {
      if (n === 2) throw new Error('service unavailable');
    };
    await expect(embedMissingVectors(db, vectors, provider, { batchSize: 5 })).rejects.toThrow('service unavailable');
    expect(chunksWithoutVectors(db)).toBe(7);
    provider.beforeAnswer = () => {};
    expect(await embedMissingVectors(db, vectors, provider, { batchSize: 5 })).toBe(7);
    expect(chunksWithoutVectors(db)).toBe(0);
  });

  it('stops between requests when aborted, and what is left stays left', async () => {
    const { db, vectors } = await workspace();
    const provider = new Counting();
    const controller = new AbortController();
    provider.beforeAnswer = (_texts, n) => {
      if (n === 1) controller.abort();
    };
    expect(await embedMissingVectors(db, vectors, provider, { batchSize: 5, signal: controller.signal })).toBe(5);
    expect(chunksWithoutVectors(db)).toBe(7);
  });
});
