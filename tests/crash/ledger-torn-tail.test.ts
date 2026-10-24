import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../src/db/sqlite';
import { runMigrations } from '../../src/db/migrations';
import { remember, replayLedger, factsFor, resolveLedgerPath, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';

/**
 * STANDING TEST (adv-crashsafe-1012, F1 and F2). A crash or a full disk during the ledger append leaves a PREFIX of
 * the last event on disk (appendLedgerEvent is one unsynced appendFile). Whatever prefix it is, the engine must still
 * start from the ledger, keep every complete event, and never serve the cut event as if it were whole.
 *
 * Engine start-up is the only caller that sets such a tail aside (replayLedger's setTornTailAside option); the sweeps
 * below are start-ups, so they pass it. Any other caller must refuse and leave the bytes alone (see the last tests).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const OBJECT = 'a-long-object-value-'.repeat(4);
const START_UP = { setTornTailAside: true };

async function ledgerWithThreeFacts(): Promise<{ vault: string; text: string; lastStart: number }> {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'torn-ledger-'));
  dirs.push(vault);
  const db = new Database(':memory:');
  runMigrations(db);
  for (const n of [1, 2, 3]) await remember(db, vault, DEFAULT_LEDGER_REL, { subject: `Tail${n}`, predicate: 'val', object: `${OBJECT}${n}`, statement: `tail fact ${n}` });
  db.close();
  const text = fs.readFileSync(resolveLedgerPath(vault, DEFAULT_LEDGER_REL), 'utf8');
  return { vault, text, lastStart: text.lastIndexOf('\n## ') + 1 };
}

describe('a ledger whose last event was cut by a crash or a full disk', () => {
  it('replays every complete event and never serves a cut event as a whole one, wherever it was cut', async () => {
    const { vault, text, lastStart } = await ledgerWithThreeFacts();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const failures: string[] = [];
    // every proper prefix of the last event (the complete event, with its final newline, is the uncut case)
    for (let cut = lastStart + 1; cut < text.length - 1; cut++) {
      fs.writeFileSync(ledger, text.slice(0, cut));
      const db = new Database(':memory:');
      runMigrations(db);
      try {
        await replayLedger(db, vault, DEFAULT_LEDGER_REL, START_UP);
        const third = factsFor(db, "Tail3") as Array<{ object_text: string }>;
        for (const n of [1, 2]) expect((factsFor(db, `Tail${n}`) as any[]).length).toBe(1);
        if (third.length > 0 && third[0].object_text !== `${OBJECT}3`) failures.push(`cut@${cut - lastStart}: served cut value ${JSON.stringify(third[0].object_text.slice(-12))}`);
      } catch (err) {
        failures.push(`cut@${cut - lastStart}: replay threw ${String((err as Error).message).slice(0, 70)}`);
      } finally { db.close(); }
    }
    expect(failures.length, `${failures.length} cut points broke replay, e.g.\n${failures.slice(0, 4).join("\n")}`).toBe(0);
    // Each cut point is a full start-up that sets its torn tail aside with real fsyncs (~0.04 s each on the dev laptop,
    // ~9 s for the sweep). The 5 s default is a hang guard here, not a timing budget, so it is raised for this sweep only.
  }, 60_000);
});

describe('a ledger whose last event was cut inside a multi-byte character', () => {
  it('starts at every byte cut of the last event, and the event is never served whole', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'torn-utf8-')); dirs.push(vault);
    const db = new Database(':memory:');
    runMigrations(db);
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'AccTail1', predicate: 'val', object: 'um', statement: 'primeiro fato' });
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'AccTail2', predicate: 'val', object: 'dois', statement: 'segundo fato' });
    const accented = 'café — 日本語 🚀 ';
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'AccTail3', predicate: 'val', object: `${accented}${accented}`, statement: `terceiro: ${accented}` });
    db.close();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    // Byte offsets, not string offsets: a cut can fall inside a multi-byte character, which a string slice never does.
    const bytes = fs.readFileSync(ledger);
    const lastStart = bytes.lastIndexOf('\n## ') + 1;
    const failures: string[] = [];
    for (let cut = lastStart + 1; cut < bytes.length - 1; cut++) {
      fs.writeFileSync(ledger, bytes.subarray(0, cut));
      const replay = new Database(':memory:');
      runMigrations(replay);
      try {
        await replayLedger(replay, vault, DEFAULT_LEDGER_REL, START_UP);
        for (const n of [1, 2]) expect((factsFor(replay, `AccTail${n}`) as any[]).length).toBe(1);
        if (factsFor(replay, 'AccTail3').length > 0) failures.push(`cut@${cut - lastStart}: the cut event was served`);
      } catch (err) {
        failures.push(`cut@${cut - lastStart}: replay threw ${String((err as Error).message).slice(0, 70)}`);
      } finally { replay.close(); }
    }
    expect(failures.length, `${failures.length} byte cut points broke start-up, e.g.\n${failures.slice(0, 4).join('\n')}`).toBe(0);
  }, 120_000);
});

describe('a final event that has its kind and object but no source line', () => {
  it('is set aside byte for byte with a loud log, and the whole events before it still replay', async () => {
    const { vault, text, lastStart } = await ledgerWithThreeFacts();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const sourceAt = text.indexOf('- source:', lastStart);
    const sourceless = text.slice(0, sourceAt); // the last block now ends after its object line, with a newline
    fs.writeFileSync(ledger, sourceless);
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      expect(await replayLedger(db, vault, DEFAULT_LEDGER_REL, START_UP)).toBe(2);
      expect(factsFor(db, 'Tail3')).toHaveLength(0);
    } finally { db.close(); }
    expect(fs.readFileSync(ledger, 'utf8')).toBe(text.slice(0, lastStart));
    const torn = fs.readdirSync(path.dirname(ledger)).filter(f => f.startsWith(`${path.basename(ledger)}.torn-`));
    expect(torn).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(ledger), torn[0]), 'utf8')).toBe(sourceless.slice(lastStart));
  });
});

describe('a torn ledger outside engine start-up', () => {
  it('refuses, and moves no bytes, when the caller is not the engine starting up', async () => {
    const { vault, text, lastStart } = await ledgerWithThreeFacts();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const cut = text.slice(0, lastStart + 30); // inside the last event's header and field lines
    fs.writeFileSync(ledger, cut);
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      await expect(replayLedger(db, vault, DEFAULT_LEDGER_REL)).rejects.toThrow(/unterminated/);
    } finally { db.close(); }
    expect(fs.readFileSync(ledger, 'utf8')).toBe(cut);
    expect(fs.readdirSync(path.dirname(ledger)).filter(f => f.includes('.torn-'))).toHaveLength(0);
  });

  it('never moves a final event the index already holds: a ledger edited to drop its last newline replays whole', async () => {
    const { vault, text } = await ledgerWithThreeFacts();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      // The first start applies the three events, so the index holds them.
      expect(await replayLedger(db, vault, DEFAULT_LEDGER_REL, START_UP)).toBe(3);
      // The same ledger, its last newline gone: the final event is complete, and the index says it was applied.
      fs.writeFileSync(ledger, text.slice(0, -1));
      await expect(replayLedger(db, vault, DEFAULT_LEDGER_REL, START_UP)).resolves.toBeGreaterThanOrEqual(0);
      expect(factsFor(db, 'Tail3')).toHaveLength(1);
    } finally { db.close(); }
    expect(fs.readFileSync(ledger, 'utf8')).toBe(text.slice(0, -1));
    expect(fs.readdirSync(path.dirname(ledger)).filter(f => f.includes('.torn-'))).toHaveLength(0);
  });

  it('a final block with a source line and an unknown kind still refuses, and is not moved', async () => {
    const { vault, text } = await ledgerWithThreeFacts();
    const ledger = resolveLedgerPath(vault, DEFAULT_LEDGER_REL);
    const bad = `${text}\n## MEM_BADKIND0000000 · 2026-10-12T00:00:00.000Z\n- kind: delete\n- subject: SynthX\n- predicate: p\n- object: ok\n- source: test\n`;
    fs.writeFileSync(ledger, bad);
    const db = new Database(':memory:');
    runMigrations(db);
    try {
      await expect(replayLedger(db, vault, DEFAULT_LEDGER_REL, START_UP)).rejects.toThrow(/unknown kind "delete"/);
    } finally { db.close(); }
    expect(fs.readFileSync(ledger, 'utf8')).toBe(bad);
    expect(fs.readdirSync(path.dirname(ledger)).filter(f => f.includes('.torn-'))).toHaveLength(0);
  });
});
