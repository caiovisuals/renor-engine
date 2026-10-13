import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { embeddingSpace, EMBEDDING_SPACE_VERSION } from '../../src/embeddings/space';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { attachEngine, engineRebuildEmbeddings, semanticReady, type Engine } from '../../src/mvp/engine';
import { indexFile, indexVault } from '../../src/indexer/pipeline';
import type { MvpConfig } from '../../src/mvp/config';

/**
 * Dimensions alone cannot tell two embedding models apart: a service restarted with another model of the same
 * dimensions would keep writing vectors into an index full of the first model's, and search would compare numbers
 * that mean different things. The index records the embedding space its vectors are in (provider, model,
 * dimensions); attaching with another space fails closed, and stored vectors are reused only inside one space.
 * Synthetic providers only, no model and no network.
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dbs.length) dbs.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  dbs.push(db);
  runMigrations(db);
  return db;
}

/** The hash stub's dimensions, a different model. */
class OtherModel extends EvalHashEmbeddingProvider {
  readonly identity = { kind: 'eval-hash', model: 'another-model' };
}

/** A different model whose every vector points the opposite way to the stub's, so whose vector a chunk holds is plain to see. */
class OppositeModel extends EvalHashEmbeddingProvider {
  readonly identity = { kind: 'eval-hash', model: 'opposite-model' };
  async embed(texts: string[]): Promise<number[][]> {
    return (await super.embed(texts)).map((v) => v.map((x) => -x));
  }
}

const config = { embeddingProvider: 'none' } as MvpConfig;

describe('embeddingSpace', () => {
  it('names the provider, model and dimensions, and has none for a provider that declares no identity', () => {
    const hash = new EvalHashEmbeddingProvider();
    expect(embeddingSpace(hash)).toBe(`v${EMBEDDING_SPACE_VERSION}|document|eval-hash|lexical-hash-v1|256`);
    expect(embeddingSpace(new OtherModel())).not.toBe(embeddingSpace(hash));
    expect(embeddingSpace({ identity: hash.identity, dimensions: 768 })).not.toBe(embeddingSpace(hash));
    expect(embeddingSpace({ dimensions: 256 })).toBeNull();
  });
});

describe('VectorIndex records the space its vectors are in', () => {
  it('starts with none, keeps what was set, and forgets it when the vector table is created afresh (a rebuild)', () => {
    const db = freshDb();
    const vectors = new VectorIndex(db, 4);
    vectors.initTable();
    expect(vectors.space()).toBeNull();
    expect(vectors.hasVectors()).toBe(false);

    vectors.setSpace('space-a');
    vectors.upsert(1, [1, 0, 0, 0]);
    expect(vectors.space()).toBe('space-a');
    expect(vectors.hasVectors()).toBe(true);
    vectors.setSpace('space-b');
    expect(vectors.space()).toBe('space-b');

    new VectorIndex(db, 4).initTable(); // the table exists: nothing changes
    expect(vectors.space()).toBe('space-b');

    db.prepare('DROP TABLE chunk_embeddings').run();
    vectors.initTable(); // created afresh: it holds no vectors, so no space describes it
    expect(vectors.space()).toBeNull();
    expect(vectors.hasVectors()).toBe(false);
  });
});

describe('attachEngine claims the embedding space', () => {
  it('records the space on first attach and accepts the same model again', () => {
    const db = freshDb();
    attachEngine(db, config, new EvalHashEmbeddingProvider());
    expect(new VectorIndex(db, 256).space()).toBe(embeddingSpace(new EvalHashEmbeddingProvider()));
    expect(() => attachEngine(db, config, new EvalHashEmbeddingProvider())).not.toThrow();
  });

  it('a different model with the same dimensions is neither refused nor named: the recorded space stays, and the index is not read until it is rebuilt', () => {
    const db = freshDb();
    const first = attachEngine(db, config, new EvalHashEmbeddingProvider());
    new VectorIndex(db, 256).upsert(7, new Array(256).fill(0.0625)); // the index now holds a vector of the first model
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let second!: Engine;
    expect(() => { second = attachEngine(db, config, new OtherModel()); }).not.toThrow();
    expect(new VectorIndex(db, 256).space()).toBe(embeddingSpace(new EvalHashEmbeddingProvider()));
    expect(semanticReady(first)).toBe(true);
    expect(semanticReady(second)).toBe(false);
    expect(warn.mock.calls[0].join(' ')).toMatch(/holds vectors from .* but the configured embedding is .*another-model.*rebuild/s);
  });

  it('still refuses other dimensions first, as before', () => {
    const db = freshDb();
    attachEngine(db, config, new EvalHashEmbeddingProvider());
    const wider = Object.assign(new EvalHashEmbeddingProvider(), { dimensions: 512 });
    expect(() => attachEngine(db, config, wider)).toThrow(/dimension mismatch/i);
  });

  it('an index built before spaces were recorded stays unnamed: nothing says which model wrote its vectors', () => {
    const db = freshDb();
    const vectors = new VectorIndex(db, 256);
    vectors.initTable();
    vectors.upsert(7, new Array(256).fill(0.0625));
    expect(vectors.space()).toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachEngine(db, config, new EvalHashEmbeddingProvider());
    expect(vectors.space()).toBeNull(); // not given the configured model's name
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toMatch(/no record of the model that wrote them.*rebuild embeds every chunk again.*semantic search is off/s);

    // Another model with the same dimensions is no more named, and none is refused: this index cannot tell them apart.
    expect(() => attachEngine(db, config, new OtherModel())).not.toThrow();
    expect(vectors.space()).toBeNull();
  });

  it('an index with notes but no vectors yet takes the configured model\'s space, and says nothing', () => {
    const db = freshDb();
    const vectors = new VectorIndex(db, 256);
    vectors.initTable();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachEngine(db, config, new EvalHashEmbeddingProvider());
    expect(vectors.space()).toBe(embeddingSpace(new EvalHashEmbeddingProvider()));
    expect(warn).not.toHaveBeenCalled();
  });

  it('a provider that declares no identity claims nothing and is never refused', () => {
    const db = freshDb();
    attachEngine(db, config, new EvalHashEmbeddingProvider());
    const unnamed = { dimensions: 256, embed: async (texts: string[]) => texts.map(() => new Array(256).fill(0)) };
    expect(() => attachEngine(db, config, unnamed)).not.toThrow();
    expect(new VectorIndex(db, 256).space()).toBe(embeddingSpace(new EvalHashEmbeddingProvider()));

    const fresh = freshDb();
    attachEngine(fresh, config, unnamed);
    expect(new VectorIndex(fresh, 256).space()).toBeNull();
  });

  it('a provider that declares no identity says nothing about an unnamed index either', () => {
    const db = freshDb();
    const vectors = new VectorIndex(db, 256);
    vectors.initTable();
    vectors.upsert(7, new Array(256).fill(0.0625));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    attachEngine(db, config, { dimensions: 256, embed: async (texts: string[]) => texts.map(() => new Array(256).fill(0)) });
    expect(vectors.space()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('after the vector table is dropped, as a rebuild does, another model may take the index', () => {
    const db = freshDb();
    attachEngine(db, config, new EvalHashEmbeddingProvider());
    db.prepare('DROP TABLE chunk_embeddings').run();
    expect(() => attachEngine(db, config, new OtherModel())).not.toThrow();
    expect(new VectorIndex(db, 256).space()).toBe(embeddingSpace(new OtherModel()));
  });
});

describe('a model switch on an index built before spaces were recorded', () => {
  const note = (sections: number, last = 'last') => '# Note\n\n' + Array.from({ length: sections }, (_, k) =>
    `## Section ${k}\n${k === sections - 1 ? last : 'unchanged'} text of section ${k}\n`).join('\n');

  it('is not taken for the index\'s own model: nothing is named for the new model, and what it embeds is not mixed with a stored vector', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-vault-'));
    tmpDirs.push(dir);
    const a = path.join(dir, 'a.md');
    fs.writeFileSync(a, note(4));
    fs.writeFileSync(path.join(dir, 'b.md'), note(4));
    const db = freshDb();

    // Built by one model, as an index of the previous release is: it holds vectors and no record of their space.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const built = attachEngine(db, config, new EvalHashEmbeddingProvider());
    await indexVault(db, dir, { embeddingProvider: built.provider!, vectorIndex: built.vectorIndex! }, 1);
    log.mockRestore();
    db.prepare("DELETE FROM chunk_embedding_meta WHERE key = 'space'").run();

    // The next deploy configures another model of the same dimensions, and a note is edited.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = new OppositeModel();
    const next = attachEngine(db, config, other);
    expect(next.vectorIndex!.space()).toBeNull();
    fs.writeFileSync(a, note(4, 'edited'));
    await indexFile(db, a, { embeddingProvider: other, vectorIndex: next.vectorIndex! });

    expect(next.vectorIndex!.space()).toBeNull(); // never claimed for a model that wrote only part of it
    // The edited note is embedded afresh, every chunk of it, though three of its four sections are unchanged:
    // none of its vectors is one the first model wrote.
    const edited = db.prepare('SELECT id, text FROM chunks WHERE note_path = ? ORDER BY id').all(a) as Array<{ id: number; text: string }>;
    expect(edited.length).toBeGreaterThanOrEqual(4);
    const wantedEdited = await other.embed(edited.map((c) => c.text));
    edited.forEach((c, i) => {
      const stored = next.vectorIndex!.get(c.id)!;
      expect(stored.every((x, j) => Math.abs(x - wantedEdited[i][j]) < 1e-5), c.text).toBe(true);
    });

    // The index now holds two models' vectors (the untouched b.md still has the first model's), so it is not read:
    // search is off until every chunk of every file is embedded again by the model that searches it.
    expect(semanticReady(next)).toBe(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await engineRebuildEmbeddings(db, next)!.done;
    expect(semanticReady(next)).toBe(true);
    expect(next.vectorIndex!.space()).toBe(embeddingSpace(other));
    const all = db.prepare('SELECT id, note_path, text FROM chunks ORDER BY id').all() as Array<{ id: number; note_path: string; text: string }>;
    expect(new Set(all.map((c) => path.basename(c.note_path)))).toEqual(new Set(['a.md', 'b.md']));
    const wantedAll = await other.embed(all.map((c) => c.text));
    const first = await new EvalHashEmbeddingProvider().embed(all.map((c) => c.text));
    all.forEach((c, i) => {
      const stored = next.vectorIndex!.get(c.id)!;
      // every file's vectors, not only the edited one's: the new model's, and not one of the first model's
      expect(stored.every((x, j) => Math.abs(x - wantedAll[i][j]) < 1e-5), `${path.basename(c.note_path)}: ${c.text}`).toBe(true);
      expect(stored.some((x, j) => Math.abs(x - first[i][j]) < 1e-5 && Math.abs(x) > 1e-3)).toBe(false);
    });
    expect((db.prepare('SELECT COUNT(*) FROM chunk_embeddings_rowids').pluck().get() as number)).toBe(all.length);
  });
});
