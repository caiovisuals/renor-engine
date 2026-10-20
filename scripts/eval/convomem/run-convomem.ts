/**
 * Renor-on-ConvoMem end-to-end runner (scripts/eval/convomem/).
 *
 * Chains the existing stages; it adds no answer, judge or retrieval logic of its own:
 *
 *   1. retrieval  scripts/eval/locomo/run-retrieval.ts over the split's adapter cases
 *                 (per-case isolated vault + index, the LoCoMo/BEAM retrieval path)
 *   2. QA         scripts/eval/run-longmemeval-qa.ts — the same answer prompt, judge prompt,
 *                 eval cache, sentinels and run-ledger record as LongMemEval; every reader
 *                 option after `--` is passed to it unchanged, and the run is recorded on the
 *                 ledger as `convomem-<split>-qa-end-to-end`
 *   3. score      scripts/eval/convomem/score-convomem.ts — per-category accuracy + retrieval
 *
 * `--abstention-answer-style <style>` runs the abstention ids as a second QA run with that
 * answer style (the measured 2026-09-20 protocol: `bestguess` for the five answerable
 * categories, `direct` for abstention); the scorer merges the two disjoint runs.
 *
 * `--dry-run` runs all of it offline on a tiny synthetic fixture (never benchmark data):
 * the adapter (build-corpus.py --local-files) builds six categories × (1 champion + 1 holdout),
 * retrieval uses the eval-hash embedding, and both models are a loopback stub server. The
 * children get a scrubbed environment (throwaway HOME, scratch run ledger, no credentials),
 * so a dry run cannot reach a provider, the shared ledger or the shared caches. Its report is
 * labelled dry-run-wiring-smoke with qualityEligible=false.
 *
 * Paid stages (Vertex retrieval, the answer and judge models) run only without --dry-run,
 * on the benchmark machine, with the credentials named by the passed-through QA options.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { scoreConvoMemDirs, CONVOMEM_CATEGORIES } from './score-convomem';
import type { ConvoMemReport } from './score-convomem';

const ENGINE_ROOT = path.resolve(__dirname, '../../..');
const BUILD_CORPUS = 'scripts/eval/convomem/build-corpus.py';
const RETRIEVAL = 'scripts/eval/locomo/run-retrieval.ts';
const QA = 'scripts/eval/run-longmemeval-qa.ts';

/** Options this runner sets on the QA stage itself; passing them after `--` is refused. */
export const RESERVED_QA_OPTIONS = ['--run', '--output', '--ids-file', '--dataset'] as const;

export const STUB_ANSWER_MODEL = 'convomem-stub-answer';
export const STUB_JUDGE_MODEL = 'convomem-stub-judge';

