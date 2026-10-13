import {
  contradictionFirst,
  forbiddenRetrieved,
  hitAtK,
  ndcgAtK,
  recallAllAtK,
  recallAtK,
  reciprocalRank,
  roleOf,
  type GoldTarget,
  type RetrievedHit,
} from './metrics';

export interface EvalCase {
  id: string;
  category: string;
  query: string;
  relevant: GoldTarget[];
  /**
   * Evidence that must ALL be retrieved for the case to count as fully
   * answered (multi-hop / multi-attribute completeness). Defaults to the
   * positive `relevant` targets when omitted.
   */
  requiredEvidence?: GoldTarget[];
  /**
   * Evidence that must NEVER be retrieved (deleted/erasure notes, or content
   * that must not resurface). Any retrieval within top-10 counts as a
   * violation in forbiddenRetrievalRate.
   */
  forbiddenEvidence?: GoldTarget[];
  expectedAnswer?: string | null;
  shouldAbstain?: boolean;
  split: 'dev' | 'test';
  notes?: string;
}

export interface EvalResult {
  id: string;
  hits: (RetrievedHit & { reason?: string })[];
  latencyMs?: number;
  contextTokens?: number;
}

interface Aggregate {
  count: number;
  answerable: number;
  abstention: number;
  hit1: number;
  hit5: number;
  hit10: number;
  recall1: number;
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg5: number;
  ndcg10: number;
  abstentionEmpty: number;
  supersessionSensitive: number;
  contradictionFirst: number;
  recallAll5: number;
  recallAll10: number;
  forbiddenSensitive: number;
  forbiddenRetrievals: number;
  latencyMs: number[];
  contextTokens: number[];
}

