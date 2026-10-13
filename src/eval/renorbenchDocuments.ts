import { hitAtK, type RetrievedHit } from './metrics';
import { scoreRetrieval, type EvalCase } from './scoring';
import type { MetricMap, QualityMetric, RunSummary } from './comparison';
import type { ProductResult } from './renorbenchProduct';

/**
 * The documents arm of RenorBench: a vault of handbook-style notes (scripts/eval/generate-renorbench-docs.ts), read through
 * the shipped `search_memory` tool and through `get_context` at 800 tokens, in process, and scored on one thing: whether the
 * probed section of a note (the one with the case's needle) is in the reply an agent receives.
 *
 * Why it exists. RenorBench v1 and v2 have no document in them: v2's notes are chats (a turn is a section, and the turns of a
 * chat share their headings) and short logs, so a change to what the session expansion may add from a DOCUMENT (the budget,
 * the number of notes, the size of a statement, the chunker's cut or its heading rule) moved no gated number. A flat 100-token
 * cap on the expansion's statements removed 186 of the 309 answer-bearing statements it delivered on a vault of documents and
 * passed every gate. This arm is made of documents so that such a change turns the gate red.
 *
 * Nothing here needs a model, a network or a quality claim: the gold is the case's own needle, the embedder is the free hash
 * stand-in (`qualityEligible: false`), and the numbers say what the MECHANISM delivers on this fixture, never how well Renor
 * remembers. They are reported as infrastructure.
 *
 * The categories are the size band of the probed section: `adjacent-le100`, `adjacent-101-200` and `adjacent-201-400` hold
 * the cases that name a neighbour of the section (its title, or the section before it), which the section reaches only when
 * the session expansion adds it; `direct` holds the control, the opening of the section itself, which retrieval finds on its
 * own. The 101-200 band is the cap's cliff: a statement limit below 200 takes every section of it out of reach.
 *
 * Reply sizes are annotated (`documentsPath.replyTokens`), not scored: a tripwire for delivery has no business failing a
 * change that merely costs more or less, and the other arms already hold the reply's size.
 */

export const DOCUMENTS_BENCHMARK = 'renorbench-docs-product';

/** What `get_context` is asked for: its own default budget, the one an agent gets when it does not ask for more. */
export const DOCUMENTS_CONTEXT_MAX_TOKENS = 800;

/** The category of the control: a question that names the probed section's own opening. */
export const DOCUMENTS_DIRECT_CATEGORY = 'direct';

/**
 * What the gate holds the arm to, overall and per category (any one falling fails it). All three only go up. A metric a
 * category has no case for reads null and is not compared there (`directDelivered` of an adjacent band, say). The control
 * is recorded at 1: a direct hit is the statement's own chunk, and no limit on the expansion may take it away.
 */
export const DOCUMENTS_QUALITY_METRICS: QualityMetric[] = [
  { key: 'adjacentDelivered', higherBetter: true },
  { key: 'directDelivered', higherBetter: true },
  { key: 'contextDelivered', higherBetter: true },
];

/** The reply of one tool, as far as the score needs it. */
export interface DocumentsRead {
  hits: RetrievedHit[];
  /** Tokens of the reply text exactly as the agent receives it. */
  replyTokens: number;
}

/** A case's reads: `search_memory` (ProductResult's own hits and size) and `get_context` at DOCUMENTS_CONTEXT_MAX_TOKENS. */
export interface DocumentsResult extends ProductResult {
  context: DocumentsRead;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1))];
}

interface Aggregate {
  cases: number;
  adjacent: number;
  adjacentDelivered: number;
  direct: number;
  directDelivered: number;
  contextDelivered: number;
}

function emptyAggregate(): Aggregate {
  return { cases: 0, adjacent: 0, adjacentDelivered: 0, direct: 0, directDelivered: 0, contextDelivered: 0 };
}

/** The probed section is in the reply: a hit of the case's note that holds the needle. */
function delivered(test: EvalCase, hits: RetrievedHit[]): boolean {
  return hitAtK(hits, test.relevant, hits.length) === 1;
}

function addCase(agg: Aggregate, test: EvalCase, result: DocumentsResult): void {
  agg.cases += 1;
  const found = delivered(test, result.hits);
  if (test.category === DOCUMENTS_DIRECT_CATEGORY) {
    agg.direct += 1;
    if (found) agg.directDelivered += 1;
  } else {
    agg.adjacent += 1;
    if (found) agg.adjacentDelivered += 1;
  }
  if (delivered(test, result.context.hits)) agg.contextDelivered += 1;
}

function summarize(agg: Aggregate): MetricMap {
  return {
    cases: agg.cases,
    adjacentCases: agg.adjacent,
    directCases: agg.direct,
    adjacentDelivered: agg.adjacent ? round(agg.adjacentDelivered / agg.adjacent) : null,
    directDelivered: agg.direct ? round(agg.directDelivered / agg.direct) : null,
    contextDelivered: agg.cases ? round(agg.contextDelivered / agg.cases) : null,
  };
}

function validateResults(cases: EvalCase[], results: DocumentsResult[]): void {
  // The cases, the ids and the hits are validated by the chunk scorer's own rules, so that every arm agrees on what a
  // well-formed run is.
  scoreRetrieval(cases, results.map(result => ({ id: result.id, hits: result.hits, latencyMs: result.latencyMs, contextTokens: result.replyTokens })));
  for (const test of cases) {
    if (test.shouldAbstain || test.relevant.length === 0) throw new Error(`documents case ${test.id} has no gold: every case probes one section`);
  }
  for (const result of results) {
    const context = result.context;
    if (!context || !Array.isArray(context.hits) || typeof context.replyTokens !== 'number') throw new Error(`Missing get_context read for result: ${result.id}`);
    if (typeof result.replyTokens !== 'number') throw new Error(`Missing replyTokens for result: ${result.id}`);
  }
}

export function scoreDocumentsArm(cases: EvalCase[], results: DocumentsResult[]): RunSummary {
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

/** What a reply costs, per tool: recorded in summary.json for the reader, never part of the score. */
export function documentsReplyTokens(results: DocumentsResult[]): Record<string, number | null> {
  const search = results.map(result => result.replyTokens);
  const context = results.map(result => result.context.replyTokens);
  return {
    searchMean: mean(search),
    searchP95: percentile95(search),
    contextMean: mean(context),
    contextP95: percentile95(context),
  };
}
