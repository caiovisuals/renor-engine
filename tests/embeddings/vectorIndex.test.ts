import { describe, it, expect, afterEach } from 'vitest';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

const DB = tmpPath('test-vector.db');
afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

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
});
