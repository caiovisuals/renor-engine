import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { indexVault } from '../../src/indexer/pipeline';
import { hashContent } from '../../src/indexer/hasher';
import { DAILY_CHUNK_LAYOUT, noteContentHash } from '../../src/indexer/dailyEntries';
import { appendDailyMemory } from '../../src/memory/writer';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { makeLegacyDailyNote } from '../helpers/legacyDailyIndex';

/**
 * A daily note is cut into one chunk per entry (an entry is what one `remember` saved), so recalling one memory
 * returns that memory and not the day it was said on. The entry boundaries are those of the stored file, the ones the
 * memory map uses, and never a guess from the shape of the words the user typed.
 */

const BS = '\\';
const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR
const BOM = String.fromCharCode(0xfeff); // BYTE ORDER MARK
const DAY = '/v/Memory/Daily/2026-10-03.md';
const HEAD = '---\nkind: note\nupdated: 2026-10-03\n---\n# 2026-10-03\n';

const chunksOf = (content: string, file = DAY, options?: { maxTokens?: number; overlapTokens?: number }) =>
  chunkNote(parseNote(file, content), options);
const texts = (content: string, file = DAY) => chunksOf(content, file).map(c => c.text);

describe('a daily note is cut into one chunk per entry', () => {
  it('cuts each entry whole, with its time and source, under the day heading, and leaves the bare heading out', () => {
    const chunks = chunksOf(`${HEAD}\n- [08:30:00] (claude) first\n- [08:31:00] (mcp) second line one\nsecond line two\n- [08:32:00] (claude) third\n`);
    expect(chunks.map(c => c.text)).toEqual([
      '- [08:30:00] (claude) first',
      '- [08:31:00] (mcp) second line one\nsecond line two',
      '- [08:32:00] (claude) third',
    ]);
    expect(chunks.every(c => c.headingPath === '2026-10-03' && c.notePath === DAY)).toBe(true);
    // Lines of the parsed body: 0 `# 2026-10-03`, 1 blank, 2.. the entries.
    expect(chunks.map(c => [c.startLine, c.endLine])).toEqual([[2, 3], [3, 5], [5, 6]]);
    expect(chunks.map(c => c.tokenCount).every(n => n > 0)).toBe(true);
  });

  it('keeps the blank lines that lay out a file out of the entries, and a statement\'s own blank lines in', () => {
    const chunks = chunksOf(`${HEAD}\n- [08:30:00] (claude) first\n\n\n- [08:31:00] (claude) para one\n\npara two\n  \n- [08:32:00] (claude) third\n`);
    expect(chunks.map(c => c.text)).toEqual([
      '- [08:30:00] (claude) first',
      '- [08:31:00] (claude) para one\n\npara two',
      '- [08:32:00] (claude) third',
    ]);
    expect(chunks.map(c => [c.startLine, c.endLine])).toEqual([[2, 3], [5, 8], [9, 10]]);
  });

  it('does not cut a statement at its own headings, rules or front-matter look-alikes', () => {
    const statement = '# Plan\n## Step one\n---\nkind: evil\n---\n### Deep\nlast';
    const chunks = chunksOf(`${HEAD}\n- [08:30:00] (claude) ${statement}\n- [08:31:00] (claude) after\n`);
    expect(chunks.map(c => c.text)).toEqual([`- [08:30:00] (claude) ${statement}`, '- [08:31:00] (claude) after']);
    // The next entry is not under the statement's headings: the path is the note's.
    expect(chunks.map(c => c.headingPath)).toEqual(['2026-10-03', '2026-10-03']);
  });

  it('puts the entries under the headings above the first entry, and keeps prose written there', () => {
    const chunks = chunksOf(`---\nkind: note\n---\n# Log\n\n## Week 40\n\nWater the plants.\n\n- [08:30:00] (claude) a\n- [08:31:00] (claude) b\n`);
    // `# Log` has nothing under it and is not a memory; the prose under `## Week 40` is kept as it was written.
    expect(chunks.map(c => c.text)).toEqual(['## Week 40\n\nWater the plants.', '- [08:30:00] (claude) a', '- [08:31:00] (claude) b']);
    expect(chunks.map(c => c.headingPath)).toEqual(['Log > Week 40', 'Log > Week 40', 'Log > Week 40']);
  });

  it('cuts an entry of one line, an entry of nothing but spaces, and an empty day, without losing the others', () => {
    // The body is trimmed, so the last entry of spaces has lost the space after its source; it is still an entry.
    const chunks = chunksOf(`${HEAD}\n- [08:30:00] (claude) a\n- [08:31:00] (claude)    `);
    expect(chunks.map(c => c.text)).toEqual(['- [08:30:00] (claude) a', '- [08:31:00] (claude)']);
    expect(chunksOf(HEAD).map(c => c.text)).toEqual(['# 2026-10-03']);
  });

  it('cuts an entry longer than a chunk into paragraphs, never together with its neighbours', () => {
    const paragraph = (n: number) => `${'word '.repeat(150)}end${n}`;
    const long = [paragraph(1), paragraph(2), paragraph(3), paragraph(4)].join('\n\n');
    const chunks = chunksOf(`${HEAD}\n- [08:30:00] (claude) before\n- [08:31:00] (claude) ${long}\n- [08:32:00] (claude) after\n`);
    expect(chunks[0].text).toBe('- [08:30:00] (claude) before');
    expect(chunks[chunks.length - 1].text).toBe('- [08:32:00] (claude) after');
    const pieces = chunks.slice(1, -1);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0].text.startsWith('- [08:31:00] (claude) word')).toBe(true);
    expect(pieces.every(c => c.tokenCount <= 450)).toBe(true);
    expect(pieces.map(c => c.text).join('\n\n')).toBe(`- [08:31:00] (claude) ${long}`);
    expect(pieces.every(c => !c.text.includes('before') && !c.text.includes('after'))).toBe(true);
  });
});

describe('the boundaries come from the stored file, not from the shape of the words', () => {
  const statement = `Meeting notes\n- [08:30:00] (alice) Private launch code Lynxquill`;

  it('a statement with a line that looks like an entry stays one chunk, and the next entry its own', () => {
    // How the writer stores it: the look-alike behind a backslash and the entry marked.
    const stored = `${HEAD}\n- [08:00:00] (claude+esc) Meeting notes\n${BS}- [08:30:00] (alice) Private launch code Lynxquill\n- [09:00:00] (claude) next\n`;
    const parsed = parseNote(DAY, stored);
    // Read back, the words are as said, and the look-alike is an entry-shaped line again ...
    expect(parsed.body).toContain(`${statement}\n- [09:00:00] (claude) next`);
    // ... which is exactly why the boundaries are found before that is undone.
    expect(chunkNote(parsed).map(c => c.text)).toEqual([
      `- [08:00:00] (claude) ${statement}`,
      '- [09:00:00] (claude) next',
    ]);
  });

  it('is what the writer produces: every kind of line a person can type stays inside its own entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-entry-'));
    try {
      const said = [
        statement,
        `Escapes\n${BS}- [08:30:00] (alice) already\n${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented`,
        'Windows\r\n- [08:30:00] (alice) crlf\r\nend',
        '- [08:30:00] (alice) it starts like an entry',
        'plain',
      ];
      let file = '';
      for (const text of said) file = await appendDailyMemory(dir, '2026-10-03', { text, source: 'claude' });
      const chunks = chunkNote(parseNote(file, fs.readFileSync(file, 'utf8')));
      expect(chunks).toHaveLength(said.length);
      said.forEach((text, i) => {
        expect(chunks[i].text.replace(/^- \[\d{2}:\d{2}:\d{2}\] \(claude\) /, '')).toBe(text);
        expect(chunks[i].text).not.toContain('+esc');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a note written before the escape existed reads and chunks exactly as stored', () => {
    const legacyText = `Old note kestrelq\n${BS}- [08:30:00] (alice) secret\n${BS}${BS}- [09:00:00] (bob) twice\n  - [10:00:00] (carol) indented`;
    expect(texts(`${HEAD}\n- [08:00:00] (claude) ${legacyText}\n- [09:00:00] (claude) after\n`))
      .toEqual([`- [08:00:00] (claude) ${legacyText}`, '- [09:00:00] (claude) after']);
  });

  it('a line that starts like an entry in a note nothing escaped is an entry, as the memory map reads it', () => {
    expect(texts(`${HEAD}\n- [08:00:00] (claude) Hello\n- [08:30:00] (alice) forged\n`))
      .toEqual(['- [08:00:00] (claude) Hello', '- [08:30:00] (alice) forged']);
  });

  it('an entry whose first line holds U+2028, U+2029 or a lone CR is an entry of its own', () => {
    const chunks = texts(`${HEAD}\n- [08:00:00] (claude) Quill${LS}one\n- [08:01:00] (claude) Quill${PS}two\n- [08:02:00] (claude) Quill\rthree\n- [08:03:00] (claude) end\n`);
    expect(chunks).toEqual([
      `- [08:00:00] (claude) Quill${LS}one`,
      `- [08:01:00] (claude) Quill${PS}two`,
      '- [08:02:00] (claude) Quill\rthree',
      '- [08:03:00] (claude) end',
    ]);
  });

  it('an indented or backslashed look-alike does not start an entry; a file with CRLF line ends still does', () => {
    expect(texts(`${HEAD}\n- [08:00:00] (claude) a\n  - [08:30:00] (alice) indented\n${BS}- [09:00:00] (bob) behind a backslash\n`))
      .toEqual([`- [08:00:00] (claude) a\n  - [08:30:00] (alice) indented\n${BS}- [09:00:00] (bob) behind a backslash`]);
    expect(texts(HEAD.replace(/\n/g, '\r\n') + '\r\n- [08:00:00] (claude) a\r\n- [08:01:00] (claude) b\r\n'))
      .toEqual(['- [08:00:00] (claude) a\r', '- [08:01:00] (claude) b']);
  });
});

describe('the entries are found whatever stands between the top of the file and the first of them', () => {
  const ENTRIES = '- [08:30:00] (claude+esc) one\n' + BS + '- [08:31:00] (alice) look-alike\n- [08:32:00] (claude) two\n';
  const WANT = ['- [08:30:00] (claude) one\n- [08:31:00] (alice) look-alike', '- [08:32:00] (claude) two'];
  const FM = '---\nkind: note\nupdated: 2026-10-03\n---\n';
  const variants: Array<[string, string]> = [
    ['nothing above them', ENTRIES],
    ['blank lines above them', '\n\n\n' + ENTRIES],
    ['spaces and blank lines above them', '  \n \t\n\n' + ENTRIES],
    ['frontmatter directly above them', FM + ENTRIES],
    ['frontmatter and blank lines above them', FM + '\n\n\n' + ENTRIES],
    ['frontmatter, a heading and blank lines above them', FM + '# 2026-10-03\n\n\n' + ENTRIES],
    ['frontmatter written with CRLF line ends', FM.replace(/\n/g, '\r\n') + '\r\n' + ENTRIES],
    ['a byte order mark and frontmatter', BOM + FM + '# 2026-10-03\n\n' + ENTRIES],
    ['a long frontmatter', '---\nkind: note\ntags:\n  - a\n  - b\naliases: [x, y]\nupdated: 2026-10-03\n---\n\n' + ENTRIES],
  ];
  for (const [name, content] of variants) {
    it(`finds them with ${name}`, () => {
      const parsed = parseNote(DAY, content);
      expect(parsed.entryStarts, name).toBeDefined();
      expect(texts(content).slice(-2), name).toEqual(WANT);
      // Every start is the first line of an entry of the body, and nothing else is.
      const lines = parsed.body.split('\n');
      expect(parsed.entryStarts!.map(i => lines[i].slice(0, 16)), name).toEqual(['- [08:30:00] (cl', '- [08:32:00] (cl']);
    });
  }
});

