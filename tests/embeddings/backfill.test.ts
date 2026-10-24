import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile, indexVault } from '../../src/indexer/pipeline';
import { hashContent } from '../../src/indexer/hasher';
import { VectorIndex, markVectorsUnfinished } from '../../src/embeddings/vectorIndex';
import { chunksWithoutVectors, rebuildEmbeddings } from '../../src/embeddings/rebuild';
import { embeddingSpace } from '../../src/embeddings/space';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { attachEngine, engineRebuildEmbeddings, engineSearchMemory, engineStatus, semanticReady } from '../../src/mvp/engine';
import { DEFAULT_LEDGER_REL, type MvpConfig } from '../../src/mvp/config';

/**
 * The pieces that let a workspace which gains an embedding provider embed what it already holds, once: an index with
 * chunks and no vector is marked unfinished rather than named as new; a process with no provider marks an index that
 * has a model's vectors unfinished; while an index is unfinished a save writes its chunks and leaves every vector to the
 * background job; and that job, when it finishes, leaves exactly one vector per chunk. Synthetic notes, the eval-hash
 * stub (no model, no network).
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

class Counting extends EvalHashEmbeddingProvider {
  calls = 0;
  texts: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts.push(...texts);
    return super.embed(texts);
  }
}

const KEYWORD_ONLY = { embeddingProvider: 'none' } as MvpConfig;
const HEAD = '---\ntype: ledger\n---\n\n# Ledger\n\nAppend-only record.\n';
const event = (k: number) => `\n## Event ${k}\n- kind: store\n- object: value ${k}\n`;

function vault(files: Record<string, string>): { dir: string; db: Database.Database } {
  const dir = tmp('backfill-unit-');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const db = openDb(path.join(dir, '.memory-index', 'index.db'));
  dbs.push(db);
  runMigrations(db);
  return { dir, db };
}

/** What memory_status counts: the workspace's memory directory and its ledger. */
const workspace = (dir: string) => ({ memoryDir: dir, ledgerRelPath: DEFAULT_LEDGER_REL });
const chunkIds = (db: Database.Database, file: string) =>
  db.prepare('SELECT id FROM chunks WHERE note_path = ? ORDER BY id').pluck().all(file) as number[];
