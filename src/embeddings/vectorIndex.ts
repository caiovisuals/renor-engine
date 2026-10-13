import Database from 'better-sqlite3';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };

export interface VectorSearchResult { chunkId: number; score: number }

/** sqlite-vec's ceiling on `k` in one nearest-neighbour query. */
export const KNN_MAX_K = 4096;

/**
 * For a writer that gives the chunks it writes no vector (a process with no embedding provider, or an import): when the
 * index records the space its vectors are in, mark it unfinished (see `VectorIndex.beginRebuild`), so the next process
 * with that model embeds the chunks written meanwhile before semantic search reads the index again. An index that
 * records no space needs no mark: one with vectors is rebuilt anyway and one without is completed (see
 * `claimEmbeddingSpace` in `mvp/engine.ts`). Plain SQL: it does not need the vector extension. True when this call set
 * the mark.
 */
export function markVectorsUnfinished(db: Database.Database): boolean {
  const meta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embedding_meta'").get();
  if (!meta || db.prepare("SELECT 1 FROM chunk_embedding_meta WHERE key = 'space'").get() === undefined) return false;
  return db.prepare(
    "INSERT INTO chunk_embedding_meta(key, value) VALUES('rebuilding', '1') ON CONFLICT(key) DO NOTHING"
  ).run().changes > 0;
}

export class VectorIndex {
  private db: Database.Database;
  private dimensions: number;
  private statements = new Map<string, Database.Statement>();

  constructor(db: Database.Database, dimensions: number) {
    this.db = db;
    this.dimensions = dimensions;
    // Load sqlite-vec extension
    sqliteVec.load(db);
  }

