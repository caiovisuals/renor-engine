import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import { hitAtK, recallAtK, forbiddenRetrieved, contradictionFirst, roleOf, type GoldTarget } from '../../src/eval/metrics';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';

function sha256(data: string | Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(data as unknown as string).digest('hex');
}

function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

const program = new Command()
  .name('analyze-failures')
  .argument('<run-dir>', 'Renor eval run directory')
  .option('--cases <path>', 'legacy case JSONL outside the run dir; must match the run hash')
  .option('--k <n>', 'retrieval cutoff to analyze', '5')
  .parse(process.argv);

const [runArg] = program.args as [string];
const opts = program.opts<{ cases?: string; k: string }>();
const k = Number(opts.k);
if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error('--k must be an integer between 1 and 100');

const runDir = path.resolve(runArg);
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
const casesPath = opts.cases ? path.resolve(opts.cases) : path.join(runDir, 'cases.jsonl');
const casesBytes = fs.readFileSync(casesPath);
const expectedHash = opts.cases ? manifest.casesSha256 : manifest.caseSnapshotSha256;
if (!expectedHash || sha256(casesBytes) !== expectedHash) throw new Error('Cases do not match run manifest');
const cases = readJsonl<EvalCase>(casesPath);
const resultsPath = path.join(runDir, 'results.jsonl');
if (manifest.resultsSha256 && sha256(fs.readFileSync(resultsPath)) !== manifest.resultsSha256) throw new Error('Result hash mismatch');
const results = readJsonl<EvalResult>(resultsPath);
scoreRetrieval(cases, results);
const byId = new Map(results.map(result => [result.id, result]));

const failures: Array<Record<string, unknown>> = [];
const categoryCounts: Record<string, { cases: number; failures: number }> = {};

for (const test of cases) {
  const result = byId.get(test.id);
  if (!result) throw new Error(`Missing result: ${test.id}`);
  const category = categoryCounts[test.category] ?? { cases: 0, failures: 0 };
  category.cases += 1;

  const positive: GoldTarget[] = test.relevant.filter(target => roleOf(target) === 'positive');
  const shouldAbstain = Boolean(test.shouldAbstain) || positive.length === 0;
  let failure: string | null = null;
  if (shouldAbstain) {
    if (result.hits.length > 0) failure = 'failed_abstention';
  } else if (forbiddenRetrieved(result.hits, test.relevant, Math.min(k, result.hits.length))) {
    failure = `forbidden_evidence_retrieved_at_${Math.min(k, result.hits.length)}`;
  } else if (contradictionFirst(result.hits, test.relevant)) {
    failure = 'contradiction_ranked_first';
  } else if (hitAtK(result.hits, positive, k) === 0) {
    failure = `miss_at_${k}`;
  } else if (recallAtK(result.hits, positive, k) < 1) {
    failure = `partial_evidence_at_${k}`;
  }

  if (failure !== null) {
    category.failures += 1;
    failures.push({
      id: test.id,
      category: test.category,
      query: test.query,
      failure,
      expectedEvidence: test.relevant,
      topHits: result.hits.slice(0, 5).map(hit => ({
        notePath: hit.notePath,
        score: hit.score,
        text: (hit.text ?? '').replace(/\s+/g, ' ').slice(0, 240),
      })),
      latencyMs: result.latencyMs,
      contextTokens: result.contextTokens,
    });
  }
  categoryCounts[test.category] = category;
}

const output = {
  runDir,
  cutoff: k,
  totalCases: cases.length,
  failureCount: failures.length,
  categories: categoryCounts,
  failures,
};

console.log(JSON.stringify(output, null, 2));