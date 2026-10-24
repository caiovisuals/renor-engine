/**
 * The distance scan of the in-process vector mirror (vectorIndex.ts), on 128-bit SIMD.
 *
 * A hosted workspace stores dense vectors (768 floats each). A JavaScript scan over them costs about 0.8 microseconds a
 * vector whether the rows are in cache or not (9,661 vectors: 7.5 ms), so it is the arithmetic that is slow, not the
 * memory. The same scan in WebAssembly SIMD (f32x4, four independent partial sums) takes 1.1 ms. The module is a few
 * hundred bytes, assembled below from named instructions, with no import but its memory.
 *
 * It only measures squared distances, in f32, for vectorIndex.ts to choose candidates from. That choice is a band around
 * the k-th nearest, wider than the gap between this arithmetic and `vec_distance_l2` (8e-8 measured over 71 queries and
 * 9,661 real Vertex vectors, against a band of 1e-3); every candidate is then scored by `vec_distance_l2` itself, and a
 * candidate that disagrees with the scan by more than half the band sends that query to the exact KNN path. Nothing a
 * caller reads comes from this module.
 *
 * The rows live in the module's own linear memory and `data` is a view of it, so there is still one copy of the
 * vectors. A linear memory reserves address space and starts the WebAssembly runtime, so a mirror too small to matter does
 * not get one (`SIMD_MIN_BYTES`), and an allocation that fails means no SIMD (the JavaScript scan), never an error.
 *
 * RENOR_VECTOR_SIMD=0 turns it off.
 */

import { createLogger } from '../mvp/log';

const log = createLogger('engine');

/** Rows one call writes distances for; the output area below holds this many f32. */
const CHUNK_ROWS = 8192;
/** The most floats in a row this module scans (the query area below). */
export const SIMD_MAX_DIMS = 8192;
/** Layout of the linear memory: the query, then the distances of one chunk, then the rows. */
const QUERY_AT = 0;
const OUT_AT = SIMD_MAX_DIMS * 4;
const DATA_AT = OUT_AT + CHUNK_ROWS * 4;
const PAGE = 65536;

/**
 * Below this many bytes of vectors (2,731 of them at 768 dimensions) a mirror is scanned in JavaScript: that scan costs under
 * 2.2 ms, about a tenth of a `get_context`, and a WebAssembly memory brings the runtime with it (about 3 MiB resident for
 * the whole engine, 10 GiB of address space). From here the scan is a fifth of a call and the saving pays for both. The
 * bytes counted are the vectors the mirror holds, never the room it keeps for more (vectorIndex.ts wantsRows).
 */
export const SIMD_MIN_BYTES = 8 * 1024 * 1024;

// ---- the module: a few instructions, named as in the WebAssembly text format --------------------------------------

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const text = (s: string): number[] => [...uleb(s.length), ...Buffer.from(s)];

const I32 = 0x7f;
const V128 = 0x7b;
const get = (i: number): number[] => [0x20, ...uleb(i)];
const set = (i: number): number[] => [0x21, ...uleb(i)];
const tee = (i: number): number[] => [0x22, ...uleb(i)];
const i32 = (n: number): number[] => [0x41, ...sleb(n)];
const I32_ADD = [0x6a];
const I32_AND = [0x71];
const I32_SHL = [0x74];
const I32_GE_U = [0x4f];
const BLOCK = [0x02, 0x40];
const LOOP = [0x03, 0x40];
const END = [0x0b];
const br = (depth: number): number[] => [0x0c, ...uleb(depth)];
const brIf = (depth: number): number[] => [0x0d, ...uleb(depth)];
/** v128.load at `p + offset`, byte aligned: a row of a mirror is not 16-byte aligned. */
const v128Load = (offset: number): number[] => [0xfd, 0x00, 0x00, ...uleb(offset)];
const V128_ZERO = [0xfd, 0x0c, ...new Array<number>(16).fill(0)];
const F32X4_ADD = [0xfd, ...uleb(0xe4)];
const F32X4_SUB = [0xfd, ...uleb(0xe5)];
const F32X4_MUL = [0xfd, ...uleb(0xe6)];
const f32x4Lane = (lane: number): number[] => [0xfd, 0x1f, lane];
const F32_ADD = [0x92];
const F32_STORE = [0x38, 0x02, 0x00];

