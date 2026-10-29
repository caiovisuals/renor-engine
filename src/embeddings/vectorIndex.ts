import Database from '../db/sqlite';
import { SimdRows, SIMD_MIN_BYTES } from './simdScan';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };

export interface VectorSearchResult { chunkId: number; score: number }

/** sqlite-vec's ceiling on `k` in one nearest-neighbour query. */
export const KNN_MAX_K = 4096;

/**
 * Above this many bytes of vectors the process keeps asking sqlite-vec, instead of keeping a second copy of every
 * vector. 64 MiB is about 21,000 vectors at the 768 dimensions a hosted workspace uses, and the measured fixture
 * (about 10,000) fits under it. This is the hosted default; RENOR_VECTOR_MIRROR_MIB raises it (see mirrorCapBytes).
 */
const MIRROR_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The most a copy may hold, whatever RENOR_VECTOR_MIRROR_MIB says: 4 GiB, the largest linear memory a WebAssembly instance
 * can have (the SIMD scan keeps its copy in one). A larger number is this ceiling, so a long run of digits never becomes
 * Infinity bytes.
 */
const MIRROR_CEILING_MIB = 4096;

/**
 * The byte cap for `RENOR_VECTOR_MIRROR_MIB`: a whole number of MiB, from 1 to {@link MIRROR_CEILING_MIB} (a larger number
 * is the ceiling). Unset, empty, not a whole number, or 0 keeps {@link MIRROR_MAX_BYTES}. A self-hosted process with spare
 * RAM can raise it; each vector then costs 4 bytes per dimension in RAM (about 295 MiB for 100,000 chunks of 768 dimensions).
 */
export function mirrorCapBytes(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return MIRROR_MAX_BYTES;
  // Number() of a very long run of digits is Infinity; the minimum keeps the cap at the ceiling.
  const mib = Math.min(Number(text), MIRROR_CEILING_MIB);
  return mib >= 1 ? mib * 1024 * 1024 : MIRROR_MAX_BYTES;
}

/**
 * How far past the k-th scan distance a vector is still rescored exactly. The scan is ordinary f64 arithmetic and is
 * not sqlite-vec's distance: on 768-d unit vectors, hash and dense, the largest gap seen against `vec_distance_l2`
 * was under 1e-6, and 1e-3 still added only a few extra rows. A wider gap is slower, not wrong. A row whose exact
 * distance then disagrees by more than half of this is a broken bound, and that one query uses the KNN path.
 */
const MIRROR_SLACK = 1e-3;

/** Past this many exact distances, one KNN query is the cheaper exact answer (a tie across the whole index). */
const MIRROR_EXACT_LIMIT = 256;

/** The most nearest vectors a search takes the k-th distance of with a heap; a larger k sorts a copy. */
const KTH_HEAP_MAX = 64;
const kthHeap = new Float64Array(KTH_HEAP_MAX);

/**
 * The k-th smallest of `values[0..n)` (1 <= k <= n): what sorting a copy and reading index k - 1 gives, without the
 * copy and the sort (about 0.8 ms for 9,661 distances, against 0.03 ms for this). A sorted copy puts a NaN (a stored
 * vector that is not a number, or a query that is not) after every number, so a NaN is never among the k smallest, and
 * the k-th is a NaN only when fewer than k of the values are numbers; the heap skips NaNs and answers the same.
 */
export function kthSmallest(values: Float64Array, n: number, k: number): number {
  if (k > KTH_HEAP_MAX) {
    const sorted = values.slice(0, n);
    sorted.sort();
    return sorted[k - 1];
  }
  const heap = kthHeap; // the k smallest numbers seen so far, the largest of them at heap[0]
  let size = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v !== v) continue; // NaN
    if (size < k) {
      let at = size++;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (heap[parent] >= v) break;
        heap[at] = heap[parent];
        at = parent;
      }
      heap[at] = v;
    } else if (v < heap[0]) {
      let at = 0;
      for (;;) {
        let child = 2 * at + 1;
        if (child >= k) break;
        if (child + 1 < k && heap[child + 1] > heap[child]) child++;
        if (heap[child] <= v) break;
        heap[at] = heap[child];
        at = child;
      }
      heap[at] = v;
    }
  }
  return size < k ? Number.NaN : heap[0];
}

