import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, factsFor, LifecycleInputError, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { appendDailyMemory } from '../../src/memory/writer';
import { assertStorable, secretGuardEnabled, SecretGuardDecisionModel, SecretRefusedError } from '../../src/extraction/secretGuard';
import { defaultDecisionModel, LocalRulesDecisionModel } from '../../src/extraction/decision-model';
import * as scanner from '../../src/extraction/secretScanner';
import { KEY_SHAPES, Rng, password } from '../../scripts/eval/secret-guard/plantedSet';

/**
 * RENOR_SECRET_GUARD on the write path: `remember` (the lifecycle ledger behind `remember` and `save_memory`) and the
 * daily-note writer refuse text the scanner flags, before anything is written. Planted synthetic secrets only, built
 * at run time. With the guard OFF nothing here applies; secret-guard-off-identity.test.ts proves that.
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];
const SAVED = process.env.RENOR_SECRET_GUARD;

const mkdir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `secret-guard-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const mkdb = () => {
  const db = openDb(path.join(mkdir('db'), 'index.db'));
  runMigrations(db);
  dbs.push(db);
  return db;
};

/** Every file under `dir`, as relative path -> sha256, so "nothing was written" is one comparison. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const dirs = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const factCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) c FROM facts').get() as { c: number }).c;
/** Enough of a secret, from its random end, to find it in anything that was said back. */
const fragments = (secret: string) => [secret.slice(-12), secret.slice(0, 10)].filter(f => f.length >= 8);

beforeEach(() => {
  process.env.RENOR_SECRET_GUARD = '1';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (SAVED === undefined) delete process.env.RENOR_SECRET_GUARD;
  else process.env.RENOR_SECRET_GUARD = SAVED;
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the switch', () => {
  it('is on by default: off only when set to 0, false, no or off, in any case; unset, empty and unknown values keep it on', () => {
    for (const v of [undefined, '', '1', 'true', 'yes', 'on', 'TRUE', ' On ', 'YES', '2', 'enabled', 'y', 'banana', '1 1']) expect(secretGuardEnabled({ RENOR_SECRET_GUARD: v }), String(v)).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', 'OFF', ' No ', 'FALSE']) expect(secretGuardEnabled({ RENOR_SECRET_GUARD: v }), v).toBe(false);
  });

  it('screens a save when the variable is not set at all: the guard is on by default', async () => {
    delete process.env.RENOR_SECRET_GUARD;
    const vault = mkdir('vault');
    const text = `deploy token ${KEY_SHAPES.github(new Rng(2))}`;
    await expect(appendDailyMemory(vault, '2026-10-03', { text, source: 'claude' })).rejects.toBeInstanceOf(SecretRefusedError);
    expect(fs.readdirSync(vault)).toEqual([]);
  });

  it('is read when a write happens, so the process environment is the one switch', async () => {
    const vault = mkdir('vault');
    const text = `deploy token ${KEY_SHAPES.github(new Rng(1))}`;
    process.env.RENOR_SECRET_GUARD = '0';
    await appendDailyMemory(vault, '2026-10-03', { text, source: 'claude' });
    process.env.RENOR_SECRET_GUARD = 'on';
    await expect(appendDailyMemory(vault, '2026-10-03', { text, source: 'claude' })).rejects.toBeInstanceOf(SecretRefusedError);
  });
});

