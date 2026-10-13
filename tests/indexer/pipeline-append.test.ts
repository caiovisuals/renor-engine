import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile, type IndexOptions } from '../../src/indexer/pipeline';
import * as chunker from '../../src/indexer/chunker';
import { walkVaultStats } from '../../src/indexer/walker';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { embeddingSpace } from '../../src/embeddings/space';

/**
 * A note that only grows at its end is indexed by what was appended (pipeline.ts, indexAppend). The ledger gains one
 * event per fact a save records, and a pass used to read, parse and cut all of it and read every chunk it had back
 * from the index, so a fact save cost what the ledger held. Now the next pass over a note this process indexed, when
 * the file is the same bytes and more, cuts it from its last section on (chunkBodyFrom); anything else goes through
 * the full pass (chunkNoteCut). Whichever path a pass takes, the note's rows must be the ones a fresh index of the same
 * bytes holds, so every test here compares the two, and checks which path ran.
 * Synthetic notes, the repo's hash embeddings (no model).
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

class CountingProvider extends EvalHashEmbeddingProvider {
  texts: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.texts.push(...texts);
    return super.embed(texts);
  }
}

/** The hash stub without its declared identity: nothing stored is ever reused for a provider like it. */
function unnamedProvider(): CountingProvider {
  const provider = new CountingProvider();
  Object.defineProperty(provider, 'identity', { value: undefined });
  return provider;
}

interface Index {
  db: Database.Database;
  provider: CountingProvider;
  vectors: VectorIndex;
  options: IndexOptions;
}

function newIndex(provider: CountingProvider = new CountingProvider()): Index {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-db-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  dbs.push(db);
  runMigrations(db);
  const vectors = new VectorIndex(db, provider.dimensions);
  vectors.initTable();
  return { db, provider, vectors, options: { embeddingProvider: provider, vectorIndex: vectors } };
}

function noteFile(content: string | Buffer, name = 'Ledger.md'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-note-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const HEAD = '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Ledger\n\nAppend-only durable record.\n';
const event = (k: number, body = `value ${k}`) => `\n## MEM_${String(k).padStart(4, '0')} · 2026-01-01T00:00:00.000Z\n- kind: store\n- object: ${body}\n- source: test\n`;
const ledger = (events: number) => HEAD + Array.from({ length: events }, (_, k) => event(k)).join('');

/** One note's rows, as a fresh index of the same bytes must hold them (ids aside: they are positions there). */
function noteState(db: Database.Database, file: string) {
  const all = (sql: string) => db.prepare(sql).all(file);
  return {
    note: db.prepare('SELECT title, kind, note_hash, modified_at, frontmatter_json FROM notes WHERE path = ?').get(file),
    chunks: all('SELECT heading_path, text, start_line, end_line, token_count, chunk_hash FROM chunks WHERE note_path = ? ORDER BY id'),
    search: all('SELECT text, heading_path FROM chunks_fts WHERE note_path = ? ORDER BY rowid'),
    entities: all('SELECT type, canonical_name, aliases_json FROM entities WHERE source_note = ? ORDER BY id'),
    facts: all('SELECT predicate, object_text, confidence FROM facts WHERE source_path = ? ORDER BY id'),
    relations: all(`SELECT r.relation, t.canonical_name AS target, t.source_note AS target_note FROM relations r
                    JOIN entities t ON t.id = r.target_entity_id WHERE r.source_note = ? ORDER BY r.id`),
  };
}

/** Every chunk has exactly one vector, and it is the embedding of that chunk's current text. */
async function vectorsMatchText(ix: Index): Promise<boolean> {
  const chunks = ix.db.prepare('SELECT id, text FROM chunks').all() as Array<{ id: number; text: string }>;
  const vectorCount = (ix.db.prepare('SELECT COUNT(*) c FROM chunk_embeddings').get() as { c: number }).c;
  if (vectorCount !== chunks.length) return false;
  const wanted = await new EvalHashEmbeddingProvider().embed(chunks.map((c) => c.text));
  return chunks.every((c, i) => {
    const stored = ix.vectors.get(c.id);
    return !!stored && stored.every((x, j) => Math.abs(x - wanted[i][j]) < 1e-6);
  });
}

/** The note's rows in `ix` equal a fresh index's of the file as it is now, vectors included when it embeds. */
async function expectFresh(ix: Index, file: string, options: IndexOptions = ix.options, label = '') {
  const fresh = newIndex(new CountingProvider());
  const freshOptions: IndexOptions = options === ix.options ? fresh.options
    : options.embeddingProvider ? { ...options, embeddingProvider: fresh.provider, vectorIndex: fresh.vectors } : {};
  await indexFile(fresh.db, file, freshOptions);
  expect(noteState(ix.db, file), label).toEqual(noteState(fresh.db, file));
  ix.db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1)").run();
  expect(ix.db.pragma('foreign_key_check')).toEqual([]);
  if (options.embeddingProvider) expect(await vectorsMatchText(ix), `${label} vectors`).toBe(true);
}