const hasTable = (db: Database.Database, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

describe('claiming an index with chunks and no vector', () => {
  it('marks it unfinished in the configured model\'s space, so it is completed before semantic search reads it', async () => {
    const { dir, db } = vault({ 'a.md': '# Alpha\n\nquokkaberry alpha\n', 'b.md': '# Bravo\n\nquokkaberry bravo\n' });
    await indexVault(db, dir, {}, 1); // keyword-only: chunks and no vector table
    const chunks = db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;
    expect(chunks).toBeGreaterThan(0);
    expect(hasTable(db, 'chunk_embeddings')).toBe(false);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new Counting();
    const engine = attachEngine(db, KEYWORD_ONLY, provider);
    expect(engine.vectorIndex!.space()).toBe(embeddingSpace(provider));
    expect(engine.vectorIndex!.rebuilding()).toBe(true);
    expect(semanticReady(engine)).toBe(false);
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(`"event":"embeddings_backfill","chunks":${chunks},`);
    const status = engineStatus(db, engine, workspace(dir));
    expect(status.semantic).toBe(false);
    expect(status.embeddingRebuild).toEqual({ chunksLeft: chunks, chunks });
    const held = await engineSearchMemory(db, engine, dir, 'quokkaberry', 5);
    expect(held).toMatchObject({ ok: false, error: 'semantic-rebuilding', hits: [] });
    expect(held.notice).toContain(`(${chunks} of ${chunks} chunks left)`);
    expect(provider.calls).toBe(0); // claiming embeds nothing; the background job does

    await engineRebuildEmbeddings(db, engine)!.done;
    expect(provider.texts.length).toBe(chunks);
    expect(chunksWithoutVectors(db)).toBe(0);
    expect(semanticReady(engine)).toBe(true);
    expect(engineStatus(db, engine, workspace(dir)).semantic).toBe(true);
    expect(engineStatus(db, engine, workspace(dir))).not.toHaveProperty('embeddingRebuild');
  });

  it('names an index with no chunk at once: it is new, and whole', () => {
    const { dir, db } = vault({});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const engine = attachEngine(db, KEYWORD_ONLY, new Counting());
    expect(engine.vectorIndex!.rebuilding()).toBe(false);
    expect(semanticReady(engine)).toBe(true);
    expect(engineStatus(db, engine, workspace(dir)).semantic).toBe(true);
    expect(engineRebuildEmbeddings(db, engine)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('claims nothing for a provider that declares no identity, as before: it is never held back', async () => {
    const { dir, db } = vault({ 'a.md': '# Alpha\n\nquokkaberry alpha\n' });
    await indexVault(db, dir, {}, 1);
    const unnamed = { dimensions: 256, embed: async (texts: string[]) => new EvalHashEmbeddingProvider().embed(texts) };
    const engine = attachEngine(db, KEYWORD_ONLY, unnamed);
    expect(engine.vectorIndex!.space()).toBeNull();
    expect(engine.vectorIndex!.rebuilding()).toBe(false);
    expect(semanticReady(engine)).toBe(true);
  });
});

describe('markVectorsUnfinished: a process with no provider marks an index that has a model\'s vectors', () => {
  it('marks only an index that records its space, once, and creates nothing in one that never had vectors', async () => {
    const never = vault({ 'a.md': '# Alpha\n\ntext\n' });
    await indexVault(never.db, never.dir, {}, 1);
    expect(markVectorsUnfinished(never.db)).toBe(false);
    expect(hasTable(never.db, 'chunk_embedding_meta')).toBe(false); // nothing is created for a keyword-only index

    const unnamed = vault({});
    new VectorIndex(unnamed.db, 256).initTable(); // the meta table exists, no space is recorded
    expect(markVectorsUnfinished(unnamed.db)).toBe(false);

    const named = vault({ 'a.md': '# Alpha\n\ntext\n' });
    const provider = new Counting();
    const engine = attachEngine(named.db, KEYWORD_ONLY, provider);
    await indexVault(named.db, named.dir, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! }, 1);
    expect(semanticReady(engine)).toBe(true);
    expect(markVectorsUnfinished(named.db)).toBe(true);
    expect(markVectorsUnfinished(named.db)).toBe(false); // already marked
    expect(engine.vectorIndex!.rebuilding()).toBe(true);
    expect(engine.vectorIndex!.space()).toBe(embeddingSpace(provider)); // the vectors it has are still that model's
    expect(semanticReady(engine)).toBe(false);
  });

  it('is what attachEngine does when no provider is configured', async () => {
    const { dir, db } = vault({ 'a.md': '# Alpha\n\ntext\n' });
    const provider = new Counting();
    const engine = attachEngine(db, KEYWORD_ONLY, provider);
    await indexVault(db, dir, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! }, 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const keywordOnly = attachEngine(db, KEYWORD_ONLY, null);
    expect(keywordOnly.provider).toBeNull();
    expect(engine.vectorIndex!.rebuilding()).toBe(true);
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('"event":"embeddings_unconfigured","detail":"no embedding provider is configured');
  });
});

describe('a save while the index is unfinished', () => {
  async function unfinishedLedger(events: number) {
    const { dir, db } = vault({ 'Ledger.md': HEAD + Array.from({ length: events }, (_, k) => event(k)).join('') });
    const file = path.join(dir, 'Ledger.md');
    await indexFile(db, file, {}); // written without a provider: chunks, no vectors, the note finished
    const provider = new Counting();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const engine = attachEngine(db, KEYWORD_ONLY, provider);
    expect(engine.vectorIndex!.rebuilding()).toBe(true);
    return { dir, db, file, provider, vectors: engine.vectorIndex!, engine };
  }

  it('writes its chunks, embeds nothing, keeps the chunks it did not change, and finishes the note', async () => {
    const { db, file, provider, vectors, engine } = await unfinishedLedger(5);
    const before = chunkIds(db, file);
    fs.appendFileSync(file, event(5));
    await indexFile(db, file, { embeddingProvider: provider, vectorIndex: vectors });
    expect(provider.calls).toBe(0);
    const after = chunkIds(db, file);
    // The header and the first four events keep their rows; the last event (its end line moved) and the new one are written.
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after.length).toBe(before.length + 1);
    const noteHash = db.prepare('SELECT note_hash FROM notes WHERE path = ?').pluck().get(file);
    expect(noteHash).toBe(hashContent(fs.readFileSync(file, 'utf8'))); // finished: its vectors are the job's
    expect(chunksWithoutVectors(db)).toBe(after.length);

    // The job then embeds every chunk once, the save's included.
    await engineRebuildEmbeddings(db, engine)!.done;
    const texts = db.prepare('SELECT text FROM chunks ORDER BY id').pluck().all() as string[];
    expect([...provider.texts].sort()).toEqual([...texts].sort());
    expect(semanticReady(engine)).toBe(true);
  });

  it('copies the vector a chunk with the same text already has, and still embeds nothing', async () => {
    const { dir, db } = vault({ 'Ledger.md': HEAD + event(0) + event(1) });
    const file = path.join(dir, 'Ledger.md');
    const provider = new Counting();
    const engine = attachEngine(db, KEYWORD_ONLY, provider);
    await indexFile(db, file, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! });
    const eventOne = db.prepare("SELECT id, text FROM chunks WHERE note_path = ? AND text LIKE '%value 1%'").get(file) as { id: number; text: string };
    const vectorOfEventOne = engine.vectorIndex!.get(eventOne.id);
    expect(vectorOfEventOne).not.toBeNull();
    markVectorsUnfinished(db);
    const callsBefore = provider.calls;

    fs.writeFileSync(file, HEAD + event(9) + event(0) + event(1)); // a new event on top: every chunk below it moves
    await indexFile(db, file, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! });
    expect(provider.calls).toBe(callsBefore);
    const moved = db.prepare("SELECT id FROM chunks WHERE note_path = ? AND text = ?").pluck().get(file, eventOne.text) as number;
    expect(moved).not.toBe(eventOne.id);
    expect(engine.vectorIndex!.get(moved)).toEqual(vectorOfEventOne); // copied, byte for byte
    const nine = db.prepare("SELECT id FROM chunks WHERE note_path = ? AND text LIKE '%value 9%'").pluck().get(file) as number;
    expect(engine.vectorIndex!.get(nine)).toBeNull(); // left to the job
  });

  it('controls: a whole index embeds the save\'s chunks as before, and an index unfinished in another model\'s space refuses the write', async () => {
    const whole = vault({ 'Ledger.md': HEAD + event(0) });
    const file = path.join(whole.dir, 'Ledger.md');
    const provider = new Counting();
    const engine = attachEngine(whole.db, KEYWORD_ONLY, provider);
    await indexFile(whole.db, file, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! });
    const callsBefore = provider.calls;
    fs.appendFileSync(file, event(1));
    await indexFile(whole.db, file, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! });
    expect(provider.calls).toBe(callsBefore + 1);
    expect(chunksWithoutVectors(whole.db)).toBe(0);

    engine.vectorIndex!.beginRebuild('v1|document|eval-hash|another-model|256'); // a rebuild toward another model
    fs.appendFileSync(file, event(2));
    await expect(indexFile(whole.db, file, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! }))
      .rejects.toThrow(/another embedding model/);
  });

  it('control: a provider that declares no identity has no job to leave its vectors to, so its saves embed their own chunks', async () => {
    const { dir, db } = vault({ 'Ledger.md': HEAD + event(0) });
    const file = path.join(dir, 'Ledger.md');
    const named = new Counting();
    const engine = attachEngine(db, KEYWORD_ONLY, named);
    await indexFile(db, file, { embeddingProvider: named, vectorIndex: engine.vectorIndex! });
    expect(markVectorsUnfinished(db)).toBe(true);

    const texts: string[] = [];
    const unnamed = { dimensions: 256, embed: async (batch: string[]) => { texts.push(...batch); return new EvalHashEmbeddingProvider().embed(batch); } };
    const unnamedEngine = attachEngine(db, KEYWORD_ONLY, unnamed);
    expect(engineRebuildEmbeddings(db, unnamedEngine)).toBeNull(); // it claims nothing: no job runs for it
    fs.appendFileSync(file, event(1));
    await indexFile(db, file, { embeddingProvider: unnamed, vectorIndex: unnamedEngine.vectorIndex! });
    expect(texts.length).toBeGreaterThan(0);
  });
});

