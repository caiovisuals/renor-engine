/**
 * Pure scoring for retrieval ablations (no I/O, no model, no embedding).
 *
 * What is measured, and on which list:
 *  - Session recall / MRR are read from the WINDOW the product selected by score: the hits that are not session-expand
 *    additions, ordered by (score desc, note path, chunk id), the order retrieveContext selects in before it lays the
 *    window out newest-first. A "hit" is one returned chunk, so recall@k means the k best chunks, which is what top_k is.
 *  - Evidence-turn coverage is read from what the benchmark client would hand the reader: the returned list in layout
 *    order, exact duplicates collapsed, cut at the client's token cap (`deliver`, a copy of assembleClientContext's loop,
 *    cross-checked against the real function by the driver).
 * Gold labels (answer_session_ids, has_answer) enter here only, never the product process.
 */

export interface StoredHit {
  /** Index into the question's `paths`. */
  p: number;
  /** Chunk id. */
  c: number;
  /** Score the product returned. */
  s: number;
  /** Reason the product returned (`semantic+content`, `session-expand`, ...). */
  r: string;
  /** o200k tokens of the bare hit text. */
  t: number;
  /** Indexes into the question's `evidence` that this hit's text covers. */
  e: number[];
  /** First 10 hex digits of the sha1 of the exact hit text: enough to tell two lists apart without storing the text. */
  x?: string;
  /** Delivered under the benchmark client's cap (set by the driver). */
  u?: 1;
}

export interface StoredArm {
  rankedBy: 'session_date' | 'score';
  /** In the order the product returned them (its layout). */
  hits: StoredHit[];
  /** Benchmark-client context tokens under the cap. */
  ctxTokens: number;
  /** The same without a cap. */
  retTokens: number;
}

export interface EvidenceTurn { key: string; turn: number }

export interface StoredQuestion {
  id: string;
  type: string;
  abstention: boolean;
  /** Gold session identities (note path with the `-occN` suffix removed). */
  gold: string[];
  evidence: EvidenceTurn[];
  paths: string[];
  arms: Record<string, StoredArm>;
}

export const SESSION_EXPAND_REASON = 'session-expand';

/** A note path's identity: separators normalised and the `-occN` suffix of a repeated noise session removed. */
export function identity(notePath: string): string {
  return notePath.replace(/\\/g, '/').trim().replace(/-occ\d+(?=\.md$)/, '');
}

/** retrieval/semantic.ts byScoreThenPlace: highest score first, equal scores by note path then chunk id. */
export function windowOf(q: StoredQuestion, arm: StoredArm): StoredHit[] {
  return arm.hits
    .filter(h => h.r !== SESSION_EXPAND_REASON)
    .sort((a, b) => b.s - a.s || (q.paths[a.p] < q.paths[b.p] ? -1 : q.paths[a.p] > q.paths[b.p] ? 1 : 0) || a.c - b.c);
}

/** 1-based position of the first window hit of each gold session (Infinity when the window has none of it). */
export function goldRanks(q: StoredQuestion, window: StoredHit[]): number[] {
  const first = new Map<string, number>();
  window.forEach((h, i) => {
    const key = identity(q.paths[h.p]);
    if (!first.has(key)) first.set(key, i + 1);
  });
  return q.gold.map(g => first.get(g) ?? Infinity);
}

/** Share of the gold sessions with a hit among the first k window hits. */
export function recallAt(ranks: number[], k: number): number {
  // An absent gold session has rank Infinity; `Infinity <= Infinity` is true, so absence is tested for explicitly.
  return ranks.length === 0 ? 1 : ranks.filter(r => Number.isFinite(r) && r <= k).length / ranks.length;
}

/** Every gold session is among the first k window hits. */
export function allGoldAt(ranks: number[], k: number): boolean {
  return ranks.every(r => Number.isFinite(r) && r <= k);
}

/** At least one gold session is among the first k window hits. */
export function anyGoldAt(ranks: number[], k: number): boolean {
  return ranks.some(r => Number.isFinite(r) && r <= k);
}

/** Reciprocal of the position of the first window hit that belongs to a gold session; 0 when there is none. */
export function reciprocalRank(ranks: number[]): number {
  const best = Math.min(...ranks);
  return Number.isFinite(best) ? 1 / best : 0;
}

/**
 * The same over distinct sessions: a session's position is the number of distinct sessions up to and including it, in
 * the order of their first window hit. Chunks of one session ranked above it no longer push it down.
 */
