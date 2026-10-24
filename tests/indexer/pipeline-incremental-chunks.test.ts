import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile, type IndexOptions } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { insertStructuredRows } from '../../src/context/rowStore';
import { FACTS_EXTRACTION_VERSION } from '../../src/extraction/typedFacts';
import { hashContent } from '../../src/indexer/hasher';
import { embeddingSpace } from '../../src/embeddings/space';

/**
 * An edited file costs what changed in it, not what it holds. A ledger is one chunk per event and
 * is appended to constantly, so re-indexing it after each append used to delete and re-insert every
 * chunk and its search entries, and embed every chunk again. Now:
 *   - a chunk whose text is unchanged keeps its vector (copied to the replacement chunk), so only
 *     chunks with new text are embedded;
 *   - the chunks from the top of the note that are already stored exactly as they are now keep their
 *     rows, search entries and vectors, and only the rest is replaced.
 * Whatever is kept, the index must be the one a fresh index of the same text would hold.
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
  calls = 0;
  failNext = 0;
  async embed(texts: string[]): Promise<number[][]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('synthetic embedding outage');
    }
    this.calls++;
    this.texts.push(...texts);
    return super.embed(texts);
  }
}

interface Index {
  db: Database.Database;
  provider: CountingProvider;
  vectors: VectorIndex;
  options: IndexOptions;
}

function newIndex(inMemory = false): Index {
  const dbPath = inMemory ? ':memory:' : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chunks-db-')), 'index.db');
  if (!inMemory) tmpDirs.push(path.dirname(dbPath));
  const db = openDb(dbPath);
  dbs.push(db);
  runMigrations(db);
  const provider = new CountingProvider();
  const vectors = new VectorIndex(db, provider.dimensions);
  vectors.initTable();
  return { db, provider, vectors, options: { embeddingProvider: provider, vectorIndex: vectors } };
}

function noteFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunks-note-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'Ledger.md');
  fs.writeFileSync(file, content);
  return file;
}

const HEAD = '---\ntype: ledger\n---\n\n# Ledger\n\nAppend-only record.\n';
const section = (k: number, body = `value ${k}`) => `\n## Event ${k}\n- kind: store\n- object: ${body}\n`;
const ledger = (events: number) => HEAD + Array.from({ length: events }, (_, k) => section(k)).join('');

const chunkIds = (db: Database.Database) =>
  (db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);

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

describe('indexFile reuses the vector of a chunk whose text did not change', () => {
  it('appending a section embeds only the new chunk and leaves the index a fresh index would build', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.texts).toHaveLength(9); // the heading section and the 8 events
    ix.provider.texts = [];

    fs.appendFileSync(file, section(8));
    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.texts).toHaveLength(1);
    expect(ix.provider.texts[0]).toContain('## Event 8');
    expect(await vectorsMatchText(ix)).toBe(true);

    const fresh = newIndex();
    await indexFile(fresh.db, file, fresh.options);
    expect(snapshot(ix.db)).toEqual(snapshot(fresh.db));
  });

  it('editing one section embeds only that section', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    ix.provider.texts = [];

    fs.writeFileSync(file, ledger(8).replace('value 3', 'a corrected value'));
    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.texts).toHaveLength(1);
    expect(ix.provider.texts[0]).toContain('a corrected value');
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('removing a section embeds nothing and drops its vector', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    ix.provider.texts = [];
    ix.provider.calls = 0;

    fs.writeFileSync(file, ledger(8).replace(section(4), ''));
    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.calls).toBe(0);
    expect(await vectorsMatchText(ix)).toBe(true);
    expect((ix.db.prepare("SELECT COUNT(*) c FROM chunks WHERE text LIKE '%Event 4%'").get() as { c: number }).c).toBe(0);
  });

  it('two chunks with the same text both keep a vector', async () => {
    const ix = newIndex();
    const twin = '\n## Same\n- a repeated section\n';
    const file = noteFile(HEAD + twin + section(1) + twin);
    await indexFile(ix.db, file, ix.options);
    ix.provider.texts = [];

    fs.appendFileSync(file, section(2));
    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.texts).toHaveLength(1);
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('a chunk with no stored vector is embedded, not copied', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(5));
    await indexFile(ix.db, file, ix.options);
    const lost = ix.db.prepare("SELECT id FROM chunks WHERE text LIKE '%Event 2%'").get() as { id: number };
    ix.vectors.delete(lost.id); // e.g. an embedding that failed earlier
    ix.provider.texts = [];

    fs.appendFileSync(file, section(5));
    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.texts.map((t) => t.match(/Event \d+/)![0]).sort()).toEqual(['Event 2', 'Event 5']);
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('a failed embedding leaves the note pending, and the retry embeds only what is missing', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(5));
    await indexFile(ix.db, file, ix.options);
    ix.provider.texts = [];

    fs.appendFileSync(file, section(5));
    ix.provider.failNext = 1;
    await expect(indexFile(ix.db, file, ix.options)).rejects.toThrow('synthetic embedding outage');
    expect((ix.db.prepare('SELECT note_hash h FROM notes').get() as { h: string }).h).toBe('');

    await indexFile(ix.db, file, ix.options);
    expect(ix.provider.texts).toHaveLength(1);
    expect(ix.provider.texts[0]).toContain('## Event 5');
    expect((ix.db.prepare('SELECT note_hash h FROM notes').get() as { h: string }).h).not.toBe('');
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('an index that cannot copy embeds every chunk it replaces, as before', async () => {
    const ix = newIndex();
    const noCopy: IndexOptions = {
      embeddingProvider: ix.provider,
      vectorIndex: { upsert: (id, v) => ix.vectors.upsert(id, v), delete: (id) => ix.vectors.delete(id) },
    };
    const file = noteFile(ledger(5));
    await indexFile(ix.db, file, noCopy);
    ix.provider.texts = [];

    fs.appendFileSync(file, section(5));
    await indexFile(ix.db, file, noCopy);
    expect(ix.provider.texts).toHaveLength(7); // heading section, 5 old events, 1 new
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('without an embedding provider nothing is copied or embedded', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(3));
    await indexFile(ix.db, file, { vectorIndex: ix.vectors });
    expect((ix.db.prepare('SELECT COUNT(*) c FROM chunk_embeddings').get() as { c: number }).c).toBe(0);
    fs.appendFileSync(file, section(3));
    await indexFile(ix.db, file, { vectorIndex: ix.vectors });
    expect((ix.db.prepare('SELECT COUNT(*) c FROM chunk_embeddings').get() as { c: number }).c).toBe(0);
  });
});

describe('indexFile keeps the unchanged chunks from the top of an edited note', () => {
  it('appending a section keeps every chunk above the last one and replaces only that one and the new one', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    const before = chunkIds(ix.db); // the heading section and 8 events
    expect(before).toHaveLength(9);

    fs.appendFileSync(file, section(8));
    await indexFile(ix.db, file, ix.options);
    const after = chunkIds(ix.db);
    expect(after).toHaveLength(10);
    expect(after.slice(0, 8)).toEqual(before.slice(0, 8)); // untouched rows, same ids
    // The old last event (its end line moved) and the new event are the only rows written.
    expect(after.slice(8).every((id) => id > Math.max(...before))).toBe(true);
  });

  it('an edit in the middle keeps the chunks above it and replaces everything from it down', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    const before = chunkIds(ix.db);

    fs.writeFileSync(file, ledger(8).replace('value 3', 'a corrected value')); // chunk 4 of 9
    await indexFile(ix.db, file, ix.options);
    const after = chunkIds(ix.db);
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
    expect(after.slice(4).every((id) => id > Math.max(...before))).toBe(true);
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('a note whose last pass did not finish is replaced whole', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    const before = chunkIds(ix.db);
    ix.db.prepare("UPDATE notes SET note_hash = ''").run();

    fs.appendFileSync(file, section(8));
    await indexFile(ix.db, file, ix.options);
    expect(chunkIds(ix.db).every((id) => id > Math.max(...before))).toBe(true);
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('a stored chunk without its vector makes the pass replace the whole note, which heals it', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, ix.options);
    const before = chunkIds(ix.db);
    ix.vectors.delete(before[2]);

    fs.appendFileSync(file, section(8));
    await indexFile(ix.db, file, ix.options);
    expect(chunkIds(ix.db).every((id) => id > Math.max(...before))).toBe(true);
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('a note with structured rows is replaced whole, so they are reattached as before', async () => {
    const ix = newIndex();
    const text = ledger(4);
    const file = noteFile(text);
    await indexFile(ix.db, file, ix.options);
    const before = chunkIds(ix.db);
    insertStructuredRows(ix.db, [{
      rowKind: 'fact',
      sourcePath: file,
      sourceChunkId: before[1],
      sourceHash: hashContent(text),
      extractionVersion: FACTS_EXTRACTION_VERSION,
      validFrom: '2026-03-10',
      payload: { value: '14', unit: 'kg', verb: 'weighs', object: 'dog' },
    }]);

    fs.appendFileSync(file, section(4));
    await indexFile(ix.db, file, ix.options);
    expect(chunkIds(ix.db).every((id) => id > Math.max(...before))).toBe(true);
  });

  it('an index that cannot report stored vectors replaces the whole note, and still embeds only new text', async () => {
    const ix = newIndex();
    const noCount: IndexOptions = {
      embeddingProvider: ix.provider,
      vectorIndex: {
        upsert: (id, v) => ix.vectors.upsert(id, v),
        delete: (id) => ix.vectors.delete(id),
        copy: (from, to) => ix.vectors.copy(from, to),
        space: () => ix.vectors.space(),
        setSpace: (space) => ix.vectors.setSpace(space),
        hasVectors: () => ix.vectors.hasVectors(),
      },
    };
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, noCount);
    const before = chunkIds(ix.db);
    ix.provider.texts = [];

    fs.appendFileSync(file, section(8));
    await indexFile(ix.db, file, noCount);
    expect(chunkIds(ix.db).every((id) => id > Math.max(...before))).toBe(true);
    expect(ix.provider.texts).toHaveLength(1);
    expect(await vectorsMatchText(ix)).toBe(true);
  });

  it('without an embedding provider the leading chunks are kept and no vector is involved', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(8));
    await indexFile(ix.db, file, {});
    const before = chunkIds(ix.db);

    fs.appendFileSync(file, section(8));
    await indexFile(ix.db, file, {});
    expect(chunkIds(ix.db).slice(0, 8)).toEqual(before.slice(0, 8));
    expect((ix.db.prepare('SELECT COUNT(*) c FROM chunk_embeddings').get() as { c: number }).c).toBe(0);
  });
});

describe('stored vectors are kept and copied only within one embedding space', () => {
  /** Same dimensions as the hash stub, but a different model: its vectors are the negation of the stub's. */
  class OtherModel extends CountingProvider {
    readonly identity = { kind: 'eval-hash', model: 'another-model' };
    async embed(texts: string[]): Promise<number[][]> {
      return (await super.embed(texts)).map((v) => v.map((x) => -x));
    }
  }

  /** Two models with the same dimensions and no declared identity, as a service restarted with another model sees them. */
  const unnamed = (vector: number[]) => ({
    dimensions: 4,
    texts: [] as string[],
    async embed(texts: string[]) {
      this.texts.push(...texts);
      return texts.map(() => vector);
    },
  });

  const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  const allVectors = (ix: Index) => (ix.db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>)
    .map((c) => ix.vectors.get(c.id));

  it('a new index takes the provider\'s space with its first vectors', async () => {
    const ix = newIndex();
    expect(ix.vectors.space()).toBeNull();
    await indexFile(ix.db, noteFile(ledger(3)), ix.options);
    expect(ix.vectors.space()).toBe(embeddingSpace(ix.provider));
  });

  it('a model with the same dimensions and no declared identity re-embeds an edited note whole: nothing of the old model survives in it', async () => {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'space-db-')), 'index.db'));
    tmpDirs.push(path.dirname(db.name));
    dbs.push(db);
    runMigrations(db);
    const vectors = new VectorIndex(db, 4);
    vectors.initTable();
    const first = unnamed([1, 0, 0, 0]);
    const second = unnamed([0, 1, 0, 0]);
    const file = noteFile('# A\n\n## B\nbody\n');
    await indexFile(db, file, { embeddingProvider: first, vectorIndex: vectors });

    fs.appendFileSync(file, '\n## C\nmore\n');
    await indexFile(db, file, { embeddingProvider: second, vectorIndex: vectors });

    const stored = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: number }>).map((c) => vectors.get(c.id));
    expect(stored).toHaveLength(3);
    for (const vector of stored) expect(vector!.map((x) => Math.round(x * 1e6) / 1e6)).toEqual(unit([0, 1, 0, 0]));
    expect(second.texts).toHaveLength(3); // every chunk, not just the new one
    expect(vectors.space()).toBeNull(); // an unnamed provider claims nothing
  });

  it('a different declared model fails the file before anything changes, rather than mixing vectors', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(5));
    await indexFile(ix.db, file, ix.options);
    const rows = snapshot(ix.db);
    const vectorsBefore = allVectors(ix);

    fs.appendFileSync(file, section(5));
    const other = new OtherModel();
    await expect(indexFile(ix.db, file, { embeddingProvider: other, vectorIndex: ix.vectors })).rejects.toThrow(/another embedding model/);
    expect(snapshot(ix.db)).toEqual(rows);
    expect(allVectors(ix)).toEqual(vectorsBefore);
    expect(other.texts).toHaveLength(0);
    expect(ix.vectors.space()).toBe(embeddingSpace(ix.provider)); // still the original model's
  });

  it('an index that holds vectors but never recorded their space reuses nothing, and does not claim one', async () => {
    const ix = newIndex();
    const file = noteFile(ledger(5));
    // vectors of unknown origin (no identity declared), 256-d like the stub
    const unknownOrigin = { dimensions: 256, embed: async (texts: string[]) => texts.map(() => new Array(256).fill(1)) };
    await indexFile(ix.db, file, { embeddingProvider: unknownOrigin, vectorIndex: ix.vectors });
    expect(ix.vectors.space()).toBeNull();
    expect(ix.vectors.hasVectors()).toBe(true);

    fs.appendFileSync(file, section(5));
    await indexFile(ix.db, file, ix.options); // a named provider, vectors of unknown origin already stored
    expect(ix.provider.texts).toHaveLength(7); // all chunks again: none could be vouched for
    expect(ix.vectors.space()).toBeNull();
    expect(await vectorsMatchText(ix)).toBe(true);
  });
});

