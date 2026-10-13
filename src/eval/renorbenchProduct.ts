import {
  contradictionFirst,
  forbiddenRetrieved,
  hitAtK,
  recallAllAtK,
  recallAtK,
  roleOf,
  type RetrievedHit,
} from './metrics';
import { scoreRetrieval, type EvalCase } from './scoring';
import type { QualityMetric, RunSummary } from './comparison';
import { DOCUMENTS_BENCHMARK } from './renorbenchDocuments';

/**
 * The product arm of RenorBench: the same questions as the chunk arm, answered through the shipped `search_memory`
 * tool, scored on the reply an agent actually receives. Nothing here needs a model: the gold is the case's own notes,
 * the verdict is the reply's own `relevance` object, and the cost is the reply's own token count.
 *
 * What it measures that the chunk arm cannot (the chunk arm scores `retrieveContext` hits at top-K 10 and never sees
 * the tool): the reply as a whole (the window, the session-expansion statements and the facts the tool adds, at the
 * tool's own top_k), the order the tool presents it in, the `relevance` verdict, and what the reply costs in tokens.
 *
 * Rank-based scores (hit@1, MRR, nDCG) are deliberately absent: the tool's default order is newest first, and it tells
 * the agent to judge a hit by its score, never its position, so a rank score would measure dates. The delivery scores
 * count what is in the reply. Order matters only where it can mislead: `contradictionFirstRate`.
 */

export const PRODUCT_BENCHMARK = 'renorbench-v1-product';
export const PRODUCT_V2_BENCHMARK = 'renorbench-v2-product';

/**
 * What the product arm can run: the questions, the vault they are asked of, and the benchmark id that its runs and its
 * baseline carry. v1 is the original (191 questions of a 30-note vault) and stays as it was, so its scores stay comparable
 * with every run recorded before v2 existed. v2 (scripts/eval/generate-renorbench-v2.ts) is a larger vault of chats and
 * logs with questions that need session expansion, the newest-value rules and the verdict, which v1 is too small to show.
 */
export const PRODUCT_SUITES = {
  v1: { benchmark: PRODUCT_BENCHMARK, cases: 'docs/evals/renorbench-v1.dev.jsonl', fixture: 'fixtures/eval/renorbench-v1' },
  v2: { benchmark: PRODUCT_V2_BENCHMARK, cases: 'docs/evals/renorbench-v2.dev.jsonl', fixture: 'fixtures/eval/renorbench-v2' },
  // Forty handbook-style notes (scripts/eval/generate-renorbench-docs.ts), read by search_memory and by get_context at 800
  // tokens, and scored by delivery alone (src/eval/renorbenchDocuments.ts): what the other suites cannot see of a document.
  documents: { benchmark: DOCUMENTS_BENCHMARK, cases: 'docs/evals/renorbench-docs.dev.jsonl', fixture: 'fixtures/eval/renorbench-docs' },
} as const;
export type ProductSuiteName = keyof typeof PRODUCT_SUITES;

/**
 * The verdict's bar for the hash embedder. The product judges "does anything on file match?" by the cosine of the best
 * hit against a bar calibrated per embedding model (CALIBRATED_BARS), and the hash stand-in has no calibration, so it
 * gets no verdict at all unless a bar is set (RENOR_CONTEXT_RELEVANCE_MIN, the product's own setting for a model with
 * no calibrated bar). This is that setting for the stand-in. It is a constant of this harness, not a property of any
 * model: the midpoint of the median best-hit cosine of the answerable cases (0.407) and of the abstention cases
 * (0.3425) on this fixture, rounded, so that both kinds of case sit at a mixed operating point where a change to the
 * verdict can move them. Lexical vectors cannot separate the two kinds of case (at best about two thirds are judged
 * right), so under this bar the verdict scores say that the verdict still works, never how well a real model judges:
 * a real embedder runs on its calibrated bar and never on this one.
 */
export const HASH_RELEVANCE_BAR = 0.375;

/** The reply's `relevance` object, as far as the score needs it. */
export interface ProductVerdict {
  relevant: boolean;
  similarity: number | null;
  bar: number;
}

export interface ProductResult {
  id: string;
  /** The hits the reply carried, in the order the product presents them (matches first, then session-expansion statements). */
  hits: (RetrievedHit & { reason?: string })[];
  /** The reply's `relevance`; null when the reply carried none. */
  verdict: ProductVerdict | null;
  /** Tokens of the reply text exactly as the agent receives it, counted the way the engine counts a reply (o200k). */
  replyTokens: number;
  latencyMs?: number;
}

/**
 * What the gate holds the product arm to, overall and per category (any one falling fails it). Delivery and the
 * verdict only ever go up, erasure and a stale value read first only ever go down, and so does what a reply costs:
 * cost is part of quality, so a reply that grows is a regression the PR must defend, not a number that drifts.
 */
export const PRODUCT_QUALITY_METRICS: QualityMetric[] = [
  { key: 'replyRecall', higherBetter: true },
  { key: 'replyRecallAll', higherBetter: true },
  { key: 'contradictionFirstRate', higherBetter: false },
  { key: 'forbiddenInReplyRate', higherBetter: false },
  { key: 'verdictRelevantRate', higherBetter: true },
  { key: 'verdictAbstainRate', higherBetter: true },
  { key: 'meanReplyTokens', higherBetter: false },
];

/**
 * What the gate holds the v2 suite to: the same, but for `forbiddenInReplyRate`. v2 has no erasure case, so that rate has
 * nothing to count (it reads null), and a null is not a number a floor can be held to.
 */
export const PRODUCT_V2_QUALITY_METRICS: QualityMetric[] = PRODUCT_QUALITY_METRICS.filter(metric => metric.key !== 'forbiddenInReplyRate');

interface Aggregate {
  count: number;
  answerable: number;
  abstention: number;
  hit: number;
  recall: number;
  recallAll: number;
  supersessionSensitive: number;
  contradictionFirst: number;
  forbiddenSensitive: number;
  forbiddenInReply: number;
  verdictRelevant: number;
  verdictAbstain: number;
  verdictMissing: number;
  latencyMs: number[];
  replyTokens: number[];
}

function emptyAggregate(): Aggregate {
  return {
    count: 0, answerable: 0, abstention: 0, hit: 0, recall: 0, recallAll: 0,
    supersessionSensitive: 0, contradictionFirst: 0, forbiddenSensitive: 0, forbiddenInReply: 0,
    verdictRelevant: 0, verdictAbstain: 0, verdictMissing: 0, latencyMs: [], replyTokens: [],
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))];
}

function rounded(value: number | null): number | null {
  return value === null ? null : round(value);
}

function addCase(agg: Aggregate, test: EvalCase, result: ProductResult): void {
  agg.count += 1;
  // The whole reply is read, so "in the reply" is every hit it carries.
  const reply = result.hits.length;
  if (test.forbiddenEvidence && test.forbiddenEvidence.length > 0) {
    agg.forbiddenSensitive += 1;
    if (forbiddenRetrieved(result.hits, test.forbiddenEvidence, reply)) agg.forbiddenInReply += 1;
  }
  // A reply with no verdict is a wrong verdict for either kind of case: the product could not say, and the agent
  // cannot tell "the answer is on file" from "cannot judge" (see contextRelevance.ts).
  if (result.verdict === null) agg.verdictMissing += 1;
  if (Boolean(test.shouldAbstain) || test.relevant.length === 0) {
    agg.abstention += 1;
    if (result.verdict?.relevant === false) agg.verdictAbstain += 1;
  } else {
    agg.answerable += 1;
    if (result.verdict?.relevant === true) agg.verdictRelevant += 1;
    agg.hit += hitAtK(result.hits, test.relevant, reply);
    agg.recall += recallAtK(result.hits, test.relevant, reply);
    const required = test.requiredEvidence ?? test.relevant.filter(target => roleOf(target) === 'positive');
    if (required.length > 0) agg.recallAll += recallAllAtK(result.hits, required, reply);
    if (test.relevant.some(target => roleOf(target) === 'positive') && test.relevant.some(target => roleOf(target) === 'forbidden')) {
      agg.supersessionSensitive += 1;
      if (contradictionFirst(result.hits, test.relevant)) agg.contradictionFirst += 1;
    }
  }
  if (typeof result.latencyMs === 'number') agg.latencyMs.push(result.latencyMs);
  agg.replyTokens.push(result.replyTokens);
}

function summarize(agg: Aggregate) {
  const a = Math.max(1, agg.answerable);
  const z = Math.max(1, agg.abstention);
  return {
    cases: agg.count,
    answerableCases: agg.answerable,
    abstentionCases: agg.abstention,
    replyHit: round(agg.hit / a),
    replyRecall: round(agg.recall / a),
    replyRecallAll: round(agg.recallAll / a),
    contradictionFirstRate: agg.supersessionSensitive ? round(agg.contradictionFirst / agg.supersessionSensitive) : null,
    supersessionSensitiveCases: agg.supersessionSensitive,
    forbiddenInReplyRate: agg.forbiddenSensitive ? round(agg.forbiddenInReply / agg.forbiddenSensitive) : null,
    forbiddenSensitiveCases: agg.forbiddenSensitive,
    verdictRelevantRate: agg.answerable ? round(agg.verdictRelevant / a) : null,
    verdictAbstainRate: agg.abstention ? round(agg.verdictAbstain / z) : null,
    verdictMissingCases: agg.verdictMissing,
    meanReplyTokens: rounded(mean(agg.replyTokens)),
    p95ReplyTokens: rounded(percentile(agg.replyTokens, 0.95)),
    meanLatencyMs: rounded(mean(agg.latencyMs)),
    p50LatencyMs: rounded(percentile(agg.latencyMs, 0.5)),
    p95LatencyMs: rounded(percentile(agg.latencyMs, 0.95)),
  };
}

function validateResults(cases: EvalCase[], results: ProductResult[]): void {
  // The cases, the ids, the hits and the token and time samples are validated by the chunk scorer's own rules, so the
  // two arms can never disagree about what a well-formed run is (a run that fails there fails here).
  scoreRetrieval(cases, results.map(result => ({ id: result.id, hits: result.hits, latencyMs: result.latencyMs, contextTokens: result.replyTokens })));
  for (const result of results) {
    if (typeof result.replyTokens !== 'number') throw new Error(`Missing replyTokens for result: ${result.id}`);
    const verdict = result.verdict;
    if (verdict === null) continue;
    if (!verdict || typeof verdict.relevant !== 'boolean' || !Number.isFinite(verdict.bar)
        || (verdict.similarity !== null && !Number.isFinite(verdict.similarity))) {
      throw new Error(`Invalid verdict for result: ${result.id}`);
    }
  }
}

export function scoreProductArm(cases: EvalCase[], results: ProductResult[]): RunSummary {
  validateResults(cases, results);
  const byId = new Map(results.map(result => [result.id, result]));
  const overall = emptyAggregate();
  const categories = new Map<string, Aggregate>();
  for (const test of cases) {
    const result = byId.get(test.id)!; // validateResults has already refused a missing id
    addCase(overall, test, result);
    const category = categories.get(test.category) ?? emptyAggregate();
    addCase(category, test, result);
    categories.set(test.category, category);
  }
  return {
    overall: summarize(overall),
    byCategory: Object.fromEntries([...categories.entries()].map(([name, agg]) => [name, summarize(agg)])),
  };
}
