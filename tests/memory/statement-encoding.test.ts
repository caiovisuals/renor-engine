import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, replayLedger, parseLedgerEvents, factsFor, LifecycleInputError } from '../../src/memory/lifecycle';
import type Database from '../../src/db/sqlite';

/**
 * The statement is the user's free text, so it must survive ANY character
 * sequence: written once, read back exactly, never able to change how the
 * ledger is framed, and never able to stop the engine from replaying it.
 *
 * Characters are built with String.fromCharCode, never typed as escapes or raw
 * glyphs: U+2028/U+2029 are exactly the characters that corrupt source files,
 * editors and tool pipelines, which is the bug class under test.
 */
const cu = (...codes: number[]) => String.fromCharCode(...codes);
const range = (from: number, to: number) => cu(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
const LS = cu(0x2028); // LINE SEPARATOR
const PS = cu(0x2029); // PARAGRAPH SEPARATOR
const NEL = cu(0x85); // NEXT LINE (C1)
const NUL = cu(0);
/** Anything a line-oriented reader could treat as a control character or line end. */
const UNSAFE_IN_A_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-encoding-'));
  tmpDirs.push(d);
  return d;
}
function freshDb(file: string): Database.Database {
  const db = openDb(file);
  runMigrations(db);
  dbs.push(db);
  return db;
}
const ledgerPath = (v: string) => path.join(v, LEDGER);
const readLedger = (v: string) => fs.readFileSync(ledgerPath(v), 'utf-8');

afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Deterministic PRNG so a failing fuzz case is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What is on disk for one statement: the single `- statement:` line of the single event. */
function statementLines(raw: string): string[] {
  return raw.split('\n').filter(l => l.startsWith('- statement:'));
}

const HOSTILE: Array<[string, string]> = [
  ['U+2028 LINE SEPARATOR', `before${LS}after`],
  ['U+2029 PARAGRAPH SEPARATOR', `before${PS}after`],
  ['U+0085 NEXT LINE', `before${NEL}after`],
  ['DEL and every C1 control, U+007F..U+009F', range(0x7f, 0x9f)],
  ['only line and paragraph separators', LS + PS + NEL + LS],
  ['lone CR, CRLF and LF', 'a\rb\r\nc\nd\r'],
  ['VT, FF, FS, GS, RS', cu(0x0b, 0x0c, 0x1c, 0x1d, 0x1e)],
  ['NUL', `a${NUL}b${NUL}`],
  ['unpaired high surrogate', `a${cu(0xd800)}b`],
  ['unpaired low surrogate', `a${cu(0xdc00)}b`],
  ['reversed surrogate pair', cu(0xdc00, 0xd800)],
  ['surrogate half next to a real pair', `${cu(0xd83d)}\u{1F600}${cu(0xde00)}`],
  ['astral emoji, CJK, combining accent', '\u{1F600} 日本語 é'],
  ['quotes, backslashes and a literal backslash-u escape text', 'say "hi" \\ \\\\ \\u2028 \\n'],
  ['forged event heading and field lines', 'x\n## MEM_FORGED · 2020-01-01T00:00:00.000Z\n- kind: store\n- subject: Mallory\n- statement: "y"\n- source: evil'],
  ['the same forgery without a newline, after separators', `x${LS}## MEM_FORGED · 2020-01-01T00:00:00.000Z${PS}- subject: Mallory`],
  ['JSON that tries to close the string', '"}, {"statement": "'],
  ['markdown fence, wikilink and tag', '```\n[[Other Note]] #tag\n```'],
  ['padding whitespace', '   padded   '],
  ['empty string', ''],
  ['4000 ordinary characters', 'x'.repeat(4000)],
  ['4000 U+2028, the worst-case escape expansion', LS.repeat(4000)],
  ['4000 NUL', NUL.repeat(4000)],
  ['4000 mixed hostile characters', (`${LS}${PS}${NEL}${NUL}"\\\r\n`).repeat(500)],
];

describe('the statement encoding: no character sequence can break the ledger', () => {
  it.each(HOSTILE)('%s: written once, one line, read back exactly, replays on restart and cold rebuild', async (_label, statement) => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: 'Before', predicate: 'p', object: 'one', statement: 'ordinary before' });
    const saved = await remember(db, v, LEDGER, { subject: 'Hostile', predicate: 'p', object: 'two', statement });
    await remember(db, v, LEDGER, { subject: 'After', predicate: 'p', object: 'three', statement: 'ordinary after' });
    expect(saved.action).toBe('store');

    const raw = readLedger(v);
    // Framing: nothing in the statement became a line break, a heading or a field.
    expect(raw.split('\n').filter(l => UNSAFE_IN_A_LINE.test(l))).toEqual([]);
    expect(raw.match(/^## MEM_/gm)).toHaveLength(3);
    expect(raw).not.toMatch(/^## MEM_FORGED/m);
    expect(raw).not.toMatch(/^- subject: Mallory/m);
    expect(statementLines(raw)).toHaveLength(3);
    // The stored form is a JSON string literal for the exact input.
    const line = statementLines(raw)[1];
    expect(JSON.parse(line.slice('- statement: '.length))).toBe(statement);

    // The strict parser reads exactly what was written, nothing more.
    const events = parseLedgerEvents(raw);
    expect(events.map(e => e.subject)).toEqual(['Before', 'Hostile', 'After']);
    expect(events[1].statement).toBe(statement);

    // Restart with the index kept (idempotent replay) and cold rebuild (fresh index).
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    const cold = freshDb(path.join(v, 'cold.db'));
    await expect(replayLedger(cold, v, LEDGER)).resolves.toBe(3);
    expect((factsFor(cold, 'Hostile') as Array<{ object_text: string }>).map(f => f.object_text)).toEqual(['two']);

    // The same words again are still recognised as the same words: no new event.
    const bytes = fs.statSync(ledgerPath(v)).size;
    const again = await remember(db, v, LEDGER, { subject: 'Hostile', predicate: 'p', object: 'two', statement });
    expect(again.action).toBe('nochange');
    expect(fs.statSync(ledgerPath(v)).size).toBe(bytes);
  });

  it('survives a seeded fuzz of hostile characters in one shared ledger', async () => {
    const atoms = [
      'a', 'b', ' ', ' ', 'é', '日本', '\u{1F600}', LS, PS, NEL, cu(0x7f), cu(0x80), cu(0x9f), NUL, '\n', '\r', '\r\n', '\t',
      '"', '\\', '\\u2028', '\\n', '## MEM_X · 2026-01-01T00:00:00.000Z', '- statement: "x"', '- kind: store', '[[link]]', '`', '#', '- ', ': ',
      cu(0xd800), cu(0xdc00), cu(0xd83d), cu(0xde00),
    ];
    const rnd = mulberry32(0x5eed2028);
    const statements: string[] = [];
    for (let i = 0; i < 150; i++) {
      const n = 1 + Math.floor(rnd() * 14);
      statements.push(Array.from({ length: n }, () => atoms[Math.floor(rnd() * atoms.length)]).join(''));
    }

    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    for (let i = 0; i < statements.length; i++) {
      await remember(db, v, LEDGER, { subject: `Fuzz${i}`, predicate: 'p', object: `o${i}`, statement: statements[i] });
    }
    const raw = readLedger(v);
    expect(raw.split('\n').filter(l => UNSAFE_IN_A_LINE.test(l))).toEqual([]);
    expect(raw.match(/^## MEM_/gm)).toHaveLength(statements.length);
    const events = parseLedgerEvents(raw);
    expect(events).toHaveLength(statements.length);
    events.forEach((e, i) => {
      expect(e.subject).toBe(`Fuzz${i}`);
      expect(e.statement).toBe(statements[i]);
    });
    const cold = freshDb(path.join(v, 'cold.db'));
    await expect(replayLedger(cold, v, LEDGER)).resolves.toBe(statements.length);
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
  }, 30_000);

  it('rejects an over-long or non-string statement as an input error and writes nothing', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const base = { subject: 'Long', predicate: 'p', object: 'o' };
    await expect(remember(db, v, LEDGER, { ...base, statement: 'x'.repeat(4001) })).rejects.toBeInstanceOf(LifecycleInputError);
    await expect(remember(db, v, LEDGER, { ...base, statement: LS.repeat(100000) })).rejects.toBeInstanceOf(LifecycleInputError);
    await expect(remember(db, v, LEDGER, { ...base, statement: 42 as unknown as string })).rejects.toBeInstanceOf(LifecycleInputError);
    expect(fs.existsSync(ledgerPath(v))).toBe(false);
    // The limit itself is accepted, in its widest escaped form.
    await expect(remember(db, v, LEDGER, { ...base, statement: LS.repeat(4000) })).resolves.toMatchObject({ action: 'store' });
  });
});

describe('a ledger written by an earlier build still loads', () => {
  const HEAD = '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n';
  const event = (id: string, subject: string, extra: string) =>
    `\n## ${id} · 2026-01-01T00:00:00.000Z\n- kind: store\n- subject: ${subject}\n- predicate: p\n- object: o\n${extra}- source: legacy\n`;

  it('reads statements an earlier build wrote with a literal separator inside the quotes, and treats resends as the same words', async () => {
    const literal = `a${LS}b${PS}c${NEL}d${cu(0x7f)}e`;
    const v = mkvault();
    fs.mkdirSync(path.dirname(ledgerPath(v)), { recursive: true });
    fs.writeFileSync(ledgerPath(v), HEAD + event('MEM_RAW1', 'Raw', `- statement: "${literal}"\n`) + event('MEM_OLD1', 'Old', ''));

    const events = parseLedgerEvents(readLedger(v));
    expect(events.map(e => e.statement)).toEqual([literal, undefined]);
    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(2);

    const bytes = fs.statSync(ledgerPath(v)).size;
    const again = await remember(db, v, LEDGER, { subject: 'Raw', predicate: 'p', object: 'o', statement: literal });
    expect(again.action).toBe('nochange');
    expect(fs.statSync(ledgerPath(v)).size).toBe(bytes);

    // New events are written in the escaped form and the mixed ledger still replays cold.
    await remember(db, v, LEDGER, { subject: 'New', predicate: 'p', object: 'o', statement: `n${LS}w` });
    const after = readLedger(v);
    expect(statementLines(after).filter(l => UNSAFE_IN_A_LINE.test(l))).toHaveLength(1); // only the old literal one remains
    const cold = freshDb(path.join(v, 'cold.db'));
    await expect(replayLedger(cold, v, LEDGER)).resolves.toBe(3);
  });

  it('still rejects a statement field that is not one JSON string literal, including a raw control character inside it', () => {
    for (const bad of ['not quoted', '"unterminated', '"a" trailing', '"a\u0001b"', '42', 'null']) {
      expect(() => parseLedgerEvents(HEAD + event('MEM_BAD', 'Bad', `- statement: ${bad}\n`)), bad).toThrow(/statement is not a JSON string literal/);
    }
  });

  it('reads a line separator inside a structured field as data instead of failing the whole replay', () => {
    // Structured fields are not escaped (they reject control characters), but U+2028/U+2029 are not in
    // that set and used to make the field line unparseable: one such event stopped the engine starting.
    const events = parseLedgerEvents(HEAD + event('MEM_SEP1', `Sub${LS}ject`, '').replace('- object: o', `- object: o${PS}p`));
    expect(events[0].subject).toBe(`Sub${LS}ject`);
    expect(events[0].object).toBe(`o${PS}p`);
    // What stays corruption: a control character (here a lone CR) in a structured field.
    expect(() => parseLedgerEvents(HEAD + event('MEM_SEP2', 'Sub\rject', ''))).toThrow(/control character/);
  });
});

describe('nochange needs the subject spelled exactly as the current event spells it', () => {
  const stmt = 'Keep the exact subject spelling.';
  const subjects = (raw: string) => parseLedgerEvents(raw).map(e => e.subject);

  it('a re-spelled subject is recorded, not swallowed as nochange', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const args = { predicate: 'value', object: 'same', statement: stmt };
    expect((await remember(db, v, LEDGER, { ...args, subject: 'ExactSubject' })).action).toBe('store');
    const respelled = await remember(db, v, LEDGER, { ...args, subject: 'exactsubject' });
    expect(respelled.action).toBe('supersede');
    expect(respelled.eventId).not.toBe('none');
    expect(subjects(readLedger(v))).toEqual(['ExactSubject', 'exactsubject']);

    // Same entity: still exactly one current value, with the earlier spelling in history.
    expect(factsFor(db, 'ExactSubject')).toHaveLength(1);
    expect(factsFor(db, 'ExactSubject', { includeHistory: true })).toHaveLength(2);

    // Now identical to the current event in every field: no growth.
    const bytes = fs.statSync(ledgerPath(v)).size;
    expect((await remember(db, v, LEDGER, { ...args, subject: 'exactsubject' })).action).toBe('nochange');
    expect(fs.statSync(ledgerPath(v)).size).toBe(bytes);

    // And the comparison is against the CURRENT event, so going back is a change too.
    expect((await remember(db, v, LEDGER, { ...args, subject: 'ExactSubject' })).action).toBe('supersede');
    expect(subjects(readLedger(v))).toEqual(['ExactSubject', 'exactsubject', 'ExactSubject']);
  });

  it('is exact for Unicode forms too: NFC and NFD spellings are different words', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const nfc = 'José';
    const nfd = 'José';
    const args = { predicate: 'city', object: 'Lisbon', statement: 'Jose lives in Lisbon.' };
    expect((await remember(db, v, LEDGER, { ...args, subject: nfc })).action).toBe('store');
    expect((await remember(db, v, LEDGER, { ...args, subject: nfd })).action).toBe('supersede');
    expect((await remember(db, v, LEDGER, { ...args, subject: nfd })).action).toBe('nochange');
    expect(subjects(readLedger(v))).toEqual([nfc, nfd]);
  });

  it('leaves a write without a statement unchanged: save_memory style callers still dedupe on value', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const args = { predicate: 'value', object: 'same' };
    await remember(db, v, LEDGER, { ...args, subject: 'ExactSubject', statement: stmt });
    const bytes = fs.statSync(ledgerPath(v)).size;
    expect((await remember(db, v, LEDGER, { ...args, subject: 'exactsubject' })).action).toBe('nochange');
    expect(fs.statSync(ledgerPath(v)).size).toBe(bytes);
  });

  it('records the event when the current fact has no ledger event to compare against', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const args = { subject: 'Orphan', predicate: 'value', object: 'same', statement: stmt };
    await remember(db, v, LEDGER, args);
    // The ledger the current fact points at is gone: the spelling and words cannot be confirmed,
    // so the user's words are written again rather than assumed.
    fs.rmSync(ledgerPath(v));
    expect((await remember(db, v, LEDGER, args)).action).toBe('supersede');
    expect(parseLedgerEvents(readLedger(v))).toHaveLength(1);
  });
});
