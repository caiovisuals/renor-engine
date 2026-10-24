import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, factsFor } from '../../src/memory/lifecycle';

/**
 * A fact save resolves its subject among the lifecycle entities by identity (case and Unicode form folded, aliases
 * unified), which SQLite cannot compare, so it used to read every lifecycle entity and fold its name, twice per save:
 * a save cost what the workspace held (about 6, 26 and 73 ms at 0, 10k and 30k facts). The entities are now kept in
 * an index per database, by identity, and the table is asked only whether it still holds what the index was read
 * from (how many rows, and the newest id): rows added since are read and added, anything else reads the table again.
 * These tests pin both halves: what a save reads, and that the answer is the table's whoever changed it.
 * Synthetic subjects only.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) dbs.pop()!.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-index-'));
  tmpDirs.push(vault);
  const dbPath = path.join(vault, 'index.db');
  const open = () => {
    const db = openDb(dbPath);
    dbs.push(db);
    runMigrations(db);
    return db;
  };
  return { vault, open, db: open() };
}

const save = (db: Database.Database, vault: string, subject: string, predicate: string, object: string) =>
  remember(db, vault, LEDGER, { subject, predicate, object, source: 'test' });

/** Lifecycle entity rows read by `run` (a db.prepare spy over every statement it runs). */
async function entityRowsRead(db: Database.Database, run: () => Promise<unknown>): Promise<number> {
  let rows = 0;
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (!/SELECT id, canonical_name FROM entities WHERE source_note/.test(sql)) return statement;
    const all = statement.all.bind(statement);
    Object.assign(statement, { all: (...args: unknown[]) => { const out = all(...args); rows += out.length; return out; } });
    return statement;
  }) as typeof db.prepare);
  await run();
  vi.restoreAllMocks();
  return rows;
}

describe('a fact save reads the lifecycle entities it needs, not all of them', () => {
  it('reads no entity row to supersede a fact or to save a new subject, at 20 subjects or at 300', async () => {
    const read: Record<number, { supersede: number; newSubject: number }> = {};
    for (const subjects of [20, 300]) {
      const { db, vault } = workspace();
      for (let i = 0; i < subjects; i++) await save(db, vault, `Service ${i}`, 'status', 'up');
      await save(db, vault, 'Service 0', 'status', 'warming'); // the first lookup in a process reads the table once
      read[subjects] = {
        supersede: await entityRowsRead(db, () => save(db, vault, 'service 7', 'status', 'down')),
        newSubject: await entityRowsRead(db, () => save(db, vault, `Brand new ${subjects}`, 'status', 'up')),
      };
      expect((factsFor(db, 'Service 7') as Array<{ object_text: string }>).map((f) => f.object_text)).toEqual(['down']);
    }
    // It used to be every lifecycle entity, twice per save: 2 x 20 and 2 x 300 rows for the supersession.
    expect(read).toEqual({ 20: { supersede: 0, newSubject: 0 }, 300: { supersede: 0, newSubject: 0 } });
  }, 60_000); // 320 saves to set up: more than vitest's default 5 s on a loaded host

  it('a subject saved since the last save is found by the next one, in any case or Unicode form', async () => {
    const { db, vault } = workspace();
    await save(db, vault, 'Zoë', 'city', 'Lisbon');
    const created = await save(db, vault, 'Ana', 'city', 'Porto'); // a new entity, after the index was read
    expect(created.action).toBe('store');
    expect((await save(db, vault, 'ANA', 'city', 'Faro')).action).toBe('supersede');
    expect((await save(db, vault, 'Zoë'.normalize('NFD'), 'city', 'Braga')).action).toBe('supersede');
    expect(db.prepare("SELECT COUNT(*) FROM entities WHERE source_note = '_mcp_'").pluck().get()).toBe(2);
  });
});

