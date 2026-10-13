// Adversary review of the vault confinement fix: the walk (lstat of each directory) and the open are two steps, so a
// process with write access inside the vault could swap a directory for a link between them and have a confined write land
// outside the vault (escaped within 76 to 198 ms in the review). The writers now ask the kernel where the opened file really
// is before the first byte. This test races a real second process that flips a vault directory between the real one and a
// link to an outside directory, and asserts that no byte of what the engine writes ever lands outside.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { appendConfined, writeConfined } from '../../src/memory/confinedWrite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { readSource } from '../../src/importing/source';
import { buildImportPlan } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';
import { BUNDLE_FORMAT } from '../../src/importing/types';

// The check reads /proc/self/fd; without /proc (not Linux) the race stays open and is documented in README.public.md.
const HAS_PROC = fs.existsSync('/proc/self/fd');
const RACE_MS = 4000;
const CANARY = 'ENGINE-WRITE-';

let root: string;
let vault: string;
let outside: string;
let racer: ChildProcess | undefined;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'confined-race-')));
  vault = path.join(root, 'vault');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(vault, 'Memory/Daily'), { recursive: true });
  fs.mkdirSync(outside);
});
afterEach(() => {
  racer?.kill('SIGKILL');
  racer = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A second process that keeps replacing `dir` by a link to `outside`, and back, as fast as it can. */
async function startRacer(dir: string): Promise<void> {
  const script = `
    const fs = require('fs');
    const [dir, outside] = process.argv.slice(1);
    const stash = dir + '-stash';
    process.stdout.write('ready\\n');
    for (;;) {
      try { fs.renameSync(dir, stash); } catch {}
      try { fs.symlinkSync(outside, dir); } catch {}
      try { fs.unlinkSync(dir); } catch {}
      try { fs.renameSync(stash, dir); } catch {}
    }`;
  racer = spawn(process.execPath, ['-e', script, dir, outside], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    racer!.once('error', reject);
    racer!.stdout!.once('data', () => resolve());
  });
}

/** Bytes that reached the outside directory. An empty file left by a refused create is not a leak. */
function leaked(): string[] {
  return fs.readdirSync(outside)
    .map(name => fs.readFileSync(path.join(outside, name), 'utf8'))
    .filter(content => content.includes(CANARY));
}

describe.skipIf(!HAS_PROC)('a confined write raced by a process swapping a vault directory for a link', () => {
  it('appendConfined never lands a byte outside the vault', async () => {
    await startRacer(path.join(vault, 'Memory/Daily'));
    const deadline = Date.now() + RACE_MS;
    let attempts = 0;
    for (; Date.now() < deadline && leaked().length === 0; attempts++) {
      await appendConfined(vault, 'Memory/Daily/2026-10-12.md', `${CANARY}${attempts}\n`).catch(() => undefined);
    }
    expect(attempts).toBeGreaterThan(0);
    expect(leaked()).toEqual([]);
  }, RACE_MS + 10000);

  it('writeConfined never lands a byte outside the vault', async () => {
    await startRacer(path.join(vault, 'Memory/Daily'));
    const deadline = Date.now() + RACE_MS;
    let attempts = 0;
    for (; Date.now() < deadline && leaked().length === 0; attempts++) {
      await writeConfined(vault, 'Memory/Daily/conversation.md', `${CANARY}${attempts}\n`).catch(() => undefined);
    }
    expect(attempts).toBeGreaterThan(0);
    expect(leaked()).toEqual([]);
  }, RACE_MS + 10000);

  it('the import apply layer never lands a byte outside the memory directory', async () => {
    const dbPath = path.join(vault, '.memory-index', 'index.db');
    const db = openDb(dbPath);
    runMigrations(db);
    db.close();
    const notes = Array.from({ length: 400 }, (_, i) => JSON.stringify({
      type: 'note', path: `/s/n${i}.md`, relPath: `n${i}.md`, title: `n${i}`, modifiedAt: '2026-01-02T03:04:05.000Z',
      chunks: [{ headingPath: `n${i}`, text: `# n${i}\n\n${CANARY}${i}`, tokenCount: 3 }], entities: [],
    }));
    const file = path.join(root, 'bundle.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'meta', format: BUNDLE_FORMAT, source: 's' }), ...notes].join('\n') + '\n');
    const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
    const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
    fs.mkdirSync(path.join(vault, 'Imported/src'), { recursive: true });
    await startRacer(path.join(vault, 'Imported/src'));
    const deadline = Date.now() + RACE_MS;
    let attempts = 0;
    for (; Date.now() < deadline && leaked().length === 0; attempts++) {
      await applyImportPlan(plan, bundle, { memoryDir: vault, dbPath }).catch(() => undefined);
    }
    expect(attempts).toBeGreaterThan(0);
    expect(leaked()).toEqual([]);
  }, RACE_MS + 20000);
});