describe('the background job, when it finishes', () => {
  it('drops the vectors of chunks that are gone, so a whole index holds one vector per chunk', async () => {
    const { dir, db } = vault({ 'a.md': '# Alpha\n\nalpha one\n\n## Two\n\nalpha two\n' });
    const provider = new Counting();
    const engine = attachEngine(db, KEYWORD_ONLY, provider);
    await indexVault(db, dir, { embeddingProvider: provider, vectorIndex: engine.vectorIndex! }, 1);
    const ids = chunkIds(db, path.join(dir, 'a.md'));
    // Without the provider, the note is rewritten: its chunks are replaced, their vectors stay behind.
    markVectorsUnfinished(db);
    fs.writeFileSync(path.join(dir, 'a.md'), '# Alpha\n\nalpha one, edited\n');
    await indexFile(db, path.join(dir, 'a.md'), {});
    const orphaned = db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all() as number[];
    expect(orphaned).toEqual(ids);

    const result = await rebuildEmbeddings(db, engine.vectorIndex!, provider, embeddingSpace(provider)!);
    expect(result.done).toBe(true);
    const now = chunkIds(db, path.join(dir, 'a.md'));
    expect(db.prepare('SELECT rowid FROM chunk_embeddings_rowids ORDER BY rowid').pluck().all()).toEqual(now);
    expect(engine.vectorIndex!.rebuilding()).toBe(false);
  });
});
