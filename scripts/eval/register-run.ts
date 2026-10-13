import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';

/**
 * Benchmark results registry — the persistent progress ledger.
 *
 * Every meaningful run is appended (never overwritten) to
 * docs/evals/results/registry.jsonl with full provenance. The registry is
 * committed to the repo (metrics and hashes only — never secrets, never
 * benchmark data). progress.ts computes comparable-pair deltas from it, so
 * every "now X% better" claim is auditable back to a manifest on disk.
 *
 * Registration rules:
 * - one entry per run, id = content hash of manifest+summary;
 * - diagnostic / mixed-SHA / non-quality runs are registered with their true
 *   flags and are never presented as comparable headlines;
 * - re-registering the same run (same id) is a no-op.
 */

interface RunManifest {
  benchmark?: string;
  metricProtocol?: string;
  gitShas?: string[];
  gitSha?: string | null;
  mixedSha?: boolean;
  homogeneousGitSha?: boolean;
  evaluatorSha256?: string;
  datasetSha256?: string;
  provider?: Record<string, unknown>;
  topK?: number;
  chunking?: { maxTokens?: number; overlapTokens?: number };
  selectedCases?: number;
  scoredCases?: number;
  completeDataset?: boolean;
  totalInputTokens?: number;
  finishedAt?: string;
}

const REGISTRY = 'docs/evals/results/registry.jsonl';

const program = new Command()
  .name('register-run')
  .description('Append a run to the benchmark results registry')
  .requiredOption('--run <dir>', 'run artifact directory (manifest.json + summary.json)')
  .option('--session-summary <path>', 'optional session-level summary to fold in')
  .option('--diagnostic', 'mark as diagnostic (mixed SHA, incomplete, or non-quality)')
  .option('--notes <text>', 'free-form provenance notes')
  .option('--artifact-path <text>', 'where the artifacts live (if outside this repo)')
  .parse(process.argv);

const opts = program.opts<{
  run: string;
  sessionSummary?: string;
  diagnostic?: boolean;
  notes?: string;
  artifactPath?: string;
}>();

const runDir = path.resolve(opts.run);
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) as RunManifest;
const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
const sessionSummary = opts.sessionSummary
  ? JSON.parse(fs.readFileSync(path.resolve(opts.sessionSummary), 'utf8'))
  : null;

const benchmark = manifest.benchmark ?? 'unknown';
const provider = (manifest.provider ?? {}) as Record<string, unknown>;
const providerIdentity = {
  kind: provider.kind,
  model: provider.model,
  dimensions: provider.dimensions,
  location: provider.location ?? undefined,
};
const gitShas = manifest.gitShas ?? (manifest.gitSha ? [manifest.gitSha] : []);
const qualityEligible = providerIdentity.kind !== 'hash' && manifest.completeDataset !== false;

const entry = {
  id: crypto.createHash('sha256')
    .update(JSON.stringify(manifest) + JSON.stringify(summary))
    .digest('hex').slice(0, 16),
  registeredAt: new Date().toISOString(),
  runFinishedAt: manifest.finishedAt ?? null,
  benchmark,
  metricProtocol: manifest.metricProtocol ?? null,
  gitShas,
  mixedSha: manifest.mixedSha ?? gitShas.length > 1,
  homogeneousGitSha: manifest.homogeneousGitSha ?? gitShas.length === 1,
  evaluatorSha256: manifest.evaluatorSha256 ?? null,
  datasetSha256: manifest.datasetSha256 ?? null,
  provider: providerIdentity,
  topK: manifest.topK ?? null,
  chunking: manifest.chunking ?? null,
  cases: manifest.selectedCases ?? manifest.scoredCases ?? null,
  scoredCases: manifest.scoredCases ?? null,
  completeDataset: manifest.completeDataset ?? null,
  qualityEligible,
  diagnostic: Boolean(opts.diagnostic) || !qualityEligible,
  metrics: sessionSummary
    ? { chunk: summary.overall, session: sessionSummary.overall }
    : { chunk: summary.overall },
  byCategory: summary.byCategory ?? null,
  sessionByCategory: sessionSummary?.byCategory ?? null,
  cost: {
    inputTokens: manifest.totalInputTokens ?? ((provider as any).usage?.inputTokens ?? null),
    cache: (provider as any).cache ?? null,
  },
  artifactPath: opts.artifactPath ?? opts.run,
  notes: opts.notes ?? null,
};

fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
const existing = fs.existsSync(REGISTRY)
  ? fs.readFileSync(REGISTRY, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
  : [];
if (existing.some(e => e.id === entry.id)) {
  console.log(`Already registered: ${entry.id} (${benchmark})`);
  process.exit(0);
}
fs.appendFileSync(REGISTRY, JSON.stringify(entry) + '\n');
console.log(JSON.stringify({ registered: entry.id, benchmark, gitShas, scoredCases: entry.scoredCases, qualityEligible }, null, 2));