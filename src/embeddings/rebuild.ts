import type Database from 'better-sqlite3';
import type { VectorIndex } from './vectorIndex';
import type { EmbedOptions, EmbeddingProvider } from './types';

/**
 * Write every vector of an index again with one provider, so the index holds one embedding space and nothing else.
 *
 * Vectors in a table cannot say which model wrote them, so an index whose model is unknown or is not the configured
 * one cannot be searched with the configured model's query vectors: search would compare numbers that mean different
 * things. The only index whose vectors can be vouched for is one written from empty by the model that searches it.
 * So the rebuild first clears every vector and names the index (`VectorIndex.beginRebuild`, one step), then embeds
 * every chunk and marks the index whole again. It can be stopped and resumed: a stopped rebuild leaves a named,
 * partial, unfinished index, and the next call carries on with the chunks that have no vector yet.
 */
export interface RebuildOptions {
  /** Texts per request to the provider. Default 32, what Vertex takes at once. */
  batchSize?: number;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** Stop between requests once aborted; the index stays unfinished and a later call resumes it. */
  signal?: AbortSignal;
  /** How long to wait before attempt n + 2 of a request that failed. Default 1 s, then 4 s. */
  retryDelayMs?: (attempt: number) => number;
}

export interface RebuildResult {
  /** The index is whole: every chunk has a vector, and it is marked so. Never true with a chunk missing one. */
  done: boolean;
  /** Chunks embedded by this call. */
  embedded: number;
}

const ATTEMPTS = 3;

interface Row { id: number; text: string }

/** How many chunks have no stored vector (vec0's rowid shadow table holds one row per stored vector). */
export function chunksWithoutVectors(db: Database.Database): number {
  return db.prepare(
    'SELECT COUNT(*) FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings_rowids r WHERE r.rowid = c.id)',
  ).pluck().get() as number;
}

/** Wait `ms`, or less if `signal` aborts. The timer never keeps the process alive. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Rebuild (or carry on rebuilding) the vectors of `vectors` in `space`, the space `provider` writes. Returns when the
 * index is whole, or when `options.signal` aborts. The index is marked whole only when no chunk is left without a
 * vector: a chunk the provider will not embed (a text it refuses, or a provider that is down) makes this throw, after
 * every other chunk is embedded, and the index stays unfinished for a later call to resume, so semantic search is
 * never turned on over an index with a vector missing. A save that changes chunks meanwhile is safe: a vector is
 * stored only for a chunk that is still as it was when it was read, and the save embeds its own.
 */
export async function rebuildEmbeddings(
  db: Database.Database,
  vectors: VectorIndex,
  provider: EmbeddingProvider,
  space: string,
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const {
    batchSize = 32,
    concurrency = 4,
    signal,
    retryDelayMs = (attempt: number) => 1_000 * 4 ** attempt,
  } = options;
  // An index in another space, or in none that anyone can vouch for, starts over; one in this space that is
  // unfinished carries on; one that is whole has nothing to do.
  if (vectors.space() !== space) vectors.beginRebuild(space);
  else if (!vectors.rebuilding()) return { done: true, embedded: 0 };

  // The chunks that still have no vector. Nothing is ever passed over: a chunk is stored, or it is gone (a save
  // replaced it), or this call throws; so the scan is over exactly when no chunk lacks a vector.
  const nextRows = db.prepare(
    `SELECT c.id, c.text FROM chunks c
     WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings_rowids r WHERE r.rowid = c.id)
     ORDER BY c.id LIMIT ?`,
  );
  const stillThere = db.prepare('SELECT 1 FROM chunks WHERE id = ? AND text = ?');
  const noteOf = db.prepare('SELECT note_path FROM chunks WHERE id = ?').pluck();
  // Vectors whose chunk is gone: a process with no embedding provider replaces chunks and cannot delete their vectors.
  const orphans = db.prepare(
    'SELECT r.rowid FROM chunk_embeddings_rowids r WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = r.rowid)',
  ).pluck();
  const result: RebuildResult = { done: false, embedded: 0 };

  /** One request: embed these chunks, and keep the vector of each that is still as it was read. */
  const embedAndStore = async (rows: Row[]): Promise<void> => {
    const embeddings = await provider.embed(rows.map((r) => r.text));
    if (embeddings.length !== rows.length) {
      throw new Error(`the embedding provider returned ${embeddings.length} vectors for ${rows.length} texts`);
    }
    db.transaction(() => {
      rows.forEach((row, i) => {
        // A save may have replaced this chunk meanwhile; it embedded its own.
        if (stillThere.get(row.id, row.text)) vectors.upsert(row.id, embeddings[i]);
      });
    })();
    result.embedded += rows.length;
  };

  /** Try to embed `rows` (up to ATTEMPTS times); the last error, or null once they are stored. */
  const attempt = async (rows: Row[]): Promise<unknown> => {
    let failure: unknown = null;
    for (let tries = 0; tries < ATTEMPTS && !signal?.aborted; tries++) {
      try {
        await embedAndStore(rows);
        return null;
      } catch (err) {
        failure = err;
        if (tries + 1 < ATTEMPTS) await sleep(retryDelayMs(tries), signal);
      }
    }
    return failure;
  };

  /**
   * Embed `rows`. When a batch keeps failing, embed its chunks one by one, so that every chunk the provider takes is
   * stored and only the ones it refuses stay behind; then throw, naming the first. Nothing is skipped.
   */
  const settle = async (rows: Row[]): Promise<void> => {
    const failure = await attempt(rows);
    if (failure === null || signal?.aborted) return;
    let refused: { row: Row; failure: unknown } | undefined;
    if (rows.length === 1) refused = { row: rows[0], failure };
    else {
      for (const row of rows) {
        const one = await attempt([row]);
        if (signal?.aborted) return;
        if (one !== null) refused ??= { row, failure: one };
      }
    }
    if (!refused) return;
    const note = noteOf.get(refused.row.id) as string | undefined;
    const why = refused.failure instanceof Error ? refused.failure.message : String(refused.failure);
    throw Object.assign(
      new Error(`chunk ${refused.row.id}${note ? ` of ${note}` : ''} could not be embedded: ${why}`),
      { cause: refused.failure },
    );
  };

  while (!signal?.aborted) {
    const rows = nextRows.all(batchSize * concurrency) as Row[];
    if (rows.length === 0) {
      // Whole: every chunk has its vector, and the vectors of chunks that are gone are dropped with the mark.
      db.transaction(() => {
        for (const id of orphans.all() as number[]) vectors.delete(id);
        vectors.finishRebuild();
      })();
      return { ...result, done: true };
    }
    const groups: Row[][] = [];
    for (let i = 0; i < rows.length; i += batchSize) groups.push(rows.slice(i, i + batchSize));
    // Every request settles before this call returns or throws, so nothing is left running against the database.
    const settled = await Promise.allSettled(groups.map(settle));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return result;
}

/**
 * Embed every chunk that has no vector, a batch at a time, until none is left or `signal` aborts: the chunks a save
 * kept for keyword search because the embedding service would not answer it in time. It is the patient half of an
 * interactive save: it waits as long as the provider's own retries take, and holds no lock while it does, so a service
 * that is down costs nothing but this task's time. A vector is stored only for a chunk that is still as it was read (a
 * save may have replaced it meanwhile and embedded its own). Throws what the provider throws, after which a later call
 * carries on with what is left; it does not change what the index says of its own completeness (a rebuild does that).
 * Returns how many chunks it embedded.
 */
export async function embedMissingVectors(
  db: Database.Database,
  vectors: Pick<VectorIndex, 'upsert'>,
  provider: EmbeddingProvider,
  options: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const { batchSize = 32, signal } = options;
  const nextRows = db.prepare(
    `SELECT c.id, c.text FROM chunks c
     WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings_rowids r WHERE r.rowid = c.id)
     ORDER BY c.id LIMIT ?`,
  );
  const stillThere = db.prepare('SELECT 1 FROM chunks WHERE id = ? AND text = ?');
  const embedOptions: EmbedOptions | undefined = signal ? { signal } : undefined;
  let embedded = 0;
  while (!signal?.aborted) {
    const rows = nextRows.all(batchSize) as Row[];
    if (rows.length === 0) break;
    const embeddings = await provider.embed(rows.map((r) => r.text), embedOptions);
    if (embeddings.length !== rows.length) {
      throw new Error(`the embedding provider returned ${embeddings.length} vectors for ${rows.length} texts`);
    }
    db.transaction(() => {
      rows.forEach((row, i) => {
        if (stillThere.get(row.id, row.text)) vectors.upsert(row.id, embeddings[i]);
      });
    })();
    embedded += rows.length;
  }
  return embedded;
}
