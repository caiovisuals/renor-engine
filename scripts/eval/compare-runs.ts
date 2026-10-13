import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';
import { compareRuns } from '../../src/eval/comparison';
import { sha256 } from '../../src/eval/artifacts';

interface RunManifest {
  benchmark?: string;
  casesPath?: string;
  casesSha256?: string;
  fixtureSha256?: string;
  resultsSha256?: string;
  caseSnapshotSha256?: string;
  topK?: number;
  provider?: { kind?: string; model?: string; dimensions?: number };
  qualityEligible?: boolean;
  evaluatorSha256?: string;
  chunking?: { maxTokens?: number; overlapTokens?: number };
  gitDirty?: boolean;
}

const program = new Command()
  .name('compare-runs')
  .argument('<baseline>', 'baseline run directory')
  .argument('<candidate>', 'candidate run directory')
  .option('--allow-config-change', 'provider/topK/chunking changed: descriptive A/B, not a code ablation')
  .option('--allow-evaluator-change', 'evaluator code changed: descriptive only')
  .option('--allow-dirty-tree', 'tolerate dirty runs: descriptive only')
  .option('--max-quality-regression <value>', 'absolute quality tolerance', '0')
  .option('--min-efficiency-gain <value>', 'relative efficiency gain to count as material', '0.05')
  .parse(process.argv);

const opts = program.opts<{
  allowConfigChange?: boolean;
  allowEvaluatorChange?: boolean;
  allowDirtyTree?: boolean;
  maxQualityRegression: string;
  minEfficiencyGain: string;
}>();
const tolerance = Number(opts.maxQualityRegression);
const minEfficiencyGain = Number(opts.minEfficiencyGain);
if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new Error('--max-quality-regression must be between 0 and 1');
if (!Number.isFinite(minEfficiencyGain) || minEfficiencyGain < 0 || minEfficiencyGain > 1) throw new Error('--min-efficiency-gain must be between 0 and 1');

function parseJsonl<T>(bytes: Buffer): T[] {
  return bytes.toString().trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

/**
 * Load a run and RE-Score it from raw results. Supplied summaries are never
 * trusted: tampered summaries must not earn IMPROVED (independent-review
 * finding). Requires the run to have recorded case/result snapshots and hashes.
 */
function loadRun(dir: string): { manifest: RunManifest; summary: ReturnType<typeof scoreRetrieval> } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as RunManifest;
  if (typeof manifest.benchmark !== 'string' || !manifest.benchmark
      || typeof manifest.provider?.kind !== 'string' || typeof manifest.provider.model !== 'string'
      || !Number.isInteger(manifest.provider.dimensions) || typeof manifest.topK !== 'number') {
    throw new Error(`Invalid/incomplete manifest: ${dir}`);
  }

  // Cases come from the run's own snapshot. Legacy runs without a snapshot
  // are not comparable under the frozen evaluator: fail closed instead of
  // guessing a repo-relative path (review note: the old fallback was off-by-one
  // for <repo>/.eval-runs/x layouts).
  if (!manifest.caseSnapshotSha256) {
    throw new Error(`Run predates case snapshots and cannot be re-scored: ${dir}`);
  }
  const casesBytes = fs.readFileSync(path.join(dir, 'cases.jsonl'));
  if (sha256(casesBytes) !== manifest.caseSnapshotSha256) {
    throw new Error(`Cases do not match manifest hash: ${dir}`);
  }

  const resultsBytes = fs.readFileSync(path.join(dir, 'results.jsonl'));
  if (manifest.resultsSha256 && sha256(resultsBytes) !== manifest.resultsSha256) {
    throw new Error(`results.jsonl does not match manifest hash: ${dir}`);
  }

  const cases = parseJsonl<EvalCase>(casesBytes);
  const results = parseJsonl<EvalResult>(resultsBytes);
  if (manifest.topK !== undefined) {
    if (results.some(r => r.hits.length > manifest.topK!)) throw new Error(`More hits than topK in results: ${dir}`);
  }
  const summary = scoreRetrieval(cases, results);
  // `toolPath` is the RenorBench runner's own annotation beside the scored summary; without this, every RenorBench run is "tampered".
  const { toolPath: _toolPath, ...supplied } = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  if (JSON.stringify(summary) !== JSON.stringify(supplied)) {
    throw new Error(`summary.json does not match re-scored results (tampered or stale): ${dir}`);
  }
  return { manifest, summary };
}

const [baselineDir, candidateDir] = program.args.map(value => path.resolve(value));
const baseline = loadRun(baselineDir);
const candidate = loadRun(candidateDir);

const result = compareRuns(baseline, candidate, {
  allowConfigChange: opts.allowConfigChange,
  allowEvaluatorChange: opts.allowEvaluatorChange,
  allowDirtyTree: opts.allowDirtyTree,
  maxQualityRegression: tolerance,
  minEfficiencyGain,
});

console.log(JSON.stringify({
  ...result,
  baselineDir,
  candidateDir,
  promotionEligible: false,
  note: `${result.note} No automatic promotion: hashes detect accidents, not a malicious evaluator.`,
}, null, 2));

if (result.verdict === 'REGRESSED') process.exitCode = 3;