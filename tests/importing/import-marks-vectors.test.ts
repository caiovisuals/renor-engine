import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { embeddingSpace } from '../../src/embeddings/space';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { readMarkdownSource } from '../../src/importing/markdown';
import { buildImportPlan } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';

/**
 * An import copies its chunks into the index without vectors. Where the index records the embedding space its vectors are
 * in, the import marks it unfinished in the same commit (as a process without an embedding provider does), so the
 * workspace's model embeds exactly those chunks, once, before semantic search reads the index again
 * (tests/mvp/import-embeddings.test.ts drives that end to end). The mark and the chunks land together or not at all, and
 * nothing else is marked. Synthetic notes; no embedding call is made here.
 */

const SPACE = embeddingSpace(new EvalHashEmbeddingProvider())!;
const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A Markdown folder to import, and the plan for it. */
async function planFor(files: Record<string, string>) {
  const source = tmp('import-marks-source-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), text);
  }
  const bundle = await readMarkdownSource(source, { include: [], exclude: [] });
  const plan = buildImportPlan(bundle, { namespace: 'Imported/notes', label: 'notes', eventSource: 'import:notes' });
  return { bundle, plan };
}

/** A destination workspace whose index exists; with `space`, its vector table records that embedding space. */
function destination(space?: string) {
  const memoryDir = tmp('import-marks-dest-');
  const dbPath = path.join(memoryDir, '.memory-index', 'index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  dbs.push(db);
  runMigrations(db);
  if (space) {
    const vectors = new VectorIndex(db, 256);
    vectors.initTable();
    vectors.setSpace(space);
  }
  return { memoryDir, dbPath, db };
}

const meta = (db: Database.Database, key: string) => {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embedding_meta'").get();
  return table ? (db.prepare('SELECT value FROM chunk_embedding_meta WHERE key = ?').pluck().get(key) as string | undefined) : undefined;
};
const chunkCount = (db: Database.Database) => db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;

const NOTES = {
  'Billing.md': '# Billing\n\nQuillmoor billing runs on the ninth of each month through Paddle.\n',
  'Runbooks/Deploy.md': '# Deploy\n\n## Staging\nThe Fernhollow staging deploy waits for the smoke suite.\n\n## Production\nProduction deploys go out on Tuesdays.\n',
};

describe('applyImportPlan and the vectors of the chunks it copies', () => {
  it('marks an index whose vectors are in a model\'s space unfinished, in the commit that writes the chunks', async () => {
    const { bundle, plan } = await planFor(NOTES);
    const dest = destination(SPACE);
    expect(meta(dest.db, 'rebuilding')).toBeUndefined();

    const result = await applyImportPlan(plan, bundle, { memoryDir: dest.memoryDir, dbPath: dest.dbPath });
    expect(result.indexRows.chunksInserted).toBeGreaterThan(0);
    expect(chunkCount(dest.db)).toBe(result.indexRows.chunksInserted);
    expect(meta(dest.db, 'rebuilding')).toBe('1');
    expect(meta(dest.db, 'space')).toBe(SPACE); // the same space: nothing is cleared, the chunks without a vector are completed

    // Applying the same plan again copies no chunk, and marks nothing.
    dest.db.prepare("DELETE FROM chunk_embedding_meta WHERE key = 'rebuilding'").run();
    const again = await applyImportPlan(plan, bundle, { memoryDir: dest.memoryDir, dbPath: dest.dbPath });
    expect(again.indexRows.chunksInserted).toBe(0);
    expect(meta(dest.db, 'rebuilding')).toBeUndefined();
  });

  it('leaves no mark when the import is rolled back', async () => {
    const { bundle, plan } = await planFor(NOTES);
    const dest = destination(SPACE);
    dest.db.exec("CREATE TRIGGER refuse_chunks BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'synthetic chunk insert failure'); END");

    await expect(applyImportPlan(plan, bundle, { memoryDir: dest.memoryDir, dbPath: dest.dbPath })).rejects.toThrow(/rolled back/);
    expect(chunkCount(dest.db)).toBe(0);
    expect(meta(dest.db, 'rebuilding')).toBeUndefined();
  });

  it('marks no index that records no embedding space, and nothing for a canonical-only import', async () => {
    const { bundle, plan } = await planFor(NOTES);
    // Keyword only: no vector table. A provider configured later completes the whole index anyway.
    const keywordOnly = destination();
    const result = await applyImportPlan(plan, bundle, { memoryDir: keywordOnly.memoryDir, dbPath: keywordOnly.dbPath });
    expect(result.indexRows.chunksInserted).toBeGreaterThan(0);
    expect(meta(keywordOnly.db, 'rebuilding')).toBeUndefined();
    expect(meta(keywordOnly.db, 'space')).toBeUndefined();

    // Canonical only: no chunk is copied, so there is nothing to embed.
    const canonical = destination(SPACE);
    const written = await applyImportPlan(plan, bundle, { memoryDir: canonical.memoryDir, dbPath: canonical.dbPath, canonicalOnly: true });
    expect(written.notesWritten).toBe(2);
    expect(chunkCount(canonical.db)).toBe(0);
    expect(meta(canonical.db, 'rebuilding')).toBeUndefined();
  });
});
