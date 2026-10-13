import fs from 'node:fs';
import { Command } from 'commander';

/**
 * Progress engine — comparable-pair deltas from the results registry.
 *
 * Only runs sharing benchmark + metricProtocol + datasetSha256 + provider
 * identity + topK form a "comparable series". Within a series, consecutive
 * quality-eligible, homogeneous, complete runs produce the headline deltas
 * ("hit@1 0.84 -> 0.92, +9.5%"). Diagnostic/mixed runs are listed but never
 * become progress claims. The output JSON is the source for every public
 * "now X% better" statement.
 */

interface RegistryEntry {
  id: string;
  registeredAt: string;
  runFinishedAt: string | null;
  benchmark: string;
  metricProtocol: string | null;
  gitShas: string[];
  mixedSha?: boolean;
  homogeneousGitSha?: boolean;
  datasetSha256: string | null;
  provider: { kind?: string; model?: string; dimensions?: number; location?: string };
  topK: number | null;
  chunking: unknown;
  cases: number | null;
  scoredCases: number | null;
  completeDataset: boolean | null;
  qualityEligible: boolean;
  diagnostic: boolean;
  metrics: { chunk?: Record<string, number | null>; session?: Record<string, number | null> };
  byCategory: Record<string, Record<string, number | null>> | null;
  cost: { inputTokens: number | null; cache?: { hits: number; misses: number } | null };
  artifactPath: string;
  notes: string | null;
}

const HIGHER_BETTER = new Set([
  'hitAt1', 'hitAt5', 'hitAt10', 'recallAt5', 'recallAt10', 'recallAllAt5', 'recallAllAt10',
  'recallAnyAt5', 'recallAnyAt10', 'mrr', 'ndcgAt5', 'ndcgAt10',
]);
const HEADLINE = ['hitAt1', 'hitAt5', 'hitAt10', 'recallAllAt10', 'mrr', 'ndcgAt5'];

const program = new Command()
  .name('progress')
  .description('Compute comparable-pair progress deltas from the benchmark registry')
  .option('--registry <path>', 'results registry', 'docs/evals/results/registry.jsonl')
  .parse(process.argv);

const opts = program.opts<{ registry: string }>();
const entries: RegistryEntry[] = fs.existsSync(opts.registry)
  ? fs.readFileSync(opts.registry, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
  : [];

const comparableKey = (e: RegistryEntry) =>
  JSON.stringify([e.benchmark, e.metricProtocol, e.datasetSha256, e.provider, e.topK]);
const series = new Map<string, RegistryEntry[]>();
for (const e of entries) {
  if (!e.qualityEligible || e.diagnostic || e.mixedSha) continue;
  const key = comparableKey(e);
  series.set(key, [...(series.get(key) ?? []), e]);
}

function pct(from: number, to: number, higherBetter: boolean): number {
  if (from === 0) return to === 0 ? 0 : (higherBetter ? 1 : -1) * 100;
  const raw = (to - from) / from;
  return Math.round(raw * 1000) / 10;
}

const progressSeries = [...series.values()].map(group => {
  const ordered = [...group].sort((a, b) =>
    String(a.runFinishedAt ?? a.registeredAt).localeCompare(String(b.runFinishedAt ?? b.registeredAt)));
  const pairs: Array<Record<string, unknown>> = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    for (const family of ['chunk', 'session'] as const) {
      const p = prev.metrics[family];
      const c = curr.metrics[family];
      if (!p || !c) continue;
      const deltas = Object.fromEntries(HEADLINE.filter(k => p[k] !== undefined && c[k] !== undefined)
        .map(k => [k, {
          previous: p[k], current: c[k],
          delta: Math.round(((c[k] as number) - (p[k] as number)) * 10000) / 10000,
          percent: pct(p[k] as number, c[k] as number, HIGHER_BETTER.has(k)),
        }]));
      pairs.push({
        from: prev.id, to: curr.id, family,
        fromFinishedAt: prev.runFinishedAt, toFinishedAt: curr.runFinishedAt,
        fromGitShas: prev.gitShas, toGitShas: curr.gitShas,
        benchmark: curr.benchmark, metricProtocol: curr.metricProtocol,
        deltas,
      });
    }
  }
  return {
    benchmark: group[0].benchmark,
    metricProtocol: group[0].metricProtocol,
    datasetSha256: group[0].datasetSha256,
    provider: group[0].provider,
    topK: group[0].topK,
    runs: ordered.map(e => ({ id: e.id, finishedAt: e.runFinishedAt, gitShas: e.gitShas, scoredCases: e.scoredCases })),
    pairs,
  };
});

const diagnostics = entries.filter(e => e.diagnostic).map(e => ({
  id: e.id, benchmark: e.benchmark, gitShas: e.gitShas, mixed: Boolean(e.mixedSha),
  scoredCases: e.scoredCases, completeDataset: e.completeDataset, notes: e.notes,
}));

const output = { generatedAt: new Date().toISOString(), series: progressSeries, diagnostics, registry: opts.registry };
console.log(JSON.stringify(output, null, 2));