import { describe, it, expect } from 'vitest';
import { compareRuns, SCORE_TOLERANCE, type StepRecord } from '../../scripts/bench/write-differential';

/**
 * The write differential is the instrument that says a read-path change still answers alike once things are written,
 * so what it calls "the same" is pinned: every response equal once scores are set aside (order, text, ids, length),
 * and scores equal to the noise two runs of one tree show (~3e-6), not to the size of any real change.
 */
const record = (label: string, over: Partial<StepRecord> = {}): StepRecord =>
  ({ label, ok: true, digest: 'a'.repeat(64), bytes: 100, scores: [0.5, 0.4], ...over });
const run = (...overs: Array<Partial<StepRecord>>): StepRecord[] => overs.map((over, i) => record(`step ${i}`, over));

describe('write differential: compareRuns', () => {
  it('calls two runs the same when every response is, and says how many', () => {
    const result = compareRuns(run({}, {}, {}), run({}, {}, {}));
    expect(result.identical).toBe(true);
    expect(result.worstScoreGap).toBe(0);
    expect(result.lines.at(-1)).toMatch(/^IDENTICAL: 3 responses/);
  });

  it('lets scores differ by the noise between two runs of one tree, and reports the largest gap', () => {
    const result = compareRuns(run({ scores: [0.5, 0.4] }), run({ scores: [0.5 + 3e-6, 0.4 - 1e-6] }));
    expect(result.identical).toBe(true);
    expect(result.worstScoreGap).toBeCloseTo(3e-6, 9);
  });

  it('does not let a real change of a score through: that is a boost gained or lost', () => {
    const result = compareRuns(run({ scores: [0.34076] }), run({ scores: [0.34076 + 0.0046] }));
    expect(SCORE_TOLERANCE).toBeLessThan(0.0046);
    expect(result.identical).toBe(false);
    expect(result.lines.at(-1)).toMatch(/largest score difference/);
  });

  it('names a response whose content differs, however the rest agree', () => {
    const result = compareRuns(run({}, {}), run({}, { digest: 'b'.repeat(64) }));
    expect(result.identical).toBe(false);
    expect(result.lines).toContain('DIFF step 1');
    expect(result.lines.at(-1)).toBe('1 response(s) differ');
  });

  it('names a response that answered with an error in one run only, and one of another length or with another number of hits', () => {
    expect(compareRuns(run({}), run({ ok: false })).lines).toContain('DIFF step 0 (ok true vs false)');
    expect(compareRuns(run({}), run({ bytes: 101 })).identical).toBe(false);
    expect(compareRuns(run({ scores: [0.5, 0.4] }), run({ scores: [0.5] })).identical).toBe(false);
  });

  it('counts a run that stopped short, or went on, as differing', () => {
    expect(compareRuns(run({}, {}), run({})).identical).toBe(false);
    expect(compareRuns(run({}), run({}, {})).identical).toBe(false);
  });
});
