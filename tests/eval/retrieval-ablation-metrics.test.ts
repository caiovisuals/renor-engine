import { describe, it, expect } from 'vitest';
import {
  Bootstrap,
  allGoldAt,
  anyGoldAt,
  distinctSessionsAt,
  evidenceAll,
  evidenceFraction,
  goldRanks,
  identity,
  mcnemarExact,
  mean,
  quantile,
  recallAt,
  reciprocalRank,
  rng,
  sessionReciprocalRank,
  signFlipP,
  windowOf,
  wilson,
  type StoredArm,
  type StoredHit,
  type StoredQuestion,
} from '../../scripts/eval/retrieval-ablation/metrics';

const hit = (p: number, c: number, s: number, r = 'semantic', e: number[] = []): StoredHit => ({ p, c, s, r, t: 10, e });

function question(extra: Partial<StoredQuestion> = {}): StoredQuestion {
  return {
    id: 'q1', type: 'multi-session', abstention: false,
    gold: ['Sessions/g1-aaaaaaaaaa.md', 'Sessions/g2-bbbbbbbbbb.md'],
    evidence: [{ key: 'Sessions/g1-aaaaaaaaaa.md', turn: 3 }, { key: 'Sessions/g2-bbbbbbbbbb.md', turn: 1 }],
    paths: ['Sessions/n1-cccccccccc.md', 'Sessions/g1-aaaaaaaaaa.md', 'Sessions/g2-bbbbbbbbbb.md', 'Sessions/g1-aaaaaaaaaa-occ2.md'],
    arms: {},
    ...extra,
  };
}

describe('retrieval ablation metrics: identity and window', () => {
  it('removes the -occN suffix of a repeated session and normalises separators', () => {
    expect(identity('Sessions\\g1-aaaaaaaaaa-occ2.md')).toBe('Sessions/g1-aaaaaaaaaa.md');
    expect(identity('Sessions/g1-aaaaaaaaaa.md')).toBe('Sessions/g1-aaaaaaaaaa.md');
    // only a trailing -occN before .md is a suffix
    expect(identity('Sessions/occ-note-occ.md')).toBe('Sessions/occ-note-occ.md');
  });

  it('selects the window by score and leaves session-expand additions out', () => {
    const q = question();
    // returned in layout order (newest first), not score order
    const arm: StoredArm = {
      rankedBy: 'session_date', ctxTokens: 0, retTokens: 0,
      hits: [hit(0, 7, 0.5), hit(1, 8, 0.9), hit(2, 9, 0.7), hit(1, 10, 0, 'session-expand')],
    };
    expect(windowOf(q, arm).map(h => h.c)).toEqual([8, 9, 7]);
  });

  it('breaks score ties by note path, then chunk id, as the product does', () => {
    const q = question();
    const arm: StoredArm = {
      rankedBy: 'score', ctxTokens: 0, retTokens: 0,
      // paths[1] = Sessions/g1..., paths[0] = Sessions/n1...: g1 sorts before n1
      hits: [hit(0, 1, 0.5), hit(1, 9, 0.5), hit(1, 3, 0.5)],
    };
    expect(windowOf(q, arm).map(h => [h.p, h.c])).toEqual([[1, 3], [1, 9], [0, 1]]);
  });

  it('does not reorder the stored hits', () => {
    const q = question();
    const arm: StoredArm = { rankedBy: 'score', ctxTokens: 0, retTokens: 0, hits: [hit(0, 1, 0.1), hit(1, 2, 0.9)] };
    windowOf(q, arm);
    expect(arm.hits.map(h => h.c)).toEqual([1, 2]);
  });
});

describe('retrieval ablation metrics: session rank metrics', () => {
  const q = question();
  // window by score: n1 (1), g1 (2), g1-occ2 (3), g2 (4)
  const window = [hit(0, 1, 0.9), hit(1, 2, 0.8), hit(3, 3, 0.7), hit(2, 4, 0.6)];

  it('ranks each gold session by its first hit; a repeated occurrence is the same session', () => {
    expect(goldRanks(q, window)).toEqual([2, 4]);
  });

  it('computes recall, all-gold and any-gold at k', () => {
    const ranks = goldRanks(q, window);
    expect(recallAt(ranks, 1)).toBe(0);
    expect(recallAt(ranks, 2)).toBe(0.5);
    expect(recallAt(ranks, 4)).toBe(1);
    expect(allGoldAt(ranks, 3)).toBe(false);
    expect(allGoldAt(ranks, 4)).toBe(true);
    expect(anyGoldAt(ranks, 1)).toBe(false);
    expect(anyGoldAt(ranks, 2)).toBe(true);
  });

  it('treats a gold session the window never reaches as rank Infinity', () => {
    const ranks = goldRanks(q, [hit(0, 1, 0.9)]);
    expect(ranks).toEqual([Infinity, Infinity]);
    expect(recallAt(ranks, 20)).toBe(0);
    expect(reciprocalRank(ranks)).toBe(0);
  });

  it('never counts an absent gold session as found, even for k = Infinity', () => {
    const ranks = [3, Infinity];
    expect(recallAt(ranks, Infinity)).toBe(0.5);
    expect(allGoldAt(ranks, Infinity)).toBe(false);
    expect(anyGoldAt([Infinity], Infinity)).toBe(false);
  });

  it('takes the reciprocal of the best gold position at hit level', () => {
    expect(reciprocalRank(goldRanks(q, window))).toBe(0.5);
  });

  it('counts distinct sessions for the session-level reciprocal rank', () => {
    // g1 is hit 3 behind two chunks of n1, but the second distinct session
    const w = [hit(0, 1, 0.9), hit(0, 2, 0.8), hit(1, 3, 0.7)];
    expect(reciprocalRank(goldRanks(q, w))).toBeCloseTo(1 / 3, 12);
    expect(sessionReciprocalRank(q, w)).toBe(0.5);
    expect(distinctSessionsAt(q, w, 2)).toBe(1);
    expect(distinctSessionsAt(q, w, 3)).toBe(2);
  });

  it('is vacuously perfect for a question with no gold session', () => {
    expect(recallAt([], 5)).toBe(1);
    expect(allGoldAt([], 5)).toBe(true);
    expect(anyGoldAt([], 5)).toBe(false);
  });
});