// ---------------------------- randomized equivalence with a fresh index ----------------------------

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

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omicron sigma tau upsilon'.split(' ');

function randomSection(r: () => number, n: number): string {
  const level = 1 + Math.floor(r() * 3);
  const paragraphs = 1 + Math.floor(r() * (r() < 0.15 ? 45 : 3)); // now and then long enough to be split
  const body = Array.from({ length: paragraphs }, () =>
    Array.from({ length: 5 + Math.floor(r() * 60) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' '),
  ).join('\n\n');
  return `${'#'.repeat(level)} Section ${n} ${WORDS[Math.floor(r() * WORDS.length)]}\n\n${body}\n`;
}

interface Doc { tags: string[]; sections: string[] }

const render = (d: Doc) => `---\ntags: [${d.tags.join(', ')}]\n---\n${d.sections.join('\n')}`;

function mutate(d: Doc, r: () => number, counter: { n: number }): Doc {
  const sections = [...d.sections];
  const at = () => Math.floor(r() * sections.length);
  const pick = Math.floor(r() * 9);
  if (pick === 0 || sections.length === 0) sections.push(randomSection(r, counter.n++));
  else if (pick === 1) sections[sections.length - 1] += `- an extra line ${WORDS[Math.floor(r() * WORDS.length)]}\n`;
  else if (pick === 2) sections[at()] = randomSection(r, counter.n++);
  else if (pick === 3 && sections.length > 1) sections.splice(at(), 1);
  else if (pick === 4) sections.splice(at(), 0, randomSection(r, counter.n++));
  else if (pick === 5) sections.splice(at(), 0, sections[at()]); // a repeated section
  else if (pick === 6 && sections.length > 2) sections.length = 1 + Math.floor(r() * (sections.length - 1));
  else if (pick === 7 && sections.length > 1) {
    const i = at();
    const j = at();
    [sections[i], sections[j]] = [sections[j], sections[i]];
  } else return { ...d, tags: [WORDS[Math.floor(r() * WORDS.length)], WORDS[Math.floor(r() * WORDS.length)]] };
  return { ...d, sections };
}

/** The note-derived index, in an order-free-where-it-can-be form, plus what search finds for some terms. */
function snapshot(db: Database.Database) {
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
  return {
    chunks: all('SELECT heading_path, text, start_line, end_line, token_count, chunk_hash FROM chunks ORDER BY id'),
    notes: all('SELECT title, kind, note_hash, frontmatter_json FROM notes'),
    entities: all('SELECT type, canonical_name, aliases_json FROM entities ORDER BY id'),
    facts: all('SELECT predicate, object_text FROM facts ORDER BY id'),
    search: WORDS.map((term) => all(
      'SELECT c.text FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY c.id',
      term,
    )),
  };
}

function checkFtsAndKeys(db: Database.Database) {
  db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1)").run(); // throws if the index drifted from the rows
  expect(db.pragma('foreign_key_check')).toEqual([]);
}

describe('after any run of edits, the incrementally indexed note equals a fresh index of its final text', () => {
  for (const withEmbeddings of [true, false]) {
    it(`${withEmbeddings ? 'with' : 'without'} embeddings (seeded random edits)`, async () => {
      const r = rng(withEmbeddings ? 20261002 : 77);
      let keptSteps = 0;
      let replacedSteps = 0;
      for (let trial = 0; trial < 10; trial++) {
        const counter = { n: 0 };
        let doc: Doc = {
          tags: ['alpha'],
          sections: Array.from({ length: 1 + Math.floor(r() * 12) }, () => randomSection(r, counter.n++)),
        };
        const ix = newIndex(true);
        const options: IndexOptions = withEmbeddings ? ix.options : {};
        const file = noteFile(render(doc));
        await indexFile(ix.db, file, options);

        for (let step = 0; step < 5; step++) {
          doc = mutate(doc, r, counter);
          fs.writeFileSync(file, render(doc));
          const before = new Set(chunkIds(ix.db));
          await indexFile(ix.db, file, options);
          if (chunkIds(ix.db).some((id) => before.has(id))) keptSteps++;
          else replacedSteps++;

          const fresh = newIndex(true);
          await indexFile(fresh.db, file, withEmbeddings ? fresh.options : {});
          expect(snapshot(ix.db), `trial ${trial} step ${step}`).toEqual(snapshot(fresh.db));
          checkFtsAndKeys(ix.db);
          if (withEmbeddings) expect(await vectorsMatchText(ix), `vectors, trial ${trial} step ${step}`).toBe(true);
          fresh.db.close();
          dbs.splice(dbs.indexOf(fresh.db), 1);
        }
        ix.db.close();
        dbs.splice(dbs.indexOf(ix.db), 1);
      }
      // The run must have covered both paths, or it would prove nothing about the kept rows.
      expect(keptSteps).toBeGreaterThanOrEqual(8);
      expect(replacedSteps).toBeGreaterThanOrEqual(5);
    }, 120_000);
  }
});

describe('VectorIndex', () => {
  const vectorsOnly = () => {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vec-copy-')), 'v.db'));
    tmpDirs.push(path.dirname(db.name));
    dbs.push(db);
    const vectors = new VectorIndex(db, 4);
    vectors.initTable();
    return { vectors, db };
  };

  it('copy gives a chunk the stored vector of another, byte for byte, and reports a missing source', () => {
    const { vectors } = vectorsOnly();
    vectors.upsert(1, [3, 4, 0, 0]);
    vectors.upsert(2, [0, 0, 1, 0]);

    expect(vectors.copy(1, 3)).toBe(true);
    expect(vectors.get(3)).toEqual(vectors.get(1));
    expect(vectors.copy(1, 2)).toBe(true); // an existing target is replaced
    expect(vectors.get(2)).toEqual(vectors.get(1));
    expect(vectors.copy(99, 4)).toBe(false);
    expect(vectors.get(4)).toBeNull();
    expect(vectors.copy(1, 1)).toBe(true); // copying onto itself leaves it alone
    expect(vectors.get(1)).not.toBeNull();
    expect(vectors.copy(98, 98)).toBe(false);
  });

  it('keeps working after its table is dropped and recreated, as a rebuild does', () => {
    const { vectors, db } = vectorsOnly();
    vectors.upsert(1, [1, 0, 0, 0]); // prepares and keeps the statements
    expect(vectors.get(1)).not.toBeNull();
    vectors.countStored([1]);
    vectors.search([1, 0, 0, 0], 1);

    db.prepare('DROP TABLE chunk_embeddings').run();
    vectors.initTable();
    expect(vectors.get(1)).toBeNull();
    expect(vectors.countStored([1])).toBe(0);
    vectors.upsert(2, [0, 1, 0, 0]);
    expect(vectors.copy(2, 3)).toBe(true);
    expect(vectors.countStored([1, 2, 3])).toBe(2);
    expect(vectors.search([0, 1, 0, 0], 1)[0].chunkId).toBeGreaterThanOrEqual(2);
    vectors.delete(2);
    expect(vectors.get(2)).toBeNull();
  });

  it('countStored counts the chunks that have a vector', () => {
    const { vectors } = vectorsOnly();
    vectors.upsert(1, [1, 0, 0, 0]);
    vectors.upsert(3, [0, 1, 0, 0]);
    expect(vectors.countStored([1, 2, 3, 4])).toBe(2);
    expect(vectors.countStored([2, 4])).toBe(0);
    expect(vectors.countStored([])).toBe(0);
    vectors.delete(1);
    expect(vectors.countStored([1, 3])).toBe(1);
  });
});
