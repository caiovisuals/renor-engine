import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { prepareOnce } from '../../src/db/statements';

const open: Database.Database[] = [];
function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  open.push(db);
  return db;
}
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('prepareOnce', () => {
  it('prepares a text once per connection and hands the same statement back', () => {
    const db = memoryDb();
    const prepared: string[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => (prepared.push(sql), real(sql))) as typeof db.prepare;
    const a = prepareOnce(db, 'SELECT 1 AS one');
    const b = prepareOnce(db, 'SELECT 1 AS one');
    expect(b).toBe(a);
    expect(prepared).toEqual(['SELECT 1 AS one']);
    expect(prepareOnce(db, 'SELECT 2 AS two')).not.toBe(a);
  });

  it('keeps nothing across connections: each has its own', () => {
    const one = memoryDb();
    const two = memoryDb();
    expect(prepareOnce(one, 'SELECT 1')).not.toBe(prepareOnce(two, 'SELECT 1'));
  });

  it('answers as a fresh statement does, run after run and with different parameters', () => {
    const db = memoryDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = prepareOnce(db, 'INSERT INTO t (v) VALUES (?)');
    for (const v of ['a', 'b', 'c']) insert.run(v);
    const byId = prepareOnce(db, 'SELECT v FROM t WHERE id = ?');
    expect([1, 2, 3, 4].map(id => (byId.get(id) as { v: string } | undefined)?.v)).toEqual(['a', 'b', 'c', undefined]);
    expect(prepareOnce(db, 'SELECT v FROM t ORDER BY id').all()).toEqual(db.prepare('SELECT v FROM t ORDER BY id').all());
  });

  it('sees a column a migration adds after the statement was first used', () => {
    const db = memoryDb();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)");
    const everything = prepareOnce(db, 'SELECT * FROM t');
    expect(everything.all()).toEqual([{ id: 1 }]);
    db.exec("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'x'");
    // SQLite prepares the statement again by itself when the schema changed: the cached one is not stale.
    expect(prepareOnce(db, 'SELECT * FROM t').all()).toEqual([{ id: 1, extra: 'x' }]);
  });

  it('stops keeping texts at a ceiling, and still returns a working statement past it', () => {
    const db = memoryDb();
    const texts = Array.from({ length: 300 }, (_, i) => `SELECT ${i} AS n`);
    const first = texts.map(sql => prepareOnce(db, sql));
    // The first 256 are kept; later ones are prepared each time, and answer all the same.
    expect(prepareOnce(db, texts[0])).toBe(first[0]);
    expect(prepareOnce(db, texts[299])).not.toBe(first[299]);
    expect((prepareOnce(db, texts[299]).get() as { n: number }).n).toBe(299);
  });
});