describe('retrieval ablation metrics: evidence turns', () => {
  const q = question();
  it('needs every evidence turn covered by some hit', () => {
    expect(evidenceAll(q, [hit(1, 1, 1, 'semantic', [0])])).toBe(false);
    expect(evidenceAll(q, [hit(1, 1, 1, 'semantic', [0]), hit(2, 2, 1, 'session-expand', [1])])).toBe(true);
    expect(evidenceFraction(q, [hit(1, 1, 1, 'semantic', [1])])).toBe(0.5);
    expect(evidenceFraction(q, [])).toBe(0);
  });
  it('counts a question without evidence turns as covered', () => {
    const none = question({ evidence: [] });
    expect(evidenceAll(none, [])).toBe(true);
    expect(evidenceFraction(none, [])).toBe(1);
  });
});

describe('retrieval ablation metrics: intervals', () => {
  it('Wilson reproduces textbook values', () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 10)[0]).toBe(0);
    expect(wilson(10, 10)[1]).toBeCloseTo(1, 12); // 1 - 1e-16 in double precision
    expect(wilson(0, 0)).toEqual([0, 1]);
    const [a, b] = wilson(50, 100);
    expect(a).toBeCloseTo(0.4038, 3);
    expect(b).toBeCloseTo(0.5962, 3);
  });

  it('exact McNemar reproduces the recorded p of the held-out session-expansion confirmation (39 wins, 4 losses)', () => {
    // the recorded product-GLM report, section 9.2: "39 wins and 4 losses, p = 3.1e-8"
    expect(mcnemarExact(39, 4)).toBeGreaterThan(3.0e-8);
    expect(mcnemarExact(39, 4)).toBeLessThan(3.2e-8);
    expect(mcnemarExact(10, 0)).toBeCloseTo(2 / 1024, 12);
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it('the sign-flip test is exact for few non-zero pairs, ignores zero pairs and is reproducible beyond that', () => {
    expect(signFlipP([0, 0, 0])).toBe(1);
    expect(signFlipP([0.5])).toBe(1); // one pair: both signs are as extreme as itself
    expect(signFlipP(new Array(10).fill(1))).toBeCloseTo(2 / 1024, 12);
    expect(signFlipP([0, 0, 0, ...new Array(10).fill(1)])).toBeCloseTo(2 / 1024, 12); // zeros cannot move the sum
    expect(signFlipP([1, 1, 1, 1, 1, -1, -1, -1, -1, -1])).toBe(1); // balanced: nothing is more extreme than 0
    const many = new Array(40).fill(1);
    expect(signFlipP(many)).toBeLessThan(0.001);
    expect(signFlipP(many)).toBeGreaterThan(0); // the +1 correction: a Monte Carlo p is never 0
    expect(signFlipP(many)).toBe(signFlipP(many));
  });

  it('the bootstrap is reproducible from its seed and shares resamples across arms', () => {
    const x = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const a = new Bootstrap(60, 2000, 7).ci(x);
    const b = new Bootstrap(60, 2000, 7).ci(x);
    expect(a).toEqual(b);
    expect(a[0]).toBeLessThanOrEqual(mean(x));
    expect(a[1]).toBeGreaterThanOrEqual(mean(x));
    const boot = new Bootstrap(60, 2000, 7);
    expect(boot.ci(new Array(60).fill(0.25))).toEqual([0.25, 0.25]);
    const same = boot.diff(x, x);
    expect(same).toMatchObject({ delta: 0, lo: 0, hi: 0, p: 1 });
  });

  it('a paired difference that is positive for every question has an interval above zero', () => {
    const base = Array.from({ length: 80 }, () => 0.5);
    const better = Array.from({ length: 80 }, (_, i) => 0.5 + (i % 2 === 0 ? 0.25 : 0.5));
    const d = new Bootstrap(80, 3000, 11).diff(better, base);
    expect(d.delta).toBeCloseTo(0.375, 12);
    expect(d.lo).toBeGreaterThan(0);
    expect(d.p).toBeLessThan(0.01);
  });

  it('refuses a vector of the wrong length rather than resampling the wrong questions', () => {
    expect(() => new Bootstrap(5, 100, 1).ci([1, 2, 3])).toThrow(/expected 5/);
  });

  it('quantile and the generator behave', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([], 0.5)).toBe(0);
    const r = rng(1);
    const s = rng(1);
    expect([r(), r(), r()]).toEqual([s(), s(), s()]);
  });
});
