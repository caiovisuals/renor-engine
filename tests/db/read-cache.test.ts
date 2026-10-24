import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from '../../src/db/sqlite';
import { readUntilWrite, tableHasColumns } from '../../src/db/readCache';
import { closedLedgerEvents } from '../../src/retrieval/ledgerLiveness';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember } from '../../src/memory/lifecycle';
import { tmpPath } from '../helpers/tmpPath';

const open: Database.Database[] = [];
const dirs: string[] = [];
function fileDb(name: string): { db: Database.Database; file: string } {
  const dir = tmpPath(name);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const file = path.join(dir, 'index.db');
  const db = openDb(file);
  open.push(db);
  return { db, file };
}
/** As fileDb, with the directory too: the vault a lifecycle save writes its ledger into. */
function fileDbIn(name: string): { db: Database.Database; dir: string } {
  const { db, file } = fileDb(name);
  return { db, dir: path.dirname(file) };
}
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('tableHasColumns', () => {
  it('says whether a table has every column, and keeps only a yes', () => {
    const { db } = fileDb('cols-1');
    db.exec('CREATE TABLE t (a TEXT)');
    expect(tableHasColumns(db, 't', ['a'])).toBe(true);
    expect(tableHasColumns(db, 't', ['a', 'b'])).toBe(false);
    expect(tableHasColumns(db, 't', ['a', 'b'])).toBe(false); // a no is not kept: it is still a no when asked again
    // A no is asked again: the column a migration adds is seen at once.
    db.exec('ALTER TABLE t ADD COLUMN b TEXT');
    expect(tableHasColumns(db, 't', ['a', 'b'])).toBe(true);
    expect(tableHasColumns(db, 'no_such_table', ['a'])).toBe(false);
  });

  it('asks the schema once for a yes, however often it is asked', () => {
    const { db } = fileDb('cols-2');
    db.exec('CREATE TABLE t (a TEXT, b TEXT)');
    let asked = 0;
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => (/table_info/.test(sql) && asked++, real(sql))) as typeof db.prepare;
    for (let i = 0; i < 5; i++) expect(tableHasColumns(db, 't', ['a', 'b'])).toBe(true);
    expect(asked).toBe(1);
  });
});

describe('readUntilWrite', () => {
  it('computes once while nothing is written, and returns the very value it kept', () => {
    const { db } = fileDb('rw-1');
    db.exec('CREATE TABLE t (v INTEGER)');
    let computed = 0;
    const read = () => readUntilWrite(db, 'sum', () => (computed++, db.prepare('SELECT COALESCE(SUM(v), 0) AS s FROM t').get() as { s: number }));
    const first = read();
    expect(read()).toBe(first);
    expect(read()).toBe(first);
    expect(computed).toBe(1);
  });

  it('computes again after this connection writes, whatever the write is', () => {
    const { db } = fileDb('rw-2');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    const sum = () => readUntilWrite(db, 'sum', () => (db.prepare('SELECT COALESCE(SUM(v), 0) FROM t').pluck().get() as number));
    expect(sum()).toBe(0);
    db.prepare('INSERT INTO t (v) VALUES (?)').run(5);
    expect(sum()).toBe(5);
    db.prepare('UPDATE t SET v = 7').run();
    expect(sum()).toBe(7);
    db.prepare('DELETE FROM t').run();
    expect(sum()).toBe(0);
    db.exec('INSERT INTO t (v) VALUES (3), (4)');
    expect(sum()).toBe(7);
  });

  it('computes again after another connection commits', () => {
    const { db, file } = fileDb('rw-3');
    db.exec('CREATE TABLE t (v INTEGER)');
    const count = () => readUntilWrite(db, 'count', () => (db.prepare('SELECT COUNT(*) FROM t').pluck().get() as number));
    expect(count()).toBe(0);
    const other = new Database(file);
    open.push(other);
    other.prepare('INSERT INTO t (v) VALUES (1)').run();
    expect(count()).toBe(1);
    other.prepare('INSERT INTO t (v) VALUES (2)').run();
    expect(count()).toBe(2);
  });

  it('keeps nothing from inside a transaction, so a rollback cannot leave what it saw behind', () => {
    const { db } = fileDb('rw-4');
    db.exec('CREATE TABLE t (v INTEGER)');
    const count = () => readUntilWrite(db, 'count', () => (db.prepare('SELECT COUNT(*) FROM t').pluck().get() as number));
    expect(count()).toBe(0);
    const seen: number[] = [];
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (1)').run();
      seen.push(count());
      db.prepare('INSERT INTO t (v) VALUES (2)').run();
      seen.push(count());
      throw new Error('roll back');
    })()).toThrow('roll back');
    expect(seen).toEqual([1, 2]);
    // The rows are gone; what the transaction counted must not be what is answered now.
    expect(count()).toBe(0);
    db.transaction(() => db.prepare('INSERT INTO t (v) VALUES (9)').run())();
    expect(count()).toBe(1);
  });

  it('keeps one value per key', () => {
    const { db } = fileDb('rw-5');
    expect(readUntilWrite(db, 'a', () => 'A')).toBe('A');
    expect(readUntilWrite(db, 'b', () => 'B')).toBe('B');
    expect(readUntilWrite(db, 'a', () => 'changed')).toBe('A');
  });

  it('keeps a bounded number of values per connection, the oldest first out, and every answer is still right', () => {
    const { db } = fileDb('rw-7');
    let computed = 0;
    const ask = (key: string) => readUntilWrite(db, key, () => (computed++, `value of ${key}`));
    for (let i = 0; i < 200; i++) expect(ask(`k${i}`)).toBe(`value of k${i}`);
    expect(computed).toBe(200);
    // The newest are still kept, the first ones were let go: asking again is right either way.
    ask('k199');
    expect(computed).toBe(200);
    expect(ask('k0')).toBe('value of k0');
    expect(computed).toBe(201);
  });

  it('is kept per connection', () => {
    const one = fileDb('rw-6a').db;
    const two = fileDb('rw-6b').db;
    expect(readUntilWrite(one, 'k', () => 1)).toBe(1);
    expect(readUntilWrite(two, 'k', () => 2)).toBe(2);
  });
});