  initTable(): void {
    const existed = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'").get() !== undefined;
    this.db.prepare(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(embedding FLOAT[${this.dimensions}])`
    ).run();
    this.ensureMeta();
    // A table created now holds no vectors, so what was recorded for an earlier one (a rebuild drops it) no
    // longer describes anything.
    if (!existed) this.db.prepare("DELETE FROM chunk_embedding_meta WHERE key IN ('space', 'rebuilding')").run();
  }

  private metaReady = false;
  private ensureMeta(): void {
    if (this.metaReady) return;
    this.db.prepare('CREATE TABLE IF NOT EXISTS chunk_embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
    this.metaReady = true;
  }

  /**
   * The embedding space (see embeddingSpace) every stored vector is in, as recorded when the index first held
   * vectors; null when none was recorded (a new index, or one built before spaces were recorded).
   */
  space(): string | null {
    this.ensureMeta();
    const row = this.stmt("SELECT value FROM chunk_embedding_meta WHERE key = 'space'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSpace(space: string): void {
    this.ensureMeta();
    this.stmt(
      "INSERT INTO chunk_embedding_meta(key, value) VALUES('space', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(space);
  }

  hasVectors(): boolean {
    return this.stmt('SELECT 1 FROM chunk_embeddings LIMIT 1').get() !== undefined;
  }

  /** Whether the vectors are being written afresh (see beginRebuild) and some are still to come. */
  rebuilding(): boolean {
    this.ensureMeta();
    return this.stmt("SELECT 1 FROM chunk_embedding_meta WHERE key = 'rebuilding'").get() !== undefined;
  }

  /**
   * Start the vectors over in `space`: delete every one, record `space` as the space every vector written from now
   * on is in, and mark the index unfinished, in one step, so a crash leaves the index as it was or named, empty and
   * unfinished. A stored vector cannot say which model wrote it, so the only index whose vectors can be vouched
   * for is one written from empty.
   */
  beginRebuild(space: string): void {
    this.ensureMeta();
    this.db.transaction(() => {
      this.stmt('DELETE FROM chunk_embeddings').run();
      this.setSpace(space);
      this.stmt("INSERT INTO chunk_embedding_meta(key, value) VALUES('rebuilding', '1') ON CONFLICT(key) DO NOTHING").run();
    })();
  }

  /** Every vector the rebuild had to write is written: the index is whole again. */
  finishRebuild(): void {
    this.ensureMeta();
    this.stmt("DELETE FROM chunk_embedding_meta WHERE key = 'rebuilding'").run();
  }

  /**
   * Preparing a statement on the vec0 table costs about ten times what running it does, and indexing
   * runs a few per chunk, so each is prepared once, on first use, and kept.
   */
  private stmt(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private normalize(vec: number[]): number[] {
    const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (mag === 0) return vec;
    return vec.map(v => v / mag);
  }

  upsert(chunkId: number, embedding: number[]): void {
    const normalized = this.normalize(embedding);
    const buf = Buffer.from(new Float32Array(normalized).buffer);
    this.stmt('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(chunkId));
    this.stmt('INSERT INTO chunk_embeddings(rowid, embedding) VALUES(?, ?)').run(BigInt(chunkId), buf);
  }

  /**
   * Give chunk `toId` the vector stored for chunk `fromId`, byte for byte, without embedding anything.
   * Returns false (and leaves `toId` without a vector) when `fromId` has none.
   */
  copy(fromId: number, toId: number): boolean {
    if (fromId === toId) return this.get(fromId) !== null;
    this.stmt('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(toId));
    return this.stmt(
      'INSERT INTO chunk_embeddings(rowid, embedding) SELECT ?, embedding FROM chunk_embeddings WHERE rowid = ?'
    ).run(BigInt(toId), BigInt(fromId)).changes > 0;
  }

  /**
   * How many of these chunks have a stored vector. Asked of the table's rowid shadow table, which finds each one by
   * key (as `chunksWithoutVectors` does): the vec0 table itself reads every stored vector to answer an IN list, so
   * the count cost what the index holds rather than how many were asked about.
   */
  countStored(chunkIds: number[]): number {
    const row = this.stmt(
      'SELECT COUNT(*) AS n FROM chunk_embeddings_rowids WHERE rowid IN (SELECT value FROM json_each(?))'
    ).get(JSON.stringify(chunkIds)) as { n: number };
    return row.n;
  }

  get(chunkId: number): number[] | null {
    const row = this.stmt('SELECT embedding FROM chunk_embeddings WHERE rowid = ?').get(BigInt(chunkId)) as any;
    if (!row) return null;
    return Array.from(new Float32Array(row.embedding.buffer ?? row.embedding));
  }

  /**
   * The `topK` nearest vectors, nearest first, and with them every other vector exactly as near as the farthest of
   * those. Of several equally near vectors a nearest-neighbour query picks by where they are stored, and vectors are
   * stored in the order indexing wrote them, which concurrent indexing does not fix; so a tie at the edge is returned
   * whole, for the caller to cut by what the chunks are (semanticSearch). Asking for one more than `topK` shows
   * whether the edge is tied, and only then is the query widened until the tie ends. A tie wider than one query may
   * return (KNN_MAX_K) is read whole by computing every stored vector's distance.
   *
   * Given `among` (chunk ids), only those vectors are read: the nearest of them, by the same rule. sqlite-vec filters a
   * nearest-neighbour query by row id, so a read among a few costs what a read among all does, not more.
   */
  search(query: number[], topK: number, among?: number[]): VectorSearchResult[] {
    if (topK < 1) return [];
    const normalized = this.normalize(query);
    const buf = Buffer.from(new Float32Array(normalized).buffer);
    const ids = among === undefined ? null : JSON.stringify(among);
    const nearest = (k: number) => (ids === null
      ? this.stmt('SELECT rowid, distance FROM chunk_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(buf, k)
      : this.stmt(
        'SELECT rowid, distance FROM chunk_embeddings WHERE embedding MATCH ? AND k = ? AND rowid IN (SELECT value FROM json_each(?)) ORDER BY distance'
      ).all(buf, k, ids)) as Array<{ rowid: number | bigint; distance: number }>;
    let k = Math.min(topK + 1, KNN_MAX_K);
    let rows = nearest(k);
    // The farthest vector read is as near as the edge (the topK-th), so more may be: read further.
    while (rows.length === k && k > topK && rows[k - 1].distance === rows[topK - 1].distance) {
      if (k === KNN_MAX_K) {
        rows = ((ids === null
          ? this.stmt('SELECT rowid, vec_distance_l2(embedding, ?) AS distance FROM chunk_embeddings').all(buf)
          : this.stmt(
            'SELECT rowid, vec_distance_l2(embedding, ?) AS distance FROM chunk_embeddings WHERE rowid IN (SELECT value FROM json_each(?))'
          ).all(buf, ids)) as typeof rows)
          .sort((a, b) => a.distance - b.distance);
        break;
      }
      k = Math.min(k * 4, KNN_MAX_K);
      rows = nearest(k);
    }
    const edge = rows.length > topK ? rows[topK - 1].distance : Number.POSITIVE_INFINITY;
    return rows.filter((r, i) => i < topK || r.distance === edge).map(r => ({
      chunkId: Number(r.rowid),
      score: 1 - (r.distance * r.distance) / 2
    }));
  }

  delete(chunkId: number): void {
    this.stmt('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(chunkId));
  }
}