describe('the daily-note writer', () => {
  const r = new Rng(11);
  const key = KEY_SHAPES.openai_proj(r);

  it('refuses a note with a credential in it, names the field, and writes nothing, not even the directory', async () => {
    const vault = mkdir('vault');
    const err = await appendDailyMemory(vault, '2026-10-03', { text: `the staging key is ${key}, do not lose it`, source: 'claude' }, 'Memory/Daily').catch(e => e);
    expect(err).toBeInstanceOf(SecretRefusedError);
    expect(err).toMatchObject({ name: 'SecretRefusedError', field: 'note text', reason: 'credential' });
    expect(dirs(vault)).toEqual([]);
  });

  it('refuses a payment card as a personal identifier', async () => {
    const vault = mkdir('vault');
    await expect(appendDailyMemory(vault, '2026-10-03', { text: 'Charge the renewal to card 4242 4242 4242 4242.', source: 'claude' }))
      .rejects.toMatchObject({ field: 'note text', reason: 'identifier' });
    expect(dirs(vault)).toEqual([]);
  });

  it('says what happened and what to do without saying the secret', async () => {
    const vault = mkdir('vault');
    const err = (await appendDailyMemory(vault, '2026-10-03', { text: `token ${key}`, source: 'claude' }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('Nothing was saved');
    expect(err.message).toContain('credential');
    expect(err.message).toContain('Save what it is for instead');
    for (const f of fragments(key)) expect(err.message).not.toContain(f);
  });

  it('checks the source in the form it is stored: stripping spaces can join the pieces of a key', async () => {
    const vault = mkdir('vault');
    const aws = KEY_SHAPES.aws_id(new Rng(2));
    const spaced = aws.match(/.{1,4}/g)!.join(' ');
    expect(scanner.scanSecrets(spaced)).toBeNull(); // as given, nothing in it is a key
    await expect(appendDailyMemory(vault, '2026-10-03', { text: 'a harmless note', source: spaced }))
      .rejects.toMatchObject({ field: 'note source', reason: 'credential' });
    expect(dirs(vault)).toEqual([]);
  });

  it('stores an ordinary note exactly as it does without the guard', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T08:30:00.000Z'));
    const guarded = mkdir('vault');
    const open = mkdir('vault');
    const entry = { text: 'I moved to Lisbon in March and I work near the river.\n- a second line', source: 'claude' };
    await appendDailyMemory(guarded, '2026-10-03', entry);
    process.env.RENOR_SECRET_GUARD = '0';
    await appendDailyMemory(open, '2026-10-03', entry);
    expect(tree(guarded)).toEqual(tree(open));
    expect(Object.keys(tree(guarded))).toEqual([path.join('Memory', 'Daily', '2026-10-03.md')]);
  });

  it('keeps writing after a refusal: the file lock is not left held', async () => {
    const vault = mkdir('vault');
    await appendDailyMemory(vault, '2026-10-03', { text: 'first', source: 'claude' });
    await expect(appendDailyMemory(vault, '2026-10-03', { text: `token ${key}`, source: 'claude' })).rejects.toBeInstanceOf(SecretRefusedError);
    await appendDailyMemory(vault, '2026-10-03', { text: 'second', source: 'claude' });
    const body = fs.readFileSync(path.join(vault, 'Memory', 'Daily', '2026-10-03.md'), 'utf8');
    expect(body).toContain('first');
    expect(body).toContain('second');
    expect(body).not.toContain(key);
  });

  it('keeps the checks it already had, in the same order: a bad date or an oversized note is refused as before', async () => {
    const vault = mkdir('vault');
    await expect(appendDailyMemory(vault, '2026-02-31', { text: `token ${key}`, source: 'claude' })).rejects.toThrow('valid YYYY-MM-DD calendar date');
    await expect(appendDailyMemory(vault, '2026-10-03', { text: `token ${key} ` + 'x'.repeat(4000), source: 'claude' })).rejects.toThrow('exceeds the maximum length');
    expect(dirs(vault)).toEqual([]);
  });
});

describe('remember (the fact ledger behind remember and save_memory)', () => {
  const r = new Rng(21);
  const ledger = (vault: string) => path.join(vault, DEFAULT_LEDGER_REL);

  it('refuses a statement with a credential, as a caller error, and touches neither the ledger nor the index', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const key = KEY_SHAPES.stripe(r);
    const err = await remember(db, vault, DEFAULT_LEDGER_REL, {
      subject: 'Rowan', predicate: 'uses_payments', object: 'Stripe', statement: `my live key is ${key}`,
    }).catch(e => e);
    expect(err).toBeInstanceOf(LifecycleInputError); // so an HTTP surface answers 4xx, like every other rejected field
    expect(err).toMatchObject({ field: 'statement' });
    expect(err.message).toContain('Nothing was saved');
    for (const f of fragments(key)) expect(err.message).not.toContain(f);
    expect(dirs(vault)).toEqual([]);
    expect(factCount(db)).toBe(0);
  });

  it('refuses a credential in the value, which is what save_memory stores', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'stripe', predicate: 'account', object: KEY_SHAPES.github(r) }))
      .rejects.toMatchObject({ name: 'LifecycleInputError', field: 'subject, predicate and object' });
    expect(dirs(vault)).toEqual([]);
    expect(factCount(db)).toBe(0);
  });

  it('reads subject, predicate and object together, because the cue is usually in the predicate', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const pw = password(r);
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'home router', predicate: 'admin_password', object: pw }))
      .rejects.toMatchObject({ name: 'LifecycleInputError', field: 'subject, predicate and object', message: expect.stringContaining('a credential') });
    expect(dirs(vault)).toEqual([]);
    // The same value under a predicate that does not say what it is: nothing in the text marks it. This is the
    // scanner's limit, stated here so it is not a surprise.
    expect(scanner.scanSecrets(`home router note: ${pw}`)).toBeNull();
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'home router', predicate: 'note', object: pw });
    expect(factCount(db)).toBe(1);
  });

  it('refuses a credential in the source', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Rowan', predicate: 'works_at', object: 'Memory Company', source: KEY_SHAPES.github(r) }))
      .rejects.toMatchObject({ field: 'source' });
    expect(factCount(db)).toBe(0);
  });

  it('never replaces a live value with a refused one: the current fact stays what it was', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'home router', predicate: 'admin_hint', object: 'sticker on the back' });
    const before = tree(vault);
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'home router', predicate: 'admin_hint', object: `password: ${password(r)}` }))
      .rejects.toBeInstanceOf(LifecycleInputError);
    expect(tree(vault)).toEqual(before);
    const current = (factsFor(db, 'home router') as Array<{ predicate: string; object_text: string; valid_to: string | null }>).filter(f => f.valid_to === null);
    expect(current.map(f => f.object_text)).toEqual(['sticker on the back']);
  });

  it('stores an ordinary fact exactly as it does without the guard', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T08:30:00.000Z'));
    const ids = new Rng(5);
    vi.spyOn(Math, 'random').mockImplementation(() => ids.next());
    const guarded = mkdir('vault');
    const open = mkdir('vault');
    const fact = { subject: 'Rowan', predicate: 'works_at', object: 'Memory Company', source: 'claude', scope: 'project:renor', statement: 'I work at Memory Company now.' };
    await remember(mkdb(), guarded, DEFAULT_LEDGER_REL, fact);
    process.env.RENOR_SECRET_GUARD = 'off';
    const ids2 = new Rng(5);
    vi.spyOn(Math, 'random').mockImplementation(() => ids2.next());
    await remember(mkdb(), open, DEFAULT_LEDGER_REL, fact);
    expect(tree(guarded)).toEqual(tree(open));
    expect(fs.existsSync(ledger(guarded))).toBe(true);
  });

  it('keeps writing after a refusal: the write chain is not left held, and concurrent writes are judged one by one', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const results = await Promise.allSettled([
      remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'a', predicate: 'likes', object: 'tea' }),
      remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'b', predicate: 'api_key', object: KEY_SHAPES.openai_classic(r) }),
      remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'c', predicate: 'likes', object: 'coffee' }),
    ]);
    expect(results.map(x => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    const body = fs.readFileSync(ledger(vault), 'utf8');
    expect(body).toContain('tea');
    expect(body).toContain('coffee');
    expect(factCount(db)).toBe(2);
  });

  it('keeps the checks it already had, first: a bad field is refused as before, with the guard on or off', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const key = KEY_SHAPES.github(r);
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 123 as unknown as string, predicate: 'p', object: key })).rejects.toThrow('lifecycle subject must be a string');
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 's', predicate: 'p', object: key, statement: 'x'.repeat(4001) })).rejects.toThrow('exceeds the maximum length');
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 's', predicate: 'p', object: `${key}\n` })).rejects.toThrow('control characters');
    expect(dirs(vault)).toEqual([]);
  });
});

