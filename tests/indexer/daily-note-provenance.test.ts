import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { indexVault } from '../../src/indexer/pipeline';
import { parseNote } from '../../src/indexer/parser';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { appendDailyMemory } from '../../src/memory/writer';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { DAILY_NOTE_MARKER, engineDailyHeader, isEarlierHeaderText, isEngineDailyNote, isEngineHeaderDate } from '../../src/memory/dailyNote';
import { buildMemoryMap, restoreMemory, retireMemory, type MemoryMapContext } from '../../src/memorymap/memoryMap';
import { tmpPath } from '../helpers/tmpPath';

/**
 * How the engine tells its own daily note from a person's in the same folder (daily-header-fact.test.ts shows what the
 * indexer does with the answer). One rule, over the FRONT MATTER of the file and nothing else:
 *
 *  - the marker line the engine's writer stamps on every note it creates, `renor: daily-v1`; or
 *  - for a note written before the marker existed, the complete front matter the engine wrote then: `kind: note`, then
 *    `updated:` with the note's own day, every key, value and its order, and no other key.
 *
 * Never the folder, never the name beyond the real day it must give, and never the body: a person can write anything
 * there, timestamped lines in the engine's own entry format included, so those lines say nothing about who wrote the file.
 *
 * The header is written in two places, `appendDailyMemory` and the memory map's restore, and recognised in a third; the
 * last tests pin the three to one function and that function to its literal bytes, so a change to what the engine
 * writes cannot silently stop the recognition (and the other way round).
 */

