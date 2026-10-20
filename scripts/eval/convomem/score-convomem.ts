/**
 * Renor-on-ConvoMem scorer (scripts/eval/convomem/).
 *
 * Reads the retrieval run (cases.jsonl + results.jsonl + manifest.json written by
 * scripts/eval/locomo/run-retrieval.ts over the ConvoMem adapter's cases) and one or
 * more QA runs (qa-cases.jsonl + manifest.json written by scripts/eval/run-longmemeval-qa.ts),
 * and writes score-report.json + score-report.md.
 *
 * Metric (ConvoMem, arXiv:2511.10523): accuracy per evidence category, from a binary
 * LLM-judge verdict per question. The verdicts here come from the repo's frozen judge
 * (the LongMemEval QA stage's judge prompt, unchanged), so the numbers are Renor-protocol
 * accuracy, not the paper's judge prompt: protocol-incomparable with the paper's
 * long-context / Mem0 tables unless those are re-run under this evaluator.
 *
 *   accuracyPct       = correct / questions (API and judge errors count as not correct
 *                       and are reported separately; a run with errors is incomplete)
 *   macroAccuracyPct  = unweighted mean of the per-category accuracies
 *   byCategory        = the six ConvoMem categories, each with its retrieval recall
 *
 * Retrieval (session level, gold = conversations with containsEvidence: true):
 * recallAny@5/@10/@20 and MRR of the first gold session; cases without gold are
 * excluded from recall and counted as noGold.
 *
 * Failure classification is rule-based from gold-session membership, the same rules as
 * scripts/eval/score-longmemeval-qa.ts: abstention-failure, retrieval-failure,
 * partial-evidence, answer-failure, judge-error, api-error.
 *
 * Several QA runs may be merged (one per answer style, e.g. abstention scored with
 * `direct` and the rest with `bestguess`); an id answered by two runs is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { RESEARCH_WATERMARK } from '../../../src/eval/runManifest';

export const CONVOMEM_CATEGORIES = [
  'user_facts',
  'assistant_facts',
  'changing_facts',
  'abstention',
  'preferences',
  'implicit_connections',
] as const;

export interface ConvoMemCase {
  id: string;
  category: string;
  split?: string;
  itemKey?: string;
  shouldAbstain: boolean;
  question?: string;
  query?: string;
  expectedAnswer: string;
  relevant: Array<{ notePath?: string; role: string }>;
}
interface HitRow { text: string | null; notePath: string; score: number }
interface ResultRow { id: string; hits: HitRow[] }
interface QaCase {
  id: string;
  contextTokens?: number;
  answer: { text: string } | null;
  judge: { raw: string; verdict: 0 | 1 | null; parseOk: boolean } | null;
  error?: string;
}
export interface QaRun { dir: string; manifest: Record<string, unknown>; rows: QaCase[] }

const RECALL_KS = [5, 10, 20] as const;

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10000) / 100);
const session = (notePath: string) => notePath.replace(/^Sessions\//, '');

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

interface Bucket {
  total: number; correct: number; wrong: number; judgeError: number; apiError: number;
  withGold: number; noGold: number; recallHits: Record<number, number>; rrSum: number;
}
const emptyBucket = (): Bucket => ({ total: 0, correct: 0, wrong: 0, judgeError: 0, apiError: 0, withGold: 0, noGold: 0, recallHits: { 5: 0, 10: 0, 20: 0 }, rrSum: 0 });

function summarize(b: Bucket) {
  return {
    total: b.total, correct: b.correct, wrong: b.wrong, judgeError: b.judgeError, apiError: b.apiError,
    accuracyPct: pct(b.correct, b.total),
    retrieval: {
      withGold: b.withGold, noGold: b.noGold,
      'recallAny@5': pct(b.recallHits[5], b.withGold),
      'recallAny@10': pct(b.recallHits[10], b.withGold),
      'recallAny@20': pct(b.recallHits[20], b.withGold),
      mrr: b.withGold === 0 ? null : Math.round((b.rrSum / b.withGold) * 10000) / 10000,
    },
  };
}

export function scoreConvoMem(args: {
  cases: ConvoMemCase[];
  results: ResultRow[];
  retrievalManifest: Record<string, unknown>;
  qaRuns: QaRun[];
  dryRun?: boolean;
}) {
  for (const run of args.qaRuns) {
    if (run.manifest.executionKind === 'product-public') {
      throw new Error(`Refusing: ${run.dir} is a product-public run; ConvoMem QA is research execution only.`);
    }
  }
  const caseMap = new Map(args.cases.map(row => [row.id, row]));
  const resultMap = new Map(args.results.map(row => [row.id, row]));
  const qa = new Map<string, { row: QaCase; run: string }>();
  for (const run of args.qaRuns) {
    for (const row of run.rows) {
      const prior = qa.get(row.id);
      if (prior) throw new Error(`Question ${row.id} is answered by two QA runs (${prior.run}, ${run.dir}); merge disjoint id sets only.`);
      if (!caseMap.has(row.id)) throw new Error(`QA row ${row.id} (${run.dir}) is not a case of the retrieval run.`);
      qa.set(row.id, { row, run: run.dir });
    }
  }

  const overall = emptyBucket();
  const byCategory = new Map<string, Bucket>();
  const classificationCounts: Record<string, number> = {};
  const failures: Array<Record<string, unknown>> = [];
  const splits = new Set<string>();
  const itemKeys = new Set<string>();
  const classify = (name: string) => { classificationCounts[name] = (classificationCounts[name] ?? 0) + 1; };

  for (const { row: answer } of qa.values()) {
    const row = caseMap.get(answer.id)!;
    const cat = row.category;
    if (row.split) splits.add(row.split);
    if (row.itemKey) itemKeys.add(row.itemKey);
    const bucket = byCategory.get(cat) ?? emptyBucket();
    byCategory.set(cat, bucket);
    const buckets = [overall, bucket];
    for (const b of buckets) b.total++;

    // Retrieval: rank of the first gold session among the hits (sessions in hit order, deduped).
    const gold = new Set(row.relevant.filter(r => r.role === 'positive' && r.notePath).map(r => session(r.notePath!)));
    const hits = resultMap.get(row.id)?.hits ?? [];
    const rankedSessions = [...new Set(hits.map(hit => session(hit.notePath)))];
    if (gold.size === 0) {
      for (const b of buckets) b.noGold++;
    } else {
      const firstRank = rankedSessions.findIndex(s => gold.has(s)) + 1;
      for (const b of buckets) {
        b.withGold++;
        for (const k of RECALL_KS) if (firstRank > 0 && firstRank <= k) b.recallHits[k]++;
        if (firstRank > 0) b.rrSum += 1 / firstRank;
      }
    }

    if (!answer.answer || (!answer.judge && answer.error && !answer.error.includes('judge-unparseable'))) {
      for (const b of buckets) b.apiError++;
      classify('api-error');
      failures.push({ id: row.id, category: cat, classification: 'api-error', detail: answer.error ?? 'answer missing' });
      continue;
    }
    if (!answer.judge || !answer.judge.parseOk) {
      for (const b of buckets) b.judgeError++;
      classify('judge-error');
      failures.push({ id: row.id, category: cat, classification: 'judge-error', detail: answer.error ?? 'judge missing', judgeRaw: answer.judge?.raw ?? null });
      continue;
    }
    if (answer.judge.verdict === 1) { for (const b of buckets) b.correct++; continue; }

    for (const b of buckets) b.wrong++;
    let classification: string;
    let detail: string;
    const retrieved = [...gold].filter(g => rankedSessions.includes(g)).length;
    if (row.shouldAbstain) {
      classification = 'abstention-failure';
      detail = 'should abstain';
    } else if (gold.size > 0 && retrieved === 0) {
      classification = 'retrieval-failure';
      detail = `0/${gold.size} gold sessions in top-${hits.length}`;
    } else if (retrieved < gold.size) {
      classification = 'partial-evidence';
      detail = `${retrieved}/${gold.size} gold sessions in top-${hits.length}`;
    } else {
      classification = 'answer-failure';
      detail = `all ${gold.size} gold session(s) retrieved; answer wrong`;
    }
    classify(classification);
    failures.push({
      id: row.id, category: cat, classification, detail,
      question: row.question ?? row.query, goldAnswer: row.expectedAnswer, answerText: answer.answer.text,
      judgeRaw: answer.judge.raw, contextTokens: answer.contextTokens,
    });
  }

  const categories = [...CONVOMEM_CATEGORIES.filter(c => byCategory.has(c)), ...[...byCategory.keys()].filter(c => !(CONVOMEM_CATEGORIES as readonly string[]).includes(c)).sort()];
  const perCategory = Object.fromEntries(categories.map(c => [c, summarize(byCategory.get(c)!)]));
  const categoryAccuracies = categories.map(c => perCategory[c].accuracyPct).filter((v): v is number => v !== null);
  const scoped = new Set(qa.keys());
  const missingCategories = CONVOMEM_CATEGORIES.filter(c => !byCategory.has(c));
  const complete = overall.apiError === 0 && overall.judgeError === 0;
  const retrievalQualityEligible = args.retrievalManifest.qualityEligible !== false;

  return {
    benchmark: 'convomem-qa-end-to-end',
    metric: 'per-category LLM-judge accuracy (ConvoMem arXiv:2511.10523 metric shape; Renor frozen judge prompt — protocol-incomparable with paper tables)',
    label: args.dryRun ? 'dry-run-wiring-smoke' : 'research',
    watermark: RESEARCH_WATERMARK,
    // A dry run (stub model) or a hash-embedding retrieval is never a measurement.
    qualityEligible: !args.dryRun && retrievalQualityEligible,
    complete,
    splits: [...splits].sort(),
    questions: overall.total,
    uniqueItemKeys: itemKeys.size,
    casesInRetrievalRunNotScored: args.cases.filter(c => !scoped.has(c.id)).length,
    missingCategories,
    correct: overall.correct,
    wrong: overall.wrong,
    judgeErrors: overall.judgeError,
    apiErrors: overall.apiError,
    accuracyPct: pct(overall.correct, overall.total),
    macroAccuracyPct: categoryAccuracies.length === 0 ? null : Math.round((categoryAccuracies.reduce((s, v) => s + v, 0) / categoryAccuracies.length) * 100) / 100,
    retrieval: summarize(overall).retrieval,
    byCategory: perCategory,
    failureClassification: classificationCounts,
    inputs: {
      retrievalProvider: (args.retrievalManifest.provider as { kind?: string; model?: string } | undefined) ?? null,
      retrievalTopK: args.retrievalManifest.topK ?? null,
      qaRuns: args.qaRuns.map(run => ({
        dir: run.dir,
        questions: run.rows.length,
        benchmark: run.manifest.benchmark ?? null,
        answerModel: run.manifest.answerModelRequested ?? null,
        judgeModel: run.manifest.judgeModelRequested ?? null,
        answerStyle: (run.manifest.ablation as { answerStyle?: string } | undefined)?.answerStyle ?? null,
        cache: (run.manifest.evalCache as { enabled?: boolean } | undefined)?.enabled ?? null,
        gitSha: run.manifest.gitSha ?? null,
        gitDirty: run.manifest.gitDirty ?? null,
      })),
    },
    failures,
  };
}

export type ConvoMemReport = ReturnType<typeof scoreConvoMem>;

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : `${v}%`);

export function renderMarkdown(report: ConvoMemReport): string {
  const lines = [
    `# ConvoMem QA score (${report.splits.join(', ') || 'no split'})`,
    '',
    `Label: **${report.label}** · ${report.watermark} · qualityEligible=${report.qualityEligible} · complete=${report.complete}`,
    '',
    `Metric: ${report.metric}.`,
    '',
    `| field | value |`,
    `|---|---|`,
    `| questions | ${report.questions} (${report.uniqueItemKeys} unique itemKeys) |`,
    `| accuracy | ${report.correct}/${report.questions} = ${fmt(report.accuracyPct)} |`,
    `| macro accuracy (mean of categories) | ${fmt(report.macroAccuracyPct)} |`,
    `| judge errors / API errors | ${report.judgeErrors} / ${report.apiErrors} |`,
    `| recall-any @5/@10/@20 | ${fmt(report.retrieval['recallAny@5'])} / ${fmt(report.retrieval['recallAny@10'])} / ${fmt(report.retrieval['recallAny@20'])} |`,
    `| MRR | ${report.retrieval.mrr ?? 'n/a'} |`,
    '',
    `| category | n | correct | accuracy | judge err | api err | recall@20 |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...Object.entries(report.byCategory).map(([cat, b]) =>
      `| ${cat} | ${b.total} | ${b.correct} | ${fmt(b.accuracyPct)} | ${b.judgeError} | ${b.apiError} | ${fmt(b.retrieval['recallAny@20'])} |`),
    '',
  ];
  if (report.missingCategories.length) lines.push(`Missing categories: ${report.missingCategories.join(', ')}.`, '');
  const classes = Object.entries(report.failureClassification);
  if (classes.length) lines.push(`Failures: ${classes.map(([k, v]) => `${k}=${v}`).join(', ')}.`, '');
  return lines.join('\n');
}

export function loadQaRun(dir: string): QaRun {
  const resolved = path.resolve(dir);
  return {
    dir: resolved,
    manifest: JSON.parse(fs.readFileSync(path.join(resolved, 'manifest.json'), 'utf8')) as Record<string, unknown>,
    rows: readJsonl<QaCase>(path.join(resolved, 'qa-cases.jsonl')),
  };
}

export function scoreConvoMemDirs(args: { run: string; qa: string[]; output: string; dryRun?: boolean }): ConvoMemReport {
  const runDir = path.resolve(args.run);
  const report = scoreConvoMem({
    cases: readJsonl<ConvoMemCase>(path.join(runDir, 'cases.jsonl')),
    results: readJsonl<ResultRow>(path.join(runDir, 'results.jsonl')),
    retrievalManifest: JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>,
    qaRuns: args.qa.map(loadQaRun),
    dryRun: args.dryRun,
  });
  const outputDir = path.resolve(args.output);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'score-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outputDir, 'score-report.md'), renderMarkdown(report), 'utf8');
  return report;
}

function main(): void {
  const opts = new Command()
    .name('score-convomem')
    .requiredOption('--run <dir>', 'retrieval run directory (cases.jsonl + results.jsonl + manifest.json)')
    .requiredOption('--qa <dir...>', 'one or more QA run directories (qa-cases.jsonl + manifest.json); id sets must be disjoint')
    .requiredOption('--output <dir>', 'directory for score-report.json + score-report.md')
    .option('--dry-run', 'label the report as a wiring smoke (stub model): never a measurement')
    .parse(process.argv)
    .opts<{ run: string; qa: string[]; output: string; dryRun?: boolean }>();
  const { failures, ...summary } = scoreConvoMemDirs(opts);
  void failures;
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
