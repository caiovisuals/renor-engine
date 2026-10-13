import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { assertProductScoreEligibility, RESEARCH_WATERMARK } from '../../src/eval/runManifest';

/**
 * Scores an end-to-end QA run against its retrieval run.
 *
 * Product-truth label enforcement (fail closed):
 *   --label product requires a manifest with the Wave-C product-truth contract
 *   fields (executionKind=product-public, clean provenance, complete coverage,
 *   zero promotion-arm cache reads, model echoes present). Research runs
 *   (executionKind=research or legacy pre-contract manifests) can never carry
 *   a product label and are watermarked RESEARCH-ONLY.
 *
 * Failure classification is RULE-BASED from retrieval gold-session membership
 * (documented, inspectable), never an LLM opinion:
 *   retrieval-failure        — wrong answer AND no gold session in top-K hits
 *   partial-evidence         — wrong answer AND some (not all) gold sessions in top-K
 *   answer-failure           — wrong answer AND all gold sessions in top-K
 *   abstention-failure       — _abs case judged wrong (answered when it should abstain, or failed to abstain)
 *   judge-error              — judge output unparseable (excluded from accuracy, reported separately)
 *   api-error                — answer or judge API failure (excluded from accuracy, reported separately)
 *
 * Gold session membership collapses `-occN` suffixes the same way the
 * unique-session scorer does (first occurrence = canonical session file).
 */

interface EvalCaseRow {
  id: string; category: string; query: string;
  relevant: Array<{ match: string; notePath?: string; role: string }>;
  expectedAnswer: string; shouldAbstain: boolean;
}
interface HitRow { text: string | null; notePath: string; score: number }
interface ResultRow { id: string; hits: HitRow[] }
interface QaCase {
  id: string; category: string; shouldAbstain: boolean;
  hitsUsed: number; contextTokens: number;
  answer: { text: string } | null;
  judge: { raw: string; verdict: 0 | 1 | null; parseOk: boolean } | null;
  error?: string;
}

const canonicalSession = (notePath: string) => notePath.replace(/-occ\d+\.md$/, '.md').replace(/^Sessions\//, '');

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10000) / 100);