let vault: string;
let dbPath: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-provenance-'));
  dbPath = tmpPath(`daily-provenance-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(dbPath, { force: true });
});

const FILE = '/vault/Memory/Daily/2026-10-03.md';
const MARK = DAILY_NOTE_MARKER;
const ENTRY = '- [08:30:00] (a) x';
const HEADER = engineDailyHeader('2026-10-03');
/** The front matter and heading the engine wrote before it stamped its notes, spelled out and not built by a function. */
const LEGACY = '---\nkind: note\nupdated: 2026-10-03\n---\n# 2026-10-03\n';
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

describe('what the engine\'s daily note is', () => {
  it.each([
    // The notes the engine writes now: the marker, in the front matter.
    ['the writer\'s note: the marked header, a blank line, an entry', FILE, `${HEADER}\n${ENTRY}\n`],
    ['the restore\'s shape: the header, then the entry without a blank line', FILE, `${HEADER}${ENTRY}`],
    ['an entry that goes on over several lines', FILE, `${HEADER}\n- [08:30:00] (claude) first\nsecond line\n`],
    ['the header and nothing else: every entry retired', FILE, HEADER],
    ['the same in a scope\'s daily folder', '/vault/Memory/Scopes/alpha/Daily/2026-10-03.md', `${HEADER}\n${ENTRY}`],
    ['the same in the older folder name', '/vault/OpenClaw Memory/Daily/2026-10-03.md', `${HEADER}\n${ENTRY}`],
    ['the same on a Windows path', 'C:\\vault\\Memory\\Daily\\2026-10-03.md', `${HEADER}\n${ENTRY}`],
    ['the marker beside keys a person added', FILE, `---\nkind: note\nupdated: 2026-10-03\n${MARK}\ntags: [a]\nstatus: draft\n---\n# 2026-10-03\n`],
    ['the marker in front of the other keys', FILE, `---\n${MARK}\nkind: note\nupdated: 2026-10-03\n---\n# 2026-10-03\n`],
    ['the marker in a note whose `updated` a person changed: it is still the note the engine created', FILE, `---\nkind: note\nupdated: 2026-10-04\n${MARK}\n---\n# 2026-10-03\n`],
    ['the marker in a note whose body a person rewrote', FILE, `---\nkind: note\nupdated: 2026-10-03\n${MARK}\n---\nDinner was good.\n`],
    // The notes it wrote before it had a marker: the complete front matter, and nothing else is asked of the file.
    ['an older note: the complete front matter, the heading, an entry', FILE, `${LEGACY}\n${ENTRY}\n`],
    ['an older note whose entries were all retired', FILE, LEGACY],
    ['an older note a person went on writing in, in free text', FILE, `${LEGACY}\nDinner was good.\n`],
    ['an older note with no heading: the body is not asked', FILE, '---\nkind: note\nupdated: 2026-10-03\n---\nDinner was good.\n'],
    // By design: the front matter is byte for byte the engine's old one, and nothing else is read, so this is that note.
    ['an older note with a line in the engine\'s entry format that a person wrote (the same bytes as the engine\'s)', FILE, `${LEGACY}\n- [08:30:00] (alice) Met Bob for breakfast.\n`],
  ])('is the engine\'s note: %s', (_what, file, head) => {
    expect(isEngineDailyNote(file, head)).toBe(true);
  });

  it.each([
    // The reviewer's case: a person's own note, with a log in the engine's entry format. The body says nothing.
    ['a person\'s front matter over timestamped lines in the engine\'s entry format', FILE, '---\ntitle: Journal\nupdated: 2026-10-03\n---\n# 2026-10-03\n\n- [08:30:00] (alice) Met Bob for breakfast.\n- [12:10:00] (alice) Lunch with Carol.\n'],
    ['a natural bare date and no `kind`', FILE, `---\nupdated: 2026-10-03\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['a `kind` and no date', FILE, `---\nkind: note\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['the older front matter and a further key', FILE, `---\nkind: note\nupdated: 2026-10-03\ntags: [a]\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['the older keys in another order', FILE, `---\nupdated: 2026-10-03\nkind: note\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['a different `kind`', FILE, `---\nkind: daily\nupdated: 2026-10-03\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['another day in the older front matter', FILE, `---\nkind: note\nupdated: 2026-10-02\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['the date quoted', FILE, `---\nkind: note\nupdated: "2026-10-03"\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['the older front matter with a space after a value', FILE, `---\nkind: note \nupdated: 2026-10-03\n---\n# 2026-10-03\n\n${ENTRY}`],
    ['the older front matter with carriage returns', FILE, `${crlf(LEGACY)}\r\n${ENTRY}`],
    ['the marked header with carriage returns', FILE, `${crlf(HEADER)}\r\n${ENTRY}`],
    ['the marker with a space after it', FILE, `---\nkind: note\nupdated: 2026-10-03\n${MARK} \n---\n# 2026-10-03\n`],
    ['the marker quoted', FILE, '---\nkind: note\nupdated: 2026-10-03\nrenor: "daily-v1"\n---\n# 2026-10-03\n'],
    ['the marker indented, under another key', FILE, `---\nupdated: 2026-10-03\nnote:\n  ${MARK}\n---\n# 2026-10-03\n`],
    ['the marker as a line of a text block', FILE, `---\nupdated: 2026-10-03\nnote: |\n  ${MARK}\n---\n# 2026-10-03\n`],
    ['the marker as part of another value', FILE, `---\nupdated: 2026-10-03\ntitle: "${MARK}"\n---\n# 2026-10-03\n`],
    ['another value for the same key', FILE, '---\nupdated: 2026-10-03\nrenor: something-else\n---\n# 2026-10-03\n'],
    ['the marker in the body, under a person\'s front matter', FILE, `---\nupdated: 2026-10-03\n---\n# 2026-10-03\n\n${MARK}\n${ENTRY}`],
    ['the marker in the body, between two horizontal rules', FILE, `---\nupdated: 2026-10-03\n---\n# 2026-10-03\n\n---\n${MARK}\n---\n${ENTRY}`],
    ['the marker in a front matter that never closes', FILE, `---\nkind: note\nupdated: 2026-10-03\n${MARK}\n# 2026-10-03\n\n${ENTRY}`],
    ['the marker and no front matter at all', FILE, `${MARK}\n# 2026-10-03\n`],
    ['an empty file', FILE, ''],
    ['the marked header outside the daily layout', '/vault/People/Acme.md', `${HEADER}\n${ENTRY}`],
    ['the older front matter outside the daily layout', '/vault/People/Acme.md', `${LEGACY}\n${ENTRY}`],
    ['a name that only ends in the date', '/vault/Daily/notes-2026-10-03.md', `${HEADER}\n${ENTRY}`],
    ['a name that is not a day', '/vault/Daily/2026-02-31.md', `${engineDailyHeader('2026-02-31')}\n${ENTRY}`],
    ['the lifecycle\'s own source', '_mcp_', `${HEADER}\n${ENTRY}`],
  ])('is not the engine\'s note: %s', (_what, file, head) => {
    expect(isEngineDailyNote(file, head)).toBe(false);
  });

  it('never reads the body: every body gives the same answer for the same front matter', () => {
    const bodies = ['', 'free text', ENTRY, '- [08:30:00] (alice) Met Bob for breakfast.', `${MARK}\n${ENTRY}`, '# My day\n\n---\n\nmore'];
    for (const [front, expected] of [[HEADER.slice(0, HEADER.indexOf('# ')), true], [LEGACY.slice(0, LEGACY.indexOf('# ')), true], ['---\nupdated: 2026-10-03\n---\n', false]] as const) {
      for (const body of bodies) expect(isEngineDailyNote(FILE, `${front}${body}`), `${front}${body}`).toBe(expected);
    }
  });
});

describe('the one value of `updated` that is the engine\'s', () => {
  /** What the indexer sees: the value of `updated`, as the note's own parser reads it. */
  const valueOf = (yaml: string) => parseNote(FILE, `---\nupdated: ${yaml}\n---\n# 2026-10-03\n`).frontmatter.updated;

  it.each([
    ['the bare date of the note\'s own day', '2026-10-03', true],
    ['the same instant, written as a timestamp (YAML reads the same value: nothing of a person\'s is lost)', '2026-10-03T00:00:00Z', true],
    ['the day after', '2026-10-04', false],
    ['the day before', '2026-10-02', false],
    ['a moment later in the same day', '2026-10-03T10:00:00Z', false],
    ['a quoted date', '"2026-10-03"', false],
    ['free text', 'evening', false],
    ['a number', '20261003', false],
  ])('%s: %s', (_what, yaml, expected) => {
    expect(isEngineHeaderDate(FILE, valueOf(yaml))).toBe(expected);
  });

  it('is not a value that is no valid Date, nor any value in a file that has no real day', () => {
    const day = new Date('2026-10-03T00:00:00Z');
    expect(isEngineHeaderDate(FILE, day)).toBe(true);
    expect(isEngineHeaderDate(FILE, new Date(NaN))).toBe(false);
    expect(isEngineHeaderDate(FILE, null)).toBe(false);
    expect(isEngineHeaderDate(FILE, undefined)).toBe(false);
    expect(isEngineHeaderDate(FILE, '2026-10-03')).toBe(false);
    expect(isEngineHeaderDate(FILE, day.getTime())).toBe(false);
    expect(isEngineHeaderDate('/vault/People/Acme.md', day)).toBe(false);
    expect(isEngineHeaderDate('_mcp_', day)).toBe(false);
    expect(isEngineHeaderDate('/vault/Daily/2026-02-31.md', new Date('2026-03-03T00:00:00Z'))).toBe(false);
  });
});

describe('what an earlier indexer stored for the header', () => {
  it.each([
    ['São Paulo', 'Fri Oct 02 2026 21:00:00 GMT-0300 (Brasilia Standard Time)', true],
    ['Kiritimati', 'Sat Oct 03 2026 14:00:00 GMT+1400 (Line Islands Time)', true],
    ['UTC', 'Sat Oct 03 2026 00:00:00 GMT+0000 (Coordinated Universal Time)', true],
    ['another day printed', 'Thu Oct 01 2026 21:00:00 GMT-0300 (Brasilia Standard Time)', false],
    ['a quoted date', '2026-10-03', false],
    ['a quoted timestamp', '2026-10-03T00:00:00.000Z', false],
    ['free text', 'evening', false],
    ['a number', 20261003, false],
    ['nothing', null, false],
  ])('the fact text for `updated` printed on a host in %s: %s', (_what, text, expected) => {
    expect(isEarlierHeaderText(FILE, text)).toBe(expected);
  });

  it('is never the header text of a file that is no daily note or has no real day', () => {
    const text = 'Fri Oct 02 2026 21:00:00 GMT-0300 (Brasilia Standard Time)';
    expect(isEarlierHeaderText('/vault/People/Acme.md', text)).toBe(false);
    expect(isEarlierHeaderText('_mcp_', text)).toBe(false);
    expect(isEarlierHeaderText('/vault/Daily/2026-02-31.md', text)).toBe(false);
  });
});

describe('the engine writes the header this file recognises', () => {
  it('is, byte for byte, the front matter and heading the rule is written for', () => {
    // The format of every daily note the engine creates from now on. Changing it is a decision, not a refactor: the notes
    // already on disk keep the bytes they were written with.
    expect(DAILY_NOTE_MARKER).toBe('renor: daily-v1');
    expect(engineDailyHeader('2026-10-03')).toBe('---\nkind: note\nupdated: 2026-10-03\nrenor: daily-v1\n---\n# 2026-10-03\n');
    expect(isEngineDailyNote(FILE, engineDailyHeader('2026-10-03'))).toBe(true);
  });

  it('appendDailyMemory begins every note it creates with it', async () => {
    const file = await appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' });
    const content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith(engineDailyHeader('2026-10-03'))).toBe(true);
    expect(isEngineDailyNote(file, content)).toBe(true);
  });

  it('the memory map begins a note with it when it restores an entry into a day that has no file', async () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      const file = await appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' });
      await appendDailyMemory(vault, '2026-10-03', { text: 'Lunch was late.', source: 'agent' });
      const ctx: MemoryMapContext = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
      await indexVault(db, vault, {}, 1);
      const entry = (await buildMemoryMap(ctx)).memories.find(m => m.kind === 'entry' && m.title === 'Dinner was good.')!;
      await retireMemory(ctx, entry.id); // not the day's last entry, so the file stays and the record keeps none of it
      fs.rmSync(file); // the day has no file any more
      await restoreMemory(ctx, entry.id);

      const content = fs.readFileSync(file, 'utf8');
      expect(content.startsWith(engineDailyHeader('2026-10-03'))).toBe(true);
      expect(isEngineDailyNote(file, content)).toBe(true);
    } finally {
      db.close();
    }
  });
});
