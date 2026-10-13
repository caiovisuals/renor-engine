#!/usr/bin/env node
/**
 * Paired report for scripts/eval/session-router-trial.sh (RENOR_SESSION_ROUTER).
 *
 * The comparator is a recorded run (`--baseline <dir>`: a run of run-longmemeval-product.ts whose per-question
 * results are reused, never re-run) or, when the trial ran one, its `control` arm. Every pairing says whether the two
 * runs' configurations match exactly and lists each setting that differs.
 *
 * Per arm: answer accuracy (overall, per category, per stratum), mean context tokens, and evidence delivery: every
 * `has_answer` turn inside the context the client delivered (the PageIndex scout's primary metric; a turn counts as
 * delivered when the first 50 characters of its normalised text appear in the delivered excerpts). The router arms are
 * then paired with the control on the same cases (wins, losses, exact two-sided sign test), and the router's own
 * coverage and spend come from each arm's manifest.
 *
 * Scoring side only: gold (answers, answer sessions, `has_answer` turns, categories) is read here and never reaches
 * the product process.
 *
 *   node --import tsx scripts/eval/session-router-trial-report.ts --out <trial dir> --dataset <longmemeval_s.json>
 *     [--arms replace,union,control] [--control control] [--strata <json: {name: [question ids]}>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

interface QaCase {
  id: string;
  category: string;
  contextTokens: number;
  hitsUsed: number;
  answer: { usage?: { promptTokens?: number; completionTokens?: number } } | null;
  judge: { verdict: 0 | 1 | null; usage?: unknown } | null;
  router?: Record<string, unknown>;
  error?: string;
}

interface DatasetRow {
  question_id: string;
  question_type: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}

interface ArmData {
  name: string;
  cases: Map<string, QaCase>;
  delivered: Map<string, string>;
  manifest: Record<string, unknown>;
}

const readJsonl = <T>(file: string): T[] => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T)
  : []);

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Exact two-sided sign test on discordant pairs. */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let term = 0.5 ** n; // C(n,0) / 2^n
  for (let i = 0; i <= k; i++) {
    tail += term;
    term = term * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

function loadArm(outDir: string, name: string, dir = path.join(outDir, name)): ArmData | null {
  if (!fs.existsSync(path.join(dir, 'qa-cases.jsonl'))) return null;
  const cases = new Map(readJsonl<QaCase>(path.join(dir, 'qa-cases.jsonl')).map(row => [row.id, row])); // last wins
  const delivered = new Map<string, string>();
  for (const row of readJsonl<{ id: string; hits: Array<{ text: string }> }>(path.join(dir, 'results.jsonl'))) {
    const used = cases.get(row.id)?.hitsUsed ?? 0;
    // The client's assembly: exact-duplicate collapse in order, the first `hitsUsed` excerpts.
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const hit of row.hits) {
      const text = (hit.text ?? '').trim();
      if (!text || seen.has(text)) continue;
      if (texts.length >= used) break;
      seen.add(text);
      texts.push(text);
    }
    delivered.set(row.id, normalise(texts.join('\n\n')));
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown> : {};
  return { name, cases, delivered, manifest };
}

function evidenceTurns(row: DatasetRow): string[] {
  const gold = new Set(row.answer_session_ids);
  const turns: string[] = [];
  row.haystack_sessions.forEach((session, index) => {
    if (!gold.has(row.haystack_session_ids[index])) return;
    for (const turn of session) if (turn.has_answer) turns.push(normalise(turn.content).slice(0, 50));
  });
  return turns;
}

interface EndpointTotals { questions: number; calls: number; summarized: number; promptTokens: number; completionTokens: number }

/** Summary-phase totals per endpoint that wrote them (log lines from before endpoints were recorded: 'unrecorded'). */
function summariesByEndpoint(log: Array<Record<string, unknown>>): Record<string, EndpointTotals> {
  const totals: Record<string, EndpointTotals> = {};
  for (const entry of log) {
    const key = typeof entry.endpoint === 'string' ? entry.endpoint : 'unrecorded';
    const bucket = (totals[key] ??= { questions: 0, calls: 0, summarized: 0, promptTokens: 0, completionTokens: 0 });
    bucket.questions += 1;
    for (const field of ['calls', 'summarized', 'promptTokens', 'completionTokens'] as const) {
      bucket[field] += typeof entry[field] === 'number' ? entry[field] as number : 0;
    }
  }
  return totals;
}

/**
 * A run's settings that decide its answers, apart from the session router's own knobs and the case selection.
 * Client settings at their defaults (`contextDates=false`, `stripExcerptMeta=false`, `answerStyle=direct`) are
 * dropped, because manifests written before the runner recorded them leave them out.
 */
function runConfiguration(manifest: Record<string, unknown>): Record<string, unknown> {
  const models = (manifest.models ?? {}) as Record<string, unknown>;
  const provenance = (manifest.provenance ?? {}) as Record<string, unknown>;
  const overrides = ((manifest.productMode as { overrides?: unknown[] } | undefined)?.overrides ?? [])
    .map(String)
    .filter(entry => !/^(RENOR_SESSION_ROUTER|RENOR_ROUTER_MODEL|RENOR_ROUTER_SUMMARY_MODEL|idsFile)=/.test(entry))
    .filter(entry => !['contextDates=false', 'stripExcerptMeta=false', 'answerStyle=direct'].includes(entry))
    .sort();
  return {
    answerModel: models.answerRequested, judgeModel: models.judgeRequested, topK: manifest.topK,
    maxContextTokens: manifest.maxContextTokens, temperature: manifest.temperature, overrides,
    embeddingProvider: manifest.embeddingProvider, embeddingModel: manifest.embeddingModel, embeddingDims: manifest.embeddingDims,
    datasetSha256: provenance.datasetSha256,
  };
}

/** Settings that differ between an arm and its comparator; empty means the configurations match exactly. */
export function configurationDifferences(arm: Record<string, unknown>, comparator: Record<string, unknown>): Array<{ field: string; arm: unknown; comparator: unknown }> {
  const a = runConfiguration(arm);
  const c = runConfiguration(comparator);
  return Object.keys(a)
    .filter(field => JSON.stringify(a[field]) !== JSON.stringify(c[field]))
    .map(field => ({ field, arm: a[field], comparator: c[field] }));
}

/** The two runs' evaluator code, which a recorded baseline from an older tree will not share. */
function evaluatorOf(manifest: Record<string, unknown>): string | undefined {
  const value = (manifest.provenance as { evaluatorSha256?: unknown } | undefined)?.evaluatorSha256;
  return typeof value === 'string' ? value : undefined;
}

const pct = (num: number, den: number) => (den === 0 ? '-' : `${((100 * num) / den).toFixed(1)}%`);
const fmtP = (p: number) => (p < 0.001 ? p.toExponential(1) : p.toFixed(3));

function main(): void {
  const program = new Command()
    .requiredOption('--out <dir>', 'trial directory (one subdirectory per arm)')
    .requiredOption('--dataset <path>', 'the LongMemEval dataset the trial ran (gold, for scoring only)')
    .option('--arms <list>', 'arms, comma-separated', 'replace,union,control')
    .option('--control <arm>', 'the arm the others are paired with', 'control')
    .option('--baseline <dir>', 'a recorded run of run-longmemeval-product.ts to pair with instead of a fresh control')
    .option('--strata <path>', 'JSON object of named question-id lists (non-list values are ignored)');
  program.parse(process.argv);
  const opts = program.opts<{ out: string; dataset: string; arms: string; control: string; baseline?: string; strata?: string }>();
  const outDir = path.resolve(opts.out);
  const rows = new Map((JSON.parse(fs.readFileSync(path.resolve(opts.dataset), 'utf8')) as DatasetRow[]).map(row => [row.question_id, row]));
  const arms = opts.arms.split(',').map(name => loadArm(outDir, name.trim())).filter((arm): arm is ArmData => arm !== null);
  if (opts.baseline) {
    const baseline = loadArm(outDir, 'baseline', path.resolve(opts.baseline));
    if (!baseline) throw new Error(`--baseline ${opts.baseline} has no qa-cases.jsonl`);
    arms.push(baseline);
  }
  if (arms.length === 0) throw new Error(`no arm with a qa-cases.jsonl under ${outDir}`);
  const strata: Array<[string, Set<string>]> = opts.strata
    ? Object.entries(JSON.parse(fs.readFileSync(path.resolve(opts.strata), 'utf8')) as Record<string, unknown>)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(id => typeof id === 'string'))
      .map(([name, ids]) => [name, new Set(ids)])
    : [];

  const verdict = (arm: ArmData, id: string) => arm.cases.get(id)?.judge?.verdict ?? null;
  const evidence = (arm: ArmData, id: string) => {
    const row = rows.get(id);
    const turns = row ? evidenceTurns(row) : [];
    if (turns.length === 0) return null;
    const delivered = arm.delivered.get(id) ?? '';
    return turns.every(turn => delivered.includes(turn));
  };
  const summary = (arm: ArmData, ids: Iterable<string>) => {
    let n = 0; let correct = 0; let errors = 0; let tokens = 0; let evN = 0; let evAll = 0;
    for (const id of ids) {
      const row = arm.cases.get(id);
      if (!row) continue;
      n++;
      if (row.error) errors++;
      if (row.judge?.verdict === 1) correct++;
      tokens += row.contextTokens ?? 0;
      const ev = evidence(arm, id);
      if (ev !== null) { evN++; if (ev) evAll++; }
    }
    return { n, correct, errors, meanContextTokens: n ? Math.round(tokens / n) : 0, evidenceAll: evAll, evidenceCases: evN };
  };

  const report: Record<string, unknown> = { outDir, dataset: path.resolve(opts.dataset), arms: {} as Record<string, unknown> };
  const lines: string[] = ['# Session-router trial report', ''];
  const first = arms[0].manifest as { provenance?: { gitSha?: string; gitDirty?: boolean } };
  lines.push(`Trial directory: \`${outDir}\`. Source: ${first.provenance?.gitSha ?? 'unknown'}${first.provenance?.gitDirty ? ' (dirty tree)' : ''}.`, '');
  // What each invocation ran against (session-router-trial.sh appends one line per run; never a key).
  const runs = readJsonl<Record<string, unknown>>(path.join(outDir, 'trial-runs.jsonl'));
  if (runs.length > 0) {
    report.runs = runs;
    lines.push('| run started | source | arms | summaries | router | reader | judge |', '|---|---|---|---|---|---|---|');
    for (const run of runs) {
      const at = (model: unknown, endpoint: unknown) => `${String(model ?? '')} @ ${String(endpoint ?? '')}`;
      lines.push(`| ${String(run.at ?? '')} | ${String(run.gitSha ?? '').slice(0, 8)}${run.gitDirty ? ' (dirty)' : ''} | ${String(run.arms ?? '')} | ${at(run.summaryModel, run.summaryEndpoint)} | ${at(run.routerModel, run.routerEndpoint)} | ${at(run.readerModel, run.readerEndpoint)} | ${at(run.judgeModel, run.judgeEndpoint)} |`);
    }
    lines.push('');
  }

  lines.push('| arm | cases | correct | accuracy | errors | mean context tokens | all evidence delivered |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const arm of arms) {
    const s = summary(arm, arm.cases.keys());
    (report.arms as Record<string, unknown>)[arm.name] = {
      ...s,
      productOverrides: (arm.manifest.productMode as { overrides?: unknown } | undefined)?.overrides ?? null,
      models: arm.manifest.models ?? null,
      routerCoverage: arm.manifest.routerCoverage ?? null,
      readerTokens: [...arm.cases.values()].reduce((acc, row) => ({
        prompt: acc.prompt + (row.answer?.usage?.promptTokens ?? 0),
        completion: acc.completion + (row.answer?.usage?.completionTokens ?? 0),
      }), { prompt: 0, completion: 0 }),
    };
    lines.push(`| ${arm.name} | ${s.n} | ${s.correct} | ${pct(s.correct, s.n)} | ${s.errors} | ${s.meanContextTokens} | ${s.evidenceAll}/${s.evidenceCases} |`);
  }

  // The comparator: the trial's own control arm when it ran one, else the recorded baseline.
  const control = arms.find(arm => arm.name === opts.control) ?? arms.find(arm => arm.name === 'baseline');
  if (control) {
    const source = control.name === 'baseline' ? `the recorded run ${path.resolve(opts.baseline ?? '')}` : 'a fresh control arm';
    lines.push('', `## Paired with \`${control.name}\` (${source}; same cases, both judged)`, '', '| arm | cases | wins | losses | net | sign test p | configuration |', '|---|---:|---:|---:|---:|---:|---|');
    const paired: Record<string, unknown> = {};
    for (const arm of arms.filter(other => other !== control)) {
      let n = 0; let wins = 0; let losses = 0;
      for (const id of arm.cases.keys()) {
        const a = verdict(arm, id);
        const c = verdict(control, id);
        if (a === null || c === null) continue;
        n++;
        if (a === 1 && c === 0) wins++;
        if (a === 0 && c === 1) losses++;
      }
      const p = signTestP(wins, losses);
      const differences = configurationDifferences(arm.manifest, control.manifest);
      const sameEvaluator = evaluatorOf(arm.manifest) === evaluatorOf(control.manifest);
      paired[arm.name] = {
        comparator: control.name, cases: n, wins, losses, net: wins - losses, p, configurationDifferences: differences,
        evaluator: { arm: evaluatorOf(arm.manifest) ?? null, comparator: evaluatorOf(control.manifest) ?? null, same: sameEvaluator },
      };
      const configuration = (differences.length === 0 ? 'settings match exactly' : `settings differ: ${differences.map(d => d.field).join(', ')}`)
        + (sameEvaluator ? '' : '; evaluator code differs');
      lines.push(`| ${arm.name} | ${n} | ${wins} | ${losses} | ${wins - losses >= 0 ? '+' : ''}${wins - losses} | ${fmtP(p)} | ${configuration} |`);
    }
    report.pairedWithControl = paired;
  }

  const categories = [...new Set(arms.flatMap(arm => [...arm.cases.values()].map(row => row.category)))].sort();
  lines.push('', '## Accuracy by category', '', `| category | ${arms.map(arm => arm.name).join(' | ')} |`, `|---|${arms.map(() => '---:').join('|')}|`);
  const byCategory: Record<string, unknown> = {};
  for (const category of categories) {
    const cells = arms.map(arm => {
      const ids = [...arm.cases.values()].filter(row => row.category === category).map(row => row.id);
      const s = summary(arm, ids);
      (byCategory[category] ??= {} as Record<string, unknown>);
      (byCategory[category] as Record<string, unknown>)[arm.name] = { n: s.n, correct: s.correct };
      return `${s.correct}/${s.n}`;
    });
    lines.push(`| ${category} | ${cells.join(' | ')} |`);
  }
  report.byCategory = byCategory;

  if (strata.length > 0) {
    lines.push('', '## Strata', '', `| stratum | ${arms.map(arm => `${arm.name} correct`).join(' | ')} | ${arms.map(arm => `${arm.name} all evidence`).join(' | ')} |`,
      `|---|${arms.map(() => '---:').join('|')}|${arms.map(() => '---:').join('|')}|`);
    const byStratum: Record<string, unknown> = {};
    for (const [name, ids] of strata) {
      const stats = arms.map(arm => summary(arm, ids));
      byStratum[name] = Object.fromEntries(arms.map((arm, i) => [arm.name, stats[i]]));
      lines.push(`| ${name} | ${stats.map(s => `${s.correct}/${s.n}`).join(' | ')} | ${stats.map(s => `${s.evidenceAll}/${s.evidenceCases}`).join(' | ')} |`);
    }
    report.byStratum = byStratum;
  }

  // The trial's summary phase (session-router-warm.ts): one line per question per run; a rerun over cached notes adds
  // zero calls, so the sums are what the summaries cost in total.
  const summaryLog = readJsonl<Record<string, unknown>>(path.join(outDir, 'summaries.jsonl'));
  if (summaryLog.length > 0) {
    const sum = (key: string) => summaryLog.reduce((total, entry) => total + (typeof entry[key] === 'number' ? entry[key] as number : 0), 0);
    const phase = {
      questions: new Set(summaryLog.map(entry => entry.id)).size,
      runs: summaryLog.length,
      models: [...new Set(summaryLog.map(entry => entry.model))],
      // Calls and tokens per endpoint that wrote summaries (lines from before endpoints were recorded: 'unrecorded').
      byEndpoint: summariesByEndpoint(summaryLog),
      summarized: sum('summarized'),
      // Failures still open: each question's latest run.
      failed: [...new Map(summaryLog.map(entry => [entry.id, entry])).values()]
        .reduce((total, entry) => total + (typeof entry.failed === 'number' ? entry.failed : 0), 0),
      calls: sum('calls'),
      promptTokens: sum('promptTokens'),
      completionTokens: sum('completionTokens'),
      ms: sum('ms'),
    };
    report.summaryPhase = phase;
    lines.push('', '## Summary phase (index time)', '', `\`${JSON.stringify(phase)}\``);
  }

  const routerArms = arms.filter(arm => arm.manifest.routerCoverage);
  if (routerArms.length > 0) {
    lines.push('', '## Router coverage and spend', '');
    for (const arm of routerArms) {
      lines.push(`- **${arm.name}**: \`${JSON.stringify(arm.manifest.routerCoverage)}\``);
    }
  }
  lines.push('', 'Evidence delivery is scored offline from the dataset\'s `has_answer` turns (first 50 normalised characters); accuracy is the judge\'s verdict. Cases with an error count in `cases` and never as correct.');

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n') + '\n');
  process.stdout.write(lines.join('\n') + '\n');
}

const invokedDirectly = process.argv[1]?.endsWith('session-router-trial-report.ts') === true;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  }
}