function emptyAggregate(): Aggregate {
  return {
    count: 0,
    answerable: 0,
    abstention: 0,
    hit1: 0,
    hit5: 0,
    hit10: 0,
    recall1: 0,
    recall5: 0,
    recall10: 0,
    mrr: 0,
    ndcg5: 0,
    ndcg10: 0,
    abstentionEmpty: 0,
    supersessionSensitive: 0,
    contradictionFirst: 0,
    recallAll5: 0,
    recallAll10: 0,
    forbiddenSensitive: 0,
    forbiddenRetrievals: 0,
    latencyMs: [],
    contextTokens: [],
  };
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function validateCase(test: EvalCase, seenCaseIds: Set<string>): void {
  if (seenCaseIds.has(test.id)) {
    throw new Error(`Duplicate eval case id: ${test.id}`);
  }
  seenCaseIds.add(test.id);

  const seenGold = new Set<string>();
  for (const target of test.relevant) {
    const key = `${normalized(target.match)}\0${normalized(target.notePath ?? '')}`;
    if (seenGold.has(key)) {
      throw new Error(`Duplicate gold target in case ${test.id}: ${target.match}`);
    }
    seenGold.add(key);
  }

  if (!test.shouldAbstain && test.relevant.length > 0) {
    const hasPositive = test.relevant.some(target => roleOf(target) === 'positive');
    if (!hasPositive) {
      throw new Error(
        `Eval case ${test.id} has gold targets but no positive-role target; binary metrics could never credit it.`,
      );
    }
  }
  for (const target of test.requiredEvidence ?? []) {
    if (roleOf(target) === 'forbidden') {
      throw new Error(`Eval case ${test.id} marks required evidence as forbidden.`);
    }
  }
}

function addCase(agg: Aggregate, test: EvalCase, result: EvalResult): void {
  agg.count += 1;
  if (test.forbiddenEvidence && test.forbiddenEvidence.length > 0) {
    agg.forbiddenSensitive += 1;
    if (forbiddenRetrieved(result.hits, test.forbiddenEvidence, 10)) agg.forbiddenRetrievals += 1;
  }
  const abstain = Boolean(test.shouldAbstain) || test.relevant.length === 0;
  if (abstain) {
    agg.abstention += 1;
    if (result.hits.length === 0) agg.abstentionEmpty += 1;
  } else {
    agg.answerable += 1;
    agg.hit1 += hitAtK(result.hits, test.relevant, 1);
    agg.hit5 += hitAtK(result.hits, test.relevant, 5);
    agg.hit10 += hitAtK(result.hits, test.relevant, 10);
    agg.recall1 += recallAtK(result.hits, test.relevant, 1);
    agg.recall5 += recallAtK(result.hits, test.relevant, 5);
    agg.recall10 += recallAtK(result.hits, test.relevant, 10);
    agg.mrr += reciprocalRank(result.hits, test.relevant);
    agg.ndcg5 += ndcgAtK(result.hits, test.relevant, 5);
    agg.ndcg10 += ndcgAtK(result.hits, test.relevant, 10);
    const required = test.requiredEvidence
      ?? test.relevant.filter(target => roleOf(target) === 'positive');
    if (required.length > 0) {
      agg.recallAll5 += recallAllAtK(result.hits, required, 5);
      agg.recallAll10 += recallAllAtK(result.hits, required, 10);
    }
    if (contradictionFirst(result.hits, test.relevant)) agg.contradictionFirst += 1;
    if (
      test.relevant.some(target => roleOf(target) === 'positive')
      && test.relevant.some(target => roleOf(target) === 'forbidden')
    ) {
      agg.supersessionSensitive += 1;
    }
  }
  if (typeof result.latencyMs === 'number') agg.latencyMs.push(result.latencyMs);
  if (typeof result.contextTokens === 'number') agg.contextTokens.push(result.contextTokens);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarize(agg: Aggregate) {
  const a = Math.max(1, agg.answerable);
  const z = Math.max(1, agg.abstention);
  return {
    cases: agg.count,
    answerableCases: agg.answerable,
    abstentionCases: agg.abstention,
    hitAt1: round(agg.hit1 / a),
    hitAt5: round(agg.hit5 / a),
    hitAt10: round(agg.hit10 / a),
    recallAt1: round(agg.recall1 / a),
    recallAt5: round(agg.recall5 / a),
    recallAt10: round(agg.recall10 / a),
    recallAllAt5: round(agg.recallAll5 / a),
    recallAllAt10: round(agg.recallAll10 / a),
    mrr: round(agg.mrr / a),
    ndcgAt5: round(agg.ndcg5 / a),
    ndcgAt10: round(agg.ndcg10 / a),
    abstentionEmptyRate: agg.abstention ? round(agg.abstentionEmpty / z) : null,
    supersessionSensitiveCases: agg.supersessionSensitive,
    contradictionFirstRate: agg.supersessionSensitive
      ? round(agg.contradictionFirst / agg.supersessionSensitive)
      : null,
    forbiddenSensitiveCases: agg.forbiddenSensitive,
    forbiddenRetrievalRate: agg.forbiddenSensitive
      ? round(agg.forbiddenRetrievals / agg.forbiddenSensitive)
      : null,
    meanLatencyMs: mean(agg.latencyMs) === null ? null : round(mean(agg.latencyMs)!),
    p50LatencyMs: percentile(agg.latencyMs, 0.5) === null ? null : round(percentile(agg.latencyMs, 0.5)!),
    p95LatencyMs: percentile(agg.latencyMs, 0.95) === null ? null : round(percentile(agg.latencyMs, 0.95)!),
    meanContextTokens: mean(agg.contextTokens) === null ? null : round(mean(agg.contextTokens)!),
  };
}

export function scoreRetrieval(cases: EvalCase[], results: EvalResult[]) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Empty eval dataset');
  const seenCaseIds = new Set<string>();
  for (const test of cases) validateCase(test, seenCaseIds);

  const seenResultIds = new Set<string>();
  for (const result of results) {
    if (seenResultIds.has(result.id)) {
      throw new Error(`Duplicate result id: ${result.id}`);
    }
    seenResultIds.add(result.id);
    if (!Array.isArray(result.hits)) throw new Error(`Invalid hits for result: ${result.id}`);
    // Measurement validity: a nonfinite or negative timing/context sample must
    // fail the run, not silently skew mean/p95 latency or cost (independent review).
    for (const [key, value] of [['latencyMs', result.latencyMs], ['contextTokens', result.contextTokens]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || (key === 'contextTokens' && !Number.isInteger(value)))) {
        throw new Error(`Invalid ${key} for result: ${result.id}`);
      }
    }
    for (const hit of result.hits) {
      if ((hit.text !== undefined && typeof hit.text !== 'string')
          || (hit.notePath !== undefined && typeof hit.notePath !== 'string')
          || (hit.score !== undefined && !Number.isFinite(hit.score))) {
        throw new Error(`Invalid hit for result: ${result.id}`);
      }
    }
  }

  const byId = new Map(results.map(result => [result.id, result]));
  const overall = emptyAggregate();
  const categories = new Map<string, Aggregate>();

  for (const test of cases) {
    const result = byId.get(test.id);
    if (!result) throw new Error(`Missing result for eval case: ${test.id}`);
    addCase(overall, test, result);
    const category = categories.get(test.category) ?? emptyAggregate();
    addCase(category, test, result);
    categories.set(test.category, category);
  }

  const unknownIds = results.filter(result => !seenCaseIds.has(result.id)).map(result => result.id);
  if (unknownIds.length) {
    throw new Error(`Results contain unknown case ids: ${unknownIds.join(', ')}`);
  }

  return {
    overall: summarize(overall),
    byCategory: Object.fromEntries(
      [...categories.entries()].map(([name, agg]) => [name, summarize(agg)]),
    ),
  };
}