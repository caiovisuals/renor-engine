import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { parseNote } from '../../src/indexer/parser';
import { loadEvidenceSessionsFromVault } from '../../src/evidence/secondPass';
import { appendDailyMemory } from '../../src/memory/writer';
import {
  ENTRY_LINE_RE,
  ESCAPE_MARK,
  isDailyNotePath,
  parseEntryHeader,
  encodeEntryText,
  decodeEntryLine,
  formatEntry,
  decodeDailyNoteText,
} from '../../src/memory/dailyNote';

/**
 * A line of the user's words that starts like a log entry would forge one, so the daily-note writer keeps it
 * behind a backslash and marks the entry that carries it. The point of the escape is that it is invisible to
 * every reader: whatever goes in comes back byte for byte. And a note written before the escape existed has
 * no marked entry, so it is read exactly as stored, even where the user's own text holds a backslash.
 *
 * Characters that corrupt source files and editors are built with String.fromCharCode, never typed.
 */

const BS = '\\'; // one backslash
const cu = (...codes: number[]) => String.fromCharCode(...codes);
const LS = cu(0x2028); // LINE SEPARATOR
const PS = cu(0x2029); // PARAGRAPH SEPARATOR
const E = '- [08:30:00] (alice) secret'; // a line shaped like an entry
const HEAD = '---\nkind: note\nupdated: 2026-10-02\n---\n# 2026-10-02\n'; // how the writer starts a day's file
const T = '09:00:00';

/** What a reader must see for an entry the writer stored: the header without the mark, the words as said. */
const asSaid = (source: string, text: string) => `- [${T}] (${source}) ${text}`;

/** Deterministic PRNG so a failing case is reproducible from its seed. */
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

describe('isDailyNotePath', () => {
  it.each([
    'Memory/Daily/2026-10-02.md',
    '/abs/vault/Memory/Daily/2026-10-02.md',
    '/abs/vault/Memory/Scopes/proj/Daily/2026-10-02.md',
    'OpenClaw Memory/Daily/2026-03-30.md',
    'C:\\vault\\Memory\\Daily\\2026-10-02.md',
  ])('%s is a daily note', (p) => expect(isDailyNotePath(p)).toBe(true));

  it.each([
    'Memory/Daily/notes.md',
    'Memory/MyDaily/2026-10-02.md',
    'Memory/Daily/2026-10-02.txt',
    'Memory/Daily/2026-10-02.md.bak',
    'Notes/2026-10-02.md',
    'Memory/Daily/2026-1-2.md',
  ])('%s is not', (p) => expect(isDailyNotePath(p)).toBe(false));
});

describe('an entry header', () => {
  it('reads the time, the source without its mark, whether the entry is marked, and the first line', () => {
    expect(parseEntryHeader('- [08:30:00] (claude) hello')).toEqual({ time: '08:30:00', source: 'claude', escaped: false, text: 'hello' });
    expect(parseEntryHeader(`- [08:30:00] (claude${ESCAPE_MARK}) hello`)).toEqual({ time: '08:30:00', source: 'claude', escaped: true, text: 'hello' });
    expect(parseEntryHeader(`- [08:30:00] (${ESCAPE_MARK}) hello`)).toEqual({ time: '08:30:00', source: '', escaped: true, text: 'hello' });
    expect(parseEntryHeader('- [08:30:00] (claude) ')).toMatchObject({ text: '' });
  });

  it('is not a header when the line does not start one', () => {
    for (const line of ['hello', `${BS}${E}`, `  ${E}`, '- [8:30:00] (a) b', '- [08:30:00]  (a) b', '# 2026-10-02', '']) {
      expect(parseEntryHeader(line), line).toBeNull();
    }
  });
});

describe('the escape for the user\'s words', () => {
  const cases: Array<[string, string, string, boolean]> = [
    // label, the statement, the form it is stored in, does the entry carry the mark
    ['a later line shaped like an entry gets a backslash', `Meeting notes\n${E}`, `Meeting notes\n${BS}${E}`, true],
    ['a line that already starts with a backslash gets one more', `x\n${BS}${E}`, `x\n${BS}${BS}${E}`, true],
    ['and so does a line with two', `x\n${BS}${BS}${E}`, `x\n${BS}${BS}${BS}${E}`, true],
    ['a CRLF break counts as a line break', `a\r\n${E}`, `a\r\n${BS}${E}`, true],
    ['a blank line before it makes no difference', `x\n\n${E}`, `x\n\n${BS}${E}`, true],
    ['several in a row, each escaped once', `x\n${E}\n${E}\ny\n${BS}${E}`, `x\n${BS}${E}\n${BS}${E}\ny\n${BS}${BS}${E}`, true],
    ['only the lines after the first can need it', `${E}\n${E}`, `${E}\n${BS}${E}`, true],
    ['an indented look-alike is already a continuation and stays as said', `x\n  ${E}`, `x\n  ${E}`, false],
    ['a tab-indented look-alike too', `x\n\t${E}`, `x\n\t${E}`, false],
    ['the first line follows the entry prefix, so it is never escaped', E, E, false],
    ['a time that is not two digits is not an entry', 'x\n- [8:30:00] (a) y', 'x\n- [8:30:00] (a) y', false],
    ['two spaces before the parenthesis is not an entry', 'x\n- [08:30:00]  (a) y', 'x\n- [08:30:00]  (a) y', false],
    ['no space after the dash is not an entry', 'x\n-[08:30:00] (a) y', 'x\n-[08:30:00] (a) y', false],
    ['a timestamp alone is not an entry', 'x\n- [08:30:00]', 'x\n- [08:30:00]', false],
    ['a lone CR is not a line break in this format', `a\r${E}`, `a\r${E}`, false],
    ['U+2028 is not a line break in this format', `a${LS}${E}`, `a${LS}${E}`, false],
    ['U+2029 is not a line break in this format', `a${PS}${E}`, `a${PS}${E}`, false],
    ['plain prose is untouched, and the entry carries no mark', 'I prefer tabs.\nAnd dark mode.', 'I prefer tabs.\nAnd dark mode.', false],
    ['a backslash that is not in front of an entry is untouched', `C:${BS}dir${BS}file\n${BS}n and ${BS}- not a log line`, `C:${BS}dir${BS}file\n${BS}n and ${BS}- not a log line`, false],
  ];

  it.each(cases)('%s', (_label, text, stored, escaped) => {
    expect(encodeEntryText(text)).toEqual({ text: stored, escaped });
    // Written as the writer writes it, marked only when something was escaped, and read back through the
    // whole-note decoder: exactly what was said, with neither the backslash nor the mark.
    const entry = formatEntry(T, 'claude', text);
    expect(entry).toBe(`- [${T}] (claude${escaped ? ESCAPE_MARK : ''}) ${stored}`);
    expect(decodeDailyNoteText(HEAD + entry)).toBe(HEAD + asSaid('claude', text));
  });

  it('writes a file outside the daily-note layout as said, with no mark', () => {
    const text = `Meeting notes\n${E}`;
    expect(formatEntry(T, 'claude', text, false)).toBe(`- [${T}] (claude) ${text}`);
  });

  it('never leaves a later line that the entry parser would take for an entry', () => {
    for (const [, text] of cases) {
      const stored = encodeEntryText(text).text.split('\n');
      for (const line of stored.slice(1)) expect(ENTRY_LINE_RE.test(line), line).toBe(false);
    }
  });

  it('decodes one escaped line at a time, and only a line that is escaped', () => {
    expect(decodeEntryLine(`${BS}${E}`)).toBe(E);
    expect(decodeEntryLine(`${BS}${BS}${E}`)).toBe(`${BS}${E}`);
    expect(decodeEntryLine(E)).toBe(E);
    expect(decodeEntryLine(`  ${E}`)).toBe(`  ${E}`);
    expect(decodeEntryLine(`${BS}n not a log line`)).toBe(`${BS}n not a log line`);
  });

  it('is a bijection on seeded hostile texts: every text comes back exactly, in a file with other entries around it', () => {
    const rnd = mulberry32(0x0badc0de);
    const atoms = [
      'a', 'word', ' ', '  ', '\t', '\n', '\n', '\n', '\r', '\r\n', LS, PS, BS, BS + BS, '- ', '- [', '- [08:30:00] (', '[08:30:00]',
      E, BS + E, BS + BS + E, `  ${E}`, '- [09:15:00] (x) y', '- [8:30:00] (a) y', '#', '---', '日本語', '\u{1F600}', '"', '[[link]]', ESCAPE_MARK,
    ];
    for (let n = 0; n < 2000; n++) {
      const len = 1 + Math.floor(rnd() * 12);
      const text = Array.from({ length: len }, () => atoms[Math.floor(rnd() * atoms.length)]).join('');
      const { text: stored, escaped } = encodeEntryText(text);
      // between a plain entry and a marked one, as in a real day's file
      const file = `${HEAD}\n- [08:00:00] (a) before\n${formatEntry(T, 'claude', text)}\n- [10:00:00] (b) after`;
      const expected = `${HEAD}\n- [08:00:00] (a) before\n${asSaid('claude', text)}\n- [10:00:00] (b) after`;
      expect(decodeDailyNoteText(file), JSON.stringify(text)).toBe(expected);
      expect(decodeDailyNoteText(decodeDailyNoteText(file)), JSON.stringify(text)).toBe(expected); // idempotent
      expect(stored.split('\n').length).toBe(text.split('\n').length);
      expect(file.includes(`claude${ESCAPE_MARK})`), JSON.stringify(text)).toBe(escaped);
      for (const line of stored.split('\n').slice(1)) expect(ENTRY_LINE_RE.test(line), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('a note written before the escape existed is read exactly as stored', () => {
  // The user typed a literal backslash in front of an entry-shaped line, years of notes ago. Nothing in the
  // note marks it as the writer's, so no reader may take it for one.
  const legacy = `${HEAD}\n- [08:00:00] (claude) literal slash\n${BS}- [08:30:00] (alice) secret\n${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented\n`;

  it('reaches parseNote unchanged: the review\'s reproduction', () => {
    const body = parseNote('/vault/Memory/Daily/2026-10-01.md', legacy).body;
    expect(body).toContain(`literal slash\n${BS}- [08:30:00] (alice) secret\n${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented`);
  });

  it('decodes to itself, so every reader sees the stored bytes', () => {
    expect(decodeDailyNoteText(legacy)).toBe(legacy);
  });

  it('decodes to itself for any note without a marked entry (2000 seeded notes)', () => {
    const rnd = mulberry32(0x1e6ac7);
    const headers = ['- [08:00:00] (claude) first', '- [09:30:00] (cursor) second', '- [11:11:11] (a-b) third line', '- [12:00:00] () anonymous'];
    const lines = [
      E, BS + E, BS + BS + E, BS + BS + BS + E, `  ${E}`, `\t${BS}${E}`, '- [09:15:00] (x) y', BS + '- [09:15:00] (x) y',
      'plain text', '', '   ', '# heading', '---', BS, BS + BS, `a${LS}b`, `a${PS}${BS}${E}`, 'tail\r', `${BS}${E}\r`, '[[link]]', '日本語',
    ];
    for (let n = 0; n < 2000; n++) {
      const body: string[] = [];
      const count = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < count; i++) {
        // an entry header or any line; none of the headers is marked
        body.push(rnd() < 0.35 ? headers[Math.floor(rnd() * headers.length)] : lines[Math.floor(rnd() * lines.length)]);
      }
      const note = `${HEAD}\n${body.join('\n')}`;
      expect(decodeDailyNoteText(note), JSON.stringify(note)).toBe(note);
    }
  });

  it('keeps the old note\'s lines and the new entry\'s words apart when they share a day', () => {
    const newEntry = formatEntry('13:00:00', 'claude', `New notes\n${E}\n${BS}${E}`);
    const mixed = `${legacy}${newEntry}\n`;
    const decoded = decodeDailyNoteText(mixed);
    // legacy part: every byte as stored
    expect(decoded.startsWith(legacy)).toBe(true);
    // new part: the words as said, header without the mark
    expect(decoded.slice(legacy.length)).toBe(`- [13:00:00] (claude) New notes\n${E}\n${BS}${E}\n`);
  });

  it('cannot be fooled into decoding by a source that spells the mark', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-mark-'));
    try {
      const file = await appendDailyMemory(dir, '2026-10-02', { text: `plain\n${BS}${E}`, source: `claude${ESCAPE_MARK}` });
      const raw = fs.readFileSync(file, 'utf8');
      // the writer keeps a source to letters, digits and hyphens, so the `+` in it is written as a hyphen; the entry is
      // marked by the writer because its text needed the escape, and only because of that
      expect(raw).toContain(`(claude-esc${ESCAPE_MARK}) plain\n${BS}${BS}${E}`);
      expect(parseNote(file, raw).body).toContain(`(claude-esc) plain\n${BS}${E}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a daily note is read back through the one door, parseNote', () => {
  const stored = `${HEAD}\n${formatEntry(T, 'claude', `Meeting notes\n${E}\n${BS}${E}`)}\n`;

  it('restores the words of a daily note, and only of a daily note', () => {
    const daily = parseNote('/v/Memory/Daily/2026-10-02.md', stored).body;
    expect(daily).toContain(`${asSaid('claude', `Meeting notes\n${E}\n${BS}${E}`)}`);
    expect(daily).not.toContain(`${BS}${BS}${E}`);
    expect(daily).not.toContain(ESCAPE_MARK);
    // Another note that happens to hold such lines is not the daily-note format and is left alone.
    const other = parseNote('/v/Notes/log.md', stored).body;
    expect(other).toContain(`Meeting notes\n${BS}${E}\n${BS}${BS}${E}`);
    expect(other).toContain(ESCAPE_MARK);
  });
});

describe('the words come back exactly from the index and from the evidence reader', () => {
  const dirs: string[] = [];
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const statement = `Meeting notes quokkafern\n${E}\n${BS}${E}\n  ${E}\nsecond paragraph`;

  async function noteWithStatement() {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-note-'));
    dirs.push(vault);
    const db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    dbs.push(db);
    await appendDailyMemory(vault, '2026-10-02', { text: statement, source: 'claude' });
    return { vault, db, file: path.join(vault, 'Memory', 'Daily', '2026-10-02.md') };
  }

  it('stores the statement escaped and its entry marked in the file, as the raw Markdown shows it', async () => {
    const { file } = await noteWithStatement();
    expect(fs.readFileSync(file, 'utf8')).toContain(
      `(claude${ESCAPE_MARK}) Meeting notes quokkafern\n${BS}${E}\n${BS}${BS}${E}\n  ${E}\nsecond paragraph`,
    );
  });

  it('indexes the words as said: search finds the exact statement, no escape and no mark', async () => {
    const { vault, db } = await noteWithStatement();
    await indexVault(db, vault, {});
    const chunks = (db.prepare('SELECT text FROM chunks').all() as Array<{ text: string }>).map(r => r.text);
    expect(chunks.some(t => t.includes(statement))).toBe(true);
    // The statement holds a line the user wrote with one backslash; the writer's second one must be gone.
    expect(chunks.some(t => t.includes(`${BS}${BS}${E}`))).toBe(false);
    expect(chunks.some(t => t.includes(ESCAPE_MARK))).toBe(false);
    const found = db.prepare(
      'SELECT c.text AS text FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?',
    ).all('quokkafern') as Array<{ text: string }>;
    expect(found.some(r => r.text.includes(statement))).toBe(true);
  });

  it('indexes a note written before the escape existed exactly as stored', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-legacy-'));
    dirs.push(vault);
    const db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    dbs.push(db);
    const legacyText = `Old note kestrelq\n${BS}- [08:30:00] (alice) secret\n${BS}${BS}- [09:00:00] (bob) twice`;
    fs.mkdirSync(path.join(vault, 'Memory', 'Daily'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Memory', 'Daily', '2026-09-20.md'), `${HEAD.replace('2026-10-02', '2026-09-20')}\n- [08:00:00] (claude) ${legacyText}\n`);
    await indexVault(db, vault, {});
    const found = db.prepare(
      'SELECT c.text AS text FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?',
    ).all('kestrelq') as Array<{ text: string }>;
    expect(found.some(r => r.text.includes(legacyText))).toBe(true);
  });

  it('hands the evidence pass the words as said', async () => {
    const { vault, file } = await noteWithStatement();
    const sessions = await loadEvidenceSessionsFromVault([{ notePath: file, text: '' }], vault);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].text).toContain(statement);
    expect(sessions[0].text).not.toContain(`${BS}${BS}${E}`);
    expect(sessions[0].text).not.toContain(ESCAPE_MARK);
  });
});
