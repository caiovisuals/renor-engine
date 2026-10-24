#!/usr/bin/env node
/**
 * Authoritative product-path LongMemEval QA runner — EXTERNAL CLIENT ONLY.
 *
 * Trust boundary (enforced by tests/eval/product-path-contract.test.ts):
 *   - This module must NOT import src/indexer, src/retrieval, src/mvp,
 *     src/evidence, src/db, src/embeddings, or any scripts/night module. It may
 *     import ONLY src/eval/* measurement infrastructure and its public-surface
 *     transport (here: the `renor` CLI as a subprocess).
 *   - For each case it prepares a temporary product instance (temp vault dir +
 *     temp SQLite DB), has the PRODUCT index the rendered markdown through its
 *     own public CLI, and then asks the public surface for the answer context.
 *     It never imports or invokes context-assembly internals.
 *   - Gold fields (answer, answer_session_ids, question_type, shouldAbstain)
 *     never reach the product process: the runtime input set is built only
 *     from question_id/question/question_date/haystack_* (the allowlist) and
 *     is structurally checked (assertGoldIsolatedRuntimeInputs) + proven
 *     gold-parity by the poisoned-fixture contract test. Gold
 *     (expectedAnswer) enters ONLY the judge prompt — scoring infrastructure.
 *   - Research sidecar flags are refused (assertNoSidecarFlags): this runner is
 *     executionKind=product-public by construction.
 *
 * Cache discipline: reuse of src/eval/evalCache v3. `--no-cache` is required
 * for promotion arms (zero reads/hits); cached iteration arms pin
 * RENOR_QA_CACHE_SCOPE + --cache-dir. The manifest records reads/hits/writes
 * and the arm role; the scorer refuses promotion arms with cache reads.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { countTextTokens } from '../../src/eval/textTokens';
import {
  assertGoldIsolatedRuntimeInputs,
  assertNoSidecarFlags,
  datasetSha256File,
  evaluatorSourceHash,
  gitState,
  MANIFEST_CONTRACT_VERSION,
  packageLockSha256,
  productFeatureFlagOverrides,
  PRODUCT_RUNTIME_FIELD_ALLOWLIST,
  type CacheArm,
} from '../../src/eval/runManifest';
import { claimDirectory, sha256 } from '../../src/eval/artifacts';
import {
  EvalCache,
  KeyPool,
  resolveCacheScope,
  resolveEvalCachePath,
  resolveJudgeKeys,
  runWithKeyPoolRetries,
  CACHE_SCHEMA_VERSION,
} from '../../src/eval/evalCache';
import { buildCacheReport, emitCacheReport, proxyWindow, readProxyCounters } from '../../src/eval/cacheReport';
import { indexConfig, resolveSnapshotRoot, resolveVaultBase, restoredReplay, SnapshotStore, vaultSignature, type IndexReplay } from '../../src/eval/indexSnapshots';
import { type LongMemInstance, type LongMemTurn, parseTimestamp, validateLongMemRows } from '../../src/eval/longmemeval';
import { admitRun, archiveRow, codeIdentity, productEnvironment, questionSet, recordRun, resolveRunLedgerPath, RUN_LEDGER_ENV, RunRefusedError, saveRunOutcome, type RunRecord } from '../../src/eval/runLedger';

// ─── Dataset → markdown rendering (harness-side preparation of the product input) ───

export function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const prefix = normalized.slice(0, 100) || 'session';
  return `${prefix}-${sha256(value).slice(0, 10)}`;
}

export function renderSession(id: string, date: string, turns: LongMemTurn[]): string {
  const body = turns.map((turn, index) => {
    const role = turn.role === 'assistant' ? 'Assistant' : turn.role === 'user' ? 'User' : turn.role;
    return `### Turn ${index + 1} — ${role}\n\n${turn.content}`;
  }).join('\n\n');
  return `---\nkind: longmemeval-session\nsession_id: ${JSON.stringify(id)}\nsession_date: ${JSON.stringify(date)}\n---\n# Session ${id}\n\nTimestamp: ${date}\n\n${body}\n`;
}

interface RenderedVault {
  vaultDir: string;
  /** Relative markdown paths with content hashes — the runtime input snapshot. */
  files: Array<{ relativePath: string; sha256: string }>;
}

export async function writeQuestionVault(root: string, row: LongMemInstance): Promise<RenderedVault> {
  if (row.haystack_session_ids.length !== row.haystack_sessions.length
    || row.haystack_dates.length !== row.haystack_sessions.length) {
    throw new Error(`Malformed LongMemEval instance ${row.question_id}: haystack arrays differ in length`);
  }
  const vaultDir = path.join(root, 'vault');
  const sessionsDir = path.join(vaultDir, 'Sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const files: RenderedVault['files'] = [];
  const occurrences = new Map<string, number>();
  for (let index = 0; index < row.haystack_sessions.length; index++) {
    const id = row.haystack_session_ids[index];
    const dateText = row.haystack_dates[index];
    const nth = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, nth);
    // Repeated noise sessions get an occurrence suffix (identical rule to the
    // research runner) so no haystack content is silently overwritten.
    const segment = nth === 1 ? safeSegment(id) : `${safeSegment(id)}-occ${nth}`;
    const relative = `Sessions/${segment}.md`;
    const content = renderSession(id, dateText, row.haystack_sessions[index]);
    await fsp.writeFile(path.join(vaultDir, relative), content, 'utf8');
    files.push({ relativePath: relative, sha256: sha256(content) });
    const timestamp = parseTimestamp(dateText);
    await fsp.utimes(path.join(vaultDir, relative), timestamp, timestamp);
  }
  return { vaultDir, files };
}

// ─── Public surface transport (CLI subprocess) ───

export interface PublicHit { notePath: string; text: string; score: number; session_date?: string }
export interface PublicSearchResult {
  hits: PublicHit[];
  /** C0 composed structured context (RENOR_STRUCTURED_CONTEXT) when the CLI composer is armed. */
  composedContext?: { text?: string };
  /** The surface's own report of its evidence pass (`search --json` `evidence`); absent when the pass is off. */
  evidence?: unknown;
  transport: string;
  command: string;
  durationMs: number;
  /** The session router's report from `search --json` when RENOR_SESSION_ROUTER is armed (ok, or why it stepped aside). */
  router?: Record<string, unknown>;
  /** The index phase's `[router] summaries` line when RENOR_SESSION_ROUTER is armed (summary calls, tokens, failures). */
  routerSummaries?: Record<string, unknown>;
  /** The write-time digest report from `search --json` when RENOR_DIGESTS is armed (the rendered table's items and where they came from). */
  digest?: Record<string, unknown>;
  /** The index phase's `[digests]` line when RENOR_DIGESTS is armed (calls, tokens, failures). */
  digestStats?: Record<string, unknown>;
  /** Wall time of the `cli index` spawn; absent when the index was restored from a snapshot. */
  indexMs?: number;
}
export interface PublicSearchArgs {
  query: string;
  vaultDir: string;
  dbPath: string;
  env: Record<string, string>;
  topK: number;
  cwd: string;
  /**
   * Index snapshots (src/eval/indexSnapshots.ts). `skip`: the index was restored into dbPath, so `cli index` does not
   * run; `replay` is what the build that made it printed about its router/digest calls. `onBuilt` is called once a
   * fresh index has been built and checked, before any search opens it: the moment to snapshot.
   */
  index?: {
    skip?: boolean;
    replay?: IndexReplay;
    onBuilt?: (built: { indexMs: number; replay: IndexReplay }) => void;
  };
}

/** Run-aborting precondition failure (distinct from per-case model/API errors). */
export class ProductPreconditionError extends Error {}

/** The `[router] summaries {json}` line the CLI index prints when RENOR_SESSION_ROUTER is armed. Exported for tests. */
export function parseRouterSummaryLine(indexStdout: string): Record<string, unknown> | undefined {
  const prefix = '[router] summaries ';
  const line = indexStdout.split(/\r?\n/).find(candidate => candidate.startsWith(prefix));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The `[digests] {json}` line the CLI index prints when RENOR_DIGESTS is armed. Exported for tests. */
export function parseDigestStatsLine(indexStdout: string): Record<string, unknown> | undefined {
  const prefix = '[digests] ';
  const line = indexStdout.split(/\r?\n/).find(candidate => candidate.startsWith(prefix));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the CLI index phase's summary line for per-file errors. Exported for tests. */
export function parseIndexErrors(indexStdout: string): { indexed: number; total: number; errors: number } {
  const doneMatch = /Done\.\s*(\d+)\/(\d+)\s*indexed,\s*(\d+)\s*errors?/.exec(indexStdout);
  if (!doneMatch) {
    // No summary line at all is itself a failure: we cannot prove the vault indexed cleanly.
    return { indexed: -1, total: -1, errors: -1 };
  }
  return { indexed: Number(doneMatch[1]), total: Number(doneMatch[2]), errors: Number(doneMatch[3]) };
}

/**
 * Default public client: spawn the shipped CLI as an external process.
 * `index` ingests the rendered markdown through the product indexer; `search
 * --json` returns the public answer context. The product process receives ONLY
 * the vault directory, the SQLite path, and the query — never gold fields.
 *
 * Mechanical preconditions (product-truth): a partial index failure must abort
 * the run — it would otherwise yield an empty-but-plausible retrieval path and a
 * quietly wrong score (the smoke's 1/10 lesson). Two independent signals carry
 * that: the CLI's exit status (it exits non-zero as of #188) and its summary
 * line, which is still parsed so the precondition does not rest on either one
 * alone.
 */
export async function cliPublicSearch(args: PublicSearchArgs): Promise<PublicSearchResult> {
  // A restored index was checked when it was saved (and again when it was restored): nothing to build or to re-check.
  if (args.index?.skip) return cliSearch(args, undefined, args.index.replay ?? {});
  let indexStdout: string;
  const indexStarted = Date.now();
  try {
    indexStdout = await spawnCli(['--import', 'tsx', 'src/cli.ts', 'index'], args, 'index');
  } catch (error) {
    // #188: the index command exits non-zero on a per-file error, so the spawn
    // rejects before the summary can be parsed. A raw Error here would be
    // caught by the per-case handler, recorded as that case's error and the run
    // would KEEP SCORING an incomplete vault — the exact failure this
    // precondition exists to prevent. Classify it as the run abort it is.
    // Migration logs lead stderr, and spawnCli's own message keeps only the
    // tail (the stack), so neither the first 400 characters nor the tail is
    // guaranteed to contain `error indexing <path>:`. Name those lines.
    const indexed = indexErrorLines(spawnCliLastStderr);
    throw new ProductPreconditionError(
      `Public CLI index precondition failed: the index command exited non-zero — ` +
      `${error instanceof Error ? error.message : String(error)}` +
      (indexed ? ` | ${indexed}` : ''),
    );
  }
  const indexHealth = parseIndexErrors(indexStdout);
  if (indexHealth.errors !== 0 || indexHealth.indexed !== indexHealth.total) {
    // A summary line that disagrees with the exit status (or is missing) must
    // still abort, and it carries the diagnostic: per-file index errors print
    // to the CLI's stderr, so the precondition reports both streams. The
    // indexer lines are quoted whole; a tail slice alone loses the path once
    // the parser stack is longer than the window.
    const stderr = spawnCliLastStderr;
    const indexed = indexErrorLines(stderr);
    throw new ProductPreconditionError(`Public CLI index precondition failed: ${JSON.stringify(indexHealth)} — ` +
      `partial index failure must abort the run, never score an empty vault (index output tail: ${indexStdout.slice(-300)}${indexed ? ` | index errors: ${indexed}` : ''}${stderr ? ` | stderr: ${stderr.slice(-600)}` : ''})`);
  }
  const indexMs = Date.now() - indexStarted;
  const built: IndexReplay = {
    ...(parseRouterSummaryLine(indexStdout) ? { routerSummaries: parseRouterSummaryLine(indexStdout) } : {}),
    ...(parseDigestStatsLine(indexStdout) ? { digestStats: parseDigestStatsLine(indexStdout) } : {}),
  };
  args.index?.onBuilt?.({ indexMs, replay: built });
  return cliSearch(args, indexMs, built);
}

async function cliSearch(args: PublicSearchArgs, indexMs: number | undefined, indexed: IndexReplay): Promise<PublicSearchResult> {
  const started = Date.now();
  const stdout = await spawnCli(
    ['--import', 'tsx', 'src/cli.ts', 'search', '--json', '--top-k', String(args.topK), args.query],
    args,
    'search',
  );
  let parsed: { hits?: Array<{ notePath?: string; text?: string; score?: number; session_date?: unknown }>; composedContext?: { text?: string }; evidence?: unknown };
  try {
    parsed = JSON.parse(stdout) as { hits?: Array<{ notePath?: string; text?: string; score?: number }>; composedContext?: { text?: string }; evidence?: unknown };
  } catch {
    throw new Error(`Public CLI surface returned unparseable JSON output (${stdout.slice(0, 200)})`);
  }
  const hits: PublicHit[] = (parsed.hits ?? []).map(hit => ({
    notePath: String(hit.notePath ?? ''),
    text: String(hit.text ?? ''),
    score: Number(hit.score ?? 0),
    ...(hit.session_date ? { session_date: String(hit.session_date) } : {}),
  }));
  if (hits.length === 0) {
    throw new ProductPreconditionError(`Retrieval precondition failed: public CLI search returned zero hits for this case — ` +
      `every case must retrieve at least one hit before scoring (empty retrieval is an abort, not an answer)`);
  }
  const router = (parsed as { router?: Record<string, unknown> }).router;
  const routerSummaries = indexed.routerSummaries;
  const digest = (parsed as { digest?: Record<string, unknown> }).digest;
  const digestStats = indexed.digestStats;
  return {
    hits,
    // C0 structured context passes through unchanged when the CLI composer is
    // armed (RENOR_STRUCTURED_CONTEXT); undefined otherwise.
    composedContext: parsed.composedContext,
    // Recorded per case and counted in the manifest; never part of the context.
    evidence: parsed.evidence,
    transport: 'cli-subprocess',
    command: `${process.execPath} --import tsx src/cli.ts search --json --top-k ${args.topK} <query>`,
    durationMs: Date.now() - started,
    // Session router (RENOR_SESSION_ROUTER): its report and the index-time summary stats, recorded per case so a run
    // whose router stepped aside is never indistinguishable from one where it routed (the issue #222 lesson).
    ...(router ? { router } : {}),
    ...(routerSummaries ? { routerSummaries } : {}),
    // Write-time digests (RENOR_DIGESTS): the same rule, a run whose digests stepped aside says so per case.
    ...(digest ? { digest } : {}),
    ...(digestStats ? { digestStats } : {}),
    ...(indexMs !== undefined ? { indexMs } : {}),
  };
}

/**
 * The environment the product process runs with: the runner's own environment, with the case's variables on top.
 * The run ledger fingerprints this same merge (productRunConfig), so a setting inherited from the operator's shell,
 * such as RENOR_NEWEST_FIRST or CHUNK_MAX_TOKENS, is configuration exactly as if the runner had set it.
 */
export function productProcessEnv(caseEnv: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...caseEnv };
}

/** Per-file index failures. Startup migration logs lead stderr, so a fixed head misses them. */
function indexErrorLines(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => line.includes('[index] error indexing '))
    .slice(0, 20);
  // Bound the number of diagnostics without truncating a broken file's path.
  if (lines.length > 0) return lines.join('\n');
  const head = stderr.slice(0, 400);
  const tail = stderr.length > 400 ? stderr.slice(-400) : '';
  if (!head) return '';
  return tail && tail !== head ? `${head} … ${tail}` : head;
}

function spawnCli(cliArgs: string[], args: PublicSearchArgs, phase: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: args.cwd,
      env: productProcessEnv(args.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', () => { spawnCliLastStderr = stderr; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Public CLI ${phase} failed (exit ${code}): ${stderr.slice(-400) || stdout.slice(-200)}`));
    });
  });
}

/** stderr of the most recently closed CLI child (diagnostics for exit-0 index errors). */
let spawnCliLastStderr = '';

// ─── Model call layer (answer + judge; request shapes identical to run-longmemeval-qa) ───

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ModelCallResult {
  rawContent: string;
  modelEcho: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface ModelCallHooks {
  /** callType 'answer'|'judge'; requestBody shapes identical to run-longmemeval-qa. */
  modelCall(callType: 'answer' | 'judge', requestBody: Record<string, unknown>): Promise<ModelCallResult>;
  /** Pre-flight health probe; the default makes a REAL provider sentinel call. */
  sentinel(callType: 'answer' | 'judge'): Promise<void>;
}

const chatHeaders = (apiKey: string, session: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
  'user-agent': process.env.RENOR_QA_USER_AGENT ?? 'renor-eval/1.0',
  'x-opencode-session': session,
});

async function chatCall(args: {
  baseUrl: string; apiKey: string; requestBody: Record<string, unknown>;
  timeoutMs: number; retries: number; session: string;
}): Promise<{ body: ChatResponse; latencyMs: number }> {
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= args.retries; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const response = await fetch(`${args.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(args.apiKey, args.session),
        body: JSON.stringify(args.requestBody),
        signal: controller.signal,
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
      }
      // The abort timer stays ARMED while the body is consumed and is cleared in
      // `finally`. It used to be cleared the moment headers arrived, so a stream
      // that stalled mid-body hung the run forever — no timeout, no retry, no
      // error row. Measured 2026-09-26: a full-500 wedged at case 201 for 45+
      // minutes with the process parked in ep_poll and zero open requests.
      const body = (await response.json()) as ChatResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) throw new Error('empty/missing assistant content');
      return { body, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < args.retries) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`API failed after ${args.retries} attempts: ${lastError}`);
}

export function parseVerdict(raw: string): 0 | 1 | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^(1|yes|correct|true)\b/.test(trimmed)) return 1;
  if (/^(0|no|incorrect|false)\b/.test(trimmed)) return 0;
  const digit = trimmed.match(/\b([01])\b/);
  if (digit) return digit[1] === '1' ? 1 : 0;
  return null;
}

const ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant answering questions using provided conversation memory excerpts.';
const JUDGE_SYSTEM_PROMPT = 'You are an impartial judge evaluating whether an AI assistant\'s answer is correct.';
const DIRECT_INSTRUCTION = 'Answer the question directly and concisely based on the excerpts above. Do not add caveats or explanations. If the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.';
// H11 bestguess wording, byte-carried from the research QA stage (scripts/eval/run-longmemeval-qa.ts)
// so screen results remain comparable with the measured H11 family.
const BESTGUESS_INSTRUCTION = 'Answer the question directly and concisely based on the excerpts above. Do not add caveats or explanations. If the excerpts and tables do not state the exact value, give your single best answer supported by the most relevant excerpt \u2014 infer only what the excerpts directly imply (dates, counts, names, stated preferences). Reply exactly "I don\'t know" only when no excerpt is relevant to the question at all.';
// COUNT-CONTRACT wording: targets the measured undercounting failure. On the
// champion's 70 wrongs, 23 of the 26 multi-session misses are count/sum questions
// where the reader answers a subset of the items it was given (3->2, $185->$65,
// 140h->70h, 4->2, $720->$220, 99->74). The items are in context; the reader
// enumerates them and then reports a partial count. This instruction makes the
// enumeration explicit and forbids answering with a subset. The final tally must
// be written as the last thing in the answer.
//
// Note this is a COUNTING discipline, not an abstention relaxer: the IDK rule is
// byte-identical to `direct`, so the abstention class is untouched by
// construction (H12 already showed the count-sidecar ceiling is item coverage,
// not arithmetic — this arm tests the reader contract only).
const COUNT_INSTRUCTION = 'Answer the question directly and concisely based on the excerpts above. Do not add caveats or explanations. '
  + 'If the question asks how many, how much, or for a total: before answering, enumerate EVERY item in the excerpts that the question could be counting, one per line, '
  + 'each with its stated value. Count or sum the items you listed. If you listed three items, the answer is three \u2014 never report a number lower than the number of items you listed. '
  + 'End your reply with a single line containing only the final value. '
  + 'If the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.';
const ANSWER_INSTRUCTIONS: Record<'direct' | 'bestguess' | 'count', string> = { direct: DIRECT_INSTRUCTION, bestguess: BESTGUESS_INSTRUCTION, count: COUNT_INSTRUCTION };
const answerUserPrompt = (questionDate: string, question: string, context: string, answerStyle: 'direct' | 'bestguess' | 'count' = 'direct') => `Conversation memory excerpts (retrieved from long-term memory, highest relevance first):

${context}

Question (asked on ${questionDate}): ${question}

${ANSWER_INSTRUCTIONS[answerStyle] ?? DIRECT_INSTRUCTION}`;
const judgeUserPrompt = (question: string, gold: string, answer: string) => `Question: ${question}

Ground truth answer: ${gold}

Assistant's answer: ${answer}

Does the assistant's answer agree with the ground truth in substance (correct fact, person, value, or the required "I don't know")? Respond with ONLY the single digit 1 if correct, or 0 if incorrect, incomplete, or evasive. Output nothing else.`;

// ─── Runner ───

export interface ProductQaCase {
  id: string;
  /** Scorer-side fields (never sent to the product process). */
  category: string;
  shouldAbstain: boolean;
  questionDate: string;
  hitsUsed: number;
  contextTokens: number;
  answer: { text: string; modelEcho: string; finishReason: string; latencyMs: number; usage: { promptTokens: number; completionTokens: number }; fromCache: boolean; cacheKey?: string } | null;
  judge: { raw: string; verdict: 0 | 1 | null; parseOk: boolean; modelEcho: string; fromCache: boolean; cacheKey?: string } | null;
  publicSearchMs: number;
  runtimeInputSha256: string;
  /** What the product's evidence pass did for this case (absent on rows written before it was recorded). */
  evidence?: CaseEvidence;
  error?: string;
  /** Session-router report for this case (RENOR_SESSION_ROUTER armed), routed note paths relative to the vault. */
  router?: Record<string, unknown>;
  /** Index-time summary stats for this case's vault (RENOR_SESSION_ROUTER armed). */
  routerSummaries?: Record<string, unknown>;
  /** Write-time digest report for this case (RENOR_DIGESTS armed): status, items rendered, and their provenance. */
  digest?: Record<string, unknown>;
  /** Index-time digest stats for this case's vault (RENOR_DIGESTS armed). */
  digestStats?: Record<string, unknown>;
  /** How this case's memory store came about when index snapshots are on: restored, built (and saved), or built cold because the snapshot was stale, corrupt or its slot busy. */
  indexSnapshot?: { state: 'restored' | 'built' | 'rebuilt-stale' | 'rebuilt-corrupt' | 'cold-busy'; indexMs?: number; savedIndexMs?: number };
}

export interface ProductRunnerOptions {
  dataset: string;
  output: string;
  topK: number;
  limit: number;
  offset: number;
  shardIndex: number;
  shardCount: number;
  maxContextTokens: number;
  embeddingProvider: string;
  transportSmoke?: boolean;
  /** embed-proxy stats file (scripts/eval/embed-proxy.ts); recorded in the manifest when present. */
  embedProxyStats?: string;
  arm: CacheArm;
  cache?: boolean;
  cacheDir?: string;
  answerModel: string;
  judgeModel: string;
  baseUrl: string;
  apiKeyEnv: string;
  judgeBaseUrl?: string;
  judgeApiKeyEnv?: string;
  judgeKeysEnv?: string;
  maxLiveCalls?: number;
  contextDates?: boolean;
  /** Arm the four structured-row flags in the temp product instance. Default off. */
  structuredRows?: boolean;
  /** P1: strip pure-meta header lines (# Session <id>, Timestamp:) from excerpt blocks. Default off. */
  stripExcerptMeta?: boolean;
  answerStyle?: 'direct' | 'bestguess' | 'count';
  idsFile?: string;
  temperature: number;
  retries: number;
  /**
   * The run ledger (src/eval/runLedger.ts). The CLI always passes it, so every run it starts is recorded
   * and a configuration already on record is refused unless rerunReason says why. In-process callers
   * (tests) that leave it out are neither recorded nor refused.
   */
  runLedger?: { path: string; rerunReason?: string };
  /**
   * Index snapshots (src/eval/indexSnapshots.ts): restore a question's memory store instead of building it when
   * nothing that decides what an index stores has changed. Iteration arms only; a promotion arm refuses it. Absent
   * means off, which is every in-process caller; the CLI turns it on for cached iteration runs.
   */
  snapshots?: { root: string; vaultBase: string };
}

/** The code a product run executes: the product (spawned through src/cli.ts), this runner and the locked dependencies. */
export const PRODUCT_RUN_CODE_ROOTS = ['src', 'scripts/eval/run-longmemeval-product.ts', 'package-lock.json'] as const;

/**
 * The configuration a product run is fingerprinted by in the run ledger: models and endpoints, the answer
 * prompt and client-side assembly, the product process's environment (its product-namespace variables,
 * credentials and cache paths by presence only: src/eval/runLedger.ts productEnvironment), the cache arm, the
 * question set, the dataset and the code. Output paths, budgets and retry counts are not configuration.
 */
export function productRunConfig(args: {
  opts: ProductRunnerOptions;
  /** The environment every case's product process receives, as productProcessEnv builds it (per-case VAULT_PATH/DB_PATH aside). */
  childEnv: Record<string, string | undefined>;
  datasetSha256: string;
  questionIds: readonly string[];
  codeSha256: string;
}): Record<string, unknown> {
  const { opts } = args;
  const cacheEnabled = opts.cache !== false;
  return {
    runner: 'longmemeval-product',
    benchmark: 'longmemeval-s-qa-end-to-end',
    datasetSha256: args.datasetSha256,
    questions: questionSet(args.questionIds),
    answer: { model: opts.answerModel, baseUrl: opts.baseUrl },
    judge: { model: opts.judgeModel, baseUrl: opts.judgeBaseUrl ?? opts.baseUrl },
    answerStyle: opts.answerStyle ?? 'direct',
    contextDates: opts.contextDates === true,
    stripExcerptMeta: opts.stripExcerptMeta === true,
    topK: opts.topK,
    maxContextTokens: opts.maxContextTokens,
    temperature: opts.temperature,
    transportSmoke: opts.transportSmoke === true,
    productEnv: productEnvironment(args.childEnv),
    arm: opts.arm ?? (cacheEnabled ? 'iteration' : 'promotion'),
    cache: cacheEnabled,
    codeSha256: args.codeSha256,
  };
}

export interface ProductHooks {
  publicSearch(args: PublicSearchArgs): Promise<{ hits: PublicHit[]; evidence?: unknown; transport: string; command: string; durationMs: number }>;
  models: ModelCallHooks;
}

/** What a public search may carry besides its hits when RENOR_SESSION_ROUTER is armed (cliPublicSearch does). */
export type RouterSearchFields = Pick<PublicSearchResult, 'router' | 'routerSummaries'>;

/**
 * One case's evidence pass, from the report the public surface itself returns
 * (`search --json` `evidence`, src/evidence/attach.ts productEvidenceReport).
 * `unreported` means the surface said nothing (the pass was switched off with
 * RENOR_SEARCH_EVIDENCE=0, or a transport without the report); it is never
 * read as "the table was there".
 */
export interface CaseEvidence {
  /** ok | failed | unavailable | not-applied | off, or unreported. */
  state: string;
  reason?: string;
  /** Items the extractor returned; 0 means it ran and no table was attached. */
  items?: number;
  fromCache?: boolean;
  model?: string;
  error?: string;
}

export function caseEvidence(report: unknown): CaseEvidence {
  if (typeof report !== 'object' || report === null || Array.isArray(report)) return { state: 'unreported' };
  const r = report as Record<string, unknown>;
  if (typeof r.state !== 'string' || r.state === '') return { state: 'unreported' };
  return {
    state: r.state,
    ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    ...(Array.isArray(r.items) ? { items: r.items.length } : {}),
    ...(typeof r.fromCache === 'boolean' ? { fromCache: r.fromCache } : {}),
    ...(typeof r.model === 'string' && r.model !== '' ? { model: r.model } : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {}),
  };
}

const EVIDENCE_STATES = ['ok', 'failed', 'unavailable', 'not-applied', 'off', 'unreported'] as const;

/**
 * The manifest's evidence block (issue #222 part 2). On 2026-09-30 an evidence
 * key pool emptied after 423 of 500 cases and the last 77 were answered
 * without the table while the manifest reported full coverage; this block
 * counts every case by state and names each failed case, so a run whose
 * evidence layer went missing says so in its own artifact.
 */
export interface EvidenceCoverage {
  /** Cases per state; every state is present, 0 when none. */
  states: Record<string, number>;
  /** ok with at least one item: a dated item table reached the answer context. */
  attached: number;
  /** ok tables replayed from the product's evidence cache (no model call). */
  replayed: number;
  /** Each failed case, by id, with the product's reason and error. */
  failed: Array<{ id: string; reason: string; error?: string }>;
  /** Extractor models the reports named. */
  models: string[];
}

export function evidenceCoverage(cases: Array<{ id: string; evidence?: CaseEvidence }>): EvidenceCoverage {
  const states: Record<string, number> = Object.fromEntries(EVIDENCE_STATES.map(state => [state, 0]));
  const failed: EvidenceCoverage['failed'] = [];
  const models = new Set<string>();
  let attached = 0;
  let replayed = 0;
  for (const c of cases) {
    const evidence = c.evidence ?? { state: 'unreported' };
    states[evidence.state] = (states[evidence.state] ?? 0) + 1;
    if (evidence.model) models.add(evidence.model);
    if (evidence.state === 'ok' && (evidence.items ?? 0) > 0) attached++;
    if (evidence.state === 'ok' && evidence.fromCache === true) replayed++;
    if (evidence.state === 'failed') {
      failed.push({ id: c.id, reason: evidence.reason ?? 'unknown', ...(evidence.error !== undefined ? { error: evidence.error } : {}) });
    }
  }
  return { states, attached, replayed, failed, models: [...models].sort() };
}

/**
 * Build the answer context from PUBLIC-SURFACE OUTPUT ONLY: exact-duplicate
 * collapse, token cap, excerpt numbering. The client never injects content
 * the public surface did not return.
 */
export function assembleClientContext(hits: PublicHit[], maxContextTokens: number, options?: { contextDates?: boolean; stripExcerptMeta?: boolean }): { context: string; tokens: number; hitsUsed: number } {
  const seen = new Set<string>();
  const excerpts: string[] = [];
  let tokens = 0;
  for (const hit of hits) {
    const text = (hit.text ?? '').trim();
    if (!text || seen.has(text)) continue;
    // E3/A1 lever (+8pp research precedent): render each excerpt's session date
    // when present — timestamp starvation was the dominant historical failure.
    const dateLine = options?.contextDates && (hit as PublicHit & { session_date?: unknown }).session_date
      ? `Session date: ${String((hit as PublicHit & { session_date?: unknown }).session_date)}\n`
      : '';
    const strippedText = stripExcerptMetaLines(text, options?.stripExcerptMeta === true);
    const candidate = options?.stripExcerptMeta === true
      ? `${dateLine}${strippedText}` // strip mode: no [Excerpt N] marker (P1); date always kept
      : `${dateLine}[Excerpt ${excerpts.length + 1}]\n${strippedText}`;
    const candidateTokens = countTextTokens(candidate);
    if (tokens + candidateTokens > maxContextTokens) break;
    seen.add(text);
    excerpts.push(candidate);
    tokens += candidateTokens;
  }
  return { context: excerpts.join('\n\n'), tokens, hitsUsed: excerpts.length };
}

// P1 strip-excerpt-meta: remove ONLY pure-meta header lines from an excerpt
// block when enabled — the `# Session <id>` line and the `Timestamp:` line.
// Turn content and every `Session date:` footer are preserved verbatim; lines
// mixing meta with content are never touched. No-op when flag is false.
export function stripExcerptMetaLines(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return text
    .replace(/^# Session .+$/gm, '')
    .replace(/^Timestamp: .+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

export interface ProductArgv {
  dataset: string;
  output: string;
  topK: string;
  limit: string;
  offset: string;
  shardIndex: string;
  shardCount: string;
  maxContextTokens: string;
  embeddingProvider: string;
  transportSmoke?: boolean;
  embedProxyStats?: string;
  arm: string;
  cache?: boolean;
  cacheDir?: string;
  answerModel: string;
  judgeModel: string;
  baseUrl: string;
  apiKeyEnv: string;
  judgeBaseUrl?: string;
  judgeApiKeyEnv?: string;
  judgeKeysEnv?: string;
  maxLiveCalls?: number;
  contextDates?: boolean;
  structuredRows?: boolean;
  stripExcerptMeta?: boolean;
  answerStyle?: 'direct' | 'bestguess' | 'count';
  idsFile?: string;
  temperature: string;
  retries: string;
  rerunReason?: string;
  /** commander negation of --no-index-snapshots: undefined/true = on for cached iteration arms. */
  indexSnapshots?: boolean;
  snapshotDir?: string;
  snapshotVaultBase?: string;
}

export function parseProductArgs(userArgv: string[]): ProductArgv {
  const program = new Command()
    .name('run-longmemeval-product')
    .requiredOption('--dataset <path>', 'path to official longmemeval_s.json')
    .requiredOption('--output <dir>', 'output artifact directory')
    .option('--top-k <n>', 'retrieval depth requested from the public surface', '20')
    .option('--limit <n>', 'maximum selected questions after sharding; 0 = all', '2')
    .option('--offset <n>', 'skip selected questions before limit', '0')
    .option('--shard-index <n>', 'zero-based shard index', '0')
    .option('--shard-count <n>', 'number of deterministic shards', '1')
    .option('--max-context-tokens <n>', 'client-side token cap over public-surface hits', '6000')
    .requiredOption('--embedding-provider <kind>', 'EMBEDDING_PROVIDER for the temp product instance (openai|local|eval-hash) — REQUIRED, no default: the measured embedding configuration must be pinned explicitly')
    .option('--arm <arm>', 'arm role recorded in the manifest: iteration (cache allowed) or promotion (--no-cache required)', 'iteration')
    .option('--transport-smoke', 'explicitly watermark a non-production embedding run (eval-hash/local); refused with --arm promotion')
    .option('--embed-proxy-stats <path>', 'embed-proxy stats JSON (scripts/eval/embed-proxy.ts); embedded into the manifest when the file exists')
    .option('--no-cache', 'disable the eval cache (required for promotion arms)')
    .option('--cache-dir <path>', 'explicit path to eval cache SQLite (default: resolveEvalCachePath)')
    .option('--answer-model <id>', 'answer model identifier', process.env.RENOR_QA_ANSWER_MODEL ?? 'deepseek-v4.1-flash')
    .option('--judge-model <id>', 'judge model identifier', process.env.RENOR_QA_JUDGE_MODEL ?? 'gemma4:31b')
    .option('--base-url <url>', 'OpenAI-compatible endpoint for the answerer (and judge unless --judge-base-url)', process.env.RENOR_QA_BASE_URL ?? 'https://ollama.com/v1')
    .option('--api-key-env <name>', 'env var holding the answerer API key', 'OLLAMA_API_KEY')
    .option('--judge-base-url <url>', 'OpenAI-compatible endpoint for the judge (defaults to --base-url)')
    .option('--judge-api-key-env <name>', 'env var holding the judge API key (defaults to --api-key-env)')
    .option('--judge-keys-env <prefix>', 'env var prefix for numbered judge keys', '')
    .requiredOption('--max-live-calls <n>', 'hard budget: maximum live model calls this run may make (REQUIRED — resources are never unlimited; the run aborts at the cap and checkpoints)', v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error('--max-live-calls must be a positive integer'); return n; })
    .option('--context-dates', 'render each excerpt\'s session_date in the client-side context (E3/A1 lever; default off = byte-identical baseline assembly)')

    .option('--structured-rows', 'arm RENOR_TYPED_FACTS, RENOR_CHRONICLE, RENOR_PREFS and RENOR_STRUCTURED_CONTEXT in the temp product instance; default off')
    .option('--strip-excerpt-meta', 'P1: strip pure-meta header lines (# Session <id>, Timestamp:) from excerpt blocks; content and dates kept (default off = byte-identical baseline assembly)', process.env.RENOR_STRIP_EXCERPT_META === '1' ? true : undefined)
    .option('--answer-style <style>', 'answer prompt instruction: direct (default), bestguess (H11 wording, byte-carried from the research QA stage), or count (enumerate-then-tally contract targeting the measured count/sum undercounting)', 'direct')
    .option('--ids-file <path>', 'frozen offline case-id list (one question_id per line) — slice screens; selection rule must be recorded, never runtime gold')
    .option('--temperature <t>', 'sampling temperature for both models', '0')
    .option('--retries <n>', 'per-call retry attempts', '5')
    .option('--no-index-snapshots', 'build every question\'s memory store cold (iteration arms restore it from an index snapshot when nothing that decides what an index stores has changed; promotion arms always build cold)')
    .option('--snapshot-dir <path>', 'index snapshot directory (default: $RENOR_EVAL_SNAPSHOT_DIR, else <bench data>/index-snapshots)')
    .option('--snapshot-vault-base <path>', 'where snapshotted vaults are rendered; part of the snapshot key because the index stores absolute paths (default: $RENOR_EVAL_SNAPSHOT_VAULT_BASE, else /tmp/renor-index-vault)')
    .option('--rerun-reason <text>', `run even though this exact configuration is already on the run ledger (${RUN_LEDGER_ENV}); the reason is recorded with the run`);
  program.parse(userArgv, { from: 'user' });
  return program.opts() as ProductArgv;
}

const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

/**
 * Embed-proxy provenance for the manifest (additive; no trust-boundary change).
 *
 * embeddingProxy: contents of the --embed-proxy-stats file when it exists at
 * manifest write time (presence + namespace + component-split hit counts), so
 * an auditor can see how much of the run's vectors came from the shared cache.
 *
 * embeddingUpstream: set when the openai provider points at a localhost
 * base URL — the proxy URL alone in embeddingBaseURL is NOT sufficient
 * provenance; the auditor must see what actually produced the vectors.
 */
function embedProxyManifestFields(opts: { embeddingProvider: string; embedProxyStats?: string }): Record<string, unknown> {
  let embeddingProxy: Record<string, unknown> | null = null;
  if (opts.embedProxyStats) {
    const statsPath = path.resolve(opts.embedProxyStats);
    if (fs.existsSync(statsPath)) {
      const raw = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as Record<string, unknown>;
      embeddingProxy = { present: true, statsPath, ...raw };
    } else {
      embeddingProxy = { present: false, statsPath, note: 'stats file did not exist at manifest write time' };
    }
  }
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const localhostBase = typeof baseUrl === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUrl);
  const embeddingUpstream = opts.embeddingProvider === 'openai' && localhostBase
    ? {
        endpoint: 'vertex-predict',
        model: process.env.RENOR_EMBED_UPSTREAM_MODEL ?? 'gemini-embedding-001',
        dims: 768,
        note: 'vectors may be served from the shared vertex cache namespace',
      }
    : null;
  return { embeddingProxy, embeddingUpstream };
}

/**
 * A note's path in the form hits are scored in: relative to the case vault, `/`-separated. The CLI prints it that way (as
 * the hosted tools do), and one that printed the absolute path is still read. `path.relative` resolves a relative path
 * against the working directory, so it is asked only of an absolute one; the evidence table's `_renor/…` path is no file.
 */
export function vaultRelativeNotePath(vaultDir: string, notePath: string): string {
  const inVault = notePath.startsWith('_renor/') || !path.isAbsolute(notePath) ? notePath : path.relative(vaultDir, notePath);
  return inVault.replaceAll(path.sep, '/');
}

/** The router report with each routed note's path made relative to the case vault (the form hits are scored in). */
function relativeRouterReport(report: Record<string, unknown>, vaultDir: string): Record<string, unknown> {
  const routed = Array.isArray(report.routed) ? report.routed as Array<Record<string, unknown>> : undefined;
  if (!routed) return report;
  return {
    ...report,
    routed: routed.map(entry => typeof entry.notePath === 'string' && path.isAbsolute(entry.notePath)
      ? { ...entry, notePath: path.relative(vaultDir, entry.notePath).replaceAll(path.sep, '/') }
      : entry),
  };
}

/**
 * Manifest summary of the session router over a run (null when no case carried a router report): how many cases it
 * routed, why it stepped aside on the rest, and what its calls cost. A router arm that quietly fell back to the control
 * on part of the run is visible here without reading every case.
 */
export function summarizeRouterCoverage(cases: Array<Pick<ProductQaCase, 'router' | 'routerSummaries'>>): Record<string, unknown> | null {
  const reports = cases.map(c => c.router).filter((r): r is Record<string, unknown> => Boolean(r));
  if (reports.length === 0) return null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const skipped: Record<string, number> = {};
  let routedCases = 0;
  let routedSessions = 0;
  let deliveredTokens = 0;
  let routeAnswers = 0;
  let liveRouteCalls = 0;
  let routePromptTokens = 0;
  let routeCompletionTokens = 0;
  const liveLatencies: number[] = [];
  for (const report of reports) {
    if (report.status === 'ok') {
      routedCases++;
      routedSessions += Array.isArray(report.routed) ? report.routed.length : 0;
      deliveredTokens += num(report.deliveredTokens);
    } else {
      const reason = typeof report.reason === 'string' ? report.reason : 'unknown';
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    }
    const usage = report.usage as { promptTokens?: unknown; completionTokens?: unknown } | undefined;
    if (usage) {
      routeAnswers++;
      routePromptTokens += num(usage.promptTokens);
      routeCompletionTokens += num(usage.completionTokens);
    }
    if (report.usage && report.fromCache === false) {
      liveRouteCalls++;
      liveLatencies.push(num(report.latencyMs));
    }
  }
  liveLatencies.sort((a, b) => a - b);
  const quantile = (q: number) => (liveLatencies.length === 0 ? null : liveLatencies[Math.min(liveLatencies.length - 1, Math.floor(q * liveLatencies.length))]);
  const summaries = cases.map(c => c.routerSummaries).filter((s): s is Record<string, unknown> => Boolean(s));
  return {
    cases: reports.length,
    routed: routedCases,
    skipped,
    meanRoutedSessions: routedCases ? Number((routedSessions / routedCases).toFixed(2)) : null,
    meanDeliveredTokens: routedCases ? Math.round(deliveredTokens / routedCases) : null,
    // Every routing answer the cases used (live or replayed from the router cache) and its tokens: what routing costs
    // a run without a cache. `liveCalls` is what this run actually called.
    route: {
      answers: routeAnswers,
      liveCalls: liveRouteCalls,
      promptTokens: routePromptTokens,
      completionTokens: routeCompletionTokens,
      liveLatencyMsP50: quantile(0.5),
      liveLatencyMsP95: quantile(0.95),
    },
    summaries: {
      indexRuns: summaries.length,
      notes: summaries.reduce((sum, s) => sum + num(s.notes), 0),
      cached: summaries.reduce((sum, s) => sum + num(s.cached), 0),
      summarized: summaries.reduce((sum, s) => sum + num(s.summarized), 0),
      failed: summaries.reduce((sum, s) => sum + num(s.failed), 0),
      liveCalls: summaries.reduce((sum, s) => sum + num(s.calls), 0),
      promptTokens: summaries.reduce((sum, s) => sum + num(s.promptTokens), 0),
      completionTokens: summaries.reduce((sum, s) => sum + num(s.completionTokens), 0),
    },
  };
}

/** Read a JSONL checkpoint, tolerating a trailing partially-written line from a crash. */
function readCheckpoint<T>(file: string, parse: (line: string) => T): T[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    try {
      rows.push(parse(lines[index]));
    } catch {
      if (index === lines.length - 1) break; // trailing partial line — ignore
      throw new Error(`Corrupt checkpoint line ${index + 1} in ${file}`);
    }
  }
  return rows;
}

function selectShard<T>(rows: T[], shardIndex: number, shardCount: number): T[] {
  return rows.filter((_, index) => index % shardCount === shardIndex);
}

/**
 * The product process environment every case shares (VAULT_PATH and DB_PATH are added per case), and the structured-row
 * flags it carries. Built once per run, before any case runs, so the run ledger fingerprints exactly what the child
 * receives. The index snapshot key is built from the same environment, so the tools that print or check a key call this too.
 */
export function buildProductChildEnv(
  args: { embeddingProvider: string; structuredRows?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): { childEnv: Record<string, string>; structuredRowFlags: Record<string, string> } {
  // Built once. The child env and the manifest both read this, because the
  // runner does not mutate its own process.env. Absent means the four flags
  // stay at their shipped default, off.
  const structuredRowFlags: Record<string, string> = args.structuredRows === true
    ? {
        RENOR_TYPED_FACTS: '1',
        RENOR_CHRONICLE: '1',
        RENOR_PREFS: '1',
        RENOR_STRUCTURED_CONTEXT: '1',
      }
    : {};
  // The product process environment every case shares; VAULT_PATH and DB_PATH
  // are added per case. Built once, before any case runs, so the run ledger
  // fingerprints exactly what the child receives.
  const childEnv: Record<string, string> = {
    EMBEDDING_PROVIDER: args.embeddingProvider,
    LLM_EXTRACTION: 'false',
    INDEX_CONCURRENCY: env.RENOR_EVAL_INDEX_CONCURRENCY ?? '4',
  };
  // Embedding configuration passthrough (openai-compatible provider config;
  // the API key travels in env only and never appears in logs or manifests).
  // C2–C5 screen arming: shipped default-off feature flags pass through
  // ONLY when the operator set them; each armed flag is recorded in the
  // manifest's productMode.overrides (productFeatureFlagOverrides below).
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_BASE_URL', 'EMBEDDING_DIMS', 'EMBEDDING_BATCH_SIZE', 'RENOR_SEARCH_EVIDENCE', 'RENOR_EVIDENCE_MODE', 'RENOR_EVIDENCE_SESSIONS', 'RENOR_EVIDENCE_ENUMERATE', 'RENOR_EVIDENCE_CACHE', 'RENOR_EVIDENCE_MODEL', 'RENOR_EVIDENCE_BASE_URL', 'RENOR_EVIDENCE_API_KEY', 'RENOR_EVIDENCE_API_KEYS', 'RENOR_EVIDENCE_MAX_TOKENS', 'RENOR_EVIDENCE_REASONING_EFFORT', 'RENOR_STRUCTURED_CONTEXT', 'RENOR_TYPED_FACTS', 'RENOR_CHRONICLE', 'RENOR_PREFS', 'RENOR_QUERY_SCOPED_ROWS', 'OLLAMA_CLOUD_KEY_1', 'OLLAMA_CLOUD_KEY_2', 'OLLAMA_CLOUD_KEY_3', 'OLLAMA_CLOUD_KEY_4', 'OLLAMA_MAX_KEY', 'OLLAMA_API_KEY', 'RENOR_EXTRACTOR_API_KEY', 'RENOR_EXTRACTOR_API_KEYS', 'RENOR_EXTRACTOR_BASE_URL', 'RENOR_EXTRACTOR_TIMEOUT_MS']) {
    if (env[name] !== undefined) childEnv[name] = env[name] as string;
  }
  // The session router's knobs (src/router/sessionRouter.ts), passed and recorded the same way.
  // The write-time digest knobs (src/digests/digests.ts), passed and recorded the same way.
  // The self-hosted engine's unset evidence mode is off (src/evidence/gate.ts); the benchmark measures hosted Renor,
  // whose unit sets always (scripts/alpha/provision-renor-tenant.sh). An operator's own value still passes through.
  if (!childEnv.RENOR_EVIDENCE_MODE?.trim()) childEnv.RENOR_EVIDENCE_MODE = 'always';
  for (const name of ['RENOR_DIGESTS', 'RENOR_DIGEST_MODEL', 'RENOR_DIGEST_REASONING_EFFORT', 'RENOR_DIGEST_CACHE', 'RENOR_DIGEST_CACHE_ONLY', 'RENOR_DIGEST_TOKENS', 'RENOR_DIGEST_RETRIES', 'RENOR_DIGEST_BASE_URL', 'RENOR_DIGEST_API_KEY', 'RENOR_DIGEST_API_KEYS']) {
    if (env[name] !== undefined) childEnv[name] = env[name] as string;
  }
  for (const name of ['RENOR_SESSION_ROUTER', 'RENOR_ROUTER_MODEL', 'RENOR_ROUTER_SUMMARY_MODEL', 'RENOR_ROUTER_CACHE', 'RENOR_ROUTER_TIMEOUT_MS', 'RENOR_ROUTER_RETRIES', 'RENOR_ROUTER_BASE_URL', 'RENOR_ROUTER_API_KEY', 'RENOR_ROUTER_API_KEYS']) {
    if (env[name] !== undefined) childEnv[name] = env[name] as string;
  }
  // After the passthrough. An operator shell with one of these flags set
  // to 0 must not silently disarm an explicit --structured-rows arm, and
  // the manifest records the same values the child receives.
  Object.assign(childEnv, structuredRowFlags);
  return { childEnv, structuredRowFlags };
}

/**
 * Run the authoritative product-path benchmark. `hooks` are injectable so
 * contract tests can exercise the REAL public surface with stubbed model
 * calls (tests must never make provider calls); production runs use the
 * default hooks (real CLI spawn + real model calls).
 */
export async function runProductBenchmark(
  opts: ProductRunnerOptions,
  hooks: ProductHooks,
): Promise<{ outputDir: string; manifest: Record<string, unknown>; cases: ProductQaCase[] }> {
  const cacheEnabled = opts.cache !== false;
  const arm: CacheArm = opts.arm ?? (cacheEnabled ? 'iteration' : 'promotion');
  const { childEnv, structuredRowFlags } = buildProductChildEnv(opts);
  if (arm === 'promotion' && cacheEnabled) {
    // Plan Task 8: "fresh isolated write-through caches and zero hits". A
    // promotion arm may use the eval cache ONLY at a verified-fresh path — zero
    // reads by construction (every response recorded for future cached arms).
    const freshPath = opts.cacheDir ? path.resolve(opts.cacheDir) : null;
    if (!freshPath) {
      throw new Error('Refused: promotion arms with cache enabled require --cache-dir pointing at a FRESH (nonexistent) cache DB — zero reads must hold by construction while writes seed future cached arms');
    }
    if (fs.existsSync(freshPath)) {
      // Construction lock exception — EXPLICIT resume semantics only. The
      // existing DB may be opened iff this output dir provably belongs to the
      // same logical run (identity gate below, after dataset selection);
      // the MEASUREMENT lock (end-of-run zero-hit assertion) still holds and
      // is what actually guarantees validity on resume: any served read aborts.
    }
    if (!process.env.RENOR_QA_CACHE_SCOPE?.trim()) {
      throw new Error('Refused: promotion arms with cache enabled require a pinned RENOR_QA_CACHE_SCOPE — writes land directly under the pinned scope so future iteration arms replay them (write-through seeding)');
    }
  }
  if (opts.transportSmoke === true && arm === 'promotion') {
    throw new Error('Refused: transport-smoke runs (non-production embeddings: eval-hash/local) can never be promotion arms');
  }
  const repoRoot = process.cwd();
  if (opts.snapshots && arm === 'promotion') {
    throw new Error('Refused: index snapshots are for iteration arms; a promotion arm builds every question\'s memory store cold');
  }
  // The key of an index snapshot is built from the environment the product process receives, exactly as the child gets it.
  const snapshotStore = opts.snapshots
    ? new SnapshotStore({
        root: opts.snapshots.root,
        vaultBase: opts.snapshots.vaultBase,
        config: indexConfig({
          repoRoot,
          env: productProcessEnv(childEnv),
          vaultBase: opts.snapshots.vaultBase,
          embeddingNamespace: process.env.RENOR_EMBED_UPSTREAM_MODEL ?? null,
        }),
      })
    : null;
  const snapshotGitSha = snapshotStore ? gitState(repoRoot).sha : undefined;
  const datasetPath = path.resolve(opts.dataset);
  const datasetBytes = fs.readFileSync(datasetPath);
  const allRows = JSON.parse(datasetBytes.toString('utf8')) as LongMemInstance[];
  validateLongMemRows(allRows);
  let selected = selectShard(allRows, opts.shardIndex, opts.shardCount)
    .slice(opts.offset, opts.limit === 0 ? undefined : opts.offset + opts.limit);
  if (opts.idsFile) {
    // Frozen slice screens: ids come from OFFLINE artifacts (e.g., a prior
    // report's failure list) — never from runtime gold access.
    const wanted = new Set(fs.readFileSync(path.resolve(opts.idsFile), 'utf8').trim().split(/\r?\n/).filter(Boolean));
    const allIds = new Set(allRows.map(row => row.question_id));
    const unknown = [...wanted].filter(id => !allIds.has(id));
    if (unknown.length > 0) throw new Error(`--ids-file contains ${unknown.length} id(s) not in the dataset (e.g., ${unknown[0]})`);
    selected = allRows.filter(row => wanted.has(row.question_id));
  }
  if (selected.length === 0) throw new Error('No LongMemEval instances selected');

  const outputDir = path.resolve(opts.output);
  const checkpointPath = path.join(outputDir, 'qa-cases.jsonl');
  // Before the output directory is claimed or any provider is called: a
  // configuration already on the run ledger is refused (src/eval/runLedger.ts).
  // An output directory that holds this run's checkpoint continues that run.
  const admission = opts.runLedger
    ? admitRun({
        ledgerPath: opts.runLedger.path,
        runner: 'longmemeval-product',
        config: productRunConfig({
          opts,
          childEnv: productProcessEnv(childEnv),
          datasetSha256: sha256(datasetBytes),
          questionIds: selected.map(row => row.question_id),
          codeSha256: codeIdentity(repoRoot, PRODUCT_RUN_CODE_ROOTS),
        }),
        outputDir,
        resuming: fs.existsSync(checkpointPath),
        rerunReason: opts.runLedger.rerunReason,
      })
    : null;
  // Resume re-entry: an output dir with an existing checkpoint is resumed
  // (claim skipped — mkdirSync EEXIST would block every resume); a fresh run
  // still claims the directory exclusively.
  if (!fs.existsSync(checkpointPath)) claimDirectory(outputDir);
  // Run lock (mutual exclusion): BOTH fresh and resume entry claim
  // <outputDir>/.run.lock with O_EXCL — a live second invocation is refused
  // (interleaved checkpoint writes + double-spent API calls); a stale lock from
  // a crashed owner is detected via pid liveness and removed.
  const runLockPath = path.join(outputDir, '.run.lock');
  if (fs.existsSync(runLockPath)) {
    let ownerAlive = false;
    let ownerPid = 'unknown';
    try {
      const lock = JSON.parse(fs.readFileSync(runLockPath, 'utf8')) as { pid?: number; startedAt?: string };
      ownerPid = String(lock.pid ?? 'unknown');
      if (typeof lock.pid === 'number') {
        try { process.kill(lock.pid, 0); ownerAlive = true; } catch { ownerAlive = false; }
      }
    } catch { /* corrupt lock file: treat as stale */ }
    if (ownerAlive) {
      throw new Error(`Refused: another run owns this output directory (pid ${ownerPid}) — concurrent invocation would interleave checkpoint writes and double-spend API calls; wait for it to finish or use a different --output`);
    }
    fs.rmSync(runLockPath, { force: true }); // stale lock from a crashed owner
  }
  const runLockFd = fs.openSync(runLockPath, 'wx');
  fs.writeSync(runLockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), node: process.version }) + '\n');
  fs.closeSync(runLockFd);
  // Self-healing resume: rows that completed cleanly are skipped; rows that
  // errored (API abort, judge failure) are retried — failed calls are never
  // cached, so a retried case is a fresh live draw, never a replay.
  const checkpointRows = readCheckpoint<ProductQaCase>(checkpointPath, JSON.parse);
  // Previously-errored case ids (self-healing retry): retried cases are FORCED
  // LIVE by construction — a prior partial attempt may have written a usable
  // answer before a judge failure, and reading it back would both break
  // "retried = fresh draw" and trip the promotion zero-hit guard (deadlock).
  const erroredIds = new Set(checkpointRows.filter(row => row.error).map(row => row.id));
  // Identity gate: an existing promotion cache DB may be opened only when this
  // output dir provably belongs to the same logical run — every checkpoint id
  // must belong to this dataset+shard selection. Otherwise --cache-dir would
  // become a general bypass of the leftover-DB guard.
  if (arm === 'promotion' && cacheEnabled && opts.cacheDir && fs.existsSync(path.resolve(opts.cacheDir))) {
    const selectedIds = new Set(selected.map(row => row.question_id));
    const foreign = checkpointRows.filter(row => !selectedIds.has(row.id));
    if (checkpointRows.length === 0 || foreign.length > 0) {
      throw new Error(`Refused: promotion cache DB ${path.resolve(opts.cacheDir!)} exists but the output dir does not provably belong to this run (${foreign.length} foreign checkpoint id(s), ${checkpointRows.length} rows) — resume requires the run's own partial output; use a fresh --cache-dir path otherwise`);
    }
  }
  const done = new Set(checkpointRows.filter(c => !c.error).map(c => c.id));
  const todo = selected.filter(row => !done.has(row.question_id));

  // Cache: reuse evalCache v3. Reads use the canonical scope when explicitly
  // pinned (RENOR_QA_CACHE_SCOPE); writes always go to the unique process scope.
  const qaSession = process.env.RENOR_QA_SESSION ?? `renor-eval-product-${process.pid}-${Date.now().toString(36)}`;
  const evalCachePath = cacheEnabled
    ? (opts.cacheDir ? path.resolve(opts.cacheDir) : resolveEvalCachePath(process.env))
    : null;
  const evalCache = evalCachePath ? new EvalCache(evalCachePath) : null;
  const cacheReadScope = resolveCacheScope({ explicit: process.env.RENOR_QA_CACHE_SCOPE, session: qaSession });
  const pinnedScope = process.env.RENOR_QA_CACHE_SCOPE?.trim() || null;
  // Promotion arms with a pinned scope write DIRECTLY under it: the fresh-DB
  // zero-read guarantee holds by construction, and the recordings become the
  // canonical pool that future iteration arms replay (write-through seeding).
  const cacheWriteScope = arm === 'promotion' && pinnedScope ? cacheReadScope : `x-opencode-session:${qaSession}`;
  let cacheWrites = 0;
  let liveModelCalls = 0;
  // Hard budget cap (owner directive 2026-09-21: resources are NEVER
  // unlimited): every run declares its max live model calls upfront; promotion
  // arms REFUSE to launch without one; the run aborts at the cap (checkpoint
  // makes that a clean pause, never a loss or silent overrun).
  const requestedBudget = opts.maxLiveCalls !== undefined ? Number(opts.maxLiveCalls) : null;
  if (arm === 'promotion' && (requestedBudget === null || !Number.isFinite(requestedBudget) || requestedBudget <= 0)) {
    throw new Error('Refused: promotion arms require --max-live-calls (an explicit live-model-call budget) — resources are never unlimited; price the run before launching it');
  }
  // Iteration arms get a FINITE default budget (owner directive: every run is
  // priced): 2 live calls per pending case is the fully-cold upper bound
  // (answer + judge per case; cached hits come in under it, never over).
  const liveBudget = requestedBudget ?? todo.length * 2;
  const budgetExceeded = (): never => {
    throw new ProductPreconditionError(`Live-call budget exceeded: ${liveModelCalls} >= ${liveBudget} — run aborted at the declared cap (checkpointed; resume raises the budget explicitly)`);
  };
  // On the ledger before the first provider call (the sentinels), so a run
  // that is killed is still on record. A run with nothing left to do spends
  // nothing and is not recorded again.
  let ledgerRecord: RunRecord | null = null;
  if (admission && todo.length > 0) {
    const startGit = gitState(repoRoot);
    ledgerRecord = recordRun(admission, { gitSha: startGit.sha, gitDirty: startGit.dirty, perQuestionResults: checkpointPath });
  }

  const startedAt = new Date().toISOString();
  const newCaseRows: Array<Record<string, unknown>> = [];
  const newResults: Array<Record<string, unknown>> = [];
  // The embed-proxy outlives runs: its counters are lifetime totals, so this run's share is the change.
  const proxyBefore = readProxyCounters(opts.embedProxyStats);

  // Sentinels only when there is work to do (mirrors run-longmemeval-qa).
  let healthProbes = 0;
  if (todo.length > 0) {
    await hooks.models.sentinel('answer');
    await hooks.models.sentinel('judge');
    healthProbes = 2;
  }

  for (const row of todo) {
    // With snapshots on, the case's vault is rendered at a fixed place (the index stores absolute paths) and held by a lock
    // for the case; a slot another run holds means this case is built the ordinary way.
    const claim = snapshotStore ? snapshotStore.claim(row.question_id) : null;
    const workDir = claim ? claim.root : await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-product-'));
    try {
      // Runtime inputs: ONLY allowlisted dataset fields (question, question_date,
      // haystack corpus). Gold fields never enter this marshaling.
      const query = `Question date: ${row.question_date}\n${row.question}`;
      const rendered = await writeQuestionVault(workDir, row);
      const dbPath = path.join(workDir, 'product.db');
      const spawnEnv: Record<string, string> = { VAULT_PATH: rendered.vaultDir, DB_PATH: dbPath, ...childEnv };
      // Structural gold-isolation check over the exact runtime inputs.
      assertGoldIsolatedRuntimeInputs({
        query,
        argv: ['node', '--import', 'tsx', 'src/cli.ts', 'search', '--json', '--top-k', String(opts.topK), query],
        env: spawnEnv,
      });
      const runtimeInputSha256 = sha256(
        [query, ...rendered.files.map(file => `${file.relativePath}:${file.sha256}`)].join('\0'),
      );

      let snapshotCase: ProductQaCase['indexSnapshot'];
      let indexArgs: PublicSearchArgs['index'];
      if (snapshotStore) {
        if (!claim) {
          snapshotCase = { state: 'cold-busy' };
        } else {
          const signature = vaultSignature(rendered.vaultDir, rendered.files);
          const restored = snapshotStore.restore(row.question_id, signature, dbPath);
          if (restored.state === 'restored') {
            snapshotCase = { state: 'restored', savedIndexMs: restored.meta.indexMs };
            indexArgs = { skip: true, replay: restoredReplay(restored.meta.indexReplay) };
          } else {
            snapshotCase = { state: restored.state === 'stale' ? 'rebuilt-stale' : restored.state === 'corrupt' ? 'rebuilt-corrupt' : 'built' };
            indexArgs = {
              onBuilt: ({ indexMs, replay }) => {
                snapshotCase = { ...snapshotCase!, indexMs };
                snapshotStore.save({ questionId: row.question_id, signature, dbPath, indexMs, replay, gitSha: snapshotGitSha });
              },
            };
          }
        }
      }
      const searchStarted = Date.now();
      const publicResult = await hooks.publicSearch({
        query, vaultDir: rendered.vaultDir, dbPath, env: spawnEnv, topK: opts.topK, cwd: repoRoot,
        ...(indexArgs ? { index: indexArgs } : {}),
      });
      // Run-level precondition (defense in depth — holds for every transport, not just the CLI):
      // zero-hit retrieval is an abort, never a scoreable empty case.
      if (publicResult.hits.length === 0) {
        throw new ProductPreconditionError(`Retrieval precondition failed: public surface returned zero hits for case ${row.question_id} — every case must retrieve at least one hit before scoring`);
      }
      const publicSearchMs = Date.now() - searchStarted;
      const hits = publicResult.hits.map(hit => ({ ...hit, notePath: vaultRelativeNotePath(rendered.vaultDir, hit.notePath) }));

      // C0 structured context (RENOR_STRUCTURED_CONTEXT): the product CLI emits
      // `composedContext` alongside hits when the composer is armed. External
      // clients consume ONLY the structured sections (facts/chronicle/prefs) —
      // the composer's own Excerpts section is dropped because the client
      // assembles excerpts itself (with session dates and its own dedupe), so
      // appending both would double-count every hit. Bounded: the excerpts
      // budget shrinks by the structured-section tokens.
      const composedRaw = (publicResult as { composedContext?: { sections?: Array<{ name?: string; included?: boolean; text?: string }>; text?: string } }).composedContext;
      const composedText = (composedRaw?.sections ?? [])
        .filter(s => s?.included && s?.name !== 'excerpts' && typeof s?.text === 'string')
        .map(s => s.text!)
        .join('\n\n');
      const composedTokens = composedText ? countTextTokens(composedText) : 0;
      const excerptBudget = Math.max(0, opts.maxContextTokens - composedTokens);
      const assembled = assembleClientContext(hits, excerptBudget, { contextDates: opts.contextDates === true, stripExcerptMeta: opts.stripExcerptMeta === true });
      const context = composedText ? `${composedText}\n\n${assembled.context}` : assembled.context;
      const contextTokens = composedTokens + assembled.tokens;
      const questionDate = query.match(/^Question date: (.*)\n/)?.[1] ?? '';
      const isAbstention = row.question_id.endsWith('_abs');

      const record: ProductQaCase = {
        id: row.question_id,
        // Scorer-side fields only (never sent to the product process):
        category: row.question_type,
        shouldAbstain: isAbstention,
        questionDate,
        hitsUsed: assembled.hitsUsed,
        contextTokens,
        ...(composedText ? { composedTokens } : {}),
        answer: null,
        judge: null,
        publicSearchMs,
        runtimeInputSha256,
        evidence: caseEvidence(publicResult.evidence),
      };
      const routerFields = publicResult as RouterSearchFields;
      if (snapshotCase) record.indexSnapshot = snapshotCase;
      if (routerFields.router) record.router = relativeRouterReport(routerFields.router, rendered.vaultDir);
      if (routerFields.routerSummaries) record.routerSummaries = routerFields.routerSummaries;
      const digestFields = publicResult as Pick<PublicSearchResult, 'digest' | 'digestStats'>;
      if (digestFields.digest) record.digest = digestFields.digest;
      if (digestFields.digestStats) record.digestStats = digestFields.digestStats;
      try {
        const answerRequestBody = {
          model: opts.answerModel,
          messages: [
            { role: 'system', content: ANSWER_SYSTEM_PROMPT },
            { role: 'user', content: answerUserPrompt(questionDate, row.question, context, opts.answerStyle ?? 'direct') },
          ],
          temperature: opts.temperature,
        };
        const answerNamespace = `${opts.baseUrl}#${opts.answerModel}`;
        const forceLive = erroredIds.has(row.question_id);
        const answerReadKey = evalCache && !forceLive ? EvalCache.computeKey(answerNamespace, answerRequestBody, cacheReadScope) : null;
        const answerWriteKey = evalCache ? EvalCache.computeKey(answerNamespace, answerRequestBody, cacheWriteScope) : null;

        let answerRaw = '';
        let answerEcho = '';
        let answerFinish = '';
        let answerLatency = 0;
        let answerPromptTokens = 0;
        let answerCompletionTokens = 0;
        let answerFromCache = false;
        const cachedAnswer = evalCache && answerReadKey ? evalCache.get(answerReadKey, 'answer') : null;
        if (cachedAnswer) {
          answerRaw = cachedAnswer.rawContent;
          answerEcho = cachedAnswer.modelEcho;
          answerFinish = cachedAnswer.finishReason;
          answerLatency = cachedAnswer.latencyMs;
          answerPromptTokens = cachedAnswer.promptTokens;
          answerCompletionTokens = cachedAnswer.completionTokens;
          answerFromCache = true;
        } else {
          liveModelCalls++;
          if (liveModelCalls > liveBudget) budgetExceeded();
          const call = await hooks.models.modelCall('answer', answerRequestBody);
          answerRaw = call.rawContent;
          answerEcho = call.modelEcho;
          answerFinish = call.finishReason;
          answerLatency = call.latencyMs;
          answerPromptTokens = call.promptTokens;
          answerCompletionTokens = call.completionTokens;
          if (evalCache && answerWriteKey) {
            evalCache.put({
              cacheKey: answerWriteKey,
              providerNamespace: answerNamespace,
              callType: 'answer',
              questionId: row.question_id,
              rawContent: answerRaw,
              modelEcho: answerEcho,
              finishReason: answerFinish,
              promptTokens: answerPromptTokens,
              completionTokens: answerCompletionTokens,
              latencyMs: answerLatency,
              requestBody: answerRequestBody,
            });
            cacheWrites++;
          }
        }
        record.answer = {
          text: answerRaw, modelEcho: answerEcho, finishReason: answerFinish, latencyMs: answerLatency,
          usage: { promptTokens: answerPromptTokens, completionTokens: answerCompletionTokens },
          fromCache: answerFromCache,
          cacheKey: (answerFromCache ? answerReadKey : answerWriteKey) ?? undefined,
        };

        // Gold (expectedAnswer) enters ONLY the judge prompt — scoring infrastructure.
        const judgeNamespace = `${(opts.judgeBaseUrl ?? opts.baseUrl)}#${opts.judgeModel}`;
        const judgeRequestBody = {
          model: opts.judgeModel,
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: judgeUserPrompt(row.question, row.answer, answerRaw) },
          ],
          temperature: opts.temperature,
        };
        const judgeReadKey = evalCache && !forceLive ? EvalCache.computeKey(judgeNamespace, judgeRequestBody, cacheReadScope) : null;
        const judgeWriteKey = evalCache ? EvalCache.computeKey(judgeNamespace, judgeRequestBody, cacheWriteScope) : null;
        // The judge memo (EvalCache.computeJudgeMemoKey): the same question, gold, answer, judge and prompt are never judged twice,
        // across runs and routing sessions. Read by iteration arms only (a promotion arm reads nothing, by construction).
        const judgeMemoKey = evalCache ? EvalCache.computeJudgeMemoKey(judgeNamespace, row.question_id, judgeRequestBody) : null;

        let judgeRaw = '';
        let judgeEcho = '';
        let judgeFinish = '';
        let judgeLatency = 0;
        let judgePromptTokens = 0;
        let judgeCompletionTokens = 0;
        let judgeFromCache = false;
        const memoJudge = evalCache && judgeMemoKey && arm !== 'promotion' && !forceLive ? evalCache.getJudgeMemo(judgeMemoKey) : null;
        const cachedJudge = memoJudge ?? (evalCache && judgeReadKey ? evalCache.get(judgeReadKey, 'judge') : null);
        if (cachedJudge) {
          judgeRaw = cachedJudge.rawContent;
          judgeEcho = cachedJudge.modelEcho;
          judgeFromCache = true;
        } else {
          liveModelCalls++;
          if (liveModelCalls > liveBudget) budgetExceeded();
          const call = await hooks.models.modelCall('judge', judgeRequestBody);
          judgeRaw = call.rawContent;
          judgeEcho = call.modelEcho;
          judgeFinish = call.finishReason;
          judgeLatency = call.latencyMs;
          judgePromptTokens = call.promptTokens;
          judgeCompletionTokens = call.completionTokens;
          if (evalCache && judgeWriteKey) {
            evalCache.put({
              cacheKey: judgeWriteKey,
              providerNamespace: judgeNamespace,
              callType: 'judge',
              questionId: row.question_id,
              rawContent: judgeRaw,
              modelEcho: judgeEcho,
              finishReason: judgeFinish,
              promptTokens: judgePromptTokens,
              completionTokens: judgeCompletionTokens,
              latencyMs: judgeLatency,
              requestBody: judgeRequestBody,
            });
            cacheWrites++;
          }
        }
        const verdict = parseVerdict(judgeRaw);
        // Only a verdict that parsed is memoized: the next run asks again about one that did not.
        if (evalCache && judgeMemoKey && !judgeFromCache && verdict !== null) {
          evalCache.putJudgeMemo({
            cacheKey: judgeMemoKey,
            providerNamespace: judgeNamespace,
            callType: 'judge',
            questionId: row.question_id,
            rawContent: judgeRaw,
            modelEcho: judgeEcho,
            finishReason: judgeFinish,
            promptTokens: judgePromptTokens,
            completionTokens: judgeCompletionTokens,
            latencyMs: judgeLatency,
            requestBody: judgeRequestBody,
          });
        }
        record.judge = {
          raw: judgeRaw, verdict, parseOk: verdict !== null, modelEcho: judgeEcho,
          fromCache: judgeFromCache,
          cacheKey: (judgeFromCache ? (memoJudge ? judgeMemoKey : judgeReadKey) : judgeWriteKey) ?? undefined,
        };
        if (verdict === null) record.error = 'judge-unparseable';
      } catch (error) {
        if (error instanceof ProductPreconditionError) throw error; // run abort, never a per-case score
        record.error = error instanceof Error ? error.message : String(error);
      }

      fs.appendFileSync(checkpointPath, JSON.stringify(record) + '\n', 'utf8');
      if (ledgerRecord) archiveRow(ledgerRecord, JSON.stringify(record));
      process.stderr.write(`[product] ${done.size + newCaseRows.length + 1}/${selected.length} ${row.question_id} ${record.error ? 'ERROR:' + record.error : record.judge?.verdict === 1 ? 'correct' : record.judge?.verdict === 0 ? 'wrong' : '?'}${record.evidence?.state === 'failed' ? ` evidence:failed(${record.evidence.reason ?? 'unknown'})` : ''}\n`);

      // Scorer artifacts: cases.jsonl (gold for failure classification —
      // scorer-side only) and results.jsonl (the PUBLIC-SURFACE hits the client
      // received). Neither is ever an input to the product process.
      newCaseRows.push({
        id: row.question_id,
        category: row.question_type,
        query,
        relevant: row.answer_session_ids.map(id => ({
          match: safeSegment(id),
          notePath: `Sessions/${safeSegment(id)}.md`,
          relevance: 1,
          role: 'positive',
        })),
        expectedAnswer: row.answer,
        shouldAbstain: isAbstention,
        split: 'test',
      });
      newResults.push({
        id: row.question_id,
        hits: hits.map(hit => ({ text: hit.text, notePath: hit.notePath, score: hit.score })),
        latencyMs: publicSearchMs,
        contextTokens,
      });
    } finally {
      if (claim) claim.release();
      else await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  // Compact the checkpoint last-wins per id: a self-healing retry appends a
  // superseding row for the same case; the scorer must never double-count a
  // retried case, and the final manifest/cases view is the compacted set.
  const rawCheckpointRows = readCheckpoint<ProductQaCase>(checkpointPath, JSON.parse);
  const cases = [...new Map(rawCheckpointRows.map(row => [row.id, row])).values()];
  if (cases.length !== rawCheckpointRows.length) {
    await fsp.writeFile(checkpointPath, jsonl(cases), 'utf8');
  }
  const finishedAt = new Date().toISOString();
  const answerErrors = cases.filter(c => !c.answer).length;
  const judgeParseFailures = cases.filter(c => c.judge && !c.judge.parseOk).length;
  const answerEchoes = [...new Set(cases.map(c => c.answer?.modelEcho).filter((echo): echo is string => Boolean(echo)))];
  const judgeEchoes = [...new Set(cases.map(c => c.judge?.modelEcho).filter((echo): echo is string => Boolean(echo)))];

  const git = gitState(repoRoot);
  const evaluator = evaluatorSourceHash(repoRoot);
  const datasetSha = datasetSha256File(datasetPath);
  const embeddingWindow = proxyWindow(proxyBefore, readProxyCounters(opts.embedProxyStats));
  // This run's index snapshot outcomes, from the records that were written (a resumed run counts its earlier cases too).
  const snapshotCounts = {
    restored: 0, built: 0, coldBusy: 0, rebuiltStale: 0, rebuiltCorrupt: 0, indexMsSpent: 0, indexMsNotSpent: 0,
  };
  for (const c of cases) {
    const state = c.indexSnapshot?.state;
    if (!state) continue;
    if (state === 'restored') { snapshotCounts.restored++; snapshotCounts.indexMsNotSpent += c.indexSnapshot?.savedIndexMs ?? 0; continue; }
    if (state === 'cold-busy') snapshotCounts.coldBusy++;
    else snapshotCounts.built++;
    if (state === 'rebuilt-stale') snapshotCounts.rebuiltStale++;
    if (state === 'rebuilt-corrupt') snapshotCounts.rebuiltCorrupt++;
    snapshotCounts.indexMsSpent += c.indexSnapshot?.indexMs ?? 0;
  }
  const manifest = {
    schemaVersion: 1,
    benchmark: 'longmemeval-s-qa-end-to-end',
    manifestContractVersion: MANIFEST_CONTRACT_VERSION,
    executionKind: 'product-public',
    publicEntryPoint: 'cli',
    entryPointDetail: {
      transport: 'cli-subprocess',
      command: `${process.execPath} --import tsx src/cli.ts search --json --top-k ${opts.topK} <query>`,
      indexCommand: `${process.execPath} --import tsx src/cli.ts index (env VAULT_PATH/DB_PATH/EMBEDDING_PROVIDER=${opts.embeddingProvider})`,
    },
    runtimeVisibleFieldAllowlist: [...PRODUCT_RUNTIME_FIELD_ALLOWLIST],
    goldIsolated: true,
    goldIsolationBasis: 'structural marshal check (assertGoldIsolatedRuntimeInputs) + poisoned-fixture parity test (tests/eval/product-path-contract.test.ts); per-case runtimeInputSha256 snapshots',
    productMode: {
      defaults: 'shipped product defaults via public CLI (search --json)',
      overrides: [`EMBEDDING_PROVIDER=${opts.embeddingProvider}`, `topK=${opts.topK}`, `contextDates=${opts.contextDates === true}`, `stripExcerptMeta=${opts.stripExcerptMeta === true}`, `answerStyle=${(opts.answerStyle === 'bestguess' || opts.answerStyle === 'count') ? opts.answerStyle : 'direct'}`, ...productFeatureFlagOverrides({ ...process.env, ...structuredRowFlags }), ...(opts.idsFile ? [`idsFile=${path.basename(opts.idsFile)}(${selected.length} ids)`] : [])],
    },
    composition: {
      arms: [arm],
      live: liveModelCalls,
      cacheHits: (evalCache?.stats.answerHits ?? 0) + (evalCache?.stats.judgeHits ?? 0),
      mergedFrom: null,
    },
    // End-of-run promotion guard: zero reads must hold not just by construction
    // but by measured assertion — any read hit in a promotion arm is a defect.
    ...(arm === 'promotion' && evalCache && evalCache.stats.answerHits + evalCache.stats.judgeHits > 0
      ? (() => { throw new Error(`Promotion arm recorded ${(evalCache.stats.answerHits) + (evalCache.stats.judgeHits)} cache HIT(S) — zero-read must hold by construction and by measurement; aborting before the manifest is accepted`); })()
      : {}),
    coverage: {
      casesTotal: selected.length,
      casesCompleted: cases.length,
      answerErrors,
      judgeParseFailures,
      failedRunRecorded: false,
    },
    evidence: evidenceCoverage(cases),
    cache: {
      enabled: Boolean(evalCache),
      arm,
      scope: cacheReadScope,
      reads: (evalCache?.stats.answerHits ?? 0) + (evalCache?.stats.answerMisses ?? 0)
        + (evalCache?.stats.judgeHits ?? 0) + (evalCache?.stats.judgeMisses ?? 0),
      hits: (evalCache?.stats.answerHits ?? 0) + (evalCache?.stats.judgeHits ?? 0),
      writes: cacheWrites,
      dbPath: evalCachePath,
      schemaVersion: CACHE_SCHEMA_VERSION,
    },
    // Every cache layer this run read or wrote, side by side (src/eval/cacheReport.ts has the per-layer rates).
    cachesUsed: {
      arm,
      embedding: embeddingWindow
        ? { via: 'embed-proxy', hits: embeddingWindow.hits, misses: embeddingWindow.misses, ...(embeddingWindow.sent ? { sentToProvider: embeddingWindow.sent } : {}) }
        : { via: opts.embeddingProvider === 'openai' ? 'unmeasured' : opts.embeddingProvider },
      evalCache: evalCache
        ? {
            enabled: true,
            answerHits: evalCache.stats.answerHits, answerMisses: evalCache.stats.answerMisses,
            judgeHits: evalCache.stats.judgeHits, judgeMisses: evalCache.stats.judgeMisses,
            judgeMemoHits: evalCache.stats.judgeMemoHits, judgeMemoMisses: evalCache.stats.judgeMemoMisses,
            scopePinned: Boolean(pinnedScope),
          }
        : { enabled: false },
      indexSnapshots: snapshotStore
        ? {
            enabled: true,
            configHash: snapshotStore.config.hash,
            restored: snapshotCounts.restored, built: snapshotCounts.built, coldBusy: snapshotCounts.coldBusy,
            rebuiltStale: snapshotCounts.rebuiltStale, rebuiltCorrupt: snapshotCounts.rebuiltCorrupt,
            indexMsSpent: snapshotCounts.indexMsSpent, indexMsNotSpent: snapshotCounts.indexMsNotSpent,
            vaultBase: snapshotStore.config.components.vaultBase,
            components: snapshotStore.config.components,
          }
        : { enabled: false },
      // Caches the product process itself reads, named by whether the operator pointed them at a path (the paths are not recorded).
      productCaches: Object.fromEntries(['RENOR_EVIDENCE_CACHE', 'RENOR_DIGEST_CACHE', 'RENOR_ROUTER_CACHE'].map(name => [name, Boolean(childEnv[name])])),
    },
    provenance: {
      gitSha: git.sha,
      gitDirty: git.dirty,
      gitStatusSha256: git.statusSha256,
      evaluatorSha256: evaluator,
      datasetSha256: datasetSha,
      packageLockSha256: packageLockSha256(repoRoot),
    },
    models: {
      answerRequested: opts.answerModel,
      answerEchoes,
      judgeRequested: opts.judgeModel,
      judgeEchoes,
    },
    watermark: null,
    // Present only when the run armed RENOR_SESSION_ROUTER (a control run's manifest is unchanged).
    ...(() => {
      const routerCoverage = summarizeRouterCoverage(cases);
      return routerCoverage ? { routerCoverage } : {};
    })(),
    // Compatibility fields for existing tooling:
    gitSha: git.sha,
    gitDirty: git.dirty,
    evaluatorSha256: evaluator,
    datasetSha256: datasetSha,
    answerModelRequested: opts.answerModel,
    judgeModelRequested: opts.judgeModel,
    answerModelEchoes: answerEchoes,
    judgeModelEchoes: judgeEchoes,
    answerHits: evalCache?.stats.answerHits ?? 0,
    answerMisses: evalCache?.stats.answerMisses ?? 0,
    judgeHits: evalCache?.stats.judgeHits ?? 0,
    judgeMisses: evalCache?.stats.judgeMisses ?? 0,
    cacheScope: cacheReadScope,
    cacheWriteScope,
    qaSession,
    topK: opts.topK,
    maxContextTokens: opts.maxContextTokens,
    temperature: opts.temperature,
    embeddingProvider: opts.embeddingProvider,
    embeddingModel: opts.embeddingProvider === 'openai' ? (process.env.EMBEDDING_MODEL ?? null) : null,
    embeddingBaseURL: opts.embeddingProvider === 'openai' ? (process.env.EMBEDDING_BASE_URL ?? null) : null,
    ...embedProxyManifestFields(opts),
    embeddingDims: opts.embeddingProvider === 'openai' && process.env.EMBEDDING_DIMS ? Number(process.env.EMBEDDING_DIMS) : null,
    transportSmoke: opts.transportSmoke === true,
    perCaseRuntimeInputSha256: Object.fromEntries(cases.map(c => [c.id, c.runtimeInputSha256])),
    startedAt,
    finishedAt,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };

  // Scorer artifacts cover the FULL selected set (resume included): prior rows
  // are re-read from disk so a resumed run never loses earlier cases.
  const priorCaseRows = fs.existsSync(path.join(outputDir, 'cases.jsonl'))
    ? fs.readFileSync(path.join(outputDir, 'cases.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    : [];
  const priorResults = fs.existsSync(path.join(outputDir, 'results.jsonl'))
    ? fs.readFileSync(path.join(outputDir, 'results.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    : [];
  const mergedCases = new Map(priorCaseRows.map(row => [row.id, row]));
  for (const row of newCaseRows) mergedCases.set(row.id, row);
  const mergedResults = new Map(priorResults.map(row => [row.id, row]));
  for (const row of newResults) mergedResults.set(row.id, row);

  await Promise.all([
    fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'cases.jsonl'), jsonl([...mergedCases.values()]), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'results.jsonl'), jsonl([...mergedResults.values()]), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'qa-cases.sha256'), sha256(fs.readFileSync(checkpointPath, 'utf8')) + '\n', 'utf8'),
  ]);
  emitCacheReport(buildCacheReport({
    embedding: embeddingWindow,
    evalCache: evalCache?.stats,
    liveModelCalls,
    pinnedScope: Boolean(pinnedScope),
    healthProbes,
    ...(snapshotStore ? { indexSnapshots: { restored: snapshotCounts.restored, built: snapshotCounts.built, coldBusy: snapshotCounts.coldBusy, savedIndexMs: snapshotCounts.indexMsNotSpent } } : {}),
  }), outputDir);
  if (ledgerRecord) {
    saveRunOutcome(ledgerRecord, {
      status: cases.filter(c => !c.error).length === selected.length ? 'complete' : 'incomplete',
      finishedAt,
      casesTotal: selected.length,
      casesCompleted: cases.length,
      correct: cases.filter(c => c.judge?.verdict === 1).length,
      answerErrors,
      judgeParseFailures,
      liveModelCalls,
    });
  }
  evalCache?.close();
  fs.rmSync(runLockPath, { force: true });

  return { outputDir, manifest, cases };
}

// ─── CLI entry ───

async function main(): Promise<void> {
  assertNoSidecarFlags(process.argv.slice(2));
  const opts = parseProductArgs(process.argv.slice(2));
  const apiKeyEnv = opts.apiKeyEnv;
  const judgeKeyEnv = opts.judgeApiKeyEnv ?? apiKeyEnv;
  const judgeKeys = resolveJudgeKeys(process.env, judgeKeyEnv, opts.judgeKeysEnv || undefined);
  if (judgeKeys.length === 0) throw new Error(`Judge API key env ${judgeKeyEnv} is not set`);
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`API key env ${apiKeyEnv} is not set`);
  const qaSession = process.env.RENOR_QA_SESSION ?? `renor-eval-product-${process.pid}-${Date.now().toString(36)}`;
  const judgeKeyPool = new KeyPool(judgeKeys, 1);
  const retries = Number(opts.retries);
  const temperature = Number(opts.temperature);

  const hooks: ProductHooks = {
    publicSearch: cliPublicSearch,
    models: {
      async modelCall(callType, requestBody) {
        if (callType === 'answer') {
          const call = await chatCall({
            baseUrl: opts.baseUrl, apiKey, requestBody, timeoutMs: 120_000, retries, session: qaSession,
          });
          return {
            rawContent: call.body.choices?.[0]?.message?.content ?? '',
            modelEcho: call.body.model ?? '',
            finishReason: call.body.choices?.[0]?.finish_reason ?? '',
            promptTokens: call.body.usage?.prompt_tokens ?? 0,
            completionTokens: call.body.usage?.completion_tokens ?? 0,
            latencyMs: call.latencyMs,
          };
        }
        const pooled = await runWithKeyPoolRetries(judgeKeyPool, retries, async ({ key }) =>
          chatCall({
            baseUrl: opts.judgeBaseUrl ?? opts.baseUrl, apiKey: key, requestBody,
            timeoutMs: 60_000, retries: 1, session: qaSession,
          }));
        return {
          rawContent: pooled.value.body.choices?.[0]?.message?.content ?? '',
          modelEcho: pooled.value.body.model ?? '',
          finishReason: pooled.value.body.choices?.[0]?.finish_reason ?? '',
          promptTokens: pooled.value.body.usage?.prompt_tokens ?? 0,
          completionTokens: pooled.value.body.usage?.completion_tokens ?? 0,
          latencyMs: pooled.value.latencyMs,
        };
      },
      async sentinel(callType) {
        const requestBody = callType === 'answer'
          ? { model: opts.answerModel, messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }], temperature: 0 }
          : { model: opts.judgeModel, messages: [{ role: 'user', content: 'Reply with exactly 1 and nothing else.' }], temperature: 0 };
        const call = await chatCall({
          baseUrl: callType === 'answer' ? opts.baseUrl : (opts.judgeBaseUrl ?? opts.baseUrl),
          apiKey: callType === 'answer' ? apiKey : judgeKeys[0],
          requestBody, timeoutMs: 30_000, retries: 2, session: qaSession,
        });
        const content = (call.body.choices?.[0]?.message?.content ?? '').trim();
        if (callType === 'answer' && !/^ok[.!]?$/i.test(content)) {
          throw new Error(`answerer sentinel failed: ${JSON.stringify(content.slice(0, 120))}`);
        }
        if (callType === 'judge' && parseVerdict(content) !== 1) {
          throw new Error(`judge sentinel failed: ${JSON.stringify(content.slice(0, 120))}`);
        }
      },
    },
  };

  const result = await runProductBenchmark({
    dataset: opts.dataset,
    output: opts.output,
    topK: Number(opts.topK),
    limit: Number(opts.limit),
    offset: Number(opts.offset),
    shardIndex: Number(opts.shardIndex),
    shardCount: Number(opts.shardCount),
    maxContextTokens: Number(opts.maxContextTokens),
    embeddingProvider: opts.embeddingProvider,
    transportSmoke: opts.transportSmoke === true,
    embedProxyStats: opts.embedProxyStats,
    arm: (opts.arm as CacheArm) ?? 'iteration',
    cache: opts.cache !== false,
    cacheDir: opts.cacheDir,
    answerModel: opts.answerModel,
    judgeModel: opts.judgeModel,
    baseUrl: opts.baseUrl,
    judgeBaseUrl: opts.judgeBaseUrl,
    apiKeyEnv,
    judgeApiKeyEnv: judgeKeyEnv,
    judgeKeysEnv: opts.judgeKeysEnv || undefined,
    maxLiveCalls: typeof opts.maxLiveCalls === 'number' ? opts.maxLiveCalls : undefined,
    contextDates: opts.contextDates === true,
    structuredRows: opts.structuredRows === true,
    stripExcerptMeta: opts.stripExcerptMeta === true,
    answerStyle: (opts.answerStyle === 'bestguess' || opts.answerStyle === 'count') ? opts.answerStyle : 'direct',
    idsFile: opts.idsFile ? path.resolve(opts.idsFile) : undefined,
    temperature,
    retries,
    runLedger: { path: resolveRunLedgerPath(process.env), rerunReason: opts.rerunReason },
    // Cached iteration runs restore memory stores; promotion arms and --no-cache runs build everything cold, as ever.
    ...(opts.arm !== 'promotion' && opts.cache !== false && opts.indexSnapshots !== false
      ? { snapshots: { root: resolveSnapshotRoot(opts.snapshotDir), vaultBase: resolveVaultBase(opts.snapshotVaultBase) } }
      : {}),
  }, hooks);
  const evidence = result.manifest.evidence as EvidenceCoverage;
  console.log(JSON.stringify({
    outputDir: result.outputDir,
    casesCompleted: result.cases.length,
    executionKind: result.manifest.executionKind,
    publicEntryPoint: result.manifest.publicEntryPoint,
    evidence: { ...evidence, failed: evidence.failed.length },
  }, null, 2));
}

// Run main() only when executed directly as a script (tsx sets argv[1] to this
// file). Importers (contract tests) get the exported helpers without side effects.
const invokedDirectly = process.argv[1]?.endsWith('run-longmemeval-product.ts') === true;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof RunRefusedError ? error.message : error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}