#!/usr/bin/env node
/**
 * Summary phase of the session-router trial (scripts/eval/session-router-trial.sh): for each selected question, render
 * its vault exactly as the benchmark client does and run the product's own `renor index` with RENOR_SESSION_ROUTER
 * armed, so the shared router cache (RENOR_ROUTER_CACHE) holds every note's title + summary before any arm answers.
 * No search, no reader, no judge: the router's settings come from this process's environment (the trial script sets
 * them), and a note already in the cache costs nothing.
 *
 * Why a phase of its own: summaries are almost all of the trial's model calls (~11 per 49-session haystack), and a
 * call budget here lets them be built over several provider days while every arm still answers on one day.
 *
 * Appends one JSON line per question to --log (its `[router] summaries` stats, the source SHA and, when the trial
 * names it in RENOR_TRIAL_SUMMARY_ENDPOINT, the endpoint that wrote them); exit 0 when every question is
 * summarised, 3 when --max-calls stopped it first (rerun to continue), 1 on an index failure.
 *
 *   node --import tsx scripts/eval/session-router-warm.ts --dataset <json> --log <jsonl> --max-calls <n> [--ids-file <f>] [--limit <n>]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { parseRouterSummaryLine, writeQuestionVault } from './run-longmemeval-product';
import type { LongMemInstance } from '../../src/eval/longmemeval';
import { gitState } from '../../src/eval/runManifest';

/** The most calls one haystack has needed (49 sessions at 56,000 characters per call, plus a retry), for the stop rule. */
const CALLS_PER_QUESTION_CEILING = 14;

function runIndex(env: Record<string, string>, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'index'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function main(): Promise<number> {
  const program = new Command()
    .requiredOption('--dataset <path>', 'LongMemEval dataset')
    .requiredOption('--log <path>', 'JSONL of per-question summary stats (appended)')
    .requiredOption('--max-calls <n>', 'stop before a question that could take the run past this many summary calls')
    .option('--ids-file <path>', 'question ids, one per line')
    .option('--limit <n>', 'first n questions when no ids file (0 = all)', '0');
  program.parse(process.argv);
  const opts = program.opts<{ dataset: string; log: string; maxCalls: string; idsFile?: string; limit: string }>();
  const maxCalls = Number(opts.maxCalls);
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error('--max-calls must be a non-negative integer');
  if ((process.env.RENOR_SESSION_ROUTER ?? '').trim() === '') throw new Error('RENOR_SESSION_ROUTER must be armed for the summary phase');
  if (!process.env.RENOR_ROUTER_CACHE) throw new Error('RENOR_ROUTER_CACHE must name the trial\'s shared router cache');

  const rows = JSON.parse(fs.readFileSync(path.resolve(opts.dataset), 'utf8')) as LongMemInstance[];
  let selected = Number(opts.limit) > 0 ? rows.slice(0, Number(opts.limit)) : rows;
  if (opts.idsFile) {
    const wanted = new Set(fs.readFileSync(path.resolve(opts.idsFile), 'utf8').trim().split(/\r?\n/).filter(Boolean));
    selected = rows.filter(row => wanted.has(row.question_id));
  }
  const done = new Set(fs.existsSync(opts.log)
    ? fs.readFileSync(opts.log, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { id: string; failed: number })
      .filter(entry => entry.failed === 0).map(entry => entry.id)
    : []);
  const cwd = path.resolve(__dirname, '..', '..');
  // Summaries may be written at another commit than the arms run at: every line names its source.
  const source = gitState(cwd);
  let calls = 0;
  for (const row of selected) {
    if (done.has(row.question_id)) continue;
    if (calls + CALLS_PER_QUESTION_CEILING > maxCalls) {
      process.stderr.write(`[warm] stopped by --max-calls ${maxCalls} after ${calls} call(s); rerun to continue\n`);
      return 3;
    }
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-warm-'));
    try {
      const rendered = await writeQuestionVault(workDir, row);
      const env = { VAULT_PATH: rendered.vaultDir, DB_PATH: path.join(workDir, 'product.db'), LLM_EXTRACTION: 'false' };
      const result = await runIndex(env, cwd);
      const stats = parseRouterSummaryLine(result.stdout);
      if (!stats) {
        process.stderr.write(`[warm] ${row.question_id}: index printed no router summary line (exit ${result.code}): ${result.stderr.slice(-400)}\n`);
        return 1;
      }
      calls += typeof stats.calls === 'number' ? stats.calls : 0;
      const endpoint = process.env.RENOR_TRIAL_SUMMARY_ENDPOINT?.trim();
      fs.appendFileSync(opts.log, JSON.stringify({
        id: row.question_id, at: new Date().toISOString(), gitSha: source.sha, gitDirty: source.dirty, ...(endpoint ? { endpoint } : {}), ...stats,
      }) + '\n');
      process.stderr.write(`[warm] ${row.question_id}: ${JSON.stringify(stats)}\n`);
      if (result.code !== 0) {
        process.stderr.write(`[warm] ${row.question_id}: index failed (exit ${result.code}); rerun to retry it\n${result.stderr.slice(-400)}\n`);
        return 1;
      }
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }
  process.stderr.write(`[warm] every selected question is summarised (${calls} call(s) this run)\n`);
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith('session-router-warm.ts') === true;
if (invokedDirectly) {
  main().then(code => process.exit(code), error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