export function sessionReciprocalRank(q: StoredQuestion, window: StoredHit[]): number {
  const gold = new Set(q.gold);
  const seen = new Set<string>();
  for (const h of window) {
    const key = identity(q.paths[h.p]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (gold.has(key)) return 1 / seen.size;
  }
  return 0;
}

/** How many distinct sessions the first k window hits touch. */
export function distinctSessionsAt(q: StoredQuestion, window: StoredHit[], k: number): number {
  return new Set(window.slice(0, k).map(h => identity(q.paths[h.p]))).size;
}

/** Every evidence turn is covered by a hit of the list (an empty evidence list is vacuously covered). */
export function evidenceAll(q: StoredQuestion, hits: StoredHit[]): boolean {
  const covered = new Set<number>();
  for (const h of hits) for (const e of h.e) covered.add(e);
  return q.evidence.every((_, i) => covered.has(i));
}

/** Share of the evidence turns covered by a hit of the list. */
export function evidenceFraction(q: StoredQuestion, hits: StoredHit[]): number {
  if (q.evidence.length === 0) return 1;
  const covered = new Set<number>();
  for (const h of hits) for (const e of h.e) covered.add(e);
  return q.evidence.filter((_, i) => covered.has(i)).length / q.evidence.length;
}

/** Hits the benchmark client delivers: stored as `u` by the driver. */
export function deliveredHits(arm: StoredArm): StoredHit[] {
  return arm.hits.filter(h => h.u === 1);
}

// ─── Statistics ───

/** Wilson score interval for k successes of n at 95%. */
export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export const mean = (xs: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return xs.length === 0 ? 0 : s / xs.length;
};

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** mulberry32: a seeded generator, so a published interval can be recomputed to the digit. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap over questions with ONE set of resamples shared by every arm and metric of a split, so a
 * difference between two arms is paired by construction and two arms are never separated by resampling noise.
 */
export class Bootstrap {
  readonly n: number;
  readonly B: number;
  private readonly index: Uint16Array;

  constructor(n: number, B = 10_000, seed = 20261006) {
    if (n > 65_535) throw new Error('Bootstrap supports up to 65,535 questions');
    this.n = n;
    this.B = B;
    this.index = new Uint16Array(n * B);
    const rand = rng(seed);
    for (let i = 0; i < this.index.length; i++) this.index[i] = Math.floor(rand() * n);
  }

  /** Mean of `values` in each resample. */
  private means(values: ArrayLike<number>): Float64Array {
    if (values.length !== this.n) throw new Error(`expected ${this.n} values, got ${values.length}`);
    const out = new Float64Array(this.B);
    for (let b = 0; b < this.B; b++) {
      let s = 0;
      const base = b * this.n;
      for (let i = 0; i < this.n; i++) s += values[this.index[base + i]];
      out[b] = s / this.n;
    }
    return out;
  }

  /** 95% interval of the mean of `values`. */
  ci(values: ArrayLike<number>): [number, number] {
    const m = this.means(values);
    m.sort();
    return [m[Math.floor(0.025 * this.B)], m[Math.min(this.B - 1, Math.floor(0.975 * this.B))]];
  }

  /** The mean difference a - b with its 95% interval and a two-sided bootstrap p (twice the smaller tail). */
  diff(a: ArrayLike<number>, b: ArrayLike<number>): { delta: number; lo: number; hi: number; p: number } {
    const d = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) d[i] = a[i] - b[i];
    const m = this.means(d);
    m.sort();
    let below = 0;
    let above = 0;
    for (const x of m) { if (x <= 0) below++; if (x >= 0) above++; }
    const p = Math.min(1, (2 * Math.min(below, above)) / this.B);
    return { delta: mean(d), lo: m[Math.floor(0.025 * this.B)], hi: m[Math.min(this.B - 1, Math.floor(0.975 * this.B))], p };
  }
}

/**
 * Paired randomisation (sign-flip) test of a mean difference, two-sided. A difference of exactly 0 cannot move the sum, so
 * only the non-zero pairs are flipped: with most pairs identical (one knob rarely changes a window) the bootstrap's own
 * p-value is degenerate, this one is not. Exact up to 20 non-zero pairs, otherwise `B` seeded random flips with the +1
 * correction, so a reported p is never 0.
 */
export function signFlipP(diffs: ArrayLike<number>, B = 20_000, seed = 424_242): number {
  const nz: number[] = [];
  for (let i = 0; i < diffs.length; i++) if (diffs[i] !== 0) nz.push(diffs[i]);
  if (nz.length === 0) return 1;
  let observed = 0;
  for (const d of nz) observed += d;
  observed = Math.abs(observed);
  const eps = 1e-12 * Math.max(1, observed);
  if (nz.length <= 20) {
    let extreme = 0;
    const total = 2 ** nz.length;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < nz.length; i++) s += (mask >> i) & 1 ? nz[i] : -nz[i];
      if (Math.abs(s) >= observed - eps) extreme++;
    }
    return extreme / total;
  }
  const rand = rng(seed);
  let extreme = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < nz.length; i++) s += rand() < 0.5 ? nz[i] : -nz[i];
    if (Math.abs(s) >= observed - eps) extreme++;
  }
  return (1 + extreme) / (B + 1);
}

/** Two-sided exact sign test on the discordant pairs (McNemar): P(X <= min(wins, losses)) doubled, X ~ Bin(wins+losses, 1/2). */
export function mcnemarExact(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  // log-space binomial tail, exact to double precision for the n this harness sees (a few hundred).
  const logChoose = (nn: number, kk: number): number => {
    let s = 0;
    for (let i = 1; i <= kk; i++) s += Math.log((nn - kk + i) / i);
    return s;
  };
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}
