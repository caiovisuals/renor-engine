import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { engineDailyHeader, formatEntry } from '../../src/memory/dailyNote';
import { findMemories, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import { factQueryTerms } from '../../src/mvp/agentMemory';

// memory_map with a query used to read every note in the vault and only then decide which were its words (5-10 s on
// 3,000 notes, for a query that found nothing). A lookup now reads only the notes that can hold one of its words, so
// the number of note files it opens is the structural claim these tests pin. Synthetic notes, no embeddings.

describe('memory_map lookup opens only the notes that can match', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.join(vault, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  const find = (query: string) => findMemories(ctx, { query, terms: factQueryTerms(query), limit: 10 });

  beforeEach(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'map-candidates-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
    for (let i = 0; i < 200; i++) write(`Memory/notes/n${i}.md`, `# Note ${i}\n\nSome plain words about topic ${i}.\n`);
    write('Memory/Daily/2026-10-01.md', engineDailyHeader('2026-10-01')
      + formatEntry('09:00:00', 'cli', 'the landlord fixed the boiler', false) + '\n');
    await indexVault(db, vault, {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /** The note files a lookup opened: every .md it read, by the path the read was made with. */
  function openedNotes(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.md'));
  }

  it('a query no memory holds opens no note file', async () => {
    const open = vi.spyOn(fsp, 'open');
    const reply = await find('zzzqqq');
    expect(reply.memories).toEqual([]);
    expect(openedNotes(open)).toEqual([]);
  });

  it('a query opens the notes that hold its word, and no other', async () => {
    const open = vi.spyOn(fsp, 'open');
    const reply = await find('landlord');
    expect(reply.memories.map((m) => m.path)).toEqual(['Memory/Daily/2026-10-01.md']);
    expect(openedNotes(open).map((p) => path.basename(p))).toEqual(['2026-10-01.md']);
  });

  it('a note that changed since it was indexed is read, so its new words are found', async () => {
    write('Memory/notes/n7.md', '# Note 7\n\nA zebra arrived after the last index.\n');
    const reply = await find('zebra');
    expect(reply.memories.map((m) => m.path)).toEqual(['Memory/notes/n7.md']);
  });

  it('a word after a symbol is found, as the words of a note are wherever the index cut them', async () => {
    write('Memory/notes/config.md', '# Config\n\nset KEY=dangerzone before the next run\n');
    await indexVault(db, vault, {});
    const reply = await find('dangerzone');
    expect(reply.memories.map((m) => m.path)).toEqual(['Memory/notes/config.md']);
  });

  it('a daily log too large to read whole still marks the map truncated when it cannot match', async () => {
    const big = path.join(vault, 'Memory/Daily/2026-10-02.md');
    fs.writeFileSync(big, engineDailyHeader('2026-10-02') + 'x'.repeat(8 * 1024 * 1024 + 1) + '\n');
    const mtime = fs.statSync(big).mtime.toISOString();
    db.prepare('INSERT INTO notes (path, title, note_hash, modified_at) VALUES (?, ?, ?, ?)')
      .run('Memory/Daily/2026-10-02.md', '2026-10-02', '', mtime);
    const reply = await find('zzzqqq');
    expect(reply.memories).toEqual([]);
    expect(reply.truncated.memories).toBe(true);
  });
});
