/**
 * Pure comparison policy between two eval runs. Extracted from the CLI
 * wrapper so the promotion logic itself lives in the frozen evaluator
 * trust domain (its hash is recorded in run manifests) and is unit tested.
 */

export type MetricMap = Record<string, number | null | undefined>;

export interface RunSummary {
  overall: MetricMap;
  byCategory?: Record<string, MetricMap>;
}

export interface RunManifest {
  benchmark?: string;
  casesSha256?: string;
  fixtureSha256?: string;
  topK?: number;
  provider?: {
    kind?: string;
    model?: string;
    dimensions?: number;
  };
  qualityEligible?: boolean;
  evaluatorSha256?: string;
  chunking?: { maxTokens?: number; overlapTokens?: number };
  gitDirty?: boolean;
}

export interface CompareOptions {
  /** Allow provider/topK/chunking changes; verdict becomes DESCRIPTIVE_ONLY. */
  allowConfigChange?: boolean;
  /** Allow evaluator-hash mismatch; verdict becomes DESCRIPTIVE_ONLY. */
  allowEvaluatorChange?: boolean;
  /** Allow dirty working trees; verdict becomes DESCRIPTIVE_ONLY. */
  allowDirtyTree?: boolean;
  /**
   * No-regression check of a deterministic stand-in run (the hash embedder) against a committed
   * baseline, as the agent gate does. A dirty tree and a non-quality provider no longer force
   * DESCRIPTIVE_ONLY, because the gate runs on uncommitted work and the stand-in is never
   * quality-eligible. Benchmark, cases, fixture, topK, provider, chunking and evaluator must still
   * match exactly, and the result is never a clean ablation or a promotion.
   */
  regressionGate?: boolean;
  /** Maximum tolerated absolute regression for primary quality metrics (0..1). */
  maxQualityRegression?: number;
  /**
   * The quality metrics this comparison judges, each with its direction. Default `QUALITY_METRICS`, the retrieval
   * metrics of the chunk arm; the RenorBench product arm judges its own list (`PRODUCT_QUALITY_METRICS`).
   */
  metrics?: QualityMetric[];
  /**
   * Minimum relative improvement on an efficiency metric (p95 latency or mean
   * context tokens) for it to count as a material efficiency gain.
   * Default 0.05 (5%). Sub-threshold deltas are noise, not IMPROVED.
   */
  minEfficiencyGain?: number;
}

export type Verdict = 'IMPROVED' | 'NEUTRAL' | 'REGRESSED' | 'DESCRIPTIVE_ONLY';

export interface QualityMetric {
  key: string;
  higherBetter: boolean;
}

export const QUALITY_METRICS: QualityMetric[] = [
  { key: 'hitAt1', higherBetter: true },
  { key: 'hitAt5', higherBetter: true },
  { key: 'recallAt5', higherBetter: true },
  { key: 'recallAllAt10', higherBetter: true },
  { key: 'mrr', higherBetter: true },
  { key: 'ndcgAt5', higherBetter: true },
  { key: 'contradictionFirstRate', higherBetter: false },
  { key: 'forbiddenRetrievalRate', higherBetter: false },
  { key: 'abstentionEmptyRate', higherBetter: true },
];

