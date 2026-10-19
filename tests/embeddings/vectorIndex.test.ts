import { describe, it, expect, afterEach } from 'vitest';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

const DB = tmpPath('test-vector.db');
afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB + suffix)) fs.unlinkSync(DB + suffix);
  }
});

describe('VectorIndex', () => {
  it('stores and retrieves embedding', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    const got = idx.get(1);
    expect(got).not.toBeNull();
    expect(got!.length).toBe(4);
    db.close();
  });

  it('returns nearest neighbors in order', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.upsert(2, [0.9, 0.1, 0, 0]);
    idx.upsert(3, [0, 0, 1, 0]);
    const results = idx.search([1, 0, 0, 0], 2);
    expect(results[0].chunkId).toBe(1);
    expect(results[1].chunkId).toBe(2);
  });

  it('deletes embedding', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.delete(1);
    expect(idx.get(1)).toBeNull();
  });

  it('returns bounded scores between -1 and 1', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.upsert(2, [0, 0, 0, 1]); // orthogonal
    const results = idx.search([1, 0, 0, 0], 2);
    results.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    });
    // First result (identical) should have score close to 1
    expect(results[0].score).toBeGreaterThan(0.9);
    db.close();
  });

  it('reloads after another connection replaces a vector without changing the count', () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(1, [1, 0, 0, 0]);
    idx.upsert(2, [0.8, 0.2, 0, 0]);
    idx.upsert(3, [0, 0, 1, 0]);
    expect(idx.search([1, 0, 0, 0], 1)[0].chunkId).toBe(1);

    const other = openDb(DB);
    const writer = new VectorIndex(other, 4);
    writer.initTable();
    writer.upsert(1, [0, 0, 0, 1]);
    other.close();

    expect(idx.search([1, 0, 0, 0], 1)[0].chunkId).toBe(2);
    db.close();
  });

  it('does not grow the copy past its byte cap', () => {
    // 6144-d: the cap holds 2,730 vectors. The copy is built on search, at an exact 2,048, so the next
    // write is the one that doubles 2,048 → 4,096 (96 MiB) while one more vector still fits. The copy
    // must stay at or under 64 MiB and search must still find the new row. Writes before the first
    // search do not grow anything: there is no copy yet, and the next search reads the table.
    const dims = 6144;
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, dims); idx.initTable();
    const vector = new Array<number>(dims).fill(0);
    vector[0] = 1;
    db.transaction(() => {
      for (let id = 1; id <= 2048; id++) idx.upsert(id, vector);
    })();
    // Identical rows tie, so the id is whichever path answers. The search is what builds the copy, at cap 2,048.
    idx.search(vector, 1);
    const loaded = (idx as unknown as { mirror: { count: number; cap: number } | null }).mirror;
    expect(loaded).not.toBeNull();
    expect(loaded!.count).toBe(2048);
    expect(loaded!.cap).toBe(2048);
    const added = new Array<number>(dims).fill(0);
    added[1] = 1;
    idx.upsert(2049, added);
    const copy = (idx as unknown as { mirror: { data: Float32Array } | null }).mirror;
    expect(copy).not.toBeNull();
    expect(copy!.data.byteLength).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(idx.search(added, 1)[0].chunkId).toBe(2049);
    db.close();
  }, 120_000);

  it('throws when the stored table was created at another dimension', () => {
    const db = openDb(DB); runMigrations(db);
    const wide = new VectorIndex(db, 8); wide.initTable();
    wide.upsert(1, [1, 0, 0, 0, 0, 0, 0, 0]);
    const narrow = new VectorIndex(db, 4);
    expect(() => narrow.search([1, 0, 0, 0], 1)).toThrow(/Dimension mismatch/);
    db.close();
  });
});