/**
 * The scan is built at load, not written as a function the caller can inline. Inlined into `searchMirror`, it
 * deoptimizes with that method: a scoped search and an unscoped one disagree about the shape of the slot list, the
 * method bails out, and the scan then runs in the interpreter. On the 9,661 × 768 fixture that is about 40ms instead
 * of about 7ms, on some calls and not others, which is what puts the median on the slow ones. The distances only
 * choose the rows to rescore; the score is still `vec_distance_l2`.
 */
function compileScan(params: string, body: string): (...args: never[]) => void {
  return new Function(...params.split(','), `'use strict';\n${body}`) as (...args: never[]) => void;
}

export const scanPackedL2 = compileScan('data,count,dims,q,out', `
  let i = 0;
  if ((dims & 7) === 0) {
    // Four rows at a time, each summed from the first dimension up in its own chain: the query is read once for the four,
    // and the four chains do not wait on one another (about a fifth less time than one row at a time).
    for (; i + 3 < count; i += 4) {
      const b0 = i * dims, b1 = b0 + dims, b2 = b1 + dims, b3 = b2 + dims;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let d = 0; d < dims; d += 2) {
        const qd = q[d], qe = q[d + 1];
        const x0 = data[b0 + d] - qd, x1 = data[b1 + d] - qd, x2 = data[b2 + d] - qd, x3 = data[b3 + d] - qd;
        const y0 = data[b0 + d + 1] - qe, y1 = data[b1 + d + 1] - qe, y2 = data[b2 + d + 1] - qe, y3 = data[b3 + d + 1] - qe;
        s0 += x0 * x0; s1 += x1 * x1; s2 += x2 * x2; s3 += x3 * x3;
        s0 += y0 * y0; s1 += y1 * y1; s2 += y2 * y2; s3 += y3 * y3;
      }
      out[i] = Math.sqrt(s0); out[i + 1] = Math.sqrt(s1); out[i + 2] = Math.sqrt(s2); out[i + 3] = Math.sqrt(s3);
    }
    for (; i < count; i++) {
      const base = i * dims;
      let sum = 0;
      for (let d = 0; d < dims; d += 8) {
        const a0 = data[base + d] - q[d];
        const a1 = data[base + d + 1] - q[d + 1];
        const a2 = data[base + d + 2] - q[d + 2];
        const a3 = data[base + d + 3] - q[d + 3];
        const a4 = data[base + d + 4] - q[d + 4];
        const a5 = data[base + d + 5] - q[d + 5];
        const a6 = data[base + d + 6] - q[d + 6];
        const a7 = data[base + d + 7] - q[d + 7];
        sum += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3 + a4 * a4 + a5 * a5 + a6 * a6 + a7 * a7;
      }
      out[i] = Math.sqrt(sum);
    }
    return;
  }
  for (; i < count; i++) {
    const base = i * dims;
    let sum = 0;
    for (let d = 0; d < dims; d++) {
      const diff = data[base + d] - q[d];
      sum += diff * diff;
    }
    out[i] = Math.sqrt(sum);
  }
`) as (data: Float32Array, count: number, dims: number, q: Float32Array, out: Float64Array) => void;

/** Same scan over an arbitrary slot list (a scope), not the packed prefix. */
export const scanSlotsL2 = compileScan('data,slots,dims,q,out', `
  const n = slots.length;
  let i = 0;
  if ((dims & 7) === 0) {
    for (; i + 3 < n; i += 4) {
      const b0 = slots[i] * dims, b1 = slots[i + 1] * dims, b2 = slots[i + 2] * dims, b3 = slots[i + 3] * dims;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let d = 0; d < dims; d += 2) {
        const qd = q[d], qe = q[d + 1];
        const x0 = data[b0 + d] - qd, x1 = data[b1 + d] - qd, x2 = data[b2 + d] - qd, x3 = data[b3 + d] - qd;
        const y0 = data[b0 + d + 1] - qe, y1 = data[b1 + d + 1] - qe, y2 = data[b2 + d + 1] - qe, y3 = data[b3 + d + 1] - qe;
        s0 += x0 * x0; s1 += x1 * x1; s2 += x2 * x2; s3 += x3 * x3;
        s0 += y0 * y0; s1 += y1 * y1; s2 += y2 * y2; s3 += y3 * y3;
      }
      out[i] = Math.sqrt(s0); out[i + 1] = Math.sqrt(s1); out[i + 2] = Math.sqrt(s2); out[i + 3] = Math.sqrt(s3);
    }
    for (; i < n; i++) {
      const base = slots[i] * dims;
      let sum = 0;
      for (let d = 0; d < dims; d += 8) {
        const a0 = data[base + d] - q[d];
        const a1 = data[base + d + 1] - q[d + 1];
        const a2 = data[base + d + 2] - q[d + 2];
        const a3 = data[base + d + 3] - q[d + 3];
        const a4 = data[base + d + 4] - q[d + 4];
        const a5 = data[base + d + 5] - q[d + 5];
        const a6 = data[base + d + 6] - q[d + 6];
        const a7 = data[base + d + 7] - q[d + 7];
        sum += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3 + a4 * a4 + a5 * a5 + a6 * a6 + a7 * a7;
      }
      out[i] = Math.sqrt(sum);
    }
    return;
  }
  for (; i < n; i++) {
    const base = slots[i] * dims;
    let sum = 0;
    for (let d = 0; d < dims; d++) {
      const diff = data[base + d] - q[d];
      sum += diff * diff;
    }
    out[i] = Math.sqrt(sum);
  }
`) as (data: Float32Array, slots: readonly number[], dims: number, q: Float32Array, out: Float64Array) => void;

