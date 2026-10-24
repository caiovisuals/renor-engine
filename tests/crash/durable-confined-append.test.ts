import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { runMigrations } from '../../src/db/migrations';
import { appendDailyEntry } from '../../src/memory/writer';
import { appendLedgerEvent, remember, replayLedger, resolveLedgerPath, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';

/**
 * The one append for the daily log and the ledger (appendConfined) keeps BOTH guarantees: it is confined to the vault
 * (adv-vaultfs-1012 F1: a planted link or hard link is refused, never followed) and durable (adv-crashsafe-1012 F1-F3: a
 * failed write is cut back, a crash cut is detected). These tests hold the two against each other.
 */
const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const CANARY = 'export PATH=$PATH:/opt/canary\n'.repeat(20);
const EV = (id: string, object: string) => ({
  id, at: '2026-10-12T00:00:00.000Z', kind: 'store' as const, subject: 'S', predicate: 'p', object, closedEvent: null, source: 'test',
});

function vaultWithOutside(): { vault: string; outside: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'durable-confined-')));
  roots.push(root);
  const vault = path.join(root, 'vault');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
  return { vault, outside };
}

describe('a hard link planted on the append path', () => {
  it('refuses the ledger, and the file it shares a name with is neither truncated nor written', async () => {
    const { vault, outside } = vaultWithOutside();
    await appendLedgerEvent(vault, DEFAULT_LEDGER_REL, EV('MEM_AAAAAAAAAAAAAA', 'before'));
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const target = path.join(outside, 'shell-profile.md');
    fs.writeFileSync(target, CANARY);
    fs.unlinkSync(ledger);
    fs.linkSync(target, ledger);
    // A refused file has no cut-back: the bytes it shares with the outside file are never truncated to a length.
    await expect(appendLedgerEvent(vault, DEFAULT_LEDGER_REL, EV('MEM_BBBBBBBBBBBBBB', 'planted'))).rejects.toThrow(/refusing to write/);
    expect(fs.readFileSync(target, 'utf8')).toBe(CANARY);
  });

  it('refuses the daily note, and the file it shares a name with is neither truncated nor written', async () => {
    const { vault, outside } = vaultWithOutside();
    const dir = path.join(vault, 'Memory', 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(outside, 'notes.md');
    fs.writeFileSync(target, CANARY);
    fs.linkSync(target, path.join(dir, '2026-10-12.md'));
    await expect(appendDailyEntry(vault, '2026-10-12', { text: 'planted', source: 'test' })).rejects.toThrow(/refusing to write/);
    expect(fs.readFileSync(target, 'utf8')).toBe(CANARY);
  });
});

describe('a crash cut in a ledger written through the append', () => {
  it('is refused outside start-up, and set aside byte for byte at start-up', async () => {
    const { vault } = vaultWithOutside();
    const db = new Database(':memory:');
    runMigrations(db);
    for (const n of [1, 2]) {
      await remember(db, vault, DEFAULT_LEDGER_REL, { subject: `Cut${n}`, predicate: 'val', object: `object-${n}`.repeat(10), statement: `cut fact ${n}` });
    }
    db.close();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const text = fs.readFileSync(ledger, 'utf8');
    // A crash after the second event's header and fields, before its source line: the final event is unterminated.
    const lastStart = text.lastIndexOf('\n## ') + 1;
    const cut = text.lastIndexOf('- source: ');
    const cutText = text.slice(0, cut);
    fs.writeFileSync(ledger, cutText);

    const refusing = new Database(':memory:');
    runMigrations(refusing);
    try {
      await expect(replayLedger(refusing, vault, DEFAULT_LEDGER_REL)).rejects.toThrow(/unterminated/);
    } finally { refusing.close(); }
    expect(fs.readFileSync(ledger, 'utf8')).toBe(cutText);

    const startUp = new Database(':memory:');
    runMigrations(startUp);
    try {
      expect(await replayLedger(startUp, vault, DEFAULT_LEDGER_REL, { setTornTailAside: true })).toBe(1);
    } finally { startUp.close(); }
    expect(fs.readFileSync(ledger, 'utf8')).toBe(text.slice(0, lastStart));
    const torn = fs.readdirSync(path.dirname(ledger)).filter(f => f.startsWith(`${path.basename(ledger)}.torn-`));
    expect(torn).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(ledger), torn[0]), 'utf8')).toBe(cutText.slice(lastStart));
  });
});

