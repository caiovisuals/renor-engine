import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database, { nodeSupportProblem, sqliteRuntimeProblem } from '../../src/db/sqlite';
import { openDb, openReadOnlyDb } from '../../src/db/client';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('the node:sqlite driver keeps the better-sqlite3 behaviour the engine relies on', () => {
  it('returns plain rows with Buffer BLOBs, and plucks and raws', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body BLOB)');
    db.prepare('INSERT INTO t (id, body) VALUES (?, ?)').run(1, Buffer.from([1, 2]));
    const row = db.prepare('SELECT id, body FROM t').get() as { id: number; body: Buffer };
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Buffer.isBuffer(row.body)).toBe(true);
    expect(db.prepare('SELECT id FROM t WHERE id = @id').pluck().get({ id: 1 })).toBe(1);
    expect(db.prepare('SELECT id, 2 FROM t WHERE id IN (?, ?)').raw().all([1, 5])).toEqual([[1, 2]]);
    db.close();
    db.close(); // closing twice is harmless, as before
  });

  it('rolls back a throwing transaction, and only the inner part of a nested one', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    const add = db.prepare('INSERT INTO t (v) VALUES (?)');
    db.transaction(() => {
      add.run('outer');
      expect(() => db.transaction(() => { add.run('inner'); throw new Error('no'); })()).toThrow('no');
      expect(db.inTransaction).toBe(true);
    })();
    expect(() => db.transaction(() => { add.run('lost'); throw new Error('no'); })()).toThrow('no');
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT v FROM t').pluck().all()).toEqual(['outer']);
  });

  it('rounds an integer beyond 2^53 on a read, and keeps changes a number under safeIntegers', () => {
    const db = new Database(':memory:');
    expect(db.prepare('SELECT 9007199254740993 AS id').get()).toEqual({ id: 9007199254740992 });
    expect(db.prepare('SELECT 9007199254740993 AS id').safeIntegers().get()).toEqual({ id: 9007199254740993n });
    db.exec('CREATE TABLE t (v TEXT)');
    const result = db.prepare('INSERT INTO t (v) VALUES (?)').safeIntegers().run('a');
    expect(result).toEqual({ changes: 1, lastInsertRowid: 1n });
    expect(typeof result.changes).toBe('number');
  });

  it('names SQLite errors by their code, also when an iteration step raises them', () => {
    const db = new Database(':memory:');
    expect(() => db.prepare("SELECT load_extension('/nonexistent')").iterate().next()).toThrow(expect.objectContaining({ code: 'SQLITE_ERROR' }));
  });

  it('names SQLite errors by their code', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (v TEXT UNIQUE)');
    db.prepare('INSERT INTO t VALUES (?)').run('a');
    expect(() => db.prepare('INSERT INTO t VALUES (?)').run('a')).toThrow(expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }));
  });

  it('refuses SQL load_extension(), as better-sqlite3 did', () => {
    const db = new Database(':memory:');
    expect(() => db.prepare("SELECT load_extension('/nonexistent')").get()).toThrow(/not authorized/);
  });

  it('says which Node is too old, and finds this one and sqlite-vec usable', () => {
    expect(nodeSupportProblem('20.20.0')).toContain('Node 22.16.0 or newer');
    expect(nodeSupportProblem('22.15.1')).not.toBeNull();
    expect(nodeSupportProblem('23.11.0')).not.toBeNull();
    expect(nodeSupportProblem('22.16.0')).toBeNull();
    expect(nodeSupportProblem('26.0.0')).toBeNull();
    expect(sqliteRuntimeProblem()).toBeNull();
  });
});

describe('the durability of a connection matches main (better-sqlite3 12.11.1) through openDb', () => {
  // Main's values, measured with better-sqlite3 12.11.1 (SQLite 3.53.2, DEFAULT_WAL_SYNCHRONOUS=1) on the same openDb
  // sequence: a fresh index reports FULL (2) after openDb; a connection that opens an existing WAL index, read-write or
  // read-only, reports NORMAL (1).
  const FULL = 2;
  const NORMAL = 1;
  const synchronous = (db: Database.Database) => db.pragma('synchronous', { simple: true });

  it('keeps FULL on the connection that creates the index, and NORMAL on one that opens an existing WAL index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-durability-'));
    dirs.push(dir);
    const file = path.join(dir, 'index.db');
    const fresh = openDb(file);
    expect(fresh.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(synchronous(fresh)).toBe(FULL);
    fresh.exec('CREATE TABLE t (v TEXT)');
    fresh.prepare('INSERT INTO t (v) VALUES (?)').run('a');
    // Main's connection drops to NORMAL once its first write opens the WAL; this one never syncs less than main.
    expect(synchronous(fresh)).toBe(FULL);
    const reopened = openDb(file);
    expect(synchronous(reopened)).toBe(NORMAL);
    const readonly = openReadOnlyDb(file);
    expect(synchronous(readonly)).toBe(NORMAL);
    for (const db of [readonly, reopened, fresh]) db.close();
  });
});