interface VecMirror {
  ids: number[];
  slot: Map<number, number>;
  /** The vectors, row-major. A view of `rows`' memory when there is one (a new object whenever `rows` grows), else its own array. */
  data: Float32Array;
  /** The SIMD scan over `data`, for a mirror whose live vectors are large enough to want it (simdScan.ts); null scans in JavaScript. */
  rows: SimdRows | null;
  /** Whether a memory for the SIMD scan was asked for when the live vectors reached the minimum: it is asked once per mirror. */
  simdTried: boolean;
  count: number;
  /** Slots `data` can hold. `count` of them are live. Never more than the index's byte cap. */
  cap: number;
  /**
   * `PRAGMA data_version` when this copy was read. Another connection's commit changes it, including a
   * replace that leaves the row count the same. This connection's own writes do not, and those update the
   * copy in place.
   */
  version: number;
}

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

/** The insert found a vector already stored under this chunk id: the only constraint the insert can hit. */
function storedAlready(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

/** Rows the background copy reads per turn of the event loop, and the vectors of one blob: a page of rows is one blob's worth. */
const WARM_TURN_ROWS = 1024;

export class VectorIndex {
  private db: Database.Database;
  private dimensions: number;
  private statements = new Map<string, Database.Statement>();
  /** Exact float32 copy of the stored vectors, or null when this process has not built one (or the index is past the cap). */
  private mirror: VecMirror | null = null;
  /** The scan's distances for one search, kept for the next so a search allocates nothing for them. */
  private scanned = new Float64Array(0);
  /**
   * The copy being read in the background (warmMirror). `changed` holds the chunks this index wrote or deleted meanwhile,
   * taken from the table when the copy is installed; `dropped` is set by a rebuild, which the copy cannot follow.
   */
  private warming: { changed: Set<number>; dropped: boolean } | null = null;
  /** The most bytes of vectors the copy may hold: {@link mirrorCapBytes} of RENOR_VECTOR_MIRROR_MIB, read when this index is made, unless a test passes its own (options.capBytes). */
  private readonly capBytes: number;
  /** Whether the last search found the index too large for the mirror's cap. */
  private overCap = false;
  /** Searches answered by sqlite-vec's scan because the index holds more vectors than the mirror's cap (this process). */
  private overCapSearches = 0;

  constructor(db: Database.Database, dimensions: number, options: { capBytes?: number } = {}) {
    this.db = db;
    this.dimensions = dimensions;
    this.capBytes = options.capBytes ?? mirrorCapBytes(process.env.RENOR_VECTOR_MIRROR_MIB);
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
    if (this.warming) this.warming.dropped = true;
    this.ensureMeta();
    this.db.transaction(() => {
      this.stmt('DELETE FROM chunk_embeddings').run();
      this.setSpace(space);
      this.stmt("INSERT INTO chunk_embedding_meta(key, value) VALUES('rebuilding', '1') ON CONFLICT(key) DO NOTHING").run();
    })();
    this.mirror = { ids: [], slot: new Map(), data: new Float32Array(0), rows: null, simdTried: false, count: 0, cap: 0, version: this.dataVersion() };
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
    this.noteWrite(chunkId);
    const floats = new Float32Array(this.normalize(embedding));
    const buf = Buffer.from(floats.buffer);
    this.stmt('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(chunkId));
    this.stmt('INSERT INTO chunk_embeddings(rowid, embedding) VALUES(?, ?)').run(BigInt(chunkId), buf);
    this.remember(chunkId, floats);
  }

  /**
   * The vector of a chunk this pass has just written. Chunk ids are never reused (AUTOINCREMENT), so such a chunk usually
   * has no vector to replace, and the delete `upsert` runs first would find nothing: this skips it. A background job
   * (rebuild.ts takes no lock) can store a vector for the chunk while the pass is embedding. The insert then finds the row,
   * and the chunk is upserted, as it was before this method existed, so the rows are the same in every case.
   */
  insertNew(chunkId: number, embedding: number[]): void {
    this.noteWrite(chunkId);
    const floats = new Float32Array(this.normalize(embedding));
    const buf = Buffer.from(floats.buffer);
    try {
      this.stmt('INSERT INTO chunk_embeddings(rowid, embedding) VALUES(?, ?)').run(BigInt(chunkId), buf);
    } catch (err) {
      if (!storedAlready(err)) throw err;
      this.upsert(chunkId, embedding);
      return;
    }
    this.remember(chunkId, floats);
  }

  /**
   * Give chunk `toId` the vector stored for chunk `fromId`, byte for byte, without embedding anything.
   * Returns false (and leaves `toId` without a vector) when `fromId` has none.
   */
  copy(fromId: number, toId: number): boolean {
    this.noteWrite(toId);
    if (fromId === toId) return this.get(fromId) !== null;
    const dims = this.dimensions;
    const src = this.mirror?.slot.get(fromId);
    const floats = src === undefined || !this.mirror
      ? null
      : this.mirror.data.slice(src * dims, (src + 1) * dims);
    this.stmt('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(toId));
    const copied = this.stmt(
      'INSERT INTO chunk_embeddings(rowid, embedding) SELECT ?, embedding FROM chunk_embeddings WHERE rowid = ?'
    ).run(BigInt(toId), BigInt(fromId)).changes > 0;
    if (this.mirror) {
      // Replacing an existing vector does not change the row count, so the copy has to be written into the mirror.
      // A source this mirror does not hold means it has already drifted: drop it and let the next search reload.
      if (copied && floats) {
        this.forget(toId);
        this.remember(toId, floats);
      } else if (!copied) this.forget(toId);
      else this.mirror = null;
    }
    return copied;
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
    const row = this.stmt('SELECT embedding FROM chunk_embeddings WHERE rowid = ?').get(BigInt(chunkId)) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return Array.from(new Float32Array(row.embedding.buffer ?? row.embedding));
  }

  /**
   * The `topK` nearest vectors, nearest first, and with them every other vector exactly as near as the farthest of
   * those. Of several equally near vectors a nearest-neighbour query picks by where they are stored, and vectors are
   * stored in the order indexing wrote them, which concurrent indexing does not fix; so a tie at the edge is returned
   * whole, for the caller to cut by what the chunks are (semanticSearch). Scores are sqlite-vec's own distances
   * (`1 - d²/2`), never the in-process scan's, so a reply is the one the KNN query would have built.
   *
   * Given `among` (chunk ids), only those vectors are candidates: the nearest of them, by the same rule.
   */
  search(query: number[], topK: number, among?: number[]): VectorSearchResult[] {
    if (topK < 1) return [];
    const qf = new Float32Array(this.normalize(query));
    const buf = Buffer.from(qf.buffer, qf.byteOffset, qf.byteLength);
    if (this.mirrorReady()) {
      const fast = this.searchMirror(qf, buf, topK, among);
      if (fast !== null) return fast;
    }
    if (this.overCap) this.overCapSearches++;
    return this.searchStored(buf, topK, among);
  }

  /** How many vectors the index stores. */
  storedCount(): number {
    return (this.stmt('SELECT COUNT(*) AS n FROM chunk_embeddings_rowids').get() as { n: number }).n;
  }

  /** The mirror as memory_status reports it: whether the copy is held, the vectors and bytes it holds, its cap, and the searches past it. */
  mirrorStats(): { copy: 'f32' | 'none'; rows: number; bytes: number; capBytes: number; overCapSearches: number; simd: boolean } {
    const rows = this.mirror?.count ?? 0;
    return {
      copy: this.mirror ? 'f32' : 'none', rows, bytes: rows * this.dimensions * 4, capBytes: this.capBytes,
      overCapSearches: this.overCapSearches, simd: this.mirror?.rows != null,
    };
  }

  delete(chunkId: number): void {
    this.noteWrite(chunkId);
    this.stmt('DELETE FROM chunk_embeddings WHERE rowid = ?').run(BigInt(chunkId));
    this.forget(chunkId);
  }

  /** A write of this index: a copy being read in the background takes this chunk's row from the table when it is installed. */
  private noteWrite(chunkId: number): void {
    this.warming?.changed.add(chunkId);
  }

  /**
   * Builds the copy in the background, a page of rows, then one vector blob, per turn of the event loop, so no search waits for it: until it is
   * ready, searches answer from sqlite-vec exactly as they do without it. A write by this index while the blobs are read is
   * applied when the copy is installed. The copy is dropped only when another connection commits (`PRAGMA data_version`) or
   * a rebuild starts, which it cannot follow. True when the copy is ready.
   */
  async warmMirror(): Promise<boolean> {
    if (this.mirror !== null || this.warming !== null) return this.mirror !== null;
    const token = { changed: new Set<number>(), dropped: false };
    this.warming = token;
    return this.readCopy(token);
  }

  /** Reads the copy for `token`, which is `warming` for as long as this runs (see warmMirror). */
  private async readCopy(token: { changed: Set<number>; dropped: boolean }): Promise<boolean> {
    try {
      const n = (this.stmt('SELECT COUNT(*) AS n FROM chunk_embeddings_rowids').get() as { n: number }).n;
      const version = this.dataVersion();
      if (n === 0 || n * this.dimensions * 4 > this.capBytes || this.tableDims() !== this.dimensions) return false;
      const dims = this.dimensions;
      const wantsRows = this.wantsRows(n);
      const simd = wantsRows ? SimdRows.create(dims, n) : null;
      const data = simd ? simd.data : new Float32Array(n * dims);
      const ids: number[] = [];
      const slot = new Map<number, number>();
      const offsetOf = new Uint32Array(n);
      const byChunk = new Map<number, number[]>();
      // The table's rows a page at a time, in rowid order: one read of all of them would hold the event loop for as long.
      const page = this.stmt('SELECT rowid, chunk_id, chunk_offset FROM chunk_embeddings_rowids WHERE rowid > ? ORDER BY rowid LIMIT ?');
      let after: bigint = -(2n ** 63n);
      while (ids.length < n) {
        const batch = page.all(after, BigInt(Math.min(WARM_TURN_ROWS, n - ids.length))) as Array<{
          rowid: number | bigint; chunk_id: number | bigint; chunk_offset: number | bigint;
        }>;
        if (batch.length === 0) break;
        for (const row of batch) {
          const i = ids.length;
          const id = Number(row.rowid);
          ids.push(id);
          slot.set(id, i);
          offsetOf[i] = Number(row.chunk_offset);
          const chunk = Number(row.chunk_id);
          const list = byChunk.get(chunk);
          if (list) list.push(i);
          else byChunk.set(chunk, [i]);
        }
        after = BigInt(batch[batch.length - 1].rowid);
        await new Promise<void>(resolve => setImmediate(resolve));
        if (token.dropped) return false;
      }
      const chunks = [...byChunk.keys()];
      const blobOf = this.stmt('SELECT vectors FROM chunk_embeddings_vector_chunks00 WHERE rowid = ?');
      for (const chunk of chunks) {
        if (token.dropped) return false;
        const blob = (blobOf.get(BigInt(chunk)) as { vectors: Buffer } | undefined)?.vectors;
        if (!blob) return false;
        for (const i of byChunk.get(chunk)!) {
          const off = offsetOf[i] * dims;
          if ((blob.byteOffset + off * 4) % 4 !== 0 || off * 4 + dims * 4 > blob.length) return false;
          data.set(new Float32Array(blob.buffer, blob.byteOffset + off * 4, dims), i * dims);
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (token.dropped || this.dataVersion() !== version) return false;
      // The rows placed are the count: a row deleted while the pages were read is never placed, and one inserted is replayed below.
      this.mirror = { ids, slot, data, rows: simd, simdTried: wantsRows, count: ids.length, cap: simd ? simd.capRows : n, version };
      // A chunk written or deleted while the blobs were read may hold a row the copy does not: each is taken from the table now.
      for (const chunk of token.changed) {
        const vector = this.get(chunk);
        if (vector) this.remember(chunk, Float32Array.from(vector));
        else this.forget(chunk);
      }
      return this.mirror !== null;
    } catch {
      // A copy installed before a replay failed would miss that write: no copy is kept, and the next search reads the table.
      this.mirror = null;
      return false;
    } finally {
      if (this.warming === token) this.warming = null;
    }
  }

  /**
   * Starts {@link warmMirror} on a later turn of the event loop, but only when RENOR_VECTOR_MIRROR_MIB raised the cap above
   * its default: at the default the copy is small and the first search builds it, as it always has. From this call on, a
   * search answers from sqlite-vec until the copy is ready, including one that arrives before that turn.
   */
  warmMirrorInBackground(): void {
    if (this.capBytes <= MIRROR_MAX_BYTES || this.mirror !== null || this.warming !== null) return;
    const token = { changed: new Set<number>(), dropped: false };
    this.warming = token;
    setImmediate(() => { void this.readCopy(token); });
  }

  /** `PRAGMA data_version`. Another connection's commit changes it; this connection's own writes do not. */
  private dataVersion(): number {
    return Number(this.stmt('PRAGMA data_version').pluck().get());
  }

  /** Dimensions the vec0 table was created with, or null when it has not been created. */
  private tableDims(): number | null {
    const row = this.stmt(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'`
    ).get() as { sql: string } | undefined;
    const found = row?.sql.match(/FLOAT\[(\d+)\]/i);
    return found ? Number(found[1]) : null;
  }

  /**
   * The stored vectors, copied once from sqlite-vec's packed shadow blobs (one blob per chunk of vectors, not one row
   * per vector). The copy is dropped when the row count changes without this class writing it, or when another
   * connection commits (`PRAGMA data_version`): a replace there keeps the count and would otherwise stay invisible.
   * Past the index's byte cap there is no copy. A table declared at a different dimension is not copied, so the
   * sqlite-vec query throws its dimension error instead of this copy answering with a slice of the blob.
   */
  private mirrorReady(): boolean {
    let n: number;
    let version: number;
    try {
      n = (this.stmt('SELECT COUNT(*) AS n FROM chunk_embeddings_rowids').get() as { n: number }).n;
      version = this.dataVersion();
    } catch {
      this.mirror = null;
      this.overCap = false;
      return false;
    }
    this.overCap = n * this.dimensions * 4 > this.capBytes;
    if (this.mirror && this.mirror.count === n && this.mirror.version === version) return true;
    if (n === 0) {
      this.mirror = { ids: [], slot: new Map(), data: new Float32Array(0), rows: null, simdTried: false, count: 0, cap: 0, version };
      return true;
    }
    // A background copy is being read: this search answers from sqlite-vec, as it does until the copy is ready.
    if (this.warming) return false;
    if (this.overCap) {
      this.mirror = null;
      return false;
    }
    this.mirror = this.loadMirror(n, version);
    return this.mirror !== null;
  }

  private loadMirror(n: number, version: number): VecMirror | null {
    const declared = this.tableDims();
    if (declared !== null && declared !== this.dimensions) return null;
    const dims = this.dimensions;
    // A reload (another connection committed) replaces this mirror, so its linear memory is taken over, not reserved again,
    // when the vectors it now holds still want one.
    const wantsRows = this.wantsRows(n);
    const held = this.mirror?.rows;
    const simd = !wantsRows ? null : held && held.capRows >= n ? held : SimdRows.create(dims, n);
    // The memory is asked for before the table is read, so a copy that cannot be had costs no read: searches read sqlite-vec.
    let data: Float32Array;
    try {
      data = simd ? simd.data : new Float32Array(n * dims);
    } catch {
      return null;
    }
    let chunks: Array<{ rowid: number | bigint; vectors: Buffer }>;
    let rows: Array<{ rowid: number | bigint; chunk_id: number | bigint; chunk_offset: number | bigint }>;
    try {
      chunks = this.stmt('SELECT rowid, vectors FROM chunk_embeddings_vector_chunks00').all() as typeof chunks;
      rows = this.stmt('SELECT rowid, chunk_id, chunk_offset FROM chunk_embeddings_rowids').all() as typeof rows;
    } catch {
      return null;
    }
    // A commit landed while the blobs were being copied. This search uses the KNN path; the next one copies again.
    if (rows.length !== n || this.dataVersion() !== version) return null;
    const blobs = new Map<number, Buffer>();
    for (const chunk of chunks) blobs.set(Number(chunk.rowid), chunk.vectors);
    const ids = new Array<number>(n);
    const slot = new Map<number, number>();
    try {
      for (let i = 0; i < n; i++) {
        const blob = blobs.get(Number(rows[i].chunk_id));
        const off = Number(rows[i].chunk_offset) * dims;
        if (!blob || (blob.byteOffset + off * 4) % 4 !== 0 || off * 4 + dims * 4 > blob.length) return null;
        data.set(new Float32Array(blob.buffer, blob.byteOffset + off * 4, dims), i * dims);
        const id = Number(rows[i].rowid);
        ids[i] = id;
        slot.set(id, i);
      }
    } catch {
      return null;
    }
    return { ids, slot, data, rows: simd, simdTried: wantsRows, count: n, cap: simd ? simd.capRows : n, version };
  }

  /**
   * Whether `live` vectors want a memory the SIMD scan reads. Their bytes decide, never the room the mirror keeps for more:
   * the capacity doubles ahead of the vectors, and a mirror that holds 4.3 MB must not get the 10 GiB reservation because
   * it has room for 8.6.
   */
  private wantsRows(live: number): boolean {
    return live * this.dimensions * 4 >= SIMD_MIN_BYTES;
  }

  /** The live vectors have reached the minimum: move them, once, to a memory the SIMD scan reads (the JavaScript copy stays if it cannot). */
  private moveToRows(m: VecMirror): void {
    m.simdTried = true;
    const simd = SimdRows.create(this.dimensions, m.cap);
    if (!simd) return;
    simd.data.set(m.data.subarray(0, m.count * this.dimensions));
    m.data = simd.data;
    m.rows = simd;
  }

  private remember(chunkId: number, floats: Float32Array): void {
    const m = this.mirror;
    if (!m) return;
    const dims = this.dimensions;
    const have = m.slot.get(chunkId);
    if (have !== undefined) {
      m.data.set(floats, have * dims);
      return;
    }
    if ((m.count + 1) * dims * 4 > this.capBytes) {
      this.mirror = null;
      return;
    }
    if (m.count === m.cap) {
      // Doubling can jump past the byte cap while the next single vector still fits (16,384 → 32,768 at 768 dims).
      const maxCap = Math.floor(this.capBytes / (dims * 4));
      let cap = Math.max(m.cap * 2, m.cap + 16, 16);
      if (cap > maxCap) cap = maxCap;
      if (cap < m.count + 1) {
        this.mirror = null;
        return;
      }
      if (m.rows) {
        if (!m.rows.grow(cap)) {
          this.mirror = null;
          return;
        }
        m.data = m.rows.data;
      } else {
        let data: Float32Array;
        try {
          data = new Float32Array(cap * dims);
        } catch {
          // No memory for a larger copy: this copy is dropped, and searches read sqlite-vec until a search builds one again.
          this.mirror = null;
          return;
        }
        data.set(m.data.subarray(0, m.count * dims));
        m.data = data;
      }
      m.cap = cap;
    }
    const i = m.count;
    m.data.set(floats, i * dims);
    m.ids[i] = chunkId;
    m.slot.set(chunkId, i);
    m.count++;
    if (!m.rows && !m.simdTried && this.wantsRows(m.count)) this.moveToRows(m);
  }

  private forget(chunkId: number): void {
    const m = this.mirror;
    if (!m) return;
    const i = m.slot.get(chunkId);
    if (i === undefined) return;
    const dims = this.dimensions;
    const last = m.count - 1;
    if (i !== last) {
      m.data.copyWithin(i * dims, last * dims, (last + 1) * dims);
      const moved = m.ids[last];
      m.ids[i] = moved;
      m.slot.set(moved, i);
    }
    m.slot.delete(chunkId);
    m.ids.pop();
    m.count--;
  }

  /** sqlite-vec's own distance for one stored vector. It is the KNN distance: the same C function, so the bits match. */
  private l2(slot: number, query: Buffer): number {
    const m = this.mirror!;
    const bytes = this.dimensions * 4;
    const blob = Buffer.from(m.data.buffer, m.data.byteOffset + slot * bytes, bytes);
    const row = this.stmt('SELECT vec_distance_l2(?, ?) AS distance').get(blob, query) as { distance: number };
    return row.distance;
  }

  /** The distance from `qf` to each of the `n` vectors (the packed ones, or those at `slots`) to `approx`, by the SIMD scan where the mirror has one. */
  private scanMirror(m: VecMirror, qf: Float32Array, slots: number[] | null, n: number, approx: Float64Array): void {
    const dims = this.dimensions;
    if (m.rows && qf.length === dims) {
      try {
        m.rows.stage(qf);
        if (slots) for (let i = 0; i < n; i++) approx[i] = m.rows.distance(slots[i]);
        else m.rows.distances(0, n, approx, 0);
        return;
      } catch {
        // the scan only chooses candidates: the same search in JavaScript is the same answer
      }
    }
    if (slots) scanSlotsL2(m.data, slots, dims, qf, approx);
    else scanPackedL2(m.data, n, dims, qf, approx);
  }

  private scanBuffer(n: number): Float64Array {
    if (this.scanned.length < n) this.scanned = new Float64Array(Math.max(n, this.scanned.length * 2));
    return this.scanned;
  }

  private rankExact(slots: number[], query: Buffer, topK: number): VectorSearchResult[] {
    const rows = slots.map(slot => ({ chunkId: this.mirror!.ids[slot], distance: this.l2(slot, query) }));
    rows.sort((a, b) => a.distance - b.distance || a.chunkId - b.chunkId);
    const edge = rows.length > topK ? rows[topK - 1].distance : Number.POSITIVE_INFINITY;
    const out: VectorSearchResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i >= topK && rows[i].distance !== edge) break;
      out.push({ chunkId: rows[i].chunkId, score: 1 - (rows[i].distance * rows[i].distance) / 2 });
    }
    return out;
  }

  /**
   * Same rows as {@link searchStored}. Null means this query is cheaper, or only correct, on the KNN path: the
   * candidate band is most of the index, or the scan disagreed with `vec_distance_l2` by more than the slack allows.
   */
  private searchMirror(qf: Float32Array, query: Buffer, topK: number, among?: number[]): VectorSearchResult[] | null {
    const m = this.mirror!;
    let slots: number[] | null = null;
    if (among) {
      const seen = new Set<number>();
      slots = [];
      for (const id of among) {
        if (seen.has(id)) continue;
        seen.add(id);
        const slot = m.slot.get(id);
        if (slot !== undefined) slots.push(slot);
      }
    }
    const n = slots ? slots.length : m.count;
    if (n === 0) return [];
    if (n <= MIRROR_EXACT_LIMIT) return this.rankExact(slots ?? Array.from({ length: n }, (_, i) => i), query, topK);

    const approx = this.scanBuffer(n);
    this.scanMirror(m, qf, slots, n, approx);
    const limit = kthSmallest(approx, n, Math.min(topK, n)) + MIRROR_SLACK;
    const picked: number[] = [];
    for (let i = 0; i < n; i++) if (approx[i] <= limit) picked.push(i);
    if (picked.length > MIRROR_EXACT_LIMIT) return null;

    const chosen = picked.map(i => (slots ? slots[i] : i));
    const distances = chosen.map(slot => this.l2(slot, query));
    let worst = 0;
    for (let i = 0; i < picked.length; i++) {
      const err = Math.abs(distances[i] - approx[picked[i]]);
      if (err > worst) worst = err;
    }
    if (worst > MIRROR_SLACK / 2) return null;

    const rows = chosen.map((slot, i) => ({ chunkId: m.ids[slot], distance: distances[i] }));
    rows.sort((a, b) => a.distance - b.distance || a.chunkId - b.chunkId);
    const edge = rows.length > topK ? rows[topK - 1].distance : Number.POSITIVE_INFINITY;
    const out: VectorSearchResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i >= topK && rows[i].distance !== edge) break;
      out.push({ chunkId: rows[i].chunkId, score: 1 - (rows[i].distance * rows[i].distance) / 2 });
    }
    return out;
  }

  /** The KNN query, widened until a tie at the cut is whole. The answer `search` used before the in-process scan. */
  private searchStored(buf: Buffer, topK: number, among?: number[]): VectorSearchResult[] {
    const ids = among === undefined ? null : JSON.stringify(among);
    const nearest = (k: number) => (ids === null
      ? this.stmt('SELECT rowid, distance FROM chunk_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(buf, k)
      : this.stmt(
        'SELECT rowid, distance FROM chunk_embeddings WHERE embedding MATCH ? AND k = ? AND rowid IN (SELECT value FROM json_each(?)) ORDER BY distance'
      ).all(buf, k, ids)) as Array<{ rowid: number | bigint; distance: number }>;
    let k = Math.min(topK + 1, KNN_MAX_K);
    let rows = nearest(k);
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
}
