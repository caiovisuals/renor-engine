import fs from 'node:fs';
import path from 'node:path';
import type { EvalCacheStats } from './evalCache';

/**
 * Per-run cache report: how much of a run was served from the content-addressed
 * caches instead of a provider. Pure formatting over counters the caches already
 * keep; it never touches a cache or a provider.
 */

export interface HitMiss { hits: number; misses: number }
export interface HitMissRate extends HitMiss { hitRate: number | null }

export interface CacheReport {
  /** Embedding cache lookups: one hit or miss per input occurrence, so the hit rate is a lookup rate. */
  embedding?: HitMissRate;
  /** What actually reached the embedding provider. Unlike lookup misses, a text repeated within a batch is sent once. */
  embeddingSent?: { texts: number; calls: number };
  /** True when the sent counters were unavailable (an embed-proxy that predates them), so the embedding calls are the lookup misses: an upper bound. */
  embeddingCallsUpperBound?: true;
  evidence?: HitMissRate;
  answer?: HitMissRate;
  judge?: HitMissRate;
  /** Of the judge lookups, the memo's (src/eval/evalCache.ts computeJudgeMemoKey): verdicts replayed across routing sessions. Already counted in `judge`. */
  judgeMemo?: HitMissRate;
  /** Index snapshots (src/eval/indexSnapshots.ts): memory stores restored instead of built, and the `cli index` time that saved (the build's own wall time). */
  indexSnapshots?: { restored: number; built: number; coldBusy: number; savedIndexMs: number };
  /** Calls made with no cache in front of them (cache off): live by definition, so they have no hit rate. */
  uncached?: { embedding?: number; model?: number };
  /**
   * Provider calls the run actually made, cached or not: embedding calls (batches and queries) plus
   * evidence/answer/judge calls. Retries inside one call are not counted.
   */
  liveProviderCalls: number;
  /** Pre-flight health probes: real provider calls, never cached, made whenever a run has pending work. */
  healthProbeCalls: number;
  /** Why an identical later run would still miss a layer used here; empty when every layer can replay. */
  repeatRunBlockers: string[];
}

export function cacheHitRate(counts: HitMiss): number | null {
  const lookups = counts.hits + counts.misses;
  return lookups === 0 ? null : counts.hits / lookups;
}

const rate = (counts: HitMiss): HitMissRate => ({ hits: counts.hits, misses: counts.misses, hitRate: cacheHitRate(counts) });

export const UNPINNED_SCOPE_BLOCKER = "answer/judge keys are scoped to this process's routing session; pin RENOR_QA_CACHE_SCOPE (and share --cache-dir) to replay across runs";
export const UNCACHED_EMBEDDING_BLOCKER = 'embedding calls ran with the cache off (RENOR_EVAL_EMBED_CACHE=off): turn it on to replay them';
export const UNCACHED_MODEL_BLOCKER = 'answer/judge calls ran with the eval cache off (--no-cache or RENOR_EVAL_CACHE=off): turn it on to replay them';
export const PER_RUN_EVIDENCE_BLOCKER = "the evidence cache lives in this run's output directory; set RENOR_EVIDENCE_CACHE to a shared path to replay across runs";

export function buildCacheReport(input: {
  /**
   * Embedding lookups, and what actually reached the provider. `cached: false` (a counting wrapper, no cache)
   * means every lookup was a live call. Without `sent` the calls are the lookup misses, an upper bound.
   */
  embedding?: HitMiss & { cached?: boolean; sent?: { texts: number; calls: number } };
  evidence?: HitMiss;
  /** True when RENOR_EVIDENCE_CACHE names a path that outlives this run's output directory. */
  evidenceCacheShared?: boolean;
  evalCache?: Pick<EvalCacheStats, 'answerHits' | 'answerMisses' | 'judgeHits' | 'judgeMisses'> & Partial<Pick<EvalCacheStats, 'judgeMemoHits' | 'judgeMemoMisses'>>;
  indexSnapshots?: { restored: number; built: number; coldBusy: number; savedIndexMs: number };
  /** Live answer+judge calls the runner counted itself. Authoritative: a forced-live retry makes a call with no lookup, and with the cache off there is no lookup to count. */
  liveModelCalls?: number;
  /** True when RENOR_QA_CACHE_SCOPE pins the answer/judge scope, so keys survive this process. */
  pinnedScope?: boolean;
  healthProbes?: number;
}): CacheReport {
  const report: CacheReport = { liveProviderCalls: 0, healthProbeCalls: input.healthProbes ?? 0, repeatRunBlockers: [] };
  const uncached: NonNullable<CacheReport['uncached']> = {};
  if (input.embedding) {
    const { sent } = input.embedding;
    const calls = sent ? sent.calls : input.embedding.misses;
    report.liveProviderCalls += calls;
    if (sent) report.embeddingSent = { texts: sent.texts, calls: sent.calls };
    if (input.embedding.cached === false) {
      if (calls > 0) {
        uncached.embedding = calls;
        report.repeatRunBlockers.push(UNCACHED_EMBEDDING_BLOCKER);
      }
    } else {
      report.embedding = rate(input.embedding);
      if (!sent) report.embeddingCallsUpperBound = true;
    }
  }
  if (input.evidence) {
    report.evidence = rate(input.evidence);
    report.liveProviderCalls += input.evidence.misses;
    if (!input.evidenceCacheShared && input.evidence.hits + input.evidence.misses > 0) report.repeatRunBlockers.push(PER_RUN_EVIDENCE_BLOCKER);
  }
  if (input.evalCache) {
    const { answerHits, answerMisses, judgeHits, judgeMisses } = input.evalCache;
    report.answer = rate({ hits: answerHits, misses: answerMisses });
    report.judge = rate({ hits: judgeHits, misses: judgeMisses });
    if ((input.evalCache.judgeMemoHits ?? 0) + (input.evalCache.judgeMemoMisses ?? 0) > 0) {
      report.judgeMemo = rate({ hits: input.evalCache.judgeMemoHits ?? 0, misses: input.evalCache.judgeMemoMisses ?? 0 });
    }
    if (!input.pinnedScope && answerHits + answerMisses + judgeHits + judgeMisses > 0) report.repeatRunBlockers.push(UNPINNED_SCOPE_BLOCKER);
  }
  if (input.indexSnapshots) report.indexSnapshots = input.indexSnapshots;
  const modelCalls = input.liveModelCalls ?? (input.evalCache ? input.evalCache.answerMisses + input.evalCache.judgeMisses : 0);
  report.liveProviderCalls += modelCalls;
  if (!input.evalCache && modelCalls > 0) {
    uncached.model = modelCalls;
    report.repeatRunBlockers.push(UNCACHED_MODEL_BLOCKER);
  }
  if (Object.keys(uncached).length > 0) report.uncached = uncached;
  return report;
}

const part = (label: string, r: HitMissRate | undefined): string | null =>
  r ? `${label} ${r.hits}/${r.hits + r.misses} (${r.hitRate === null ? 'n/a' : `${(r.hitRate * 100).toFixed(1)}%`})` : null;

export function formatCacheReport(report: CacheReport): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const sent = report.embeddingSent
    ? `, ${count(report.embeddingSent.texts, 'text')} in ${count(report.embeddingSent.calls, 'call')}`
    : report.embeddingCallsUpperBound ? ', calls counted as lookup misses (upper bound)' : '';
  const layers = [
    report.embedding ? `${part('embedding', report.embedding)}${sent}` : null,
    report.uncached?.embedding ? `embedding uncached${sent}` : null,
    part('evidence', report.evidence),
    part('answer', report.answer),
    part('judge', report.judge),
    part('judge memo', report.judgeMemo),
    report.indexSnapshots ? `index snapshots restored ${report.indexSnapshots.restored}/${report.indexSnapshots.restored + report.indexSnapshots.built + report.indexSnapshots.coldBusy} (${(report.indexSnapshots.savedIndexMs / 1000).toFixed(0)} s of index time not spent)` : null,
    report.uncached?.model ? `answer/judge uncached ${report.uncached.model}` : null,
  ].filter(Boolean);
  const probes = report.healthProbeCalls > 0 ? ` (+${report.healthProbeCalls} health probes, never cached)` : '';
  const lines = [`[cache] ${layers.length > 0 ? layers.join(' | ') : 'no caches in use'} | live provider calls ${report.liveProviderCalls}${probes}`];
  for (const blocker of report.repeatRunBlockers) lines.push(`[cache] a repeat run will miss: ${blocker}`);
  return lines.join('\n');
}

/** Print the report to stderr and, given an output dir, keep it beside the run as cache-report.json. */
export function emitCacheReport(report: CacheReport, outputDir?: string): void {
  process.stderr.write(`${formatCacheReport(report)}\n`);
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'cache-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

export interface ProxyCounters {
  startedAt?: string;
  cacheHits: number;
  cacheMisses: number;
  /** Texts and calls that reached the proxy's upstream; absent from a proxy that predates them. */
  upstreamTexts?: number;
  upstreamCalls?: number;
}

/** Counters from an embed-proxy stats file, or null when it is absent or unreadable. */
export function readProxyCounters(statsPath: string | undefined): ProxyCounters | null {
  if (!statsPath || !fs.existsSync(statsPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as Partial<ProxyCounters>;
    if (typeof raw.cacheHits !== 'number' || typeof raw.cacheMisses !== 'number') return null;
    const counters: ProxyCounters = { startedAt: raw.startedAt, cacheHits: raw.cacheHits, cacheMisses: raw.cacheMisses };
    if (typeof raw.upstreamTexts === 'number' && typeof raw.upstreamCalls === 'number') {
      counters.upstreamTexts = raw.upstreamTexts;
      counters.upstreamCalls = raw.upstreamCalls;
    }
    return counters;
  } catch {
    return null;
  }
}

/**
 * The embed-proxy is a long-lived service shared by every run (and shard), and
 * its stats file holds lifetime counters, so one run's embedding lookups (and what
 * the proxy sent upstream for them) are the change in those counters between its
 * start and its end. That window also counts any other client of the same proxy.
 * Unknown (undefined) when the proxy restarted in between, because its counters
 * were reset.
 */
export function proxyWindow(before: ProxyCounters | null, after: ProxyCounters | null): (HitMiss & { sent?: { texts: number; calls: number } }) | undefined {
  if (!after) return undefined;
  if (before && before.startedAt !== after.startedAt) return undefined;
  const window: HitMiss & { sent?: { texts: number; calls: number } } = {
    hits: after.cacheHits - (before?.cacheHits ?? 0),
    misses: after.cacheMisses - (before?.cacheMisses ?? 0),
  };
  // The sent figures are known only when the proxy counted them on both ends of the window; otherwise unknown, never zero.
  if (after.upstreamTexts !== undefined && after.upstreamCalls !== undefined) {
    if (!before) window.sent = { texts: after.upstreamTexts, calls: after.upstreamCalls };
    else if (before.upstreamTexts !== undefined && before.upstreamCalls !== undefined) {
      window.sent = { texts: after.upstreamTexts - before.upstreamTexts, calls: after.upstreamCalls - before.upstreamCalls };
    }
  }
  return window;
}