/**
 * Which path a pass takes: the append path cuts the note from its last section on, the full one cuts all of it (an
 * append path that finds the rows are not the ones it expected gives way to the full pass, which then cuts it all).
 */
function paths() {
  const append = vi.spyOn(chunker, 'chunkBodyFrom');
  const full = vi.spyOn(chunker, 'chunkNoteCut');
  return {
    async of(run: () => Promise<unknown>): Promise<'append' | 'full' | 'none'> {
      append.mockClear();
      full.mockClear();
      await run();
      return full.mock.calls.length ? 'full' : append.mock.calls.length ? 'append' : 'none';
    },
  };
}

describe('an append is indexed by what was appended, and leaves the rows a fresh index of the same bytes holds', () => {
  it('each event appended to a ledger takes the append path and embeds the new event alone', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(5));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    for (let k = 5; k < 15; k++) {
      fs.appendFileSync(file, event(k));
      ix.provider.texts = [];
      expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
      expect(ix.provider.texts).toEqual([event(k).trim()]);
      await expectFresh(ix, file, ix.options, `event ${k}`);
    }
  });

  it('appended text of every shape leaves the same rows as a fresh index (seeded random appends)', async () => {
    const r = rng(20261003);
    const word = () => WORDS[Math.floor(r() * WORDS.length)];
    const pieces: Array<() => string> = [
      () => event(Math.floor(r() * 9999), `${word()} ${word()}`),
      () => `\n## Section ${word()}\n\n${sentence(r, 30)}\n`,
      () => `\n### Detail ${word()}\n${sentence(r, 12)}\n`,
      () => `\n# Another title ${word()}\n\n${sentence(r, 8)}\n`, // a new H1 starts a new heading stack
      () => `- one more line about ${word()}\n`, // no heading: it extends the last section
      () => '\n\n\n',
      () => `${Array.from({ length: 4 }, () => sentence(r, 120)).join('\n\n')}\n`, // a section long enough to be split
      () => `- see [[Ledger]] and [[Ledger|the ledger]] and [[nowhere ${word()}]]\n`,
      () => `- trailing spaces ${word()}   \n`,
      () => '#\n#not a heading\n##\n---\n',
      () => `- ação ✓ 日本語 ${word()}\n`,
      () => `- a windows line ${word()}\r\n`,
      () => `- no line break at the end ${word()}`,
      () => `\n## MEM_0001 · 2026-01-01T00:00:00.000Z\n- kind: store\n- object: value 1\n- source: test\n`, // an earlier event's exact text
    ];
    let appended = 0;
    let full = 0;
    for (let trial = 0; trial < 6; trial++) {
      const ix = newIndex();
      const file = noteFile(ledger(1 + Math.floor(r() * 6)));
      await indexFile(ix.db, file, ix.options);
      const via = paths();
      for (let step = 0; step < 12; step++) {
        fs.appendFileSync(file, pieces[Math.floor(r() * pieces.length)]());
        const took = await via.of(() => indexFile(ix.db, file, ix.options));
        if (took === 'append') appended++;
        else full++;
        await expectFresh(ix, file, ix.options, `trial ${trial} step ${step}`);
      }
      vi.restoreAllMocks();
    }
    // Both paths ran, often, or the comparison would prove nothing about one of them.
    expect(appended).toBeGreaterThanOrEqual(30);
    expect(full).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('an append that starts with a heading keeps the last section\'s chunk, row and all, as the full pass does', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(4));
    await indexFile(ix.db, file, ix.options);
    const before = ix.db.prepare('SELECT id FROM chunks ORDER BY id').pluck().all() as number[];
    const via = paths();
    fs.appendFileSync(file, '## Straight after the last line\n- nothing between them\n'); // the last section's lines do not change
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    const after = ix.db.prepare('SELECT id FROM chunks ORDER BY id').pluck().all() as number[];
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    await expectFresh(ix, file);
  });

  it('a pass over the note when nothing changed keeps the append path for the next append', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(4));
    await indexFile(ix.db, file, ix.options);
    await indexFile(ix.db, file, ix.options); // as a save does when the file's stamp is too recent to trust
    const via = paths();
    fs.appendFileSync(file, event(4));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    await expectFresh(ix, file);
  });

  it('without an embedding provider the append path writes the same rows and no vector', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(4));
    await indexFile(ix.db, file, {});
    const via = paths();
    fs.appendFileSync(file, event(4));
    expect(await via.of(() => indexFile(ix.db, file, {}))).toBe('append');
    await expectFresh(ix, file, {});
    expect((ix.db.prepare('SELECT COUNT(*) c FROM chunk_embeddings').get() as { c: number }).c).toBe(0);
  });

  it('while the index is being rebuilt the append path leaves the chunks to the rebuild, as the full pass does', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(4));
    await indexFile(ix.db, file, ix.options);
    ix.vectors.beginRebuild(embeddingSpace(ix.provider)!);
    ix.provider.texts = [];
    const via = paths();
    fs.appendFileSync(file, event(4));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    expect(ix.provider.texts).toEqual([]);
    const fresh = newIndex();
    fresh.vectors.beginRebuild(embeddingSpace(fresh.provider)!);
    await indexFile(fresh.db, file, fresh.options);
    expect(noteState(ix.db, file)).toEqual(noteState(fresh.db, file));
  });
});

describe('anything an append path could get wrong goes through the full pass', () => {
  it('an edit to what was indexed, then an append: the bytes differ, so the note is indexed in full', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(6));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.writeFileSync(file, ledger(6).replace('value 2', 'value 7') + event(6)); // the same length where it changed
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('a note cut shorter is indexed in full', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(6));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.writeFileSync(file, ledger(4));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('a note replaced by a longer copy of itself is an append: the bytes say so, whatever wrote them', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(6));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    const incoming = `${file}.tmp`;
    fs.writeFileSync(incoming, ledger(8));
    fs.renameSync(incoming, file);
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    await expectFresh(ix, file);
  });

  it('after an append without a final line break, the next append is indexed in full (it may extend that line)', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(3));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, '\n## Open\n- this line has no break');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    await expectFresh(ix, file);
    fs.appendFileSync(file, ' and goes on here\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('a wikilink opened before an append and closed by it is found, since the next pass after an opening is a full one', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(3));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    // The alias part of a link may span lines (and headings), so this opening can still become a link to the note.
    fs.appendFileSync(file, '\n## Linked\n- see [[Ledger|the\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    await expectFresh(ix, file);
    fs.appendFileSync(file, '\n## Later\n- whole ledger]] here\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
    expect(noteState(ix.db, file).relations).toEqual([{ relation: 'links_to', target: 'Ledger', target_note: file }]);
  });

  it('an opening [[ the full pass found unclosed keeps the note on the full path, which then finds the link', async () => {
    const ix = newIndex();
    const file = noteFile(`${ledger(3)}\n## Linked\n- see [[Ledger|the\n`);
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, '- whole ledger]] here\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
    expect(noteState(ix.db, file).relations).toEqual([{ relation: 'links_to', target: 'Ledger', target_note: file }]);
  });

  it('a note the full pass found without a final line break is indexed in full when appended to', async () => {
    const ix = newIndex();
    const file = noteFile(`${ledger(3)}\n## Open\n- this line has no break`);
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, ' and goes on here\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('a daily note is indexed in full, as an entry appended to it can change how all of it is cut', async () => {
    const ix = newIndex();
    // A journal under Daily/ cut by its headings until the engine appends its first entry: then it is cut by entry.
    const file = path.join(path.dirname(noteFile('')), 'Daily', '2026-01-01.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# 2026-01-01\n\nA journal written by hand.\n\n## Afternoon\nMore of it.\n');
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, '- [09:00:00] (test) the first entry the engine writes\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('a note whose title comes from its file name is indexed in full (an appended heading could become its title)', async () => {
    const ix = newIndex();
    const file = noteFile('a log without a title\n#\n', 'Running Log.md');
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, 'Now a title\n'); // `#`, a line break, then text: the title the regex reads
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
    expect(noteState(ix.db, file).entities).toEqual([{ type: 'note', canonical_name: 'Now a title', aliases_json: '[]' }]);
  });

  it('a frontmatter block that was never closed is indexed in full when an append closes it', async () => {
    const ix = newIndex();
    const file = noteFile('---\naliases: [Old]\n');
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, '---\n# Closed\n\nbody\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('frontmatter, a byte order mark and windows line breaks are kept as the full pass keeps them', async () => {
    const ix = newIndex();
    const head = '---\naliases: [The Ledger]\nowner: ops\nupdated: 2026-01-01\ntags: [a, b]\n---\n# Ledger\r\n\r\nrecord\r\n';
    const file = noteFile(`${String.fromCodePoint(0xfeff)}${head}`);
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, '\r\n## Windows\r\n- line\r\n');
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    await expectFresh(ix, file);
    fs.appendFileSync(file, event(9));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    await expectFresh(ix, file);
    expect(noteState(ix.db, file).facts).toHaveLength(3);
  });

  it('bytes that are not UTF-8 are indexed in full, as text with replacement characters', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(3));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    fs.appendFileSync(file, Buffer.from([0x0a, 0x2d, 0x20, 0xff, 0xfe, 0x0a]));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
    fs.appendFileSync(file, event(3));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    await expectFresh(ix, file);
  });

  it('other chunk options cut the note in full', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(3) + `\n## Long\n\n${Array.from({ length: 6 }, (_, i) => sentence(rng(i), 120)).join('\n\n')}\n`);
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    const small: IndexOptions = { ...ix.options, chunkOptions: { maxTokens: 120, overlapTokens: 30 } };
    fs.appendFileSync(file, `${sentence(rng(9), 200)}\n`);
    expect(await via.of(() => indexFile(ix.db, file, small))).toBe('full');
    await expectFresh(ix, file, small);
    fs.appendFileSync(file, `\n${sentence(rng(10), 200)}\n`);
    expect(await via.of(() => indexFile(ix.db, file, small))).toBe('append'); // the options it was cut with
    await expectFresh(ix, file, small);
  });

  it('an appended section whose text an earlier one holds goes through the full pass, which copies that vector', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(4));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    ix.provider.texts = [];
    fs.appendFileSync(file, event(1)); // the second event, again
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    expect(ix.provider.texts).toEqual([]);
    await expectFresh(ix, file);
  });

  it('a section repeating one that earlier appends moved above the last section goes through the full pass too', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(3));
    await indexFile(ix.db, file, ix.options);
    const via = paths();
    for (const k of [3, 4]) {
      fs.appendFileSync(file, event(k));
      expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('append');
    }
    ix.provider.texts = [];
    fs.appendFileSync(file, event(3)); // the event the first append added, now above the last section
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    expect(ix.provider.texts).toEqual([]);
    await expectFresh(ix, file);
  });

  it('a stored vector removed since the last pass sends the note through the full pass, which embeds it again', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(5));
    await indexFile(ix.db, file, ix.options);
    const lost = ix.db.prepare("SELECT id FROM chunks WHERE text LIKE '%value 2%'").get() as { id: number };
    ix.vectors.delete(lost.id);
    ix.provider.texts = [];
    const via = paths();
    fs.appendFileSync(file, event(5));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    expect(ix.provider.texts.map((t) => t.match(/value \d+/)![0]).sort()).toEqual(['value 2', 'value 5']);
    await expectFresh(ix, file);
  });

  it('rows changed behind the pass (a chunk gone, or the note marked unfinished) send it through the full pass', async () => {
    const changes: Record<string, (ix: Index) => void> = {
      'a chunk and its vector deleted': (ix) => {
        const first = ix.db.prepare('SELECT MIN(id) FROM chunks').pluck().get() as number;
        ix.db.prepare('DELETE FROM chunks WHERE id = ?').run(first);
        ix.vectors.delete(first);
      },
      'the note marked unfinished': (ix) => { ix.db.prepare("UPDATE notes SET note_hash = ''").run(); },
    };
    for (const [name, change] of Object.entries(changes)) {
      const ix = newIndex();
      const file = noteFile(ledger(5));
      await indexFile(ix.db, file, ix.options);
      change(ix);
      const via = paths();
      fs.appendFileSync(file, event(5));
      expect(await via.of(() => indexFile(ix.db, file, ix.options)), name).toBe('full');
      await expectFresh(ix, file, ix.options, name);
    }
  });

  it('a provider that declares no identity has the note embedded whole on every pass, as before', async () => {
    const ix = newIndex(unnamedProvider());
    const file = noteFile(ledger(4));
    await indexFile(ix.db, file, ix.options);
    ix.provider.texts = [];
    const via = paths();
    fs.appendFileSync(file, event(4));
    expect(await via.of(() => indexFile(ix.db, file, ix.options))).toBe('full');
    expect(ix.provider.texts).toHaveLength(6); // the heading section and the five events
  });

  it('a pass that runs an extraction lane reads the whole note, so it is a full one', async () => {
    const ix = newIndex();
    const extracted: string[] = [];
    const withLane: IndexOptions = { ...ix.options, factExtractor: async (_title, body) => { extracted.push(body); return []; } };
    const file = noteFile(ledger(3));
    await indexFile(ix.db, file, withLane);
    const via = paths();
    fs.appendFileSync(file, event(3));
    expect(await via.of(() => indexFile(ix.db, file, withLane))).toBe('full');
    expect(extracted.at(-1)).toContain('value 3');
  });
});

