// Adversary run renor-adv-vaultfs-1012, F3: read_memory and retire_memory addressed any non-hidden .md under the vault, so a
// file the owner kept out of memory with .semanticignore (or that lives in node_modules) could be read in full and moved
// to .trash by its path. Also the retired-memory journal: a hard link or FIFO under its name is refused.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { readMemory, retireMemory, restoreMemory, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import type Database from 'better-sqlite3';

const SECRET = 'PRIVATE-DIARY-CANARY';

function write(vault: string, rel: string, content: string) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

describe('read_memory / retire_memory honour the vault ignore rules', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;

  beforeEach(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-ignore-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
    write(vault, '.semanticignore', 'Private/\n');
    write(vault, 'Private/diary.md', `# Diary\n${SECRET}\n`);
    write(vault, 'node_modules/pkg/README.md', `# pkg\n${SECRET}\n`);
    write(vault, 'Notes/open.md', '# Open\nan ordinary note\n');
    await indexVault(db, vault, {});
  });
  afterEach(() => {
    db.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('does not read a note the owner excluded in .semanticignore', async () => {
    await expect(readMemory(ctx, 'note:Private/diary.md')).rejects.toThrow(/not found/);
  });

  it('does not read a file under node_modules', async () => {
    await expect(readMemory(ctx, 'note:node_modules/pkg/README.md')).rejects.toThrow(/not found/);
  });

  it('does not move an excluded note to .trash', async () => {
    await expect(retireMemory(ctx, 'note:Private/diary.md')).rejects.toThrow(/not found/);
    expect(fs.existsSync(path.join(vault, 'Private/diary.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.trash'))).toBe(false);
  });

  it('still reads, retires and restores an ordinary note', async () => {
    expect((await readMemory(ctx, 'note:Notes/open.md')).text).toContain('an ordinary note');
    const receipt = await retireMemory(ctx, 'note:Notes/open.md');
    expect(fs.existsSync(path.join(vault, 'Notes/open.md'))).toBe(false);
    await restoreMemory(ctx, receipt.id);
    expect(fs.existsSync(path.join(vault, 'Notes/open.md'))).toBe(true);
  });

  it('restores a note retired before the owner excluded its folder', async () => {
    write(vault, 'Later/n.md', '# Later\nbody\n');
    await indexVault(db, vault, {});
    const receipt = await retireMemory(ctx, 'note:Later/n.md');
    write(vault, '.semanticignore', 'Private/\nLater/\n');
    await restoreMemory(ctx, receipt.id);
    expect(fs.existsSync(path.join(vault, 'Later/n.md'))).toBe(true);
  });
});