describe('the restore step the start-up log names', () => {
  it('brings a set-aside hand-written event back when it is done exactly as the log says', async () => {
    const { vault } = vaultWithOutside();
    const db = new Database(':memory:');
    runMigrations(db);
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Kept', predicate: 'val', object: 'kept object', statement: 'kept fact' });
    db.close();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    // A hand-written event with no `- source:` line, complete up to its final newline: the engine cannot tell it from a cut.
    const handWritten = '\n## mem_HANDWRITTEN0001 · 2026-10-12T00:00:00.000Z\n- kind: store\n- subject: Hand\n- predicate: val\n- object: written by hand\n';
    fs.appendFileSync(ledger, handWritten);

    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const startUp = new Database(':memory:');
    runMigrations(startUp);
    try {
      expect(await replayLedger(startUp, vault, DEFAULT_LEDGER_REL, { setTornTailAside: true })).toBe(1);
    } finally { startUp.close(); spy.mockRestore(); }
    const torn = fs.readdirSync(path.dirname(ledger)).find(f => f.startsWith(`${path.basename(ledger)}.torn-`))!;
    // The set-aside bytes are the event from its header on: the newline before the header stays with the whole event.
    const tornBytes = fs.readFileSync(path.join(path.dirname(ledger), torn), 'utf8');
    expect(tornBytes).toBe(handWritten.slice(1));
    // The log names the step: add the `- source:` line and a final newline, append the bytes, restart.
    expect(logged.join('\n')).toContain('- source:');
    fs.appendFileSync(ledger, tornBytes + '- source: restored by hand\n');

    const restarted = new Database(':memory:');
    runMigrations(restarted);
    try {
      expect(await replayLedger(restarted, vault, DEFAULT_LEDGER_REL, { setTornTailAside: true })).toBe(2);
    } finally { restarted.close(); }
    expect(fs.readdirSync(path.dirname(ledger)).filter(f => f.includes('.torn-'))).toHaveLength(1);
  });
});

describe('a file the append created, whose open lands outside the vault', () => {
  it('is not removed by name', async () => {
    const { vault, outside } = vaultWithOutside();
    const dir = path.join(vault, 'Memory', 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '2026-10-12.md');
    const realReadlink = fsp.readlink.bind(fsp);
    // The kernel's answer for the new descriptor says it landed outside (a directory swapped for a link during the write).
    const spy = vi.spyOn(fsp, 'readlink').mockImplementation(async (p: fs.PathLike) => (
      String(p).startsWith('/proc/self/fd/') ? path.join(outside, '2026-10-12.md') : realReadlink(p)
    ));
    try {
      await expect(appendDailyEntry(vault, '2026-10-12', { text: 'swapped', source: 'test' })).rejects.toThrow(/outside the vault/);
    } finally { spy.mockRestore(); }
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('a planted link on the start-up cut of a torn ledger', () => {
  async function tornLedger(root: string): Promise<Buffer> {
    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch);
    const db = new Database(':memory:');
    runMigrations(db);
    for (const n of [1, 2]) {
      await remember(db, scratch, DEFAULT_LEDGER_REL, { subject: `Outside${n}`, predicate: 'val', object: `object-${n}`.repeat(10), statement: `outside fact ${n}` });
    }
    db.close();
    const text = fs.readFileSync(resolveLedgerPath(scratch, DEFAULT_LEDGER_REL), 'utf8');
    return Buffer.from(text.slice(0, text.lastIndexOf('- source: ')));
  }

  it.each(['symlink', 'hard link', 'symlinked System directory'] as const)('refuses to start, and the outside file is neither cut nor copied (%s)', async kind => {
    const { vault, outside } = vaultWithOutside();
    const torn = await tornLedger(path.dirname(outside));
    const victimDir = path.join(outside, 'elsewhere');
    fs.mkdirSync(victimDir);
    const victim = path.join(victimDir, 'Memory Events Ledger.md');
    fs.writeFileSync(victim, torn);
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    if (kind === 'symlink') fs.symlinkSync(victim, ledger);
    else if (kind === 'hard link') fs.linkSync(victim, ledger);
    else {
      fs.rmSync(path.dirname(ledger), { recursive: true, force: true });
      fs.symlinkSync(victimDir, path.dirname(ledger));
    }
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      await expect(replayLedger(db, vault, DEFAULT_LEDGER_REL, { setTornTailAside: true })).rejects.toThrow(/refusing to write/);
    } finally { db.close(); }
    expect(fs.readFileSync(victim)).toEqual(torn);
    expect(fs.readdirSync(victimDir).filter(f => f.includes('.torn-'))).toEqual([]);
    expect(fs.readdirSync(path.dirname(ledger)).filter(f => f.includes('.torn-'))).toEqual([]);
  });
});
