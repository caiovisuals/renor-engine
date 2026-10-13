import { describe, expect, it } from 'vitest';
import { compareRuns, type RunManifest, type RunSummary } from '../../src/eval/comparison';

function summary(overrides: Record<string, number | null> = {}): RunSummary {
  return {
    overall: {
      hitAt1: 0.5,
      hitAt5: 0.7,
      recallAt5: 0.6,
      mrr: 0.55,
      ndcgAt5: 0.6,
      contradictionFirstRate: 0,
      meanLatencyMs: 40,
      p50LatencyMs: 40,
      p95LatencyMs: 42.731,
      meanContextTokens: 2000,
      ...overrides,
    },
  };
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    benchmark: 'renorbench-v0',
    casesSha256: 'cases-hash',
    fixtureSha256: 'fixture-hash',
    topK: 10,
    provider: { kind: 'local', model: 'Xenova/multilingual-e5-base', dimensions: 768 },
    qualityEligible: true,
    evaluatorSha256: 'evaluator-hash',
    chunking: { maxTokens: 400, overlapTokens: 50 },
    gitDirty: false,
    ...overrides,
  };
}

const baselineRun = { summary: summary(), manifest: manifest() };

describe('compareRuns policy', () => {
  it('P0-C regression: microscopic latency improvement is NEUTRAL, not IMPROVED', () => {
    const candidate = {
      summary: summary({ p95LatencyMs: 42.729 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('NEUTRAL');
  });

  it('a material (>= 5%) latency improvement with flat quality is IMPROVED', () => {
    const candidate = {
      summary: summary({ p95LatencyMs: 38 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('IMPROVED');
  });

  it('a material context-token reduction is IMPROVED', () => {
    const candidate = {
      summary: summary({ meanContextTokens: 1500 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('IMPROVED');
  });

  it('a 4.9% latency improvement stays below the default materiality threshold', () => {
    const candidate = {
      summary: summary({ p95LatencyMs: 42.731 * 0.951 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('NEUTRAL');
  });

  it('quality gains are still IMPROVED regardless of latency', () => {
    const candidate = {
      summary: summary({ mrr: 0.65, p95LatencyMs: 50 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('IMPROVED');
  });

  it('quality regression is REGRESSED even with a big latency win', () => {
    const candidate = {
      summary: summary({ hitAt1: 0.3, p95LatencyMs: 20 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('REGRESSED');
  });

  it('contradiction-first rate increase is a quality regression', () => {
    const candidate = {
      summary: summary({ contradictionFirstRate: 0.25 }),
      manifest: manifest(),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('REGRESSED');
  });

  it('P0-B regression: evaluator hash mismatch refuses comparison by default', () => {
    const candidate = {
      summary: summary(),
      manifest: manifest({ evaluatorSha256: 'tampered-evaluator' }),
    };
    expect(() => compareRuns(baselineRun, candidate)).toThrow(/Evaluator changed/);
  });

  it('P0-B regression: evaluator hash mismatch is DESCRIPTIVE_ONLY when explicitly allowed', () => {
    const candidate = {
      summary: summary({ mrr: 0.9 }),
      manifest: manifest({ evaluatorSha256: 'tampered-evaluator' }),
    };
    const result = compareRuns(baselineRun, candidate, { allowEvaluatorChange: true });
    expect(result.verdict).toBe('DESCRIPTIVE_ONLY');
    expect(result.reasons.join(' ')).toMatch(/Evaluator code changed/);
  });

  it('dirty working tree blocks promotion-grade comparison', () => {
    const candidate = {
      summary: summary({ mrr: 0.9 }),
      manifest: manifest({ gitDirty: true }),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('DESCRIPTIVE_ONLY');
  });

  it('legacy manifests without gitDirty provenance are not clean ablations', () => {
    const legacyManifest = manifest();
    delete (legacyManifest as Partial<RunManifest>).gitDirty;
    const candidate = { summary: summary({ mrr: 0.9 }), manifest: legacyManifest };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('DESCRIPTIVE_ONLY');
  });

  it('non-quality (hash provider) runs can never earn IMPROVED', () => {
    const candidate = {
      summary: summary({ mrr: 0.9 }),
      manifest: manifest({ qualityEligible: false }),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('DESCRIPTIVE_ONLY');
  });

  it('chunking drift blocks a clean ablation', () => {
    const candidate = {
      summary: summary({ mrr: 0.9 }),
      manifest: manifest({ chunking: { maxTokens: 800, overlapTokens: 100 } }),
    };
    const result = compareRuns(baselineRun, candidate);
    expect(result.verdict).toBe('DESCRIPTIVE_ONLY');
  });

  it('different benchmark data refuses comparison', () => {
    const candidate = {
      summary: summary(),
      manifest: manifest({ casesSha256: 'other-cases' }),
    };
    expect(() => compareRuns(baselineRun, candidate)).toThrow(/different benchmark data/);
  });
});
describe('category-collapse guard covers the baseline\'s categories too', () => {
  const withCategories = (byCategory: Record<string, Record<string, number>>) => ({ summary: { ...summary(), byCategory }, manifest: manifest() });

  it('a category the baseline has and the candidate lost is a regression, not silence', () => {
    const baseline = withCategories({ a: { hitAt1: 0.5 }, b: { hitAt1: 0.5 } });
    const result = compareRuns(baseline, withCategories({ a: { hitAt1: 0.5 } }));
    expect(result.categoryRegressions).toEqual(['b.missing']);
    expect(result.verdict).toBe('REGRESSED');
  });

  it('a category only the candidate has is still not a regression, and a drop still is', () => {
    const baseline = withCategories({ a: { hitAt1: 0.5 } });
    expect(compareRuns(baseline, withCategories({ a: { hitAt1: 0.5 }, c: { hitAt1: 0.1 } })).categoryRegressions).toEqual([]);
    expect(compareRuns(baseline, withCategories({ a: { hitAt1: 0.4 } })).categoryRegressions).toEqual(['a.hitAt1']);
  });
});

describe('compareRuns regression gate (the agent gate\'s hash baseline check)', () => {
  const hashManifest = (overrides: Partial<RunManifest> = {}) => manifest({
    provider: { kind: 'hash', model: 'eval-hash-v1', dimensions: 256 },
    qualityEligible: false,
    gitDirty: true,
    ...overrides,
  });
  const hashBaseline = { summary: summary(), manifest: hashManifest({ gitDirty: false }) };

  it('without the option a hash run on a dirty tree is only DESCRIPTIVE_ONLY, however it moved', () => {
    const result = compareRuns(hashBaseline, { summary: summary({ mrr: 0.1 }), manifest: hashManifest() });
    expect(result.verdict).toBe('DESCRIPTIVE_ONLY');
  });

  it('with the option the same run is judged: a drop is REGRESSED, equal is NEUTRAL, a rise is IMPROVED', () => {
    const judge = (overrides: Record<string, number>) => compareRuns(
      hashBaseline,
      { summary: summary(overrides), manifest: hashManifest() },
      { regressionGate: true },
    );
    expect(judge({ mrr: 0.54 }).verdict).toBe('REGRESSED');
    expect(judge({}).verdict).toBe('NEUTRAL');
    expect(judge({ mrr: 0.56 }).verdict).toBe('IMPROVED');
  });

  it('is never a clean ablation or a promotion', () => {
    const result = compareRuns(hashBaseline, { summary: summary(), manifest: hashManifest() }, { regressionGate: true });
    expect(result.regressionGate).toBe(true);
    expect(result.cleanAblation).toBe(false);
  });

  it('still refuses a changed evaluator, a changed provider and different data', () => {
    const candidate = (m: Partial<RunManifest>) => ({ summary: summary(), manifest: hashManifest(m) });
    expect(() => compareRuns(hashBaseline, candidate({ evaluatorSha256: 'edited' }), { regressionGate: true, allowEvaluatorChange: false })).toThrow(/Evaluator changed/);
    expect(() => compareRuns(hashBaseline, candidate({ fixtureSha256: 'edited' }), { regressionGate: true })).toThrow(/different benchmark data/);
    expect(compareRuns(hashBaseline, candidate({ provider: { kind: 'hash', model: 'other', dimensions: 256 } }), { regressionGate: true, allowConfigChange: true }).verdict)
      .toBe('DESCRIPTIVE_ONLY');
  });
});