describe('what an appended ledger costs', () => {
  /** How many chunk texts a pass reads back from the index (a db.prepare spy over every statement it runs). */
  async function chunkTextsRead(db: Database.Database, run: () => Promise<unknown>): Promise<number> {
    let rows = 0;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (!/\btext\b[^]*\bFROM chunks\b/.test(sql)) return statement;
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      Object.assign(statement, {
        all: (...args: unknown[]) => { const out = all(...args); rows += out.length; return out; },
        get: (...args: unknown[]) => { const out = get(...args); if (out !== undefined) rows++; return out; },
      });
      return statement;
    }) as typeof db.prepare);
    await run();
    vi.restoreAllMocks();
    return rows;
  }

  it('an append reads back the chunks of the last section only, whether the ledger holds 10 events or 400', async () => {
    const read: Record<number, number> = {};
    for (const events of [10, 400]) {
      const ix = newIndex();
      const file = noteFile(ledger(events));
      await indexFile(ix.db, file, ix.options);
      fs.appendFileSync(file, event(events));
      await indexFile(ix.db, file, ix.options); // the first pass in a process reads everything once; this one appends
      fs.appendFileSync(file, event(events + 1));
      read[events] = await chunkTextsRead(ix.db, () => indexFile(ix.db, file, ix.options));
      await expectFresh(ix, file);
    }
    expect(read).toEqual({ 10: 1, 400: 1 }); // a full pass reads every chunk the note holds back: 12 and 402
  });
});

describe('what every save pays, whatever changed', () => {
  const plan = (db: Database.Database, sql: string, ...args: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((step) => step.detail).join('\n');

  it('counting the stored vectors of the chunks a pass keeps looks each one up, rather than reading every vector', async () => {
    const ix = newIndex();
    await indexFile(ix.db, noteFile(ledger(3)), ix.options);
    const counter = new VectorIndex(ix.db, ix.provider.dimensions); // prepares its statements on first use
    const prepared = vi.spyOn(ix.db, 'prepare');
    expect(counter.countStored([1, 2, 99])).toBe(2);
    const sql = String(prepared.mock.calls.at(-1)![0]);
    prepared.mockRestore();
    // vec0 does not take an IN list as a key: asked of the vector table itself, the count reads every stored vector.
    expect(plan(ix.db, sql, '[1]')).toMatch(/SEARCH \S+ USING INTEGER PRIMARY KEY/);
    expect(plan(ix.db, sql, '[1]')).not.toMatch(/SCAN chunk_embeddings VIRTUAL TABLE/);
  });

  it('a chunk or an entity a pass deletes finds the rows whose foreign keys point at it by an index', async () => {
    const ix = newIndex();
    // The lookups SQLite runs for each deleted row (facts.source_chunk_id and structured_rows.source_chunk_id point at
    // chunks, facts.object_entity_id at entities): without an index each one reads every fact or structured row.
    for (const [table, column] of [['facts', 'source_chunk_id'], ['facts', 'object_entity_id'], ['structured_rows', 'source_chunk_id']]) {
      expect(plan(ix.db, `SELECT 1 FROM ${table} WHERE ${column} = ?`, 1), `${table}.${column}`).toMatch(/USING (COVERING )?INDEX/);
    }
  });

  it('the walk every save runs joins a folder\'s path once, not once for each file in it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-walk-'));
    tmpDirs.push(dir);
    for (const folder of ['a', 'b', 'c/d']) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, folder, `n${i}.md`), `# N${i}\n`);
    }
    const joins = vi.spyOn(path, 'join');
    const files = await walkVaultStats(dir);
    const joined = joins.mock.calls.length;
    joins.mockRestore();
    expect(files).toHaveLength(150);
    expect(joined).toBeLessThanOrEqual(8); // the .semanticignore lookup and one per folder (5); it was one per entry too
  });
});

// ----------------------------------------------------------------------------------------------------------------

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omicron sigma tau upsilon'.split(' ');

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(r: () => number, n: number): string {
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
}