describe('what is not a log of entries is cut as it always was', () => {
  const old = (note: ReturnType<typeof parseNote>) => chunkNote({ ...note, entryStarts: undefined });

  it('a note outside Daily/ that holds entry-shaped lines', () => {
    const note = parseNote('/v/Notes/log.md', `# Log\n\n- [08:30:00] (claude) a\n- [08:31:00] (claude) b\n`);
    expect(note.entryStarts).toBeUndefined();
    expect(chunkNote(note)).toEqual(old(note));
    expect(chunkNote(note)).toHaveLength(1);
  });

  it('a journal under Daily/ with no entries, such as an imported one', () => {
    const note = parseNote('/v/Imports/Daily/2024-05-01.md', `# Journal\n\nWent hiking.\n\n## Evening\n\nRead a book.\n`);
    expect(note.entryStarts).toBeUndefined();
    expect(chunkNote(note)).toEqual(old(note));
    expect(chunkNote(note).map(c => c.headingPath)).toEqual(['Journal', 'Journal > Evening']);
  });

  it('a note whose body no longer agrees with the starts it was parsed with', () => {
    const note = parseNote(DAY, `${HEAD}\n- [08:30:00] (claude) a\n- [08:31:00] (claude) b\n`);
    expect(note.entryStarts).toEqual([2, 3]);
    for (const entryStarts of [[2, 3, 9], [3, 2], [2, 2], [1, 3], [-1], [0.5]]) {
      expect(chunkNote({ ...note, entryStarts })).toEqual(old(note));
    }
    expect(chunkNote({ ...note, body: 'something else entirely\nand more', entryStarts: [0, 1] }))
      .toEqual(old({ ...note, body: 'something else entirely\nand more' }));
  });

  it('a note with frontmatter and no body, a BOM, and a note that is nothing but entries', () => {
    expect(() => chunksOf('---\nkind: note\n---\n')).not.toThrow();
    expect(texts(BOM + HEAD + '\n- [08:30:00] (claude) a\n- [08:31:00] (claude) b\n').slice(-2)).toEqual(['- [08:30:00] (claude) a', '- [08:31:00] (claude) b']);
    expect(chunksOf('- [08:30:00] (claude) a\n- [08:31:00] (claude) b\n').map(c => [c.headingPath, c.text]))
      .toEqual([['', '- [08:30:00] (claude) a'], ['', '- [08:31:00] (claude) b']]);
  });
});

describe('seeded: whatever is said, one chunk per remember, and the words come back', () => {
  function random(seed: number) {
    // mulberry32: a small deterministic generator, so a failure names its seed.
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const LINES = [
    'plain words here', '', '   ', '\t', '---', '# Heading', '## Sub heading', '### Deep', 'key: value',
    '- [08:30:00] (alice) looks like an entry', `${BS}- [09:00:00] (bob) behind a backslash`, `${BS}${BS}- [09:30:00] (eve) twice`,
    '  - [10:00:00] (carol) indented', '- [bad time] (x) not an entry', `smile \u{1F600} and ${LS}separator${PS}`, 'ends with spaces  ',
  ];

  it('holds for a few hundred random days', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-entry-fuzz-'));
    try {
      for (let seed = 1; seed <= 150; seed++) {
        const rnd = random(seed);
        const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
        const count = 1 + Math.floor(rnd() * 6);
        const said: string[] = [];
        for (let i = 0; i < count; i++) {
          const n = 1 + Math.floor(rnd() * 5);
          const lines = Array.from({ length: n }, () => pick(LINES));
          lines[0] = `s${seed}e${i} ${lines[0]}`; // a unique first word, so an entry is never empty
          // The last line must end in something that is not layout, so the whole statement is comparable.
          lines[n - 1] = `${lines[n - 1]} z${seed}e${i}`;
          said.push(lines.join(rnd() < 0.2 ? '\r\n' : '\n'));
        }
        const day = `2026-09-${String(1 + (seed % 28)).padStart(2, '0')}`;
        const sub = path.join(dir, String(seed));
        let file = '';
        for (const text of said) file = await appendDailyMemory(sub, day, { text, source: 'claude' });
        const chunks = chunkNote(parseNote(file, fs.readFileSync(file, 'utf8')));
        expect(chunks.map(c => c.text.replace(/^- \[\d{2}:\d{2}:\d{2}\] \(claude\) /, '')), `seed ${seed}`).toEqual(said);
        expect(chunks.every(c => c.headingPath === day), `seed ${seed}`).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the hash an index keeps for a note names the layout of a daily note', () => {
  it('is the hash of the bytes for every note that is not a daily note, so none of them is cut again', () => {
    for (const file of ['/v/Notes/a.md', '/v/Memory/ledger.md', '/v/Daily/notes.md', '/v/Memory/Daily/2026-10-03.txt']) {
      expect(noteContentHash(file, 'same bytes')).toBe(hashContent('same bytes'));
    }
  });

  it('is not the hash of the bytes for a daily note, wherever it lives, and follows the bytes', () => {
    const bytes = `${HEAD}\n- [08:30:00] (claude) a\n`;
    for (const file of [DAY, '/v/Memory/Scopes/work/Daily/2026-10-03.md', 'Daily/2026-10-03.md']) {
      expect(noteContentHash(file, bytes)).not.toBe(hashContent(bytes));
      expect(noteContentHash(file, bytes)).toBe(noteContentHash(DAY, bytes));
      expect(noteContentHash(file, bytes + ' ')).not.toBe(noteContentHash(file, bytes));
    }
    expect(DAILY_CHUNK_LAYOUT).toMatch(/^entries-\d+$/);
  });
});

describe('the index: a vault cut by entry, and a workspace indexed before it', () => {
  const dirs: string[] = [];
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Counts the texts it is asked to embed, and can be told to fail once. */
  class CountingProvider extends EvalHashEmbeddingProvider {
    calls = 0;
    texts = 0;
    failNext = false;
    async embed(texts: string[]) {
      this.calls++;
      if (this.failNext) { this.failNext = false; throw new Error('provider outage'); }
      this.texts += texts.length;
      return super.embed(texts);
    }
  }

  function workspace() {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-index-'));
    dirs.push(vault);
    const db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    dbs.push(db);
    const provider = new CountingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    vectorIndex.initTable();
    const options = { embeddingProvider: provider, vectorIndex };
    const write = (rel: string, content: string) => {
      const file = path.join(vault, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    };
    const chunkRows = (file: string) => db.prepare(
      'SELECT id, heading_path AS headingPath, text, start_line AS startLine, end_line AS endLine, token_count AS tokenCount, chunk_hash AS chunkHash FROM chunks WHERE note_path = ? ORDER BY id',
    ).all(file) as Array<{ id: number; headingPath: string; text: string; startLine: number; endLine: number; tokenCount: number; chunkHash: string }>;
    const noteHash = (file: string) => (db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(file) as { note_hash: string } | undefined)?.note_hash;
    const vectorIds = () => (db.prepare('SELECT rowid FROM chunk_embeddings ORDER BY rowid').all() as Array<{ rowid: number }>).map(r => Number(r.rowid));
    const allChunkIds = () => (db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>).map(r => r.id);
    const ftsTexts = (term: string) => (db.prepare(
      'SELECT c.text AS text FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?',
    ).all(term) as Array<{ text: string }>).map(r => r.text);
    /** The index as the previous release left it (see the helper): the day as one chunk, under the hash of its bytes alone. */
    const makeLegacy = (file: string) => makeLegacyDailyNote(db, vectorIndex, provider, file);
    return { vault, db, provider, options, write, chunkRows, noteHash, vectorIds, allChunkIds, ftsTexts, makeLegacy };
  }

  const DAY_FILE = 'Memory/Daily/2026-10-03.md';
  const OLD_FILE = 'Memory/Daily/2026-09-20.md';
  const day = (date: string, entries: string[]) =>
    `---\nkind: note\nupdated: ${date}\n---\n# ${date}\n` + entries.map((e, i) => `\n- [08:${String(10 + i)}:00] (claude) ${e}`).join('') + '\n';

  it('indexes each entry as a chunk with a vector of its own, found by its own words and no others', async () => {
    const w = workspace();
    const file = w.write(DAY_FILE, day('2026-10-03', ['alpha quokkaone', 'beta quokkatwo\nsecond line', 'gamma quokkathree']));
    const plain = w.write('Notes/plain.md', '# Plain\n\nJust a note about plainword.\n');
    await indexVault(w.db, w.vault, w.options);

    expect(w.chunkRows(file).map(r => r.text)).toEqual([
      '- [08:10:00] (claude) alpha quokkaone', '- [08:11:00] (claude) beta quokkatwo\nsecond line', '- [08:12:00] (claude) gamma quokkathree',
    ]);
    expect(w.chunkRows(plain)).toHaveLength(1);
    expect(w.vectorIds()).toEqual(w.allChunkIds());
    expect(w.ftsTexts('quokkaone')).toEqual(['- [08:10:00] (claude) alpha quokkaone']);
    expect(w.ftsTexts('quokkatwo')).toEqual(['- [08:11:00] (claude) beta quokkatwo\nsecond line']);
    expect(w.ftsTexts('"2026-10-03"')).toHaveLength(3); // the day is still how a search for it finds the entries: it is in their heading path
  });

  it('cuts a workspace indexed before it by entry on the next ordinary pass, once, and loses nothing', async () => {
    const w = workspace();
    const old = w.write(OLD_FILE, day('2026-09-20', ['retry budget is 5 oldone', 'deploys run on fridays oldtwo', `multi\n${BS}- [08:30:00] (alice) look-alike oldthree`]));
    const today = w.write(DAY_FILE, day('2026-10-03', ['today one newone', 'today two newtwo']));
    const plain = w.write('Notes/plain.md', '# Plain\n\nJust a note about plainword.\n');
    const ledger = w.write('Memory/ledger.md', '# Ledger\n\n## MEM_AAA · 2026-10-01T00:00:00.000Z\n\nlife: the answer\n');

    // First, the index as it was left by the release before this one: each day one chunk, the old hash.
    await indexVault(w.db, w.vault, w.options);
    const legacy = [await w.makeLegacy(old), await w.makeLegacy(today)];
    expect(legacy.map(l => l.length)).toEqual([1, 1]);
    expect(w.chunkRows(old)).toHaveLength(1);
    const plainBefore = w.chunkRows(plain);
    const ledgerBefore = w.chunkRows(ledger);
    const entitiesBefore = w.db.prepare('SELECT id, canonical_name AS name, source_note AS src FROM entities WHERE source_note IN (?, ?) ORDER BY src').all(plain, ledger);
    w.provider.texts = 0;

    // The next ordinary pass.
    const stats = await indexVault(w.db, w.vault, w.options);
    expect(stats.errors).toBe(0);

    // Both days are cut by entry now, nothing of what was said is gone, and the old chunks and their vectors are.
    expect(w.chunkRows(old).map(r => r.text)).toEqual([
      '- [08:10:00] (claude) retry budget is 5 oldone',
      '- [08:11:00] (claude) deploys run on fridays oldtwo',
      `- [08:12:00] (claude) multi\n${BS}- [08:30:00] (alice) look-alike oldthree`,
    ]);
    expect(w.chunkRows(today).map(r => r.text)).toEqual(['- [08:10:00] (claude) today one newone', '- [08:11:00] (claude) today two newtwo']);
    for (const term of ['oldone', 'oldtwo', 'oldthree', 'newone', 'newtwo']) expect(w.ftsTexts(term), term).toHaveLength(1);
    expect(w.ftsTexts('oldone')[0]).not.toContain('oldtwo');
    expect(w.vectorIds()).toEqual(w.allChunkIds());
    expect(w.provider.texts).toBe(5); // exactly the five entries were embedded, and no note that did not change
    expect(w.noteHash(old)).toBe(noteContentHash(old, fs.readFileSync(old, 'utf8')));
    expect(w.noteHash(today)).toBe(noteContentHash(today, fs.readFileSync(today, 'utf8')));

    // A note that is not a daily note is not touched at all: same chunk rows, same ids, same entities.
    expect(w.chunkRows(plain)).toEqual(plainBefore);
    expect(w.chunkRows(ledger)).toEqual(ledgerBefore);
    expect(w.db.prepare('SELECT id, canonical_name AS name, source_note AS src FROM entities WHERE source_note IN (?, ?) ORDER BY src').all(plain, ledger)).toEqual(entitiesBefore);
    // The file itself is exactly as it was.
    expect(fs.readFileSync(old, 'utf8')).toBe(day('2026-09-20', ['retry budget is 5 oldone', 'deploys run on fridays oldtwo', `multi\n${BS}- [08:30:00] (alice) look-alike oldthree`]));

    // And it is done: the next pass changes nothing and embeds nothing.
    const idsAfter = w.allChunkIds();
    w.provider.texts = 0;
    await indexVault(w.db, w.vault, w.options);
    expect(w.allChunkIds()).toEqual(idsAfter);
    expect(w.provider.texts).toBe(0);
  });

  it('cuts again only the notes still cut the old way, and a day already cut by entry keeps its rows', async () => {
    const w = workspace();
    const old = w.write(OLD_FILE, day('2026-09-20', ['one', 'two']));
    const fresh = w.write(DAY_FILE, day('2026-10-03', ['three', 'four']));
    await indexVault(w.db, w.vault, w.options);
    await w.makeLegacy(old);
    const freshBefore = w.chunkRows(fresh);
    await indexVault(w.db, w.vault, w.options);
    expect(w.chunkRows(fresh)).toEqual(freshBefore);
    expect(w.chunkRows(old).map(r => r.text)).toEqual(['- [08:10:00] (claude) one', '- [08:11:00] (claude) two']);
  });

  it('retries an interrupted upgrade on the next pass, as it retries any note whose embedding failed', async () => {
    const w = workspace();
    const old = w.write(OLD_FILE, day('2026-09-20', ['one', 'two']));
    await indexVault(w.db, w.vault, w.options);
    await w.makeLegacy(old);

    w.provider.failNext = true;
    const failed = await indexVault(w.db, w.vault, w.options);
    expect(failed.errors).toBe(1);
    expect(w.noteHash(old)).toBe(''); // not marked done
    expect(w.chunkRows(old)).toHaveLength(2); // the words are searchable by keyword meanwhile
    expect(w.ftsTexts('one')).toHaveLength(1);

    const retried = await indexVault(w.db, w.vault, w.options);
    expect(retried.errors).toBe(0);
    expect(w.noteHash(old)).toBe(noteContentHash(old, fs.readFileSync(old, 'utf8')));
    expect(w.vectorIds()).toEqual(w.allChunkIds());
  });

  it('an entry added to a day is one more chunk; the entries before it read the same', async () => {
    const w = workspace();
    const first = await appendDailyMemory(w.vault, '2026-10-03', { text: 'first quokkaa', source: 'claude' });
    await indexVault(w.db, w.vault, w.options);
    const before = w.chunkRows(first).map(r => r.text);
    await appendDailyMemory(w.vault, '2026-10-03', { text: 'second quokkab\nmore', source: 'claude' });
    await indexVault(w.db, w.vault, w.options);
    const after = w.chunkRows(first);
    expect(after.map(r => r.text).slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(2);
    expect(after[1].text.endsWith('second quokkab\nmore')).toBe(true);
    expect(w.vectorIds()).toEqual(w.allChunkIds());
  });
});