interface AdapterCase { id: string; split: string; category: string; shouldAbstain: boolean }

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  process.stderr.write(`[convomem] $ ${cmd} ${args.join(' ')}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ENGINE_ROOT, env, stdio: ['ignore', 2, 2] });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`exited ${code}: ${cmd} ${args.join(' ')}`))));
  });
}

const tsx = (script: string, args: string[], env: NodeJS.ProcessEnv) => run(process.execPath, ['--import', 'tsx', script, ...args], env);

/** Drop `--flag value` / `--flag=value` pairs for the named flags. */
export function stripOption(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { i++; continue; }
    if (args[i].startsWith(`${flag}=`)) continue;
    out.push(args[i]);
  }
  return out;
}

export function assertNoReservedQaOptions(args: string[]): void {
  const hit = args.find(arg => RESERVED_QA_OPTIONS.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (hit) throw new Error(`${hit} is set by run-convomem itself; remove it from the QA options after --`);
}

// ─── dry-run fixture and stub model ───

/**
 * Synthetic evidence files in the ConvoMem shape (evidence_items[].conversations[].messages),
 * two unique items per category: one champion, one holdout. Each item has a filler
 * conversation (containsEvidence: false) and an evidence conversation (true).
 */
export function writeSyntheticFixture(dir: string): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true });
  const facts: Record<string, Array<{ fact: string; question: string; answer: string; speaker?: string }>> = {
    user_facts: [
      { fact: 'My sister Ines lives in Porto.', question: 'Where does my sister Ines live?', answer: 'Porto' },
      { fact: 'I drive a green Volvo wagon.', question: 'What car do I drive?', answer: 'Volvo' },
    ],
    assistant_facts: [
      { fact: 'I recommended the book Dune to you.', question: 'Which book did you recommend to me?', answer: 'Dune', speaker: 'Assistant' },
      { fact: 'I suggested calling the client at 9am.', question: 'What time did you suggest calling the client?', answer: '9am', speaker: 'Assistant' },
    ],
    changing_facts: [
      { fact: 'My team standup moved from Monday to Thursday.', question: 'Which day is my team standup now?', answer: 'Thursday' },
      { fact: 'My call quota went up from 80 to 120 calls a day.', question: 'What is my daily call quota now?', answer: '120' },
    ],
    abstention: [
      { fact: 'I mostly sell solar panel leases.', question: 'What is the name of my manager?', answer: 'There is no information about your manager.' },
      { fact: 'I take my lunch break at noon.', question: 'What is my employee badge number?', answer: 'There is no information about your badge number.' },
    ],
    preferences: [
      { fact: 'I prefer scripts that open with a question.', question: 'How should my call script open?', answer: 'question' },
      { fact: 'I like short bullet summaries after calls.', question: 'What format do I like for call summaries?', answer: 'bullet' },
    ],
    implicit_connections: [
      { fact: 'I broke my wrist last week so typing hurts.', question: 'Should I log calls by typing long notes this week?', answer: 'wrist' },
      { fact: 'I am allergic to peanuts.', question: 'Can I eat the satay at the team lunch?', answer: 'peanuts' },
    ],
  };
  const files: Record<string, string> = {};
  for (const category of CONVOMEM_CATEGORIES) {
    const items = facts[category].map((f, i) => ({
      question: f.question,
      answer: f.answer,
      personId: 'synthetic-telemarketer',
      conversations: [
        {
          id: `${category}-${i}-filler`,
          containsEvidence: false,
          messages: [
            { speaker: 'User', text: 'Can you help me plan tomorrow\'s call list?' },
            { speaker: 'Assistant', text: 'Sure, start with the warm leads from this week.' },
          ],
        },
        {
          id: `${category}-${i}-evidence`,
          containsEvidence: true,
          messages: f.speaker === 'Assistant'
            ? [{ speaker: 'User', text: 'Any ideas for me?' }, { speaker: 'Assistant', text: f.fact }]
            : [{ speaker: 'User', text: f.fact }, { speaker: 'Assistant', text: 'Noted.' }],
        },
      ],
    }));
    const file = path.join(dir, `${category}.json`);
    fs.writeFileSync(file, JSON.stringify({ evidence_items: items }, null, 2) + '\n');
    files[category] = file;
  }
  return files;
}

export interface StubServer { baseUrl: string; requests: () => number; close(): Promise<void> }

/**
 * OpenAI-compatible /chat/completions stub on loopback. Answerer: echoes the retrieved
 * excerpts (no excerpts → "I don't know"). Judge: 1 when the ground truth appears in the
 * assistant's answer, case-insensitively, else 0. Answers both stages' health sentinels.
 * Deterministic; it measures wiring, never quality.
 */
export async function startStubModel(): Promise<StubServer> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests++;
      const request = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
      const last = request.messages[request.messages.length - 1]?.content ?? '';
      let content: string;
      if (/^Reply with exactly OK/.test(last)) content = 'OK';
      else if (/^Reply with exactly 1/.test(last)) content = '1';
      else if (request.model === STUB_JUDGE_MODEL) {
        const gold = /Ground truth answer: ([\s\S]*?)\n\nAssistant's answer: /.exec(last)?.[1]?.trim().toLowerCase() ?? '';
        const answer = /Assistant's answer: ([\s\S]*?)\n\nDoes the assistant's answer/.exec(last)?.[1]?.toLowerCase() ?? '';
        content = gold && answer.includes(gold) ? '1' : '0';
      } else {
        const excerpts = /excerpts \(retrieved from long-term memory, highest relevance first\):\n\n([\s\S]*?)\n\nQuestion \(asked on/.exec(last)?.[1]?.trim() ?? '';
        content = excerpts ? excerpts.replace(/\s+/g, ' ') : 'I don\'t know';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: request.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}

// ─── the pipeline ───

export interface ConvoMemRunArgs {
  adapter: string;
  output: string;
  split: 'champion' | 'holdout';
  provider: string;
  topK: number;
  retrieval?: string;
  abstentionAnswerStyle?: string;
  qaArgs: string[];
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
}

export async function runConvoMem(args: ConvoMemRunArgs): Promise<ConvoMemReport> {
  assertNoReservedQaOptions(args.qaArgs);
  const adapter = path.resolve(args.adapter);
  const output = path.resolve(args.output);
  fs.mkdirSync(output, { recursive: true });
  const all = readJsonl<AdapterCase>(path.join(adapter, 'cases.jsonl'));
  const cases = all.filter(row => row.split === args.split);
  if (cases.length === 0) throw new Error(`No ${args.split} cases in ${adapter}/cases.jsonl`);

  // 1. retrieval over this split's cases only (the other split is never embedded).
  let retrievalDir: string;
  if (args.retrieval) {
    retrievalDir = path.resolve(args.retrieval);
    const have = new Set(readJsonl<{ id: string }>(path.join(retrievalDir, 'results.jsonl')).map(row => row.id));
    const missing = cases.filter(row => !have.has(row.id)).map(row => row.id);
    if (missing.length) throw new Error(`--retrieval ${retrievalDir} lacks ${missing.length} ${args.split} case(s), e.g. ${missing[0]}`);
  } else {
    const splitCases = path.join(output, `cases-${args.split}.jsonl`);
    fs.writeFileSync(splitCases, fs.readFileSync(path.join(adapter, 'cases.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).filter(line => (JSON.parse(line) as AdapterCase).split === args.split).join('\n') + '\n');
    retrievalDir = path.join(output, 'retrieval');
    await tsx(RETRIEVAL, ['--cases', splitCases, '--output', retrievalDir, '--provider', args.provider, '--top-k', String(args.topK)], args.env);
  }

  // 2. QA — one run, or two disjoint runs when abstention gets its own answer style.
  const dataset = path.join(adapter, 'convomem-dataset.json');
  // The QA stage is a frozen evaluator source and keeps its own label (`longmemeval-s-qa-end-to-end`) on its manifest and
  // ledger row; this run's identity is `convomem-run.json` below and the ConvoMem retrieval run those records hash.
  const benchmark = `convomem-${args.split}-qa-end-to-end`;
  const groups: Array<{ name: string; ids: string[]; qaArgs: string[] }> = args.abstentionAnswerStyle
    ? [
        { name: 'qa-answerable', ids: cases.filter(c => !c.shouldAbstain).map(c => c.id), qaArgs: args.qaArgs },
        {
          name: 'qa-abstention',
          ids: cases.filter(c => c.shouldAbstain).map(c => c.id),
          qaArgs: [...stripOption(args.qaArgs, '--answer-style'), '--answer-style', args.abstentionAnswerStyle],
        },
      ]
    : [{ name: 'qa', ids: cases.map(c => c.id), qaArgs: args.qaArgs }];
  const qaDirs: string[] = [];
  for (const group of groups) {
    if (group.ids.length === 0) continue;
    const idsFile = path.join(output, `${group.name}-ids.txt`);
    fs.writeFileSync(idsFile, group.ids.join('\n') + '\n');
    const qaDir = path.join(output, group.name);
    await tsx(QA, ['--run', retrievalDir, '--output', qaDir, '--ids-file', idsFile, '--dataset', dataset, ...group.qaArgs], args.env);
    qaDirs.push(qaDir);
  }

  // 3. score
  const report = scoreConvoMemDirs({ run: retrievalDir, qa: qaDirs, output, dryRun: args.dryRun });
  fs.writeFileSync(path.join(output, 'convomem-run.json'), JSON.stringify({
    benchmark, split: args.split, dryRun: args.dryRun, adapter, retrievalDir, qaDirs,
    provider: args.retrieval ? null : args.provider, topK: args.retrieval ? null : args.topK,
    abstentionAnswerStyle: args.abstentionAnswerStyle ?? null, qaArgs: args.qaArgs,
    finishedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  return report;
}

/** The whole pipeline offline: synthetic fixture → adapter → eval-hash retrieval → stub QA → score. */
export async function runDryRun(args: { output: string; split: 'champion' | 'holdout'; abstentionAnswerStyle?: string; qaArgs: string[] }): Promise<ConvoMemReport> {
  const output = path.resolve(args.output);
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) throw new Error(`--dry-run needs a new or empty --output (got ${output})`);
  const raw = writeSyntheticFixture(path.join(output, 'fixture'));
  const adapter = path.join(output, 'adapter');
  const home = path.join(output, 'home');
  fs.mkdirSync(home, { recursive: true });
  // Scrubbed: no credential, no shared ledger or cache reaches a child.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    HOME: home,
    RENOR_EVAL_RUN_LEDGER: path.join(output, 'run-ledger.jsonl'),
    RENOR_EVAL_EMBED_CACHE: 'off',
    RENOR_EVAL_CACHE: 'off',
    CONVOMEM_STUB_KEY: 'stub-key',
  };
  await run('python3', [BUILD_CORPUS, '--output', adapter, '--raw-dir', path.join(output, 'raw-unused'), '--n-champion', '1', '--n-holdout', '1',
    '--local-files', ...Object.entries(raw).map(([cat, file]) => `${cat}=${file}`)], env);
  const stub = await startStubModel();
  try {
    return await runConvoMem({
      adapter, output: path.join(output, 'run'), split: args.split, provider: 'eval-hash', topK: 20,
      abstentionAnswerStyle: args.abstentionAnswerStyle,
      qaArgs: [
        '--base-url', stub.baseUrl, '--api-key-env', 'CONVOMEM_STUB_KEY',
        '--answer-model', STUB_ANSWER_MODEL, '--judge-model', STUB_JUDGE_MODEL,
        '--no-cache', '--retries', '1', '--recency-order', '--answer-style', 'bestguess',
        ...args.qaArgs,
      ],
      env,
      dryRun: true,
    });
  } finally {
    await stub.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const qaArgs = sep >= 0 ? argv.slice(sep + 1) : [];
  const opts = new Command()
    .name('run-convomem')
    .usage('[options] -- [run-longmemeval-qa reader options]')
    .requiredOption('--output <dir>', 'run directory (retrieval/, qa*/, score-report.json)')
    .option('--adapter <dir>', 'build-corpus.py output (cases.jsonl, convomem-dataset.json); required unless --dry-run')
    .option('--split <name>', 'champion or holdout', 'champion')
    .option('--provider <kind>', 'retrieval embedding provider: vertex, local or eval-hash', 'vertex')
    .option('--top-k <n>', 'retrieval depth', '20')
    .option('--retrieval <dir>', 'reuse a completed retrieval run instead of running retrieval')
    .option('--abstention-answer-style <style>', 'answer abstention ids in a second QA run with this style (e.g. direct)')
    .option('--dry-run', 'offline end-to-end smoke: synthetic fixture, eval-hash retrieval, stub models, scrubbed env')
    .parse(['node', 'run-convomem', ...own])
    .opts<{ output: string; adapter?: string; split: string; provider: string; topK: string; retrieval?: string; abstentionAnswerStyle?: string; dryRun?: boolean }>();
  if (opts.split !== 'champion' && opts.split !== 'holdout') throw new Error(`--split must be champion or holdout (got ${opts.split})`);
  let report: ConvoMemReport;
  if (opts.dryRun) {
    if (opts.adapter || opts.retrieval) throw new Error('--dry-run builds its own fixture; do not pass --adapter or --retrieval');
    report = await runDryRun({ output: opts.output, split: opts.split, abstentionAnswerStyle: opts.abstentionAnswerStyle, qaArgs });
  } else {
    if (!opts.adapter) throw new Error('--adapter is required (or pass --dry-run)');
    report = await runConvoMem({
      adapter: opts.adapter, output: opts.output, split: opts.split, provider: opts.provider, topK: Number(opts.topK),
      retrieval: opts.retrieval, abstentionAnswerStyle: opts.abstentionAnswerStyle, qaArgs, env: process.env, dryRun: false,
    });
  }
  const { failures, ...summary } = report;
  void failures;
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