function main(): void {
  const program = new Command()
    .name('score-longmemeval-qa')
    .requiredOption('--qa <dir>', 'QA run directory (qa-cases.jsonl)')
    .requiredOption('--run <dir>', 'retrieval run directory (cases.jsonl + results.jsonl)')
    .requiredOption('--output <path>', 'output report JSON path')
    .option('--label <label>', 'score label: research (default; watermarked RESEARCH-ONLY) or product (requires product-public contract manifest)', 'research')
    .parse(process.argv);
  const opts = program.opts<{ qa: string; run: string; output: string; label: string }>();
  if (opts.label !== 'research' && opts.label !== 'product') {
    throw new Error(`--label must be "research" or "product" (got ${opts.label})`);
  }

  const manifestPath = path.join(opts.qa, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  let failedRunRecord = false;
  if (opts.label === 'product') {
    // Fail closed: every product-label refusal has a test in
    // tests/eval/product-path-contract.test.ts (scorer refusals).
    const eligibility = assertProductScoreEligibility(manifest);
    failedRunRecord = eligibility.failedRunRecord;
    // The retrieval run must ALSO be product-public with matching provenance:
    // a product-public QA manifest can never be scored over research
    // retrieval outputs (the H10-v4 substrate pattern).
    const runManifestPath = path.join(opts.run, 'manifest.json');
    if (!fs.existsSync(runManifestPath)) {
      throw new Error('Refusing product label: retrieval run manifest.json is missing (pre-contract run).');
    }
    const runManifest = JSON.parse(fs.readFileSync(runManifestPath, 'utf8')) as Record<string, unknown>;
    if (runManifest.executionKind !== 'product-public') {
      throw new Error(`Refusing product label: retrieval run executionKind is "${String(runManifest.executionKind ?? 'missing')}" — product QA cannot be scored over research retrieval outputs.`);
    }
    const qaProv = (manifest.provenance ?? {}) as Record<string, unknown>;
    const runProv = (runManifest.provenance ?? {}) as Record<string, unknown>;
    if (typeof runProv.datasetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(runProv.datasetSha256)) {
      throw new Error('Refusing product label: retrieval run provenance.datasetSha256 missing or malformed.');
    }
    if (typeof runProv.gitSha !== 'string' || !runProv.gitSha) {
      throw new Error('Refusing product label: retrieval run provenance.gitSha missing.');
    }
    if (qaProv.datasetSha256 !== runProv.datasetSha256) {
      throw new Error('Refusing product label: datasetSha256 mismatch between QA and retrieval manifests.');
    }
    if (qaProv.gitSha !== runProv.gitSha) {
      throw new Error('Refusing product label: gitSha mismatch between QA and retrieval manifests.');
    }
  } else if (manifest.executionKind === 'product-public') {
    throw new Error('Refusing research label for a product-public run: score it with --label product. ' +
      'A RESEARCH-ONLY watermark on product-public execution would be a false provenance label.');
  }

  const qaCases = readJsonl(path.join(opts.qa, 'qa-cases.jsonl')) as unknown as QaCase[];
  const caseRows = readJsonl(path.join(opts.run, 'cases.jsonl')) as unknown as EvalCaseRow[];
  const resultRows = readJsonl(path.join(opts.run, 'results.jsonl')) as unknown as ResultRow[];
  const caseMap = new Map(caseRows.map(row => [row.id, row]));
  const resultMap = new Map(resultRows.map(row => [row.id, row]));

  const failureRows: Array<Record<string, unknown>> = [];
  const classificationCounts: Record<string, number> = {};
  const byCategory: Record<string, { total: number; correct: number; wrong: number; judgeError: number; apiError: number }> = {};
  const bump = (category: string) => {
    if (!byCategory[category]) byCategory[category] = { total: 0, correct: 0, wrong: 0, judgeError: 0, apiError: 0 };
    return byCategory[category];
  };

  let correct = 0, wrong = 0, judgeErrors = 0, apiErrors = 0;
  for (const qa of qaCases) {
    const cat = qa.shouldAbstain ? 'abstention' : qa.category;
    const bucket = bump(cat);
    bucket.total++;

    if (!qa.answer || (!qa.judge && qa.error && !qa.error.includes('judge-unparseable'))) {
      apiErrors++; bucket.apiError++;
      failureRows.push({ id: qa.id, category: cat, classification: 'api-error', detail: qa.error, answerText: qa.answer?.text ?? null });
      classificationCounts['api-error'] = (classificationCounts['api-error'] ?? 0) + 1;
      continue;
    }
    if (!qa.judge || !qa.judge.parseOk) {
      judgeErrors++; bucket.judgeError++;
      failureRows.push({ id: qa.id, category: cat, classification: 'judge-error', detail: qa.error ?? 'judge missing', answerText: qa.answer?.text, judgeRaw: qa.judge?.raw });
      classificationCounts['judge-error'] = (classificationCounts['judge-error'] ?? 0) + 1;
      continue;
    }
    if (qa.judge.verdict === 1) { correct++; bucket.correct++; continue; }

    wrong++; bucket.wrong++;
    const row = caseMap.get(qa.id);
    const result = resultMap.get(qa.id);
    let classification = 'other';
    let detail = '';
    if (qa.shouldAbstain) {
      classification = 'abstention-failure';
      detail = `should abstain; answered: ${JSON.stringify((qa.answer?.text ?? '').slice(0, 160))}`;
    } else if (row && result) {
      const goldSessions = new Set((row.relevant ?? []).filter(r => r.role === 'positive').map(r => canonicalSession(r.notePath ?? '')));
      const hitSessions = new Set((result.hits ?? []).map(h => canonicalSession(h.notePath)));
      const goldRetrieved = [...goldSessions].filter(g => hitSessions.has(g));
      if (goldSessions.size > 0 && goldRetrieved.length === 0) {
        classification = 'retrieval-failure';
        detail = `0/${goldSessions.size} gold sessions in top-10`;
      } else if (goldRetrieved.length < goldSessions.size) {
        classification = 'partial-evidence';
        detail = `${goldRetrieved.length}/${goldSessions.size} gold sessions in top-10`;
      } else {
        classification = 'answer-failure';
        detail = `all ${goldSessions.size} gold session(s) retrieved; answer wrong`;
      }
    }
    classificationCounts[classification] = (classificationCounts[classification] ?? 0) + 1;
    failureRows.push({
      id: qa.id, category: cat, classification, detail,
      question: row?.query, goldAnswer: row?.expectedAnswer, answerText: qa.answer?.text,
      judgeRaw: qa.judge.raw, hitsUsed: qa.hitsUsed, contextTokens: qa.contextTokens,
    });
  }

  const total = qaCases.length;
  const answerable = qaCases.filter(c => !c.shouldAbstain).length;
  const abstention = qaCases.filter(c => c.shouldAbstain).length;
  const report = {
    benchmark: 'longmemeval-s-qa-end-to-end',
    label: opts.label,
    scoreAuthority: opts.label === 'product' ? 'product-public' : 'research',
    watermark: opts.label === 'product' ? null : RESEARCH_WATERMARK,
    failedRunRecord,
    manifestExecutionKind: manifest.executionKind ?? null,
    cache: (manifest.cache ?? null) as Record<string, unknown> | null,
    // The run's evidence layer, next to the score it shaped (#222): null for a
    // manifest written before the runner recorded it.
    evidence: (manifest.evidence ?? null) as Record<string, unknown> | null,
    transportSmoke: manifest.transportSmoke === true,
    embeddingProvider: (manifest.embeddingProvider ?? null) as string | null,
    total, correct, wrong, judgeErrors, apiErrors,
    accuracyAll: pct(correct, total),
    accuracyAnswerable: pct(qaCases.filter(c => !c.shouldAbstain && c.judge?.verdict === 1).length, answerable),
    accuracyAbstention: pct(qaCases.filter(c => c.shouldAbstain && c.judge?.verdict === 1).length, abstention),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([cat, b]) => [cat, { ...b, accuracyPct: pct(b.correct, b.total) }])),
    failureClassification: classificationCounts,
    failures: failureRows,
  };
  fs.writeFileSync(path.resolve(opts.output), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const { failures, ...summaryOnly } = report;
  console.log(JSON.stringify(summaryOnly, null, 2));
}

main();