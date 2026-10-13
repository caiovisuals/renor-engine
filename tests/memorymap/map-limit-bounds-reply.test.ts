import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { DEFAULT_MAP_LIMIT, buildMemoryMap, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import { seedFacts } from '../helpers/seedFacts';

// memory_map's `limit` cut the memories and the retired list only: things, facts, events and links were capped at
// their own constants, so `limit: 5` on a vault of thousands of facts returned tens of kilobytes. Every array is cut
// at `limit` now, and the reply's size no longer grows with the vault. Structural: array lengths and a byte bound.

describe('memory_map limit bounds every array in the reply', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'map-limit-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
    seedFacts(db, 3000, (i) => ({
      subject: `Subject ${i}`, predicate: 'status', object: `value ${i} with some longer text to make it heavier`,
    }));
    const insert = db.prepare('INSERT INTO write_events (note_path, action, summary, created_at) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 1500; i++) {
        insert.run('_memory_ledger_', 'store', `status → value ${i}`, new Date(Date.UTC(2099, 0, 2, 0, 0, i)).toISOString());
      }
    })();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('with limit 5, things, facts, events and links are each at most 5 long, flagged truncated, and the reply stays small', async () => {
    const map = await buildMemoryMap(ctx, { limit: 5 });
    expect(map.things.length).toBeLessThanOrEqual(5);
    expect(map.facts.length).toBeLessThanOrEqual(5);
    expect(map.events.length).toBeLessThanOrEqual(5);
    expect(map.links.length).toBeLessThanOrEqual(5);
    expect(map.memories.length).toBeLessThanOrEqual(5);
    expect(map.retired.length).toBeLessThanOrEqual(5);
    expect(map.truncated.things).toBe(true);
    expect(map.truncated.facts).toBe(true);
    expect(map.truncated.events).toBe(true);
    expect(JSON.stringify(map).length).toBeLessThan(32 * 1024);
  });

  // Main's limit (PR 568) is the one default for every list: without a limit each list is cut to DEFAULT_MAP_LIMIT,
  // not to the per-list constants this branch used to keep (memory-map-limit.test.ts pins the same default).
  it('with no limit, every array is cut to the default and flagged truncated', async () => {
    const map = await buildMemoryMap(ctx);
    expect(map.things.length).toBe(DEFAULT_MAP_LIMIT);
    expect(map.facts.length).toBe(DEFAULT_MAP_LIMIT);
    expect(map.events.length).toBe(DEFAULT_MAP_LIMIT);
    expect(map.truncated.things).toBe(true);
    expect(map.truncated.facts).toBe(true);
    expect(map.truncated.events).toBe(true);
  });
});