describe('closedLedgerEvents (kept until a fact is written)', () => {
  const LEDGER = 'System/Memory Events Ledger.md';
  const save = async (db: Database.Database, vault: string, subject: string, predicate: string, object: string) =>
    (await remember(db, vault, LEDGER, { subject, predicate, object })).eventId;

  it('lists the closed events, lower-case, and sees a correction the moment it is written', async () => {
    const { db, dir } = fileDbIn('closed-1');
    runMigrations(db);
    const first = await save(db, dir, 'meeting', 'time', 'noon');
    const other = await save(db, dir, 'meeting', 'place', 'office');
    expect(closedLedgerEvents(db).size).toBe(0);
    expect(closedLedgerEvents(db)).toBe(closedLedgerEvents(db)); // read once, until something changes
    // A correction closes the first value of its subject and predicate, and the very next read says so.
    const second = await save(db, dir, 'meeting', 'time', 'one pm');
    expect([...closedLedgerEvents(db)]).toEqual([first.toLowerCase()]);
    await save(db, dir, 'meeting', 'place', 'cafe');
    expect([...closedLedgerEvents(db)].sort()).toEqual([first.toLowerCase(), other.toLowerCase()].sort());
    expect(closedLedgerEvents(db).has(second.toLowerCase())).toBe(false);
  });

  it('is empty on an index that predates the event column, and sees the column once it exists', () => {
    const { db } = fileDb('closed-2');
    db.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, source_path TEXT, valid_to TEXT)');
    expect(closedLedgerEvents(db).size).toBe(0);
    db.exec("ALTER TABLE facts ADD COLUMN event_id TEXT; INSERT INTO facts (source_path, valid_to, event_id) VALUES ('_mcp_', 'x', 'MEM_ZZZ')");
    expect([...closedLedgerEvents(db)]).toEqual(['mem_zzz']);
  });

  it('answers a read inside a transaction from the transaction, and the committed world again after a rollback', async () => {
    const { db, dir } = fileDbIn('closed-3');
    runMigrations(db);
    const event = await save(db, dir, 'meeting', 'time', 'noon');
    expect(closedLedgerEvents(db).size).toBe(0);
    expect(() => db.transaction(() => {
      db.prepare("UPDATE facts SET valid_to = '2026-10-03T00:00:00.000Z' WHERE event_id = ?").run(event);
      expect([...closedLedgerEvents(db)]).toEqual([event.toLowerCase()]);
      throw new Error('roll back');
    })()).toThrow('roll back');
    expect(closedLedgerEvents(db).size).toBe(0);
  });
});