describe('the DecisionModel seam', () => {
  it('asks the capture gate about each text it is about to store, and stops at the first refusal', async () => {
    const spy = vi.spyOn(SecretGuardDecisionModel.prototype, 'decide');
    const vault = mkdir('vault');
    const db = mkdb();
    const key = KEY_SHAPES.slack(new Rng(8));
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Rowan', predicate: 'likes', object: 'tea', source: 'claude', statement: 'I like tea.' })).resolves.toBeTruthy();
    expect(spy.mock.calls.map(c => c[0])).toEqual([
      { task: 'capture_gate', text: 'I like tea.' },
      { task: 'capture_gate', text: 'Rowan likes: tea' },
      { task: 'capture_gate', text: 'claude' },
    ]);
    spy.mockClear();
    await expect(remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Rowan', predicate: 'likes', object: 'tea', statement: `key ${key}` })).rejects.toBeInstanceOf(LifecycleInputError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers sensitive for a flagged text with the finding, and leaves every other decision to the inner model', async () => {
    const model = new SecretGuardDecisionModel();
    const local = new LocalRulesDecisionModel();
    const flagged = await model.decide({ task: 'capture_gate', text: `token ${KEY_SHAPES.github(new Rng(3))}` });
    expect(flagged).toMatchObject({ task: 'capture_gate', decision: 'sensitive', confidence: 1, costUSDCents: 0, finding: { class: 'credential', rule: 'github-token' } });
    const fact = 'Rowan ran 42 km in the marathon.';
    expect((await model.decide({ task: 'capture_gate', text: fact })).decision).toBe((await local.decide({ task: 'capture_gate', text: fact })).decision);
    const dedupe = { task: 'dedupe_adjudication' as const, candidate: { value: '3:45', object: 'Marathon' }, existing: { value: '3:50', object: 'Marathon' } };
    expect((await model.decide(dedupe)).decision).toBe((await local.decide(dedupe)).decision);
  });

  it('is not the default decision model: the flag changes nothing the indexer decides', async () => {
    const verdict = await defaultDecisionModel().decide({ task: 'capture_gate', text: `token ${KEY_SHAPES.github(new Rng(3))}` });
    expect(verdict.decision).not.toBe('sensitive');
  });
});

describe('failing closed', () => {
  it('refuses the save when the decision itself fails, in the note writer', async () => {
    vi.spyOn(SecretGuardDecisionModel.prototype, 'decide').mockRejectedValue(new Error('boom'));
    const vault = mkdir('vault');
    const err = await appendDailyMemory(vault, '2026-10-03', { text: 'a perfectly ordinary note', source: 'claude' }).catch(e => e);
    expect(err).toBeInstanceOf(SecretRefusedError);
    expect(err).toMatchObject({ field: 'note text', reason: 'unavailable' });
    expect(err.message).toContain('Nothing was saved');
    expect(err.message).toContain('could not check');
    expect(err.message).not.toContain('boom'); // the cause stays out of what the caller is told
    expect(dirs(vault)).toEqual([]);
  });

  it('refuses the save when the scanner throws, in the fact ledger, as a fault of the engine and not a bad request', async () => {
    vi.spyOn(scanner, 'scanSecrets').mockImplementation(() => { throw new RangeError('out of stack'); });
    const vault = mkdir('vault');
    const db = mkdb();
    const err = await remember(db, vault, DEFAULT_LEDGER_REL, { subject: 'Rowan', predicate: 'likes', object: 'tea' }).catch(e => e);
    expect(err).toBeInstanceOf(SecretRefusedError);
    expect(err).not.toBeInstanceOf(LifecycleInputError); // not the caller's mistake: an HTTP surface keeps it a 5xx
    expect(err.reason).toBe('unavailable');
    expect(dirs(vault)).toEqual([]);
    expect(factCount(db)).toBe(0);
  });

  it('keeps every refusal message under the 400 characters the MCP error reply keeps, with room to spare', () => {
    let longest = 0;
    for (const field of ['statement', 'subject, predicate and object', 'source', 'note text', 'note source']) {
      for (const reason of ['credential', 'identifier', 'sensitive', 'unavailable'] as const) {
        const n = new SecretRefusedError(field, reason).message.length;
        expect(n, `${field} / ${reason}`).toBeLessThan(400);
        longest = Math.max(longest, n);
      }
    }
    expect(longest).toBeLessThan(390);
  });
});

describe('what the operator sees', () => {
  it('logs one JSON line per refusal with the field and the reason, and nothing the request said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vault = mkdir('vault');
    const key = KEY_SHAPES.anthropic(new Rng(12));
    await expect(appendDailyMemory(vault, '2026-10-03', { text: `token ${key} for the card 4242 4242 4242 4242`, source: 'claude' })).rejects.toBeInstanceOf(SecretRefusedError);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'secret_guard_refusal', action: 'save', field: 'note text', reason: 'credential' });
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(['action', 'event', 'field', 'reason', 'ts']);
    for (const f of fragments(key)) expect(line).not.toContain(f);
    expect(line).not.toContain('4242');
  });

  it('logs the kind of error, and only that, when the guard could not decide', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(scanner, 'scanSecrets').mockImplementation(() => { throw new RangeError('input: a very private sentence'); });
    await expect(appendDailyMemory(mkdir('vault'), '2026-10-03', { text: 'a very private sentence', source: 'claude' })).rejects.toMatchObject({ reason: 'unavailable' });
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'secret_guard_refusal', reason: 'unavailable', error: 'RangeError' });
    expect(line).not.toContain('private');
  });

  it('logs nothing for a save it allows, or when the guard is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendDailyMemory(mkdir('vault'), '2026-10-03', { text: 'a perfectly ordinary note', source: 'claude' });
    process.env.RENOR_SECRET_GUARD = '0';
    await appendDailyMemory(mkdir('vault'), '2026-10-03', { text: `token ${KEY_SHAPES.github(new Rng(13))}`, source: 'claude' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('assertStorable', () => {
  it('does nothing and asks nothing when the guard is off', async () => {
    process.env.RENOR_SECRET_GUARD = '0';
    const decide = vi.spyOn(SecretGuardDecisionModel.prototype, 'decide');
    const scan = vi.spyOn(scanner, 'scanSecrets');
    await assertStorable([{ field: 'x', text: `token ${KEY_SHAPES.github(new Rng(4))}` }]);
    expect(decide).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('skips a field that was not given and one that is empty', async () => {
    const decide = vi.spyOn(SecretGuardDecisionModel.prototype, 'decide');
    await assertStorable([{ field: 'a', text: undefined }, { field: 'b', text: '' }]);
    expect(decide).not.toHaveBeenCalled();
  });
});