describe('what the index answers is what the table holds, whoever changed it', () => {
  it('an entity another connection saved is found by the next save here, which supersedes it rather than splitting it', async () => {
    const ws = workspace();
    await save(ws.db, ws.vault, 'Gateway', 'host', 'alpha'); // this connection's index now holds one entity
    const other = ws.open();
    await save(other, ws.vault, 'Billing queue', 'owner', 'ops');
    const receipt = await save(ws.db, ws.vault, 'billing QUEUE', 'owner', 'finance');
    expect(receipt.action).toBe('supersede');
    expect(ws.db.prepare("SELECT COUNT(*) FROM entities WHERE source_note = '_mcp_'").pluck().get()).toBe(2);
  });

  it('entities that are gone are not served: the next save makes the subject again', async () => {
    const { db, vault } = workspace();
    await save(db, vault, 'Gateway', 'host', 'alpha');
    db.prepare("DELETE FROM notes WHERE path = '_mcp_'").run(); // its entities and their facts go with it
    const receipt = await save(db, vault, 'Gateway', 'host', 'beta');
    expect(receipt.action).toBe('store');
    expect((factsFor(db, 'gateway') as Array<{ object_text: string }>).map((f) => f.object_text)).toEqual(['beta']);
  });

  it('an entity removed and another added (same count) is noticed by its newer id', async () => {
    const { db, vault } = workspace();
    await save(db, vault, 'Gateway', 'host', 'alpha');
    await save(db, vault, 'Billing queue', 'owner', 'ops');
    factsFor(db, 'Billing queue'); // the index now holds both: what follows changes the table behind it
    const gateway = db.prepare("SELECT id FROM entities WHERE source_note = '_mcp_' AND canonical_name = 'Gateway'").pluck().get();
    db.prepare('DELETE FROM entities WHERE id = ?').run(gateway);
    db.prepare("INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'Tenant router', '[]', '_mcp_', 1, '2026-01-01')").run();
    expect((await save(db, vault, 'tenant router', 'host', 'gamma')).action).toBe('store'); // found, so no new entity
    expect((await save(db, vault, 'Gateway', 'host', 'delta')).action).toBe('store'); // gone, so made again
    expect(db.prepare("SELECT canonical_name FROM entities WHERE source_note = '_mcp_' ORDER BY id").pluck().all())
      .toEqual(['Billing queue', 'Tenant router', 'Gateway']);
  });

  it('an older entity removed, and nothing added, is noticed by the count', async () => {
    const { db, vault } = workspace();
    await save(db, vault, 'Gateway', 'host', 'alpha');
    await save(db, vault, 'Billing queue', 'owner', 'ops');
    factsFor(db, 'Billing queue'); // the index now holds both
    const gateway = db.prepare("SELECT id FROM entities WHERE source_note = '_mcp_' AND canonical_name = 'Gateway'").pluck().get();
    db.prepare('DELETE FROM entities WHERE id = ?').run(gateway); // the newest id is still the same
    expect((await save(db, vault, 'Gateway', 'host', 'beta')).action).toBe('store');
    expect((factsFor(db, 'gateway') as Array<{ object_text: string }>).map((f) => f.object_text)).toEqual(['beta']);
  });

  it('an older entity removed while newer ones were added is noticed by the count, and the table is read again', async () => {
    const { db, vault } = workspace();
    await save(db, vault, 'Gateway', 'host', 'alpha');
    await save(db, vault, 'Billing queue', 'owner', 'ops');
    const gateway = db.prepare("SELECT id FROM entities WHERE source_note = '_mcp_' AND canonical_name = 'Gateway'").pluck().get();
    db.prepare('DELETE FROM entities WHERE id = ?').run(gateway);
    const add = db.prepare("INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1, '2026-01-01')");
    add.run('Tenant router');
    add.run('Session cache');
    expect((await save(db, vault, 'Gateway', 'host', 'beta')).action).toBe('store'); // gone: made again, not reused
    expect((await save(db, vault, 'SESSION cache', 'ttl', '5m')).action).toBe('store'); // found among the added ones
    expect(db.prepare("SELECT canonical_name FROM entities WHERE source_note = '_mcp_' ORDER BY id").pluck().all())
      .toEqual(['Billing queue', 'Tenant router', 'Session cache', 'Gateway']);
  });

  it('a row seen inside a transaction that is rolled back never reaches the index', async () => {
    const { db, vault } = workspace();
    await save(db, vault, 'Gateway', 'host', 'alpha');
    factsFor(db, 'Gateway'); // the index now holds it
    expect(() => db.transaction(() => {
      db.prepare("INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'Phantom', '[]', '_mcp_', 1, '2026-01-01')").run();
      expect(factsFor(db, 'Phantom')).toEqual([]); // the lookup sees the uncommitted row: it has no fact yet
      throw new Error('roll back');
    })()).toThrow('roll back');
    // Another connection adds an entity: the table has as many rows, and as new an id, as the rolled-back one made.
    db.prepare("INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', 'Other', '[]', '_mcp_', 1, '2026-01-01')").run();
    expect((await save(db, vault, 'phantom', 'state', 'real')).action).toBe('store');
    expect(db.prepare("SELECT canonical_name FROM entities WHERE source_note = '_mcp_' ORDER BY id").pluck().all()).toEqual(['Gateway', 'Other', 'phantom']);
    expect((factsFor(db, 'Phantom') as Array<{ object_text: string }>).map((f) => f.object_text)).toEqual(['real']);
    expect(factsFor(db, 'Other')).toEqual([]);
  });
});