// parameters: rows (byte address of the first row), count, dims, query (byte address), out (byte address)
const [ROWS, COUNT, DIMS, QUERY, OUT] = [0, 1, 2, 3, 4];
// locals: i (the row), p (the next float of the row), q (the next float of the query), end16, end4, then the sums
const [I, P, Q, END16, END4, A0, A1, A2, A3, X] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** sum += (row[at..at+4) - query[at..at+4))^2, four lanes at once. */
const step = (sum: number, at: number): number[] => [
  ...get(sum),
  ...get(P), ...v128Load(at), ...get(Q), ...v128Load(at), ...F32X4_SUB, ...tee(X), ...get(X), ...F32X4_MUL,
  ...F32X4_ADD, ...set(sum),
];

/**
 * (func (export "s") (param $rows i32) (param $count i32) (param $dims i32) (param $query i32) (param $out i32)
 *   for each of $count rows, which follow one another $dims floats apart (dims is a multiple of 4):
 *     four sums of four lanes, 16 floats a turn, so no add waits for the one before it; the left over groups of 4 go to the first
 *     out[i] = sum of the sixteen lanes (f32)
 */
const SCAN_BODY: number[] = [
  ...get(ROWS), ...set(P),
  ...BLOCK, ...LOOP,
  ...get(I), ...get(COUNT), ...I32_GE_U, ...brIf(1),
  ...V128_ZERO, ...set(A0), ...V128_ZERO, ...set(A1), ...V128_ZERO, ...set(A2), ...V128_ZERO, ...set(A3),
  ...get(QUERY), ...set(Q),
  ...get(P), ...get(DIMS), ...i32(-16), ...I32_AND, ...i32(2), ...I32_SHL, ...I32_ADD, ...set(END16),
  ...get(P), ...get(DIMS), ...i32(2), ...I32_SHL, ...I32_ADD, ...set(END4),
  ...BLOCK, ...LOOP,
  ...get(P), ...get(END16), ...I32_GE_U, ...brIf(1),
  ...step(A0, 0), ...step(A1, 16), ...step(A2, 32), ...step(A3, 48),
  ...get(P), ...i32(64), ...I32_ADD, ...set(P),
  ...get(Q), ...i32(64), ...I32_ADD, ...set(Q),
  ...br(0), ...END, ...END,
  ...BLOCK, ...LOOP,
  ...get(P), ...get(END4), ...I32_GE_U, ...brIf(1),
  ...step(A0, 0),
  ...get(P), ...i32(16), ...I32_ADD, ...set(P),
  ...get(Q), ...i32(16), ...I32_ADD, ...set(Q),
  ...br(0), ...END, ...END,
  ...get(OUT), ...get(I), ...i32(2), ...I32_SHL, ...I32_ADD,
  ...get(A0), ...get(A1), ...F32X4_ADD, ...get(A2), ...get(A3), ...F32X4_ADD, ...F32X4_ADD, ...set(X),
  ...get(X), ...f32x4Lane(0), ...get(X), ...f32x4Lane(1), ...F32_ADD,
  ...get(X), ...f32x4Lane(2), ...get(X), ...f32x4Lane(3), ...F32_ADD,
  ...F32_ADD, ...F32_STORE,
  ...get(I), ...i32(1), ...I32_ADD, ...set(I),
  ...br(0), ...END, ...END,
  ...END,
];

const SCAN_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // "\0asm", version 1
  ...section(1, vec([[0x60, ...vec([[I32], [I32], [I32], [I32], [I32]]), 0x00]])), // (i32 x5) -> ()
  ...section(2, vec([[...text('e'), ...text('m'), 0x02, 0x00, 0x01]])), // import e.m: a memory of at least one page
  ...section(3, vec([[0x00]])), // one function, of that type
  ...section(7, vec([[...text('s'), 0x00, 0x00]])), // export it as "s"
  ...section(10, vec([(() => {
    const code = [...vec([[...uleb(5), I32], [...uleb(5), V128]]), ...SCAN_BODY];
    return [...uleb(code.length), ...code];
  })()])),
]);

type ScanFn = (rows: number, count: number, dims: number, query: number, out: number) => void;

