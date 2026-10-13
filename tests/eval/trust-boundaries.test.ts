import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';
import { hitAtK, forbiddenRetrieved } from '../../src/eval/metrics';

const sha256 = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const testCase: EvalCase = { id: 'a', query: 'q', category: 'stable_fact', relevant: [{ match: 'gold' }], split: 'dev' };
const hit = { id: 'a', hits: [{ text: 'gold' }] };
function cli(file: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', `scripts/eval/${file}`, ...args], { encoding: 'utf8' });
}
// The two cases that start `tsx` through cli() cost 0.3-0.55s of CPU (measured, 3 runs). The budget is 20x the
// slowest, rounded up to 5s, so they pass while their process tree gets about 5% of one core.
const SPAWN_BUDGET_MS = 15_000;
function temp(action: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-review-test-'));
  try { action(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('review: fail-closed evaluation boundaries', () => {
  it('rejects duplicate case IDs rather than silently weighting a case twice', () => {
    expect(() => scoreRetrieval([testCase, testCase], [hit])).toThrow(/duplicate/i);
  });
  it('rejects duplicate result IDs rather than selecting the last score', () => {
    expect(() => scoreRetrieval([testCase], [{ id: 'a', hits: [] }, hit])).toThrow(/duplicate/i);
  });
  it('rejects empty datasets and nonfinite/negative timing or context measurements', () => {
    expect(() => scoreRetrieval([], [])).toThrow();
    expect(() => scoreRetrieval([testCase], [{ ...hit, latencyMs: -1 }])).toThrow(/Invalid latencyMs/);
    expect(() => scoreRetrieval([testCase], [{ ...hit, contextTokens: NaN }])).toThrow(/Invalid contextTokens/);
  });
  it('rejects duplicate (normalized-equal) gold targets in a case instead of weighting them', () => {
    const dup: EvalCase = { ...testCase, relevant: [{ match: 'gold' }, { match: ' GOLD ' }] };
    expect(() => scoreRetrieval([dup], [hit])).toThrow(/Duplicate gold target/i);
  });
  it('forbids credit for superseded values on now-queries via role semantics', () => {
    const now: EvalCase = {
      id: 'now', query: "what is Ava's favorite drink now?", category: 'correction_supersession',
      relevant: [
        { match: 'passion fruit juice', relevance: 3 },
        { match: 'mango juice', relevance: 1 }, // default: forbidden under role semantics
      ],
      split: 'dev',
    };
    const staleFirst = [{ id: 'now', hits: [{ text: 'mango juice' }, { text: 'passion fruit juice' }] }];
    const currentFirst = [{ id: 'now', hits: [{ text: 'passion fruit juice' }, { text: 'mango juice' }] }];
    const staleSummary = scoreRetrieval([now], staleFirst);
    const currentSummary = scoreRetrieval([now], currentFirst);
    // Binary credit only for the positive target
    expect(hitAtK(staleFirst[0].hits, now.relevant.filter(t => (t.role ?? (t.relevance ?? 0) >= 2)), 1)).toBe(0);
    expect(staleSummary.overall.contradictionFirstRate).toBe(1);
    expect(currentSummary.overall.contradictionFirstRate).toBe(0);
    expect(currentSummary.overall.hitAt1).toBe(1);
    // Supporting role can be graded for nDCG but never binary-credited
    const supporting: EvalCase = { ...now, relevant: [
      { match: 'passion fruit juice', relevance: 3 },
      { match: 'mango juice', role: 'supporting' },
    ] };
    const summary = scoreRetrieval([supporting], currentFirst);
    expect(summary.overall.hitAt1).toBe(1);
    // Correct order (positive before supporting) is a perfect nDCG ranking;
    // the reversed order must score strictly lower.
    const reversed = scoreRetrieval([supporting], staleFirst);
    expect(summary.overall.ndcgAt5).toBe(1);
    expect(reversed.overall.ndcgAt5).toBeLessThan(1);
  });
  it('detects forbidden evidence retrieval and abstention failure via analyzer inputs', () => {
    const erased: EvalCase = { id: 'erased', query: 'q2', category: 'erasure', relevant: [], shouldAbstain: true, split: 'dev' };
    const result = { id: 'erased', hits: [{ text: 'secret that was erased' }] };
    expect(scoreRetrieval([erased], [result]).overall.abstentionEmptyRate).toBe(0);
    expect(scoreRetrieval([erased], [{ id: 'erased', hits: [] }]).overall.abstentionEmptyRate).toBe(1);
    const forbiddenTarget = [{ match: 'old-value', role: 'forbidden' as const }];
    expect(forbiddenRetrieved([{ text: 'old-value' }], forbiddenTarget, 1)).toBe(true);
  });
  it('refuses to compare manifests with missing invariants or metrics', () => temp(root => {
    for (const name of ['b', 'c']) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'manifest.json'), '{}');
      fs.writeFileSync(path.join(root, name, 'summary.json'), JSON.stringify({ overall: {} }));
    }
    expect(cli('compare-runs.ts', [path.join(root, 'b'), path.join(root, 'c')]).status).not.toBe(0);
  }), SPAWN_BUDGET_MS);
  it('generator refuses an existing output without deleting its contents', () => temp(root => {
    const marker = path.join(root, 'DO-NOT-DELETE'); fs.writeFileSync(marker, 'preserve');
    const run = cli('generate-renorbench.ts', ['--seed', 'review-only-not-a-secret', '--profiles', '1', '--output', root]);
    expect(fs.existsSync(marker)).toBe(true);
    expect(run.status).not.toBe(0);
  }), SPAWN_BUDGET_MS);
  it('rejects unknown result ids and missing results', () => {
    expect(() => scoreRetrieval([testCase], [])).toThrow(/Missing result/);
    expect(() => scoreRetrieval([testCase], [hit, { id: 'extra', hits: [] }])).toThrow(/unknown case ids/i);
  });
});
