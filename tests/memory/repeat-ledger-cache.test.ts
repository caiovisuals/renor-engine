import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { DEFAULT_LEDGER_REL, remember } from '../../src/memory/lifecycle';

let db: Database.Database;
let vault: string;
let ledger: string;
const args = { subject: 'Fixture', predicate: 'status', object: 'Ready', statement: 'Fixture is ready.' };
const save = () => remember(db, vault, DEFAULT_LEDGER_REL, args);

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'repeat-ledger-'));
  ledger = path.join(vault, DEFAULT_LEDGER_REL);
  db = openDb(path.join(vault, 'index.db'));
  runMigrations(db);
  await save();
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fs.rm(vault, { recursive: true, force: true });
});

function countFields() {
  let count = 0;
  const original = RegExp.prototype.exec;
  vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
    if (this.source.startsWith('^- (')) count++;
    return original.call(this, text);
  });
  return () => count;
}

describe('repeat-write ledger cache', () => {
  it('reads canonical bytes on every repeat but avoids reparsing identical content', async () => {
    await save(); // validate the ledger and warm its single-event result
    const reads = vi.spyOn(fs, 'readFile');
    const fields = countFields();
    const before = await fs.readFile(ledger, 'utf8');
    expect((await save()).action).toBe('nochange');
    expect((await save()).action).toBe('nochange');
    expect(reads.mock.calls.filter(([file]) => file === ledger)).toHaveLength(3);
    expect(fields()).toBe(0); // Original parser revalidates all fields on each repeat.
    expect(await fs.readFile(ledger, 'utf8')).toBe(before);
  });

  it('parses only the events a write appended since the last repeat check, not the whole ledger', async () => {
    for (let i = 0; i < 30; i++) {
      await remember(db, vault, DEFAULT_LEDGER_REL, { subject: `Topic ${i}`, predicate: 'status', object: `Value ${i}`, statement: `Topic ${i} is set.` });
    }
    await save(); // the first check parses the ledger and keeps its events
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Latest', predicate: 'status', object: 'New', statement: 'Latest is new.' });
    const fields = countFields();
    expect((await save()).action).toBe('nochange');
    // One appended event carries about seven field lines; a whole-ledger parse of these 31 events reads about two hundred.
    expect(fields()).toBeLessThan(10);
    // The appended event is still judged as the ledger holds it: its own statement repeats, another one is a new event.
    expect((await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Latest', predicate: 'status', object: 'New', statement: 'Latest is new.' })).action)
      .toBe('nochange');
    expect((await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Latest', predicate: 'status', object: 'New', statement: 'Latest is newer.' })).action)
      .toBe('supersede');
  });

  it('keeps different words and subject spellings as new events for the same value', async () => {
    await save();
    expect((await remember(db, vault, DEFAULT_LEDGER_REL, { ...args, statement: 'Fixture remains ready.' })).action)
      .toBe('supersede');
    expect((await remember(db, vault, DEFAULT_LEDGER_REL, { ...args, subject: 'fixture' })).action)
      .toBe('supersede');
  });

  it('still rejects corruption anywhere in a changed ledger before appending a repeat', async () => {
    await save();
    await fs.appendFile(ledger, '\n## MEM_CORRUPT · 2026-10-07T12:00:00.000Z\n- unknown: field\n');
    const before = await fs.readFile(ledger, 'utf8');
    await expect(save()).rejects.toThrow('unknown field "unknown"');
    expect(await fs.readFile(ledger, 'utf8')).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 1 });
  });

  it('revalidates an edited target statement and a different target event', async () => {
    await remember(db, vault, DEFAULT_LEDGER_REL, { ...args, subject: 'Other', statement: 'Other is ready.' });
    await save();
    expect((await remember(db, vault, DEFAULT_LEDGER_REL, { ...args, subject: 'Other', statement: 'Other is ready.' })).action)
      .toBe('nochange');
    await save();
    const text = await fs.readFile(ledger, 'utf8');
    await fs.writeFile(ledger, text.replace('Fixture is ready.', 'Edited fixture statement.'));
    expect((await save()).action).toBe('supersede');
  });

  it('reparses after an ignored byte changes, even when both versions decode identically', async () => {
    const original = await fs.readFile(ledger);
    const first = Buffer.concat([Buffer.from([0x80, 0x0a]), original]);
    const second = Buffer.concat([Buffer.from([0x81, 0x0a]), original]);
    expect(first.toString('utf8')).toBe(second.toString('utf8'));
    await fs.writeFile(ledger, first);
    expect((await save()).action).toBe('nochange'); // validate the first byte sequence
    const fields = countFields();
    await fs.writeFile(ledger, second); // same size; only an ignored prose byte differs
    expect((await save()).action).toBe('nochange');
    expect(fields()).toBeGreaterThan(0);
    expect(await fs.readFile(ledger)).toEqual(second);
  });

  it('retains no ledger larger than the cap and preserves read errors', async () => {
    const text = await fs.readFile(ledger, 'utf8');
    await fs.writeFile(ledger, `${'prose'.repeat(60_000)}\n${text}`);
    await save();
    const fields = countFields();
    expect((await save()).action).toBe('nochange');
    expect(fields()).toBeGreaterThan(0);
    vi.restoreAllMocks();
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('synthetic read failure'), { code: 'EIO' }));
    await expect(save()).rejects.toThrow('synthetic read failure');
  });
});