const EFFICIENCY_METRICS = ['meanLatencyMs', 'p50LatencyMs', 'p95LatencyMs', 'meanContextTokens'] as const;
const MATERIAL_EFFICIENCY_METRICS = ['p95LatencyMs', 'meanContextTokens'] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function num(map: MetricMap, key: string): number | null {
  const value = map[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function delta(candidate: number | null, baseline: number | null): number | null {
  return candidate === null || baseline === null ? null : Math.round((candidate - baseline) * 10000) / 10000;
}

/** Relative improvement of candidate over baseline; null when not computable. */
function relativeGain(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null || baseline <= 0) return null;
  return (baseline - candidate) / baseline;
}

export interface CompareRunResult {
  verdict: Verdict;
  cleanAblation: boolean;
  regressionGate: boolean;
  invariantChecks: Record<string, boolean>;
  tolerance: number;
  minEfficiencyGain: number;
  quality: Record<string, { baseline: number | null; candidate: number | null; delta: number | null }>;
  efficiency: Record<string, { baseline: number | null; candidate: number | null; delta: number | null }>;
  categoryRegressions: string[];
  reasons: string[];
  note: string;
}

export function compareRuns(
  baseline: { summary: RunSummary; manifest: RunManifest },
  candidate: { summary: RunSummary; manifest: RunManifest },
  options: CompareOptions = {},
): CompareRunResult {
  const tolerance = options.maxQualityRegression ?? 0;
  const metricList = options.metrics ?? QUALITY_METRICS;
  const minEfficiencyGain = options.minEfficiencyGain ?? 0.05;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
    throw new Error('maxQualityRegression must be between 0 and 1');
  }
  if (!Number.isFinite(minEfficiencyGain) || minEfficiencyGain < 0 || minEfficiencyGain > 1) {
    throw new Error('minEfficiencyGain must be between 0 and 1');
  }

  const invariantChecks = {
    benchmark: same(baseline.manifest.benchmark, candidate.manifest.benchmark),
    cases: same(baseline.manifest.casesSha256, candidate.manifest.casesSha256),
    fixture: same(baseline.manifest.fixtureSha256, candidate.manifest.fixtureSha256),
    topK: same(baseline.manifest.topK, candidate.manifest.topK),
    provider: same(baseline.manifest.provider, candidate.manifest.provider),
    chunking: same(baseline.manifest.chunking, candidate.manifest.chunking),
    evaluator: same(baseline.manifest.evaluatorSha256, candidate.manifest.evaluatorSha256),
    cleanTree: baseline.manifest.gitDirty === false && candidate.manifest.gitDirty === false,
    qualityEligible: baseline.manifest.qualityEligible === true && candidate.manifest.qualityEligible === true,
  };

  const reasons: string[] = [];
  const datasetCompatible = invariantChecks.benchmark && invariantChecks.cases && invariantChecks.fixture;
  if (!datasetCompatible) {
    throw new Error(`Cannot compare runs from different benchmark data: ${JSON.stringify(invariantChecks)}`);
  }

  if (!invariantChecks.evaluator) {
    if (!options.allowEvaluatorChange) {
      throw new Error(
        'Evaluator changed between baseline and candidate (evaluatorSha256 mismatch). ' +
        'The candidate cannot grade its own exam: re-run the candidate against the frozen evaluator, ' +
        'or pass --allow-evaluator-change to accept a DESCRIPTIVE_ONLY comparison during evaluator development.',
      );
    }
    reasons.push('Evaluator code changed between runs; measurement meaning differs.');
  }

  if (!invariantChecks.cleanTree) {
    if (!options.allowDirtyTree) {
      reasons.push('Working tree was dirty in at least one run; executed code does not match the recorded git SHA.');
    } else {
      reasons.push('Dirty working tree tolerated (--allow-dirty-tree).');
    }
  }

  if (!invariantChecks.qualityEligible) {
    reasons.push('At least one run used a non-quality provider (e.g. hash embeddings); infrastructure evidence only.');
  }

  const configCompatible = invariantChecks.topK && invariantChecks.provider && invariantChecks.chunking;
  if (!configCompatible) {
    reasons.push('Provider, topK, or chunking changed between runs.');
  }

  const regressionGate = options.regressionGate === true;
  const experimentCompatible = Boolean(
    invariantChecks.evaluator
    && (regressionGate || (invariantChecks.cleanTree && invariantChecks.qualityEligible))
    && (configCompatible || (!regressionGate && options.allowConfigChange)),
  );

  const quality = Object.fromEntries(metricList.map(metric => {
    const baselineValue = num(baseline.summary.overall, metric.key);
    const candidateValue = num(candidate.summary.overall, metric.key);
    return [metric.key, { baseline: baselineValue, candidate: candidateValue, delta: delta(candidateValue, baselineValue) }];
  }));

  const efficiency = Object.fromEntries(EFFICIENCY_METRICS.map(key => {
    const baselineValue = num(baseline.summary.overall, key);
    const candidateValue = num(candidate.summary.overall, key);
    return [key, { baseline: baselineValue, candidate: candidateValue, delta: delta(candidateValue, baselineValue) }];
  }));

  let verdict: Verdict;
  if (!experimentCompatible) {
    verdict = 'DESCRIPTIVE_ONLY';
  } else {
    const hasRegression = metricList.some(metric => {
      const { delta: d } = quality[metric.key];
      if (typeof d !== 'number') return false;
      return metric.higherBetter ? d < -tolerance : d > tolerance;
    });
    const hasQualityGain = metricList.some(metric => {
      const { delta: d } = quality[metric.key];
      if (typeof d !== 'number') return false;
      return metric.higherBetter ? d > tolerance : d < -tolerance;
    });
    const hasMaterialEfficiencyGain = MATERIAL_EFFICIENCY_METRICS.some(key => {
      const gain = relativeGain(efficiency[key].baseline, efficiency[key].candidate);
      return gain !== null && gain >= minEfficiencyGain;
    });

    if (hasRegression) verdict = 'REGRESSED';
    else if (hasQualityGain || hasMaterialEfficiencyGain) verdict = 'IMPROVED';
    else verdict = 'NEUTRAL';
  }

  // Category-collapse guard: an aggregate improvement must not hide one
  // category regressing beyond tolerance (independent-review finding).
  const categoryRegressions: string[] = [];
  const baselineCategories = baseline.summary.byCategory ?? {};
  const candidateCategories = candidate.summary.byCategory ?? {};
  // Both sides' categories: a category the baseline has and the candidate lost is a regression too.
  for (const name of new Set([...Object.keys(baselineCategories), ...Object.keys(candidateCategories)])) {
    const baselineMetrics = baselineCategories[name];
    const metrics = candidateCategories[name];
    if (!baselineMetrics) continue; // new category: nothing to regress against
    if (!metrics) {
      categoryRegressions.push(`${name}.missing`);
      continue;
    }
    for (const metric of metricList) {
      const b = num(baselineMetrics, metric.key);
      const c = num(metrics, metric.key);
      if (b === null || c === null) continue;
      const d = delta(c, b);
      if (typeof d === 'number' && (metric.higherBetter ? d < -tolerance : d > tolerance)) {
        categoryRegressions.push(`${name}.${metric.key}`);
      }
    }
  }
  for (const name of categoryRegressions) {
    reasons.push(`Category regression beyond tolerance: ${name}`);
  }
  if (categoryRegressions.length > 0) {
    // A category regression beyond tolerance is a rejection regardless of the
    // aggregate verdict: an overall gain must not hide a collapsing category.
    verdict = 'REGRESSED';
  }

  const note = regressionGate
    ? 'Regression gate against a committed baseline: this is a no-regression check, never a clean ablation or a promotion.'
    : experimentCompatible
    ? 'IMPROVED requires no quality regression beyond tolerance and a quality gain or a material (>= threshold) efficiency gain.'
    : 'Not a clean ablation: this comparison is descriptive only and cannot support promotion.';

  return {
    verdict,
    cleanAblation: experimentCompatible && !regressionGate,
    regressionGate,
    invariantChecks,
    tolerance,
    minEfficiencyGain,
    quality,
    efficiency,
    categoryRegressions,
    reasons,
    note,
  };
}