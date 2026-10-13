import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, replayLedger, parseLedgerEvents, LifecycleInputError, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { appendDailyMemory } from '../../src/memory/writer';
import { parseEntryHeader } from '../../src/memory/dailyNote';
import { SecretRefusedError } from '../../src/extraction/secretGuard';
import { KEY_SHAPES, Rng } from '../../scripts/eval/secret-guard/plantedSet';

/**
 * What the two writers store for the `source` a client sends (memory/sourceName.ts). An agent that builds its call by
 * hand sometimes sends a file path where a name belongs. The daily-note header deleted every character that is not a
 * letter, a digit or a hyphen, so `/home/ana/atlas/BOARD.md` became `homeanaatlasBOARDmd` (and a source of any length went
 * in whole); the ledger kept the path as sent and refused the whole save past 256 characters. Both now store the name the
 * path ends in, at most 40 characters, and the header writes the characters it cannot keep as hyphens instead of deleting
 * them. Nothing already stored is touched. Synthetic data only; the same file runs against `main`, where the cases about
 * a path fail for exactly that reason and the controls (names that were already fine) pass.
 */

const DAY = '2026-10-06';
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

const mkdir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `source-stored-${tag}-`));
  tmpDirs.push(d);
  return d;
};
const mkdb = () => {
  const db = openDb(path.join(mkdir('db'), 'index.db'));
  runMigrations(db);
  dbs.push(db);
  return db;
};

beforeEach(() => {
  delete process.env.RENOR_SECRET_GUARD; // off, as shipped; the guard's own describe turns it on
});
afterEach(() => {
  if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD;
  else process.env.RENOR_SECRET_GUARD = SAVED_GUARD;
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const dailyFile = (vault: string) => path.join(vault, 'Memory', 'Daily', `${DAY}.md`);
const ledgerFile = (vault: string) => path.join(vault, DEFAULT_LEDGER_REL);

/** The source of every entry in the day's note, in order, as the header stores it. */
function headerSources(vault: string): string[] {
  return fs.readFileSync(dailyFile(vault), 'utf8').split('\n').flatMap((line) => {
    const header = parseEntryHeader(line);
    return header ? [header.source] : [];
  });
}

/** The source of every event in the ledger, in order, as the ledger stores it. */
const ledgerSources = (vault: string) => parseLedgerEvents(fs.readFileSync(ledgerFile(vault), 'utf8')).map((event) => event.source);

let seq = 0;
/** One fact per call, each its own subject, so no save supersedes another. */
const saveFact = (db: Database.Database, vault: string, source: string | undefined) =>
  remember(db, vault, DEFAULT_LEDGER_REL, { subject: `SynthSubject${++seq}`, predicate: 'p', object: 'o', ...(source === undefined ? {} : { source }) });

describe('a daily-note entry stores the name a path ends in', () => {
  const PATHS: Array<[string, string]> = [
    ['/home/ana/atlas/BOARD.md', 'BOARD-md'],
    ['~/.claude/projects/-home-ana-atlas/memory/t8.md', 't8-md'],
    ['C:\\Users\\ana\\atlas\\BOARD.md', 'BOARD-md'],
    ['file:///home/ana/atlas/BOARD.md', 'BOARD-md'],
    ['./docs/PLAN.md', 'PLAN-md'],
    ['https://github.com/acme/widgets/pull/12', 'github-com'],
  ];

  it.each(PATHS)('%s is stored as %s', async (sent, stored) => {
    const vault = mkdir('vault');
    await appendDailyMemory(vault, DAY, { text: 'Saved the T8 root cause.', source: sent });
    expect(headerSources(vault)).toEqual([stored]);
    const raw = fs.readFileSync(dailyFile(vault), 'utf8');
    // None of the path's other parts, glued or not, is anywhere in the file.
    expect(raw).not.toMatch(/homeana|home-ana|Usersana|Users-ana|projects|acme|widgets/);
  });

  it('keeps a long source to 40 characters, however it is built', async () => {
    const vault = mkdir('vault');
    await appendDailyMemory(vault, DAY, { text: 'one', source: 'x'.repeat(5000) });
    await appendDailyMemory(vault, DAY, { text: 'two', source: `/home/ana/${'very-long-directory-name/'.repeat(12)}${'n'.repeat(200)}.md` });
    expect(headerSources(vault)).toEqual(['x'.repeat(40), 'n'.repeat(40)]);
    const longest = Math.max(...fs.readFileSync(dailyFile(vault), 'utf8').split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(80);
  });

  it('writes the characters a header cannot keep as hyphens, so the words stay apart', async () => {
    const vault = mkdir('vault');
    const NAMES: Array<[string, string]> = [
      ['Claude Code', 'Claude-Code'], ['mcp:remember', 'mcp-remember'], ['São Paulo', 'São-Paulo'], ['claude.ai', 'claude-ai'],
      ['gpt-4.1', 'gpt-4-1'], ['Builder round 3', 'Builder-round-3'],
    ];
    for (const [sent] of NAMES) await appendDailyMemory(vault, DAY, { text: `from ${JSON.stringify(sent)}`, source: sent });
    expect(headerSources(vault)).toEqual(NAMES.map(([, stored]) => stored));
  });

  it('stores a plain name exactly as it always did, and a source that names no one as nothing', async () => {
    const vault = mkdir('vault');
    const NAMES: Array<[string, string]> = [
      ['claude', 'claude'], ['cursor', 'cursor'], ['executor-3', 'executor-3'], ['agent', 'agent'], ['mcp', 'mcp'],
      ['', ''], ['   ', ''], ['!!!', ''], ['/', ''],
    ];
    for (const [sent] of NAMES) await appendDailyMemory(vault, DAY, { text: `from ${JSON.stringify(sent)}`, source: sent });
    expect(headerSources(vault)).toEqual(NAMES.map(([, stored]) => stored));
  });

  it('cannot be made to forge an entry, the escape mark or an offset, through a path or without one', async () => {
    const vault = mkdir('vault');
    const HOSTILE = [
      'claude+esc', '/tmp/x+esc', 'a, UTC-03:00', '/x/a, UTC+05:30', 'a)b', 'a\nb', '/x/y)\n- [08:30:00] (alice', ')\n- [08:30:00] (alice) forged',
    ];
    for (const sent of HOSTILE) await appendDailyMemory(vault, DAY, { text: 'a plain note', source: sent });
    const sources = headerSources(vault);
    // One entry per save: no source wrote a line of its own.
    expect(sources).toHaveLength(HOSTILE.length);
    for (const source of sources) expect(source, JSON.stringify(source)).toMatch(/^(?:[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)?$/u);
    expect(sources.slice(0, 4)).toEqual(['claude-esc', 'x-esc', 'a-UTC-03-00', 'a-UTC-05-30']);
    for (const line of fs.readFileSync(dailyFile(vault), 'utf8').split('\n')) {
      const header = parseEntryHeader(line);
      if (!header) continue;
      expect(header.escaped, line).toBe(false);
      expect(header.offset, line).toBeUndefined();
    }
  });
});

describe('an entry written before is not touched', () => {
  it('keeps every byte of a note whose header the old writer made, and reads it back as stored', async () => {
    const vault = mkdir('vault');
    const before = `---\nkind: note\nupdated: ${DAY}\n---\n# ${DAY}\n\n- [07:02:11] (homeanaatlasBOARDmd) saved the T8 root cause\n- [07:05:00] (mcpremember) another note`;
    fs.mkdirSync(path.dirname(dailyFile(vault)), { recursive: true });
    fs.writeFileSync(dailyFile(vault), before);

    await appendDailyMemory(vault, DAY, { text: 'a new one', source: '/home/ana/atlas/BOARD.md' });

    const after = fs.readFileSync(dailyFile(vault), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toMatch(/^\n- \[\d\d:\d\d:\d\d\] \(BOARD-md\) a new one$/);
    // The old entries read back exactly as they were stored: the writer's new rule is not a reader's.
    expect(headerSources(vault)).toEqual(['homeanaatlasBOARDmd', 'mcpremember', 'BOARD-md']);
  });
});

describe('a fact stores the name a path ends in', () => {
  const PATHS: Array<[string, string]> = [
    ['/home/ana/atlas/BOARD.md', 'BOARD.md'],
    ['~/.claude/projects/-home-ana-atlas/memory/t8.md', 't8.md'],
    ['C:\\Users\\ana\\atlas\\BOARD.md', 'BOARD.md'],
    ['file:///home/ana/atlas/BOARD.md', 'BOARD.md'],
    ['./docs/PLAN.md', 'PLAN.md'],
    ['https://github.com/acme/widgets/pull/12', 'github.com'],
  ];

  it.each(PATHS)('%s is stored as %s', async (sent, stored) => {
    const vault = mkdir('vault');
    await saveFact(mkdb(), vault, sent);
    expect(ledgerSources(vault)).toEqual([stored]);
    // The directories of the sender's machine are not in the ledger.
    expect(fs.readFileSync(ledgerFile(vault), 'utf8')).not.toMatch(/\/home\/ana|Users|\.claude|github\.com\/acme/);
  });

  it('no longer loses the whole save to a long path, and keeps a long name to 40 characters', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const longPath = `/home/ana/${'very-long-directory-name/'.repeat(12)}STATE.md`;
    expect(longPath.length).toBeGreaterThan(256); // the ledger refused anything past 256 characters
    const saved = await saveFact(db, vault, longPath);
    expect(saved.action).toBe('store');
    await saveFact(db, vault, 'x'.repeat(5000));
    await saveFact(db, vault, 'y'.repeat(100)); // inside the old 256, past the new 40
    expect(ledgerSources(vault)).toEqual(['STATE.md', 'x'.repeat(40), 'y'.repeat(40)]);
  });

  it('stores every other source exactly as it always did', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const NAMES: Array<[string | undefined, string]> = [
      ['claude', 'claude'], ['Claude Code', 'Claude Code'], ['mcp:remember', 'mcp:remember'], ['import:markdown', 'import:markdown'],
      ['claude.ai', 'claude.ai'], ['São Paulo', 'São Paulo'], [undefined, 'agent'],
    ];
    for (const [sent] of NAMES) await saveFact(db, vault, sent);
    expect(ledgerSources(vault)).toEqual(NAMES.map(([, stored]) => stored));
  });

  it('stores a source with no name in it as the default, like one that was not sent, never as a blank line', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    const BLANKS = ['', '   ', ' \t ', '/', '///', '\\\\', './'];
    for (const blank of BLANKS) await saveFact(db, vault, blank);
    expect(ledgerSources(vault)).toEqual(BLANKS.map(() => 'agent'));
    expect(fs.readFileSync(ledgerFile(vault), 'utf8')).not.toMatch(/^- source: ?$/m);
  });

  it('still refuses a source that is not text', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    await expect(saveFact(db, vault, 42 as unknown as string)).rejects.toThrow(LifecycleInputError);
    await expect(saveFact(db, vault, 42 as unknown as string)).rejects.toThrow(/source must be a string \(received number\)/);
    expect(fs.existsSync(ledgerFile(vault))).toBe(false); // nothing was written
  });
});

describe('a control character in a source is dropped, and never loses the save', () => {
  // Independent review of PR 388, P3: `remember(..., { source: '/home/ana/BOARD\n.md' })` threw LifecycleInputError ("control
  // characters ... are rejected to keep ledger framing strict") and the whole fact was lost, while the note writer, whose header
  // is built from letters and digits only, kept the entry. A source is a name, so the control characters go and the save stays.
  // [what was sent, what the ledger stores, what the note header stores]
  const SOURCES: Array<[string, string, string]> = [
    ['/home/ana/BOARD\n.md', 'BOARD.md', 'BOARD-md'],
    ['/home/ana/BOARD.md\n', 'BOARD.md', 'BOARD-md'],
    ['/home/ana/BOARD\t.md', 'BOARD.md', 'BOARD-md'],
    ['/home/ana/BOARD\r\n.md', 'BOARD.md', 'BOARD-md'],
    ['bad\x00source', 'badsource', 'badsource'],
    ['tab\tin-the-name', 'tabin-the-name', 'tabin-the-name'],
    ['\x1b[0mcursor\x1b[0m', '[0mcursor[0m', '0mcursor-0m'],
    ['cursor\x7f', 'cursor', 'cursor'],
    [`next${String.fromCharCode(0x85)}line`, 'nextline', 'nextline'],
    ['https://exa\nmple.com/x', 'example.com', 'example-com'],
    ['ht\ntps://user:pass@example.com', 'example.com', 'example-com'],
    ['https:/\t/user:pass@example.com', 'example.com', 'example-com'],
    ['\x00\n\t\r\x7f', 'agent', ''], // nothing but control characters names no one: the ledger's default, and no name in the header
  ];

  it.each(SOURCES)('%j is stored as %j (ledger) and %j (note header)', async (sent, ledger, header) => {
    const vault = mkdir('vault');
    const saved = await saveFact(mkdb(), vault, sent);
    expect(saved).toMatchObject({ ok: true, action: 'store' });
    await appendDailyMemory(vault, DAY, { text: 'A harmless note.', source: sent });
    expect(ledgerSources(vault)).toEqual([ledger]);
    expect(headerSources(vault)).toEqual([header]);
    // The one control character either file holds is the line feed that frames its lines, and the notes read back as one entry.
    for (const file of [ledgerFile(vault), dailyFile(vault)]) expect(fs.readFileSync(file, 'utf8'), path.basename(file)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(fs.readFileSync(dailyFile(vault), 'utf8').split('\n').filter((line) => parseEntryHeader(line) !== null)).toHaveLength(1);
  });

  it('keeps every save of a run of them, each its own event, and a rebuild from the ledger reads them all', async () => {
    const vault = mkdir('vault');
    const db = mkdb();
    for (const [sent] of SOURCES) await saveFact(db, vault, sent);
    expect(ledgerSources(vault)).toEqual(SOURCES.map(([, ledger]) => ledger));
    expect(await replayLedger(mkdb(), vault, DEFAULT_LEDGER_REL)).toBe(SOURCES.length);
  });
});

describe('a URL leaves its credentials in neither store', () => {
  // Independent review of PR 388, finding P2, through the real writers: a URL with a userinfo (`user:password@`) and no host
  // used to be stored whole, so the password reached the ledger and the note header.
  const URLS: Array<[string, string, string, string[]]> = [
    // [sent, note header, ledger, what must be in neither file]
    ['https://user:pass@', '', 'agent', ['user', 'pass']],
    ['https://user:pass@#frag', '', 'agent', ['user', 'pass']],
    ['https://user:pass@?q=1', '', 'agent', ['user', 'pass']],
    ['https://user:pass@/', '', 'agent', ['user', 'pass']],
    ['https://user:pass@:8080', '', 'agent', ['user', 'pass', '8080']],
    ['https://user:p@ss@example.com/x', 'example-com', 'example.com', ['user', 'p@ss', 'ss@']],
    ['https:///user:pass@example.com', 'example-com', 'example.com', ['user', 'pass']],
    ['https:\\\\user:pass@example.com\\x', 'example-com', 'example.com', ['user', 'pass']],
    // Independent review of PR 388, second round: the same URL with ONE separator or none, which a browser reads as
    // `https://user:pass@example.com` too (it parsed as a path, and the whole userinfo reached the ledger)
    ['https:/user:pass@example.com', 'example-com', 'example.com', ['user', 'pass']],
    ['https:\\user:pass@example.com', 'example-com', 'example.com', ['user', 'pass']],
    ['https:user:pass@example.com', 'example-com', 'example.com', ['user', 'pass']],
    ['HTTPS:/user:pass@example.com/x', 'example-com', 'example.com', ['user', 'pass']],
    ['wss:user:pass@example.com:8443', 'example-com', 'example.com', ['user', 'pass', '8443']],
    ['ftp:/user:secret@', '', 'agent', ['user', 'secret']],
    ['ftp:/user:secret@ftp.example.com/pub', 'ftp-example-com', 'ftp.example.com', ['user', 'secret']],
  ];

  it.each(URLS)('%s', async (sent, header, ledger, secrets) => {
    const vault = mkdir('vault');
    await appendDailyMemory(vault, DAY, { text: 'A harmless note.', source: sent });
    await saveFact(mkdb(), vault, sent);
    expect(headerSources(vault)).toEqual([header]);
    expect(ledgerSources(vault)).toEqual([ledger]);
    for (const file of [dailyFile(vault), ledgerFile(vault)]) {
      const raw = fs.readFileSync(file, 'utf8');
      for (const secret of secrets) expect(raw, `${path.basename(file)} holds ${JSON.stringify(secret)}`).not.toContain(secret);
    }
  });
});

describe('an event written before is not touched', () => {
  const LEDGER_HEAD = '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n';
  const event = (id: string, at: string, subject: string, source: string) =>
    ['', `## ${id} · ${at}`, '- kind: store', `- subject: ${subject}`, '- predicate: board', '- object: BOARD', `- source: ${source}`, ''].join('\n');

  it('replays an event whose source is a path or a long name, keeps its bytes, and appends after it', async () => {
    const vault = mkdir('vault');
    const longOld = `/home/ana/${'very-long-directory-name/'.repeat(8)}STATE.md`; // under 256, as the old writer required
    expect(longOld.length).toBeLessThanOrEqual(256);
    const before = LEDGER_HEAD
      + event('MEM_OLD0001', '2026-10-05T19:00:00.000Z', 'AtlasOne', '/home/ana/atlas/BOARD.md')
      + event('MEM_OLD0002', '2026-10-05T19:01:00.000Z', 'AtlasTwo', longOld)
      + event('MEM_OLD0003', '2026-10-05T19:02:00.000Z', 'AtlasThree', 'Claude Code');
    fs.mkdirSync(path.dirname(ledgerFile(vault)), { recursive: true });
    fs.writeFileSync(ledgerFile(vault), before);

    const db = mkdb();
    expect(await replayLedger(db, vault, DEFAULT_LEDGER_REL)).toBe(3);
    await saveFact(db, vault, '/home/ana/atlas/BOARD.md');

    const after = fs.readFileSync(ledgerFile(vault), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(ledgerSources(vault)).toEqual(['/home/ana/atlas/BOARD.md', longOld, 'Claude Code', 'BOARD.md']);
    // A rebuild from the ledger still reads all four, the new one included.
    expect(await replayLedger(mkdb(), vault, DEFAULT_LEDGER_REL)).toBe(4);
  });
});

describe('with the secret guard on, what is judged is what is stored', () => {
  const key = KEY_SHAPES.aws_id(new Rng(7));
  const fragments = [key.slice(-12), key.slice(0, 10)];

  beforeEach(() => {
    process.env.RENOR_SECRET_GUARD = '1';
  });

  it('refuses a credential that is the name, as before', async () => {
    const vault = mkdir('vault');
    await expect(appendDailyMemory(vault, DAY, { text: 'a harmless note', source: key }))
      .rejects.toMatchObject({ name: 'SecretRefusedError', field: 'note source' });
    await expect(saveFact(mkdb(), vault, key)).rejects.toMatchObject({ field: 'source' });
    expect(fs.existsSync(dailyFile(vault))).toBe(false);
    expect(fs.existsSync(ledgerFile(vault))).toBe(false);
  });

  it('refuses a credential spaced apart, which the header would store as hyphenated pieces', async () => {
    // The header writes the spaces as hyphens (`AKIA-IOSF-...`), a form the scanner does not read as a key; the same name
    // with the separators deleted is a key, and that is what is judged too.
    const vault = mkdir('vault');
    const spaced = key.match(/.{1,4}/g)!.join(' ');
    await expect(appendDailyMemory(vault, DAY, { text: 'a harmless note', source: spaced }))
      .rejects.toMatchObject({ name: 'SecretRefusedError', field: 'note source', reason: 'credential' });
    expect(fs.existsSync(dailyFile(vault))).toBe(false);
  });

  it('refuses a credential that is the file name of a path, because that is what is stored', async () => {
    // Before, the path ran together (`homeana<key>md`) and the glued word hid the key from the scanner: it was stored.
    const vault = mkdir('vault');
    await expect(appendDailyMemory(vault, DAY, { text: 'a harmless note', source: `/home/ana/${key}.md` }))
      .rejects.toMatchObject({ name: 'SecretRefusedError', field: 'note source' });
    await expect(saveFact(mkdb(), vault, `/home/ana/${key}.md`)).rejects.toMatchObject({ field: 'source' });
    expect(fs.existsSync(dailyFile(vault))).toBe(false);
    expect(fs.existsSync(ledgerFile(vault))).toBe(false);
  });

  it('stores nothing of a credential that is only in a directory the path is cut down from', async () => {
    const vault = mkdir('vault');
    await appendDailyMemory(vault, DAY, { text: 'a harmless note', source: `/home/example/${key}/BOARD.md` });
    await saveFact(mkdb(), vault, `/home/example/${key}/BOARD.md`);
    expect(headerSources(vault)).toEqual(['BOARD-md']);
    expect(ledgerSources(vault)).toEqual(['BOARD.md']);
    for (const file of [dailyFile(vault), ledgerFile(vault)]) {
      const raw = fs.readFileSync(file, 'utf8');
      for (const piece of fragments) expect(raw, `${path.basename(file)} holds ${piece.length} characters of the key`).not.toContain(piece);
    }
  });

  it('is the same refusal type as for any other field', async () => {
    const vault = mkdir('vault');
    await expect(appendDailyMemory(vault, DAY, { text: 'x', source: key })).rejects.toBeInstanceOf(SecretRefusedError);
    await expect(saveFact(mkdb(), vault, key)).rejects.toBeInstanceOf(LifecycleInputError);
  });
});