let warned = false;
let compiled: WebAssembly.Module | null | undefined;
/** The compiled module, or null where SIMD (or WebAssembly) is not there. Compiled once per process. */
function scanModule(): WebAssembly.Module | null {
  if (compiled === undefined) {
    try {
      compiled = typeof WebAssembly === 'object' && WebAssembly.validate(SCAN_MODULE) ? new WebAssembly.Module(SCAN_MODULE) : null;
    } catch {
      compiled = null;
    }
  }
  return compiled;
}

/** RENOR_VECTOR_SIMD: 0/false/no/off turns the SIMD scan off; anything else (or nothing) leaves it on where it can run. */
export function simdScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.RENOR_VECTOR_SIMD ?? '').trim().toLowerCase());
}

const pagesFor = (dims: number, rows: number): number => Math.ceil((DATA_AT + rows * dims * 4) / PAGE);

/**
 * `capRows` rows of `dims` floats in a linear memory of their own, and the SIMD scan over them. `data` is a view of the
 * rows (row-major, as vectorIndex.ts stores them) and is a new object after `grow`: take it from here each time.
 */
export class SimdRows {
  data: Float32Array;
  capRows: number;
  private outView: Float32Array;
  private queryView: Float32Array;

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly scan: ScanFn,
    private readonly dims: number,
    capRows: number,
  ) {
    this.capRows = capRows;
    const views = this.views();
    this.data = views.data;
    this.outView = views.outView;
    this.queryView = views.queryView;
  }

  /** Null when the scan cannot run here: switched off, no SIMD, a row it does not take, or no address space for another memory. */
  static create(dims: number, capRows: number, env: NodeJS.ProcessEnv = process.env): SimdRows | null {
    if (!simdScanEnabled(env) || !Number.isInteger(dims) || dims < 4 || dims % 4 !== 0 || dims > SIMD_MAX_DIMS || capRows < 1) return null;
    const module = scanModule();
    if (!module) return null;
    try {
      const memory = new WebAssembly.Memory({ initial: pagesFor(dims, capRows) });
      const { s } = new WebAssembly.Instance(module, { e: { m: memory } }).exports as unknown as { s: ScanFn };
      return new SimdRows(memory, s, dims, capRows);
    } catch (err) {
      if (!warned) {
        warned = true;
        log.warn('simd_scan_unavailable', { detail: 'scanning in JavaScript' }, err);
      }
      return null;
    }
  }

  private views() {
    const buffer = this.memory.buffer;
    return {
      data: new Float32Array(buffer, DATA_AT, this.capRows * this.dims),
      outView: new Float32Array(buffer, OUT_AT, CHUNK_ROWS),
      queryView: new Float32Array(buffer, QUERY_AT, this.dims),
    };
  }

  /** Room for `capRows` rows, the rows kept. False when the memory cannot grow: the caller drops the mirror. */
  grow(capRows: number): boolean {
    if (capRows <= this.capRows) return true;
    try {
      const have = this.memory.buffer.byteLength / PAGE;
      const need = pagesFor(this.dims, capRows);
      if (need > have) this.memory.grow(need - have);
    } catch {
      return false;
    }
    this.capRows = capRows;
    const views = this.views();
    this.data = views.data;
    this.outView = views.outView;
    this.queryView = views.queryView;
    return true;
  }

  /** The query every `distances` and `distance` that follows measures from. */
  stage(query: Float32Array): void {
    this.queryView.set(query);
  }

  /** Distances (not squared) from the staged query to rows `from..from+count-1`, written to `out[at..at+count)`. */
  distances(from: number, count: number, out: Float64Array, at: number): void {
    const rowBytes = this.dims * 4;
    for (let done = 0; done < count; done += CHUNK_ROWS) {
      const chunk = Math.min(CHUNK_ROWS, count - done);
      this.scan(DATA_AT + (from + done) * rowBytes, chunk, this.dims, QUERY_AT, OUT_AT);
      const squared = this.outView;
      for (let i = 0; i < chunk; i++) out[at + done + i] = Math.sqrt(squared[i]);
    }
  }

  /** Distance from the staged query to one row. */
  distance(row: number): number {
    this.scan(DATA_AT + row * this.dims * 4, 1, this.dims, QUERY_AT, OUT_AT);
    return Math.sqrt(this.outView[0]);
  }
}
