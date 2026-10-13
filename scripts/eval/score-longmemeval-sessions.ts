import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

/**
 * Post-hoc unique-session scorer for finished LongMemEval artifacts.
 *
 * Does not re-embed, re-retrieve, or change the frozen evaluator. Converts
 * chunk-ranked hits into unique-session-K scores so chunk-K is not mistaken
 * for official LongMemEval retrieval.
 *
 * metricProtocol: renor-unique-session-v1-from-chunk-hits
 */

export const METRIC_PROTOCOL = 'renor-unique-session-v1-from-chunk-hits';

export const REMAINING_DIFFERENCES_VS_OFFICIAL = [
  'Renor retrieves chunks, not LongMemEval turns; session identity is the session file, not strip_turn_id(docid).',
  'Gold labels are session Markdown paths (relevant[].notePath), not turn ids. We do not strip a fake turn suffix off gold.',
  'Repeated noise files Sessions/<seg>-occN.md collapse to <seg>.md; official eval_utils.py has no occN mapping.',
  'nDCG uses the unique-session ranking of retrieved hits plus the gold-session set. Official nDCG ideals are over the full haystack corpus (all turn/session ids), which these artifacts do not contain.',
  'DCG itself matches eval_utils.py: rank 1 is undiscounted; ranks 2+ divide by log2(rank). This is not Renor chunk nDCG (2^rel-1)/(log2(rank+1)).',
  'These scores are still not official LongMemEval retrieval and are not end-to-end QA accuracy.',
] as const;

export interface SessionHit {
  notePath?: string;
  text?: string;
  score?: number;
}

export interface SessionCase {
  id: string;
  category?: string;
  relevant?: Array<{ match?: string; notePath?: string; relevance?: number; role?: string }>;
  shouldAbstain?: boolean;
}

export interface SessionResult {
  id: string;
  hits?: SessionHit[];
}

export interface ScoreOptions {
  ks?: number[];
  includeAbstention?: boolean;
}

const DEFAULT_KS = [1, 5, 10];

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Collapse Sessions/<seg>-occN.md onto Sessions/<seg>.md. Leave other hashes/ids intact. */
export function sessionIdentity(notePath: string | undefined): string {
  if (!notePath) return '';
  return notePath.replaceAll('\\', '/').trim().replace(/-occ\d+(?=\.md$)/i, '');
}

export function uniqueSessionKeys(hits: SessionHit[]): { keys: string[]; depths: number[] } {
  const keys: string[] = [];
  const depths: number[] = [];
  const seen = new Set<string>();
  hits.forEach((hit, index) => {
    const key = sessionIdentity(hit.notePath);
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
    depths.push(index + 1);
  });
  return { keys, depths };
}

/**
 * Official LongMemEval DCG: rank 1 is undiscounted; subsequent ranks divide by log2(rank).
 * Mirrors eval_utils.py dcg().
 */
export function officialDcg(relevances: number[], k: number): number {
  const sliced = relevances.slice(0, k);
  if (sliced.length === 0) return 0;
  let sum = sliced[0];
  for (let index = 1; index < sliced.length; index++) {
    sum += sliced[index] / Math.log2(index + 1);
  }
  return sum;
}

/** Binary nDCG with official DCG; ideal is min(goldCount, k) leading 1s. */
export function officialNdcg(observed: number[], goldCount: number, k: number): number {
  if (k <= 0 || goldCount <= 0) return 0;
  const ideal = Array.from({ length: Math.min(goldCount, k) }, () => 1);
  const idealDcg = officialDcg(ideal, k);
  if (idealDcg === 0) return 0;
  return officialDcg(observed, k) / idealDcg;
}

function goldSessionKeys(test: SessionCase): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const target of test.relevant ?? []) {
    if ((target.role ?? 'positive') !== 'positive') continue;
    const key = sessionIdentity(target.notePath);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function isAbstention(test: SessionCase): boolean {
  return Boolean(test.shouldAbstain) || test.id.endsWith('_abs');
}

function effectiveK(depths: number[], hitCount: number, k: number): number {
  if (k <= 0) return 0;
  if (depths.length >= k) return depths[k - 1];
  return hitCount;
}

function assertBijection(cases: SessionCase[], results: SessionResult[]): Map<string, SessionResult> {
  if (!Array.isArray(cases) || !Array.isArray(results)) {
    throw new Error('cases.jsonl / results.jsonl must be JSONL arrays of objects');
  }
  const caseIds = new Set<string>();
  for (const test of cases) {
    if (!test?.id) throw new Error('Case is missing id');
    if (caseIds.has(test.id)) throw new Error(`Duplicate case id: ${test.id}`);
    caseIds.add(test.id);
  }
  const resultIds = new Set<string>();
  const byId = new Map<string, SessionResult>();
  for (const result of results) {
    if (!result?.id) throw new Error('Result is missing id');
    if (resultIds.has(result.id)) throw new Error(`Duplicate result id: ${result.id}`);
    resultIds.add(result.id);
    byId.set(result.id, result);
  }
  const missing = [...caseIds].filter(id => !resultIds.has(id));
  const extra = [...resultIds].filter(id => !caseIds.has(id));
  if (missing.length || extra.length || caseIds.size !== resultIds.size) {
    throw new Error(
      `cases.jsonl / results.jsonl ids are not a bijection; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
    );
  }
  return byId;
}

interface CaseScore {
  category: string;
  hit: Record<number, number>;
  recallAll: Record<number, number>;
  ndcg: Record<number, number>;
  mrr: number;
  effectiveK: Record<number, number>;
}

function scoreAnswerableCase(test: SessionCase, result: SessionResult, ks: number[]): CaseScore {
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const { keys, depths } = uniqueSessionKeys(hits);
  const gold = new Set(goldSessionKeys(test));
  const goldCount = gold.size;
  const firstGold = keys.findIndex(key => gold.has(key));
  const observed = keys.map(key => (gold.has(key) ? 1 : 0));
  const hit: Record<number, number> = {};
  const recallAll: Record<number, number> = {};
  const ndcg: Record<number, number> = {};
  const effective: Record<number, number> = {};
  for (const k of ks) {
    const prefix = keys.slice(0, k);
    const found = new Set(prefix.filter(key => gold.has(key)));
    hit[k] = goldCount > 0 && found.size > 0 ? 1 : 0;
    recallAll[k] = goldCount > 0 && found.size === goldCount ? 1 : 0;
    ndcg[k] = officialNdcg(observed.slice(0, k), goldCount, k);
    effective[k] = effectiveK(depths, hits.length, k);
  }
  return {
    category: test.category ?? 'uncategorized',
    hit,
    recallAll,
    ndcg,
    mrr: firstGold === -1 ? 0 : 1 / (firstGold + 1),
    effectiveK: effective,
  };
}

interface Bucket {
  cases: number;
  answerable: number;
  abstention: number;
  hit: Record<number, number>;
  recallAll: Record<number, number>;
  ndcg: Record<number, number>;
  mrr: number;
  effectiveK: Record<number, number[]>;
}

function emptyBucket(ks: number[]): Bucket {
  return {
    cases: 0,
    answerable: 0,
    abstention: 0,
    hit: Object.fromEntries(ks.map(k => [k, 0])),
    recallAll: Object.fromEntries(ks.map(k => [k, 0])),
    ndcg: Object.fromEntries(ks.map(k => [k, 0])),
    mrr: 0,
    effectiveK: Object.fromEntries(ks.map(k => [k, [] as number[]])),
  };
}

function addAnswerable(bucket: Bucket, scored: CaseScore, ks: number[]): void {
  bucket.answerable += 1;
  bucket.mrr += scored.mrr;
  for (const k of ks) {
    bucket.hit[k] += scored.hit[k];
    bucket.recallAll[k] += scored.recallAll[k];
    bucket.ndcg[k] += scored.ndcg[k];
    bucket.effectiveK[k].push(scored.effectiveK[k]);
  }
}

function summarize(bucket: Bucket, ks: number[]): Record<string, number | null> {
  const n = Math.max(1, bucket.answerable);
  const row: Record<string, number | null> = {
    cases: bucket.cases,
    answerableCases: bucket.answerable,
    abstentionCases: bucket.abstention,
    mrr: round4(bucket.mrr / n),
  };
  for (const k of ks) {
    row[`hitAt${k}`] = round4(bucket.hit[k] / n);
    row[`recallAnyAt${k}`] = round4(bucket.hit[k] / n);
    row[`recallAllAt${k}`] = round4(bucket.recallAll[k] / n);
    row[`ndcgAt${k}`] = round4(bucket.ndcg[k] / n);
    const effectiveMean = mean(bucket.effectiveK[k]);
    row[`effectiveKMeanAt${k}`] = effectiveMean === null ? null : round4(effectiveMean);
  }
  return row;
}

export function scoreLongMemEvalSessions(
  cases: SessionCase[],
  results: SessionResult[],
  options: ScoreOptions = {},
): {
  metricProtocol: string;
  includeAbstention: boolean;
  ks: number[];
  overall: Record<string, number | null>;
  byCategory: Record<string, Record<string, number | null>>;
} {
  const ks = [...new Set(options.ks?.length ? options.ks : DEFAULT_KS)].sort((a, b) => a - b);
  if (ks.some(k => !Number.isInteger(k) || k < 1)) {
    throw new Error('--k values must be integers >= 1');
  }
  const byId = assertBijection(cases, results);
  const includeAbstention = Boolean(options.includeAbstention);
  const overall = emptyBucket(ks);
  const categories = new Map<string, Bucket>();

  for (const test of cases) {
    const result = byId.get(test.id)!;
    const skipRetrieval = !includeAbstention && isAbstention(test);
    if (skipRetrieval) continue;

    overall.cases += 1;
    const categoryName = test.category ?? 'uncategorized';
    const category = categories.get(categoryName) ?? emptyBucket(ks);
    category.cases += 1;

    if (isAbstention(test)) {
      overall.abstention += 1;
      category.abstention += 1;
    } else {
      const scored = scoreAnswerableCase(test, result, ks);
      addAnswerable(overall, scored, ks);
      addAnswerable(category, scored, ks);
    }
    categories.set(categoryName, category);
  }

  if (overall.answerable === 0) {
    throw new Error('No answerable questions selected; no unique-session retrieval score');
  }

  return {
    metricProtocol: METRIC_PROTOCOL,
    includeAbstention,
    ks,
    overall: summarize(overall, ks),
    byCategory: Object.fromEntries(
      [...categories.entries()].map(([name, bucket]) => [name, summarize(bucket, ks)]),
    ),
  };
}

function readJsonl<T>(filePath: string): T[] {
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function readChunkK(runDir: string): Record<string, unknown> | null {
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { overall?: Record<string, unknown> };
  return parsed.overall ?? parsed;
}

function formatCell(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(4);
}

function printTable(
  n: number,
  session: Record<string, number | null>,
  chunk: Record<string, unknown> | null,
): void {
  const rows: Array<[string, string, string]> = [
    ['hit@1', formatCell(session.hitAt1), formatCell(chunk?.hitAt1)],
    ['hit@5', formatCell(session.hitAt5), formatCell(chunk?.hitAt5)],
    ['hit@10', formatCell(session.hitAt10), formatCell(chunk?.hitAt10)],
    ['recall-all@5', formatCell(session.recallAllAt5), formatCell(chunk?.recallAllAt5)],
    ['recall-all@10', formatCell(session.recallAllAt10), formatCell(chunk?.recallAllAt10)],
    ['ndcg@5', formatCell(session.ndcgAt5), formatCell(chunk?.ndcgAt5)],
    ['ndcg@10', formatCell(session.ndcgAt10), formatCell(chunk?.ndcgAt10)],
    ['mrr', formatCell(session.mrr), formatCell(chunk?.mrr)],
  ];
  console.log('Renor unique-session-K vs chunk-K (from existing hits; not a new retrieval run)');
  console.log(`n=${n}  answerable=${session.answerableCases}  protocol=${METRIC_PROTOCOL}`);
  console.log('');
  console.log('metric          unique-session-K   chunk-K');
  for (const [name, sessionValue, chunkValue] of rows) {
    console.log(`${name.padEnd(16)}${sessionValue.padStart(16)}   ${chunkValue.padStart(8)}`);
  }
  console.log('');
  console.log(
    `effectiveKMean@1/5/10 = ${formatCell(session.effectiveKMeanAt1)} / ${formatCell(session.effectiveKMeanAt5)} / ${formatCell(session.effectiveKMeanAt10)}`,
  );
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.basename(entry) === 'score-longmemeval-sessions.ts'
    || path.basename(entry) === 'score-longmemeval-sessions.js';
}

async function main(): Promise<void> {
  const program = new Command()
    .name('score-longmemeval-sessions')
    .description('Post-hoc unique-session-K scores from finished LongMemEval chunk-hit artifacts')
    .requiredOption('--run <dir>', 'run directory containing cases.jsonl and results.jsonl')
    .option('--k <n>', 'unique-session K (always also reports 1, 5, 10)', '10')
    .option('--output <path>', 'write session-summary JSON here; refused if the file exists')
    .option('--include-abstention', 'include _abs / shouldAbstain rows (still not scored as answerable retrieval)')
    .parse(process.argv);

  const opts = program.opts<{
    run: string;
    k: string;
    output?: string;
    includeAbstention?: boolean;
  }>();

  const k = Number(opts.k);
  if (!Number.isInteger(k) || k < 1) throw new Error('--k must be an integer >= 1');
  const ks = [...new Set([...DEFAULT_KS, k])].sort((a, b) => a - b);

  const runDir = path.resolve(opts.run);
  const casesPath = path.join(runDir, 'cases.jsonl');
  const resultsPath = path.join(runDir, 'results.jsonl');
  if (!fs.existsSync(casesPath) || !fs.existsSync(resultsPath)) {
    throw new Error(`Run directory must contain cases.jsonl and results.jsonl: ${runDir}`);
  }

  const cases = readJsonl<SessionCase>(casesPath);
  const results = readJsonl<SessionResult>(resultsPath);
  const scored = scoreLongMemEvalSessions(cases, results, {
    ks,
    includeAbstention: Boolean(opts.includeAbstention),
  });
  const chunkK = readChunkK(runDir);
  let sourceMetricProtocol: string | null = null;
  const manifestPath = path.join(runDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { metricProtocol?: string };
    sourceMetricProtocol = manifest.metricProtocol ?? null;
  }

  const payload = {
    metricProtocol: METRIC_PROTOCOL,
    sourceMetricProtocol,
    sourceRun: runDir,
    notOfficialSessionRetrieval: true,
    remainingDifferencesVsOfficial: [...REMAINING_DIFFERENCES_VS_OFFICIAL],
    includeAbstention: scored.includeAbstention,
    ks: scored.ks,
    overall: scored.overall,
    byCategory: scored.byCategory,
    chunkK,
  };

  printTable(scored.overall.cases as number, scored.overall, chunkK);

  if (opts.output) {
    const outputPath = path.resolve(opts.output);
    if (fs.existsSync(outputPath)) {
      throw new Error(`Refusing to overwrite existing --output: ${outputPath}`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`wrote ${outputPath}`);
  }
}

if (invokedDirectly()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
