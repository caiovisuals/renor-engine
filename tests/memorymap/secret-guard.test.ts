import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { appendDailyMemory } from '../../src/memory/writer';
import { SecretRefusedError } from '../../src/extraction/secretGuard';
import { buildMemoryMap, retireMemory, restoreMemory, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import { KEY_SHAPES, Rng } from '../../scripts/eval/secret-guard/plantedSet';

/**
 * RENOR_SECRET_GUARD on the memory map: retire and restore are the two operations that move text that is ALREADY stored.
 *
 * Retire copies a daily entry's block into the retired-memory journal, or moves a note file into the retired store;
 * restore puts either back into live memory and the index. With the guard on, a memory whose text the scanner flags is
 * neither retired nor restored, and the refusal happens before anything is journaled, moved, rewritten or indexed, so a
 * refused operation changes nothing. Text saved while the guard was off is exactly what this is about: it is seeded
 * with the guard off, then the guard is switched on. Planted synthetic secrets only.
 */

const SAVED = process.env.RENOR_SECRET_GUARD;
const r = new Rng(20261003);
const KEY = KEY_SHAPES.openai_proj(r);
const NOTE_KEY = KEY_SHAPES.github(r);
const fragments = (secret: string) => [secret.slice(-14), secret.slice(0, 10)].filter(f => f.length >= 8);
const DAY = '2026-10-01';
const DAILY = path.join('Memory', 'Daily', `${DAY}.md`);
const JOURNAL = path.join('.trash', 'renor-retired', 'retired.jsonl');

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const listFiles = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).map(String).filter(f => !f.startsWith('.memory-index')).sort();

describe('retire and restore with the secret guard on', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;

  /** Everything a refused operation must leave exactly as it found it. */
  function state() {
    const read = (rel: string) => (fs.existsSync(path.join(vault, rel)) ? fs.readFileSync(path.join(vault, rel), 'utf8') : null);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
    const chunks = (db.prepare("SELECT group_concat(note_path || char(1) || text, char(10)) AS t FROM (SELECT note_path, text FROM chunks ORDER BY id)").get() as { t: string | null }).t;
    return {
      files: listFiles(vault),
      daily: read(DAILY),
      journal: read(JOURNAL),
      keysNote: read(path.join('Projects', 'keys.md')),
      notes: count('notes'), chunkCount: count('chunks'), writeEvents: count('write_events'), chunksHash: sha(chunks ?? ''),
    };
  }

  async function ids() {
    const map = await buildMemoryMap(ctx);
    const find = (kind: string, needle: string) => map.memories.find(m => m.kind === kind && (m.excerpt.includes(needle) || m.title.includes(needle)))!;
    return {
      flaggedEntry: find('entry', 'staging key').id,
      cleanEntry: find('entry', 'short answers').id,
      flaggedNote: find('note', 'Keys').id,
      cleanNote: find('note', 'Plan').id,
    };
  }

  beforeEach(async () => {
    delete process.env.RENOR_SECRET_GUARD; // what is stored before the guard exists
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memmap-guard-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', 'keys.md'), `# Keys\n\nthe deploy token is ${NOTE_KEY}, do not share\n`);
    fs.writeFileSync(path.join(vault, 'Projects', 'plan.md'), '# Plan\n\nThe launch is on the 14th and Rachel owns the checklist.\n');
    await appendDailyMemory(vault, DAY, { text: `the staging key is ${KEY}, keep it somewhere safe`, source: 'claude' });
    await appendDailyMemory(vault, DAY, { text: 'Prefers short answers from agents', source: 'claude' });
    await indexVault(db, vault, {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    if (SAVED === undefined) delete process.env.RENOR_SECRET_GUARD;
    else process.env.RENOR_SECRET_GUARD = SAVED;
    fs.rmSync(vault, { recursive: true, force: true });
  });

  describe('retire', () => {
    it('refuses a daily entry the scanner flags, before it is copied into the journal: nothing changes', async () => {
      const { flaggedEntry } = await ids();
      const before = state();
      process.env.RENOR_SECRET_GUARD = '1';
      const err = await retireMemory(ctx, flaggedEntry).catch(e => e);
      expect(err).toBeInstanceOf(SecretRefusedError);
      expect(err).toMatchObject({ field: 'memory', reason: 'credential', action: 'retire' });
      expect(err.message).toMatch(/^Nothing was changed: the memory appears to contain a credential/);
      expect(err.message).toContain('was not retired: retiring copies its text into the retired-memory journal');
      for (const f of fragments(KEY)) expect(err.message).not.toContain(f);
      expect(state()).toEqual(before); // the daily file, the journal (still absent), the index, the events: all as they were
      expect(before.journal).toBeNull();
      expect(fs.existsSync(path.join(vault, '.trash'))).toBe(false);
    });

    it('refuses a note the scanner flags, before the retired directory is created or the note leaves the index', async () => {
      const { flaggedNote } = await ids();
      const before = state();
      process.env.RENOR_SECRET_GUARD = '1';
      await expect(retireMemory(ctx, flaggedNote)).rejects.toMatchObject({ name: 'SecretRefusedError', field: 'memory', action: 'retire' });
      expect(state()).toEqual(before);
      expect(fs.existsSync(path.join(vault, 'Projects', 'keys.md'))).toBe(true);
      expect(fs.existsSync(path.join(vault, '.trash'))).toBe(false);
    });

    it('still retires a clean entry and a clean note', async () => {
      const { cleanEntry, cleanNote } = await ids();
      process.env.RENOR_SECRET_GUARD = '1';
      expect((await retireMemory(ctx, cleanEntry)).action).toBe('retired');
      expect((await retireMemory(ctx, cleanNote)).action).toBe('retired');
      const after = state();
      expect(after.daily).not.toContain('short answers');
      expect(after.daily).toContain(KEY); // the flagged entry was not touched
      expect(after.journal).toContain('short answers');
      expect(after.journal).not.toContain(KEY);
      expect(fs.existsSync(path.join(vault, 'Projects', 'plan.md'))).toBe(false);
      expect(after.journal!.match(/"kind":"entry"/g)).toHaveLength(1);
      expect(after.journal!.match(/"kind":"note"/g)).toHaveLength(1);
    });

    it('refuses a note too large to screen, as it refuses whenever it cannot check', async () => {
      fs.writeFileSync(path.join(vault, 'Projects', 'huge.md'), '# Huge\n\n' + 'plain words, nothing to see. '.repeat(Math.ceil((9 * 1024 * 1024) / 29)));
      const huge = 'note:Projects/huge.md'; // not indexed: a memory id is its path, and retiring needs no index row
      process.env.RENOR_SECRET_GUARD = '1';
      const before = state();
      const err = await retireMemory(ctx, huge).catch(e => e);
      expect(err).toBeInstanceOf(SecretRefusedError);
      expect(err).toMatchObject({ reason: 'unavailable', action: 'retire' });
      expect(err.message).toContain('could not check');
      expect(state()).toEqual(before);
    });

    it('with the guard off retires the same flagged entry, which is what the refusal was stopping', async () => {
      const { flaggedEntry } = await ids();
      await retireMemory(ctx, flaggedEntry);
      expect(state().journal).toContain(KEY);
      expect(state().daily).not.toContain(KEY);
    });
  });

  describe('restore', () => {
    /** Retire the two flagged memories while the guard is off, as an owner tidying up would have. */
    async function retireFlaggedWithGuardOff() {
      const { flaggedEntry, flaggedNote } = await ids();
      const entry = await retireMemory(ctx, flaggedEntry);
      const note = await retireMemory(ctx, flaggedNote);
      expect(entry.action).toBe('retired');
      expect(note.action).toBe('retired');
      return { flaggedEntry, flaggedNote };
    }

    it('refuses to put a flagged entry back into the live daily file, and leaves the retired bytes and the index as they were', async () => {
      const { flaggedEntry } = await retireFlaggedWithGuardOff();
      const before = state();
      expect(before.daily).not.toContain(KEY);
      process.env.RENOR_SECRET_GUARD = '1';
      const err = await restoreMemory(ctx, flaggedEntry).catch(e => e);
      expect(err).toBeInstanceOf(SecretRefusedError);
      expect(err).toMatchObject({ field: 'memory', reason: 'credential', action: 'restore' });
      expect(err.message).toContain('was not restored: restoring would put its text back into live memory. It stays retired.');
      for (const f of fragments(KEY)) expect(err.message).not.toContain(f);
      expect(state()).toEqual(before);
    });

    it('refuses to move a flagged note back into the live tree, and the stored file stays where it is', async () => {
      const { flaggedNote } = await retireFlaggedWithGuardOff();
      const before = state();
      expect(fs.existsSync(path.join(vault, 'Projects', 'keys.md'))).toBe(false);
      process.env.RENOR_SECRET_GUARD = '1';
      await expect(restoreMemory(ctx, flaggedNote)).rejects.toMatchObject({ name: 'SecretRefusedError', action: 'restore' });
      expect(state()).toEqual(before);
      expect(fs.existsSync(path.join(vault, 'Projects', 'keys.md'))).toBe(false);
      expect(before.files.some(f => f.includes(path.join('.trash', 'renor-retired', 'files')) && f.endsWith('keys.md'))).toBe(true);
    });

    it('restores both once the guard is off again, so it was the guard that held them back', async () => {
      const { flaggedEntry, flaggedNote } = await retireFlaggedWithGuardOff();
      process.env.RENOR_SECRET_GUARD = '1';
      await expect(restoreMemory(ctx, flaggedEntry)).rejects.toBeInstanceOf(SecretRefusedError);
      await expect(restoreMemory(ctx, flaggedNote)).rejects.toBeInstanceOf(SecretRefusedError);
      delete process.env.RENOR_SECRET_GUARD;
      expect((await restoreMemory(ctx, flaggedEntry)).action).toBe('restored');
      expect((await restoreMemory(ctx, flaggedNote)).action).toBe('restored');
      expect(state().daily).toContain(KEY);
      expect(fs.readFileSync(path.join(vault, 'Projects', 'keys.md'), 'utf8')).toContain(NOTE_KEY);
    });

    it('still restores a clean entry and a clean note with the guard on', async () => {
      const { cleanEntry, cleanNote } = await ids();
      await retireMemory(ctx, cleanEntry);
      await retireMemory(ctx, cleanNote);
      process.env.RENOR_SECRET_GUARD = '1';
      expect((await restoreMemory(ctx, cleanEntry)).action).toBe('restored');
      expect((await restoreMemory(ctx, cleanNote)).action).toBe('restored');
      expect(state().daily).toContain('short answers');
      expect(fs.existsSync(path.join(vault, 'Projects', 'plan.md'))).toBe(true);
    });
  });

  describe('an interrupted retirement', () => {
    /** A retirement that crashed after it was journaled and before the entry left its file: the entry is still in place. */
    function journalInterrupted(entryId: string, block: string) {
      fs.mkdirSync(path.join(vault, '.trash', 'renor-retired'), { recursive: true });
      const record = { rid: 'retired:00000000deadbeef', id: entryId, kind: 'entry', path: DAILY.split(path.sep).join('/'), title: 'earlier', retiredAt: '2026-10-01T00:00:00.000Z', block, copies: 1 };
      fs.writeFileSync(path.join(vault, JOURNAL), JSON.stringify(record) + '\n', { mode: 0o600 });
    }
    const flaggedBlock = () => {
      const line = fs.readFileSync(path.join(vault, DAILY), 'utf8').split('\n').find(l => l.includes('staging key'))!;
      return line;
    };

    it('is settled without writing a second copy of the flagged block while the guard is on', async () => {
      const { flaggedEntry, cleanEntry } = await ids();
      journalInterrupted(flaggedEntry, flaggedBlock());
      expect(fs.readFileSync(path.join(vault, JOURNAL), 'utf8').split(KEY).length - 1).toBe(1); // the one the earlier crash left
      process.env.RENOR_SECRET_GUARD = '1';
      await retireMemory(ctx, cleanEntry); // any retire settles what an earlier crash left
      const journal = fs.readFileSync(path.join(vault, JOURNAL), 'utf8');
      expect(journal.split(KEY).length - 1).toBe(1); // still one: the void record does not repeat it
      const voided = journal.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(rec => rec.voided);
      expect(voided).toBeDefined();
      expect(voided.block).toBeUndefined();
      expect(voided).toMatchObject({ rid: 'retired:00000000deadbeef', voided: true });
    });

    it('is settled as it always was with the guard off: the void record carries the block', async () => {
      const { flaggedEntry, cleanEntry } = await ids();
      journalInterrupted(flaggedEntry, flaggedBlock());
      await retireMemory(ctx, cleanEntry);
      const journal = fs.readFileSync(path.join(vault, JOURNAL), 'utf8');
      expect(journal.split(KEY).length - 1).toBe(2);
      const voided = journal.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(rec => rec.voided);
      expect(voided.block).toContain(KEY);
    });
  });

  it('keeps every refusal message under the 400 characters the MCP error reply keeps', () => {
    let longest = 0;
    for (const action of ['retire', 'restore'] as const) {
      for (const field of ['memory', 'title']) {
        for (const reason of ['credential', 'identifier', 'sensitive', 'unavailable'] as const) {
          const n = new SecretRefusedError(field, reason, action).message.length;
          expect(n, `${action} ${field} ${reason}`).toBeLessThan(400);
          longest = Math.max(longest, n);
        }
      }
    }
    expect(longest).toBeLessThan(390);
  });
});
