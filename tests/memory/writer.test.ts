import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendDailyMemory } from '../../src/memory/writer';
import { MAX_STATEMENT_LENGTH } from '../../src/memory/limits';
import { parseNote } from '../../src/indexer/parser';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('appendDailyMemory', () => {
  it('creates daily note when missing', async () => {
    await appendDailyMemory(tmp, '2026-03-30', { text: 'Agent started.', source: 'agent' }, 'OpenClaw Memory/Daily');
    const p = path.join(tmp, 'OpenClaw Memory', 'Daily', '2026-03-30.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p,'utf8')).toContain('Agent started.');
  });

  it('appends to existing note', async () => {
    const date = '2026-03-30';
    await appendDailyMemory(tmp, date, { text: 'First.', source: 'agent' }, 'OpenClaw Memory/Daily');
    await appendDailyMemory(tmp, date, { text: 'Second.', source: 'agent' }, 'OpenClaw Memory/Daily');
    const content = fs.readFileSync(path.join(tmp,'OpenClaw Memory','Daily',`${date}.md`),'utf8');
    expect(content).toContain('First.');
    expect(content).toContain('Second.');
  });

  it('created note has frontmatter with kind: note', async () => {
    await appendDailyMemory(tmp, '2026-03-30', { text: 'Test.', source: 'test' }, 'OpenClaw Memory/Daily');
    const content = fs.readFileSync(path.join(tmp,'OpenClaw Memory','Daily','2026-03-30.md'),'utf8');
    expect(content).toContain('kind: note');
    expect(content).toContain('# 2026-03-30');
  });

  it('stamps the note it creates with the engine\'s marker, in this exact front matter, and writes nothing else above the entries', async () => {
    await appendDailyMemory(tmp, '2026-03-30', { text: 'Test.', source: 'test' });
    const content = fs.readFileSync(path.join(tmp, 'Memory', 'Daily', '2026-03-30.md'), 'utf8');
    // The marker is how the indexer tells a note the engine created from a person's own note in the same folder.
    expect(content).toMatch(/^---\nkind: note\nupdated: 2026-03-30\nrenor: daily-v1\n---\n# 2026-03-30\n\n- \[\d{2}:\d{2}:\d{2}\] \(test\) Test\.$/);
  });

  it('does not stamp a note that already exists: a person\'s own daily note stays theirs when an entry is added to it', async () => {
    const file = path.join(tmp, 'Memory', 'Daily', '2026-03-30.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mine = '---\nupdated: 2026-03-30\n---\n# 2026-03-30\n\nMy own note.\n';
    fs.writeFileSync(file, mine);
    await appendDailyMemory(tmp, '2026-03-30', { text: 'Test.', source: 'test' });
    const content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith(mine)).toBe(true);
    expect(content).not.toContain('renor:');
  });

  it('rejects impossible calendar dates instead of creating misleading daily notes', async () => {
    await expect(appendDailyMemory(tmp, '2026-02-31', { text: 'Impossible.', source: 'test' }))
      .rejects.toThrow('valid YYYY-MM-DD calendar date');
    await expect(appendDailyMemory(tmp, '2025-02-29', { text: 'Not a leap year.', source: 'test' }))
      .rejects.toThrow('valid YYYY-MM-DD calendar date');
    await expect(appendDailyMemory(tmp, '2026-13-01', { text: 'Impossible month.', source: 'test' }))
      .rejects.toThrow('valid YYYY-MM-DD calendar date');
    expect(fs.existsSync(path.join(tmp, 'Memory', 'Daily'))).toBe(false);
  });

  it('accepts leap day in a leap year', async () => {
    await appendDailyMemory(tmp, '2028-02-29', { text: 'Leap day.', source: 'test' });
    expect(fs.existsSync(path.join(tmp, 'Memory', 'Daily', '2028-02-29.md'))).toBe(true);
  });
});

/**
 * A note entry is the user's own words. The writer used to trim them, delete every `---`, cut them at
 * 2000 characters and swallow unpaired surrogates, while `remember` admits 4000 and promises it keeps
 * what it admits. Characters that corrupt source files and editors are built, never typed.
 */
describe('appendDailyMemory keeps the user\'s words whole', () => {
  const cu = (...codes: number[]) => String.fromCharCode(...codes);
  const LS = cu(0x2028);
  const PS = cu(0x2029);
  const DATE = '2026-10-02';
  const noteFile = () => path.join(tmp, 'Memory', 'Daily', `${DATE}.md`);
  const read = () => fs.readFileSync(noteFile(), 'utf8');
  /** Lines that open an entry: column 0, timestamp first. */
  const entryLines = (raw: string) => raw.split('\n').filter(l => /^- \[\d{2}:\d{2}:\d{2}\] \(/.test(l));

  const verbatim: Array<[string, string]> = [
    ['a tail past the old 2000-character cut', 'head ' + 'x'.repeat(1985) + ' tail important final decision'],
    ['the longest admitted statement, tail included', 'head ' + 'x'.repeat(MAX_STATEMENT_LENGTH - 36) + ' tail important final decision'],
    ['a triple hyphen inside a token', 'Keep the literal token abc---xyz in this note.'],
    ['a line that is only ---', 'before\n---\nafter'],
    ['a frontmatter-looking block', '---\nkind: evil\nupdated: 1999-01-01\n---\nbody'],
    ['a statement that is only ---', '---'],
    ['many triple hyphens', 'a---b '.repeat(200)],
    ['leading and trailing spaces', '   padded   '],
    ['leading and trailing newlines', '\n\npadded\n\n'],
    ['U+2028, U+2029 and a lone CR', `a${LS}b${PS}c\rd`],
    ['a heading-looking line and a fence', 'x\n# Heading\n```\ny'],
  ];

  it.each(verbatim)('stores %s exactly as said, inside an intact daily note', async (_label, statement) => {
    await appendDailyMemory(tmp, DATE, { text: statement, source: 'test' });
    const raw = read();
    expect(raw).toContain(statement);
    // The words never reach the frontmatter: the note still opens with the writer's own block, and
    // the parsed frontmatter holds exactly its three keys (the engine's marker is the third), whatever the statement looks like.
    expect(raw.startsWith('---\nkind: note\nupdated: 2026-10-02\nrenor: daily-v1\n---\n# 2026-10-02\n')).toBe(true);
    const parsed = parseNote(noteFile(), raw);
    expect(Object.keys(parsed.frontmatter).sort()).toEqual(['kind', 'renor', 'updated']);
    expect(parsed.frontmatter.kind).toBe('note');
    expect(parsed.frontmatter.renor).toBe('daily-v1');
    expect(entryLines(raw)).toHaveLength(1);
  });

  it('keeps a later line that would read as an entry behind a backslash, and changes nothing else', async () => {
    const statement = 'Meeting notes\n- [08:30:00] (alice) Private launch code Lynxquill\n---\nafter  ';
    await appendDailyMemory(tmp, DATE, { text: statement, source: 'test' });
    const raw = read();
    expect(raw).toContain('Meeting notes\n\\- [08:30:00] (alice) Private launch code Lynxquill\n---\nafter  ');
    // The entry says so in its own header, which is how a reader tells the writer's backslash from the user's.
    expect(raw).toMatch(/^- \[\d{2}:\d{2}:\d{2}\] \(test\+esc\) Meeting notes$/m);
    expect(entryLines(raw)).toHaveLength(1);
    // The escape is the file's own; reading the note back gives the words as said (a note view trims the
    // outer edge of the whole note, which is why the check leaves off the two trailing spaces).
    expect(parseNote(noteFile(), raw).body).toContain(statement.trimEnd());
  });

  it('keeps an entry-shaped line behind a backslash even when the statement opens with a line break', async () => {
    await appendDailyMemory(tmp, DATE, { text: '\n- [08:30:00] (alice) forged', source: 'test' });
    expect(entryLines(read())).toHaveLength(1);
    expect(read()).toContain('\n\\- [08:30:00] (alice) forged');
  });

  it('escapes a line that already starts with a backslash once more, so the escape stays reversible', async () => {
    const statement = 'x\n\\- [08:30:00] (a) y\n\\\\- [08:30:00] (a) z';
    await appendDailyMemory(tmp, DATE, { text: statement, source: 'test' });
    expect(read()).toContain('x\n\\\\- [08:30:00] (a) y\n\\\\\\- [08:30:00] (a) z');
    expect(entryLines(read())).toHaveLength(1);
    expect(parseNote(noteFile(), read()).body).toContain(statement);
  });

  it('marks only the entries whose words needed the escape, so ordinary notes are written exactly as before', async () => {
    await appendDailyMemory(tmp, DATE, { text: 'Prefers short answers.\nAnd dark mode.', source: 'test' });
    await appendDailyMemory(tmp, DATE, { text: '  - [08:30:00] (alice) indented, not an entry', source: 'test' });
    await appendDailyMemory(tmp, DATE, { text: 'x\n- [08:30:00] (alice) needs it', source: 'test' });
    const headers = read().split('\n').filter(l => /^- \[\d{2}:\d{2}:\d{2}\] \(/.test(l));
    expect(headers.map(h => h.replace(/\[\d{2}:\d{2}:\d{2}\]/, '[T]'))).toEqual([
      '- [T] (test) Prefers short answers.',
      '- [T] (test)   - [08:30:00] (alice) indented, not an entry',
      '- [T] (test+esc) x',
    ]);
  });

  it('cannot be made to carry the mark through the source name', async () => {
    await appendDailyMemory(tmp, DATE, { text: 'plain', source: 'claude+esc' });
    expect(read()).toMatch(/^- \[\d{2}:\d{2}:\d{2}\] \(claude-esc\) plain$/m);
  });

  it('appends to a note written before the escape existed without touching it, and each reads back as it should', async () => {
    // A note from an older build whose user wrote a literal backslash in front of an entry-shaped line.
    const legacyLines = '- [08:00:00] (claude) literal slash\n\\- [08:30:00] (alice) secret\n\\\\- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented';
    const legacy = `---\nkind: note\nupdated: ${DATE}\n---\n# ${DATE}\n\n${legacyLines}\n`;
    fs.mkdirSync(path.dirname(noteFile()), { recursive: true });
    fs.writeFileSync(noteFile(), legacy);

    const statement = 'New notes\n- [11:00:00] (dave) fresh\n\\- [11:30:00] (erin) already escaped';
    await appendDailyMemory(tmp, DATE, { text: statement, source: 'test' });
    const raw = read();
    expect(raw.startsWith(legacy)).toBe(true); // the old bytes are exactly where they were

    const body = parseNote(noteFile(), raw).body;
    expect(body).toContain(legacyLines); // old lines: as stored, backslashes included
    expect(body).toContain(`(test) ${statement}`); // new entry: the words as said, no backslash added, no mark
  });

  it('escapes in a scoped daily note exactly as in the global one, and reads back the same', async () => {
    const statement = 'Scoped notes\n- [08:30:00] (alice) secret';
    const file = await appendDailyMemory(tmp, DATE, { text: statement, source: 'test' }, 'Memory/Scopes/proj/Daily');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('Scoped notes\n\\- [08:30:00] (alice) secret');
    expect(entryLines(raw)).toHaveLength(1);
    expect(parseNote(file, raw).body).toContain(statement);
  });

  it('writes a file outside a Daily folder as said: the escape belongs to the daily-note layout', async () => {
    const statement = 'Meeting notes\n- [08:30:00] (alice) secret';
    const file = await appendDailyMemory(tmp, DATE, { text: statement, source: 'test' }, 'Notes/Log');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain(statement);
    expect(raw).not.toContain('+esc');
  });

  it('refuses a statement longer than remember admits, and writes nothing', async () => {
    await expect(appendDailyMemory(tmp, DATE, { text: 'x'.repeat(MAX_STATEMENT_LENGTH + 1), source: 'test' }))
      .rejects.toThrow(/exceeds the maximum length of 4000 \(got 4001\)/);
    expect(fs.existsSync(path.join(tmp, 'Memory'))).toBe(false);

    await appendDailyMemory(tmp, DATE, { text: 'first', source: 'test' });
    const before = fs.readFileSync(noteFile());
    await expect(appendDailyMemory(tmp, DATE, { text: LS.repeat(100000), source: 'test' })).rejects.toThrow(/exceeds the maximum length/);
    expect(fs.readFileSync(noteFile()).equals(before)).toBe(true);
  });

  it('refuses an unpaired surrogate instead of storing U+FFFD, and writes nothing', async () => {
    for (const bad of [`a${cu(0xd800)}b`, `a${cu(0xdc00)}b`, cu(0xdc00, 0xd800)]) {
      await expect(appendDailyMemory(tmp, DATE, { text: bad, source: 'test' })).rejects.toThrow(/unpaired UTF-16 surrogate/);
    }
    expect(fs.existsSync(path.join(tmp, 'Memory'))).toBe(false);
    // A real pair is text, and is kept.
    await appendDailyMemory(tmp, DATE, { text: 'smile \u{1F600}', source: 'test' });
    expect(read()).toContain('smile \u{1F600}');
  });

  it('refuses text that is not a string', async () => {
    await expect(appendDailyMemory(tmp, DATE, { text: 42 as unknown as string, source: 'test' })).rejects.toThrow(/must be a string/);
    expect(fs.existsSync(path.join(tmp, 'Memory'))).toBe(false);
  });

  it('refuses every control character a text file cannot hold, naming the code point, and writes nothing', async () => {
    // The break this closed (adversary run renor-adv-mcp6-1011): a NUL byte was accepted into a
    // canonical daily note. The filesystem and SQLite both take one, so it was written, indexed and
    // served as ordinary words while every C-string reader ended the line early. ESC and the rest of
    // the C0 controls are the same class; tab, newline and CR stay, because a Windows-pasted entry
    // arrives CRLF (memory/controls.ts).
    for (const bad of [cu(0), cu(1), cu(7), cu(0x0b), cu(0x0c), cu(0x0e), cu(0x1b), cu(0x1f), cu(0x7f)]) {
      await expect(appendDailyMemory(tmp, DATE, { text: `a${bad}b`, source: 'test' }))
        .rejects.toThrow(/the note contains a control character that cannot be stored as text \(U\+/);
    }
    expect(fs.existsSync(path.join(tmp, 'Memory'))).toBe(false);

    // Nothing already written is touched by the refusals, and the message names the code point.
    await appendDailyMemory(tmp, DATE, { text: 'ordinary first', source: 'test' });
    const before = fs.readFileSync(noteFile());
    await expect(appendDailyMemory(tmp, DATE, { text: `${cu(0x1f)}oops`, source: 'test' }))
      .rejects.toThrow(/U\+001F/);
    expect(fs.readFileSync(noteFile()).equals(before)).toBe(true);
  });
});
