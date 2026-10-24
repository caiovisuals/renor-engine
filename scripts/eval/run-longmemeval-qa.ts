import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import { countTextTokens } from '../../src/eval/textTokens';
import { evaluatorSourceHash, gitState, researchTruthFields } from '../../src/eval/runManifest';
import { claimDirectory } from '../../src/eval/artifacts';
import { EvalCache, KeyPool, WorkerPool, CACHE_SCHEMA_VERSION, resolveEvalCachePath, resolveJudgeKeys, runWithKeyPoolRetries, parseRetryAfterMs, resolveWorkerConcurrency, summarizeQaTokenUsage, resolveCacheScope } from '../../src/eval/evalCache';
import { buildCacheReport, emitCacheReport } from '../../src/eval/cacheReport';
import { verifyPageDump } from '../../src/eval/pageDump';
import type { EvalCacheEntry } from '../../src/eval/evalCache';
import { admitRun, archiveRow, codeIdentity, questionSet, recordRun, resolveRunLedgerPath, RUN_LEDGER_ENV, RunRefusedError, saveRunOutcome } from '../../src/eval/runLedger';

/** The code a QA run executes: this stage, the measurement code it imports (src/eval) and the locked dependencies. */
const QA_RUN_CODE_ROOTS = ['src/eval', 'scripts/eval/run-longmemeval-qa.ts', 'package-lock.json'] as const;

const fileSha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex');

/**
 * Ablation flags (--context-dates, --suppress-header-only, --recency-order)
 * change ONLY how the answer context is assembled. Flag-off reproduces the
 * control run byte-for-byte at the prompt level. --closed-book is the raw-LLM
 * control: question + question date only, no excerpts. All flags are recorded
 * in the manifest so every arm is attributable.
 */

/**
 * End-to-end LongMemEval QA stage: reads a completed retrieval run's artifacts
 * (cases.jsonl + results.jsonl), asks an answer model with ONLY the question
 * and the retrieved excerpts (gold answers never enter the answer prompt),
 * then asks a judge model to compare the answer against the gold answer.
 *
 * Gold leakage guard: expectedAnswer is read from cases.jsonl but is used
 * exclusively inside the judge prompt.
 *
 * Per-question checkpointing: every completed question is appended to
 * qa-cases.jsonl immediately; re-invocation resumes from the last complete
 * line. API failures are recorded as error cases, never silently converted
 * into incorrect answers.
 */

interface EvalCaseRow {
  id: string;
  category: string;
  query: string;
  relevant: Array<{ match: string; notePath?: string; relevance: number; role: string }>;
  expectedAnswer: string;
  shouldAbstain: boolean;
}
interface HitRow { text: string | null; notePath: string; score: number }
interface ResultRow { id: string; hits: HitRow[]; latencyMs: number; contextTokens: number }

interface QaCase {
  id: string;
  category: string;
  shouldAbstain: boolean;
  questionDate: string;
  hitsUsed: number;
  contextTokens: number;
  answer: { text: string; modelEcho: string; finishReason: string; attempts: number; latencyMs: number; usage?: { promptTokens: number; completionTokens: number }; fromCache?: boolean; cacheKey?: string } | null;
  judge: { raw: string; verdict: 0 | 1 | null; parseOk: boolean; modelEcho: string; attempts: number; latencyMs: number; usage?: { promptTokens: number; completionTokens: number }; fromCache?: boolean; cacheKey?: string } | null;
  hitsSuppressed?: number;
  completionActivated?: boolean;
  completionAdded?: number;
  completionTokens?: number;
  temporalTokens?: number;
  factsTokens?: number;
  chronicleTokens?: number;
  error?: string;
}

const ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant answering questions using provided conversation memory excerpts.';
const CLOSED_BOOK_SYSTEM_PROMPT = 'You are a helpful assistant answering a question about a user\'s personal history. You are not given any of their conversation memory.';
const CLOSED_BOOK_INSTRUCTION = 'Answer the question directly and concisely. You have no access to this user\'s personal conversation history. If you cannot know the answer from the question itself, reply exactly: I don\'t know.';

const ANSWER_STYLE_INSTRUCTION: Record<'direct' | 'cot' | 'sum' | 'preference' | 'bestguess' | 'chrono' | 'enumerate', string> = {
  direct: 'Answer the question directly and concisely based on the excerpts above. Do not add caveats or explanations. If the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.',
  cot: 'First, briefly reason from the excerpts — note any relevant dates, compute durations or orderings step by step, and cite which excerpt supports each fact. Then end your reply with a final line in exactly this format:\nAnswer: <final short answer>\nIf the excerpts do not contain the information needed to answer, end with:\nAnswer: I don\'t know.',
  sum: 'Answer the question directly and concisely based on the excerpts above. If several excerpts each contain a number the question asks to total, add those amounts and report the sum. Do not invent amounts that are not in the excerpts. Do not add caveats or explanations. If the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.',
  preference: 'Answer the question directly and concisely based on the excerpts above. If the excerpts state an explicit user preference, constraint, or policy that applies to this question, apply it in the answer. Do not invent preferences that are not in the excerpts. Do not add caveats or explanations. If the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.',
  bestguess: 'Answer the question directly and concisely based on the excerpts above. Do not add caveats or explanations. If the excerpts and tables do not state the exact value, give your single best answer supported by the most relevant excerpt — infer only what the excerpts directly imply (dates, counts, names, stated preferences). Reply exactly "I don\'t know" only when no excerpt is relevant to the question at all.',
  chrono: 'Answer the question directly and concisely based on the excerpts above. The question asks about ordering or a time interval: first list every relevant event with its excerpt date (the question date is given in the question line), then compute day or week differences against the question date, or order the events by date. Perform the arithmetic explicitly before answering. Do not invent events or dates that are not in the excerpts. Then give your single best final answer; reply exactly "I don\'t know" only when no excerpt is relevant to the question at all.',
  enumerate: 'If and only if the question asks for the number of distinct items, events, or instances (a cardinality count), first list each distinct matching item as a bullet (one per line, with its excerpt date when available), then give the final count as the last line in exactly this format:\nAnswer: <integer>\nCount repeated mentions of the same underlying item or event only once. Include an item only when it matches the entity, action, role, and constraint asked by the question; for example, attended is not hosted, and received is not bought. Count only items the excerpts actually describe; never invent items or include merely word-related items. Do not treat sums of quantities, money, durations, or other additive totals as cardinality counts. If the excerpts do not contain enough information to count, reply exactly: I don\'t know. For every non-count question, follow the direct contract exactly: answer the question directly and concisely based on the excerpts above, do not add caveats or explanations, and if the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.',
};

const answerUserPrompt = (questionDate: string, question: string, context: string, style: 'direct' | 'cot' | 'sum' | 'preference' | 'bestguess' | 'chrono' | 'enumerate' = 'direct') => `Conversation memory excerpts (retrieved from long-term memory, highest relevance first):

${context}

Question (asked on ${questionDate}): ${question}

${ANSWER_STYLE_INSTRUCTION[style]}`;

const JUDGE_SYSTEM_PROMPT = 'You are an impartial judge evaluating whether an AI assistant\'s answer is correct.';

const judgeUserPrompt = (question: string, gold: string, answer: string) => `Question: ${question}

Ground truth answer: ${gold}

Assistant's answer: ${answer}

Does the assistant's answer agree with the ground truth in substance (correct fact, person, value, or the required "I don't know")? Respond with ONLY the single digit 1 if correct, or 0 if incorrect, incomplete, or evasive. Output nothing else.`;

interface ChatMessage { role: 'system' | 'user'; content: string }

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Unique per-process default session. A shared default ('renor-eval-session')
 * routed every run to the same (degradable) backend on the Go endpoint: same
 * prompt, 0 reasoning tokens, "I don't know" answers — and the session-blind
 * eval cache then replayed those poisoned draws across runs (COMBO incident,
 * 2026-09-18). Callers may still pin a session via RENOR_QA_SESSION.
 */
const EXPLICIT_QA_SESSION = process.env.RENOR_QA_SESSION;
const DEFAULT_QA_SESSION = `renor-eval-${process.pid}-${Date.now().toString(36)}`;
const EFFECTIVE_QA_SESSION = EXPLICIT_QA_SESSION ?? DEFAULT_QA_SESSION;
/**
 * Optional canonical cache scope for deliberate cross-run reuse.
 *
 * Canonical hits may be replayed immediately, but new live responses are first
 * written under the unique routing-session scope. They are promoted into the
 * canonical scope only after the whole run finishes cleanly and a second set of
 * cache-bypassing health checks succeeds. This keeps a transient bad routed
 * session from becoming permanent shared cache state.
 *
 * Canonical scope names are managed by the benchmark-infrastructure registry
 * (introduced in PR #67).
 */
const EXPLICIT_CACHE_SCOPE = process.env.RENOR_QA_CACHE_SCOPE;

function chatHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': process.env.RENOR_QA_USER_AGENT ?? 'renor-eval/1.0',
    'x-opencode-session': EFFECTIVE_QA_SESSION,
    ...(extra ?? {}),
  };
}

async function chatCall(args: {
  baseUrl: string; apiKey: string; requestBody: Record<string, unknown>;
  timeoutMs: number; retries: number;
  onHttpError?: (status: number, retryAfterMs?: number) => void;
}): Promise<{ body: ChatResponse; attempts: number; latencyMs: number }> {
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= args.retries; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const response = await fetch(`${args.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(args.apiKey),
        body: JSON.stringify(args.requestBody),
        signal: controller.signal,
      });
      if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        args.onHttpError?.(response.status, retryAfterMs);
      }
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
      }
      // The abort timer stays ARMED while the body is consumed and is cleared in
      // `finally`. It used to be cleared the moment headers arrived, so a stream
      // that stalled mid-body hung the run forever — no timeout, no retry, no
      // error row. Measured 2026-09-26 on the product runner: a full-500 wedged at
      // case 201 for 45+ minutes with the process parked in ep_poll and zero open
      // requests. This runner shares the same shape and the same providers.
      const body = (await response.json()) as ChatResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) throw new Error('empty/missing assistant content');
      return { body, attempts: attempt, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < args.retries) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`API failed after ${args.retries} attempts: ${lastError}`);
}

function parseVerdict(raw: string): 0 | 1 | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^(1|yes|correct|true)\b/.test(trimmed)) return 1;
  if (/^(0|no|incorrect|false)\b/.test(trimmed)) return 0;
  const digit = trimmed.match(/\b([01])\b/);
  if (digit) return digit[1] === '1' ? 1 : 0;
  return null;
}

function parseOptionalPositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer (got ${value})`);
  }
  return parsed;
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

/** Tolerate a trailing partially-written line from a crash mid-append. */
function readCheckpoint(file: string): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(file)) return done;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try { done.add((JSON.parse(line) as { id: string }).id); } catch { /* partial trailing line — ignore */ }
  }
  return done;
}

const sha256 = (data: string) => crypto.createHash('sha256').update(data).digest('hex');

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const prefix = normalized.slice(0, 100) || 'session';
  return `${prefix}-${sha256(value).slice(0, 10)}`;
}

/** Canonical session segment (strips -occN) — occurrence N shares the source id/date. */
const canonicalSegment = (notePath: string) => notePath.replace(/^Sessions\//, '').replace(/-occ\d+\.md$/, '.md').replace(/\.md$/, '');

/** notePath -> session date, built from the dataset with the runner's exact nth-occurrence rule. */
function buildDateMap(row: { haystack_session_ids: string[]; haystack_dates: string[] }): Map<string, string> {
  const dates = new Map<string, string>();
  const occurrences = new Map<string, number>();
  for (let index = 0; index < row.haystack_session_ids.length; index++) {
    const id = row.haystack_session_ids[index];
    const nth = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, nth);
    // Only the first occurrence owns the canonical filename (mirrors writeQuestionVault).
    if (nth === 1) dates.set(safeSegment(id), row.haystack_dates[index]);
    dates.set(`${safeSegment(id)}-occ${nth}`, row.haystack_dates[index]);
  }
  return dates;
}

const isHeaderOnly = (text: string) => !text.includes('### Turn') && text.trim().length < 250;

// P1 strip-excerpt-meta: remove ONLY pure-meta header lines from an excerpt
// block — the `# Session <id>` line, the `Timestamp:` line, and the
// `[Excerpt N]` marker. Every byte of turn content and every `Session date:`
// footer (the excerpt END-time, load-bearing per the tick-9 diversity kill)
// is preserved verbatim. Lines that mix meta with content are never touched.
const stripExcerptMetaLines = (text: string): string => {
  const stripped = text
    .replace(/^# Session .+$/gm, '')
    .replace(/^Timestamp: .+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
  return stripped.replace(/^\[Excerpt \d+\]\n?/, '');
};

async function verifyCanonicalPromotionHealth(args: {
  answerBaseUrl: string;
  answerApiKey: string;
  answerModel: string;
  judgeBaseUrl: string;
  judgeKeys: string[];
  judgeModel: string;
}): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const answer = await chatCall({
      baseUrl: args.answerBaseUrl,
      apiKey: args.answerApiKey,
      requestBody: {
        model: args.answerModel,
        messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }],
        temperature: 0,
      },
      timeoutMs: 30_000,
      retries: 2,
    });
    const content = answer.body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!/^ok[.!]?$/i.test(content)) {
      throw new Error(`unexpected answerer sentinel response: ${JSON.stringify(content.slice(0, 120))}`);
    }
  } catch (error) {
    errors.push(`answerer: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (let i = 0; i < args.judgeKeys.length; i++) {
    try {
      const judge = await chatCall({
        baseUrl: args.judgeBaseUrl,
        apiKey: args.judgeKeys[i],
        requestBody: {
          model: args.judgeModel,
          messages: [{ role: 'user', content: 'Reply with exactly 1 and nothing else.' }],
          temperature: 0,
        },
        timeoutMs: 30_000,
        retries: 1,
      });
      const content = judge.body.choices?.[0]?.message?.content ?? '';
      if (parseVerdict(content) !== 1) {
        throw new Error(`unexpected judge sentinel response: ${JSON.stringify(content.trim().slice(0, 120))}`);
      }
    } catch (error) {
      errors.push(`judge-key-${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

async function main(): Promise<void> {
  const program = new Command()
    .name('run-longmemeval-qa')
    .requiredOption('--run <dir>', 'completed retrieval run directory (cases.jsonl + results.jsonl)')
    .requiredOption('--output <dir>', 'QA run output directory')
    .option('--answer-model <id>', 'answer model identifier', process.env.RENOR_QA_ANSWER_MODEL ?? 'deepseek-v4.1-flash')
    .option('--judge-model <id>', 'judge model identifier', process.env.RENOR_QA_JUDGE_MODEL ?? 'gemma4:31b')
    .option('--base-url <url>', 'OpenAI-compatible endpoint for the answerer (and judge unless --judge-base-url)', process.env.RENOR_QA_BASE_URL ?? 'https://ollama.com/v1')
    .option('--api-key-env <name>', 'env var holding the answerer API key', 'OLLAMA_API_KEY')
    .option('--judge-base-url <url>', 'OpenAI-compatible endpoint for the judge (defaults to --base-url)')
    .option('--judge-api-key-env <name>', 'env var holding the judge API key (defaults to --api-key-env)')
    .option('--max-context-tokens <n>', 'context token cap built from top-K hits', '6000')
    .option('--answer-max-tokens <n>', 'max completion tokens for answer calls (includes hidden reasoning tokens on reasoning models). Omit to let the provider cap apply — a small explicit cap truncates reasoning before any answer text is emitted.')
    .option('--judge-max-tokens <n>', 'max completion tokens for judge calls; omit to let the provider cap apply')
    .option('--temperature <t>', 'sampling temperature for both models', '0')
    .option('--retries <n>', 'per-call retry attempts', '5')
    .option('--context-dates', 'ABLATION: annotate each excerpt with its session date')
    .option('--suppress-header-only', 'ABLATION: drop header-only excerpts (no turn content, <250 chars)')
    .option('--strip-excerpt-meta', 'ABLATION: strip pure-meta header lines (# Session <id>, Timestamp:, [Excerpt N]) from excerpt blocks; content and Session date footers kept', process.env.RENOR_STRIP_EXCERPT_META === '1' ? true : undefined)
    .option('--recency-order', 'ABLATION: order excerpts newest-session-first (implies date annotation)')
    .option('--answer-style <style>', 'answer prompt style: direct (default), cot, sum, preference, bestguess, chrono, or enumerate', 'direct')
    .option('--ids-file <path>', 'optional: run only the question ids listed in this file (one id per line; # comments ok)')
  .option('--completion-run <dir>', 'ABLATION: deep candidate retrieval run (e.g. top-100) for one bounded evidence-completion pass')
  .option('--completion-max-chunks <n>', 'max chunks added by evidence completion per question', '10')
  .option('--completion-token-budget <n>', 'max tokens added by evidence completion per question', '1500')
    .option('--temporal-sidecar', 'ABLATION: append a deterministic timeline (dates, order, day deltas) derived only from excerpt session dates')
    .option('--facts-file <path>', 'ABLATION: JSON {id: [{value,unit,verb,object,event}]} rendered as a facts table appended to context')
    .option('--facts-fallback', 'ABLATION: add fallback sentence to facts table instruction (answer from excerpts when table lacks the value)')
    .option('--chronicle-file <path>', 'ABLATION: JSON {id: [{when,event,entities}]} rendered as an events chronicle table appended to context')
    .option('--prefs-file <path>', 'ABLATION: JSON {id: [{statement,kind}]} rendered as a user preferences/constraints table appended to context')
    .option('--router-ctx-threshold <n>', 'H2 ROUTER: append tables only when category is in --router-tabled-cats AND raw retrieval context tokens < N (0 = off, default)', '0')
    .option('--router-tabled-cats <list>', 'H2 ROUTER: comma-separated question categories eligible for tables (requires --router-ctx-threshold > 0)')
    .option('--context-compiler <name>', 'context700: delegate context assembly to src/eval/<name>-candidate.ts compileContext() (frozen setup surface; campaign compiler file is the only mutable surface)', '')
    .option('--closed-book', 'ABLATION: no memory excerpts — question + question date only (raw LLM control)')
    .option('--dataset <path>', 'path to official longmemeval_s.json (required for date-aware ablations)')
    .option('--no-cache', 'disable content-addressed eval cache (cold run; required for authoritative promotions)')
    .option('--cache-dir <path>', 'explicit path to eval cache SQLite (default: ~/.local/share/renor/eval-cache.db)')
    .option('--concurrency <n>', 'max concurrent question evaluations (default: active judge keys, capped at 3)')
    .option('--judge-keys-env <prefix>', 'env var prefix for numbered judge keys (e.g. JUDGE_API_KEY → reads JUDGE_API_KEY_1, _2, _3)', '')
    .option('--rerun-reason <text>', `run even though this exact configuration is already on the run ledger (${RUN_LEDGER_ENV}); the reason is recorded with the run`)
    .parse(process.argv);
  const opts = program.opts<{
    run: string; output: string; answerModel: string; judgeModel: string; baseUrl: string;
    apiKeyEnv: string; judgeBaseUrl?: string; judgeApiKeyEnv?: string;
    maxContextTokens: string; answerMaxTokens?: string; judgeMaxTokens?: string;
    temperature: string; retries: string;
    contextDates?: boolean; suppressHeaderOnly?: boolean; recencyOrder?: boolean; dataset?: string;
    stripExcerptMeta?: boolean;
    answerStyle?: 'direct' | 'cot' | 'sum' | 'preference' | 'bestguess' | 'chrono' | 'enumerate';
    idsFile?: string;
    completionRun?: string;
    completionMaxChunks?: string;
    completionTokenBudget?: string;
    temporalSidecar?: boolean;
    factsFile?: string;
    factsFallback?: boolean;
    chronicleFile?: string;
    prefsFile?: string;
    routerCtxThreshold?: string;
    routerTabledCats?: string;
    contextCompiler?: string;
    closedBook?: boolean;
    cache?: boolean;
    cacheDir?: string;
    concurrency?: string;
    judgeKeysEnv?: string;
    rerunReason?: string;
  }>();

  const runDir = path.resolve(opts.run);
  const outputDir = path.resolve(opts.output);
  const checkpointPath = path.join(outputDir, 'qa-cases.jsonl');
  // Fresh runs must claim an empty directory; resume runs must already hold a
  // checkpoint file. Anything else (existing dir without checkpoint) is refused
  // rather than silently clobbered. A fresh run claims its directory after the
  // run ledger admits it (below), so a refused run leaves nothing behind.
  const resuming = fs.existsSync(checkpointPath);
  if (fs.existsSync(outputDir) && !resuming) throw new Error(`Output exists without qa-cases.jsonl (refusing to clobber): ${outputDir}`);
  const apiKey = process.env[opts.apiKeyEnv];
  if (!apiKey) throw new Error(`API key env ${opts.apiKeyEnv} is not set`);
  const judgeBaseUrl = opts.judgeBaseUrl ?? opts.baseUrl;
  const judgeKeyEnv = opts.judgeApiKeyEnv ?? opts.apiKeyEnv;
  const judgeKeys = resolveJudgeKeys(process.env, judgeKeyEnv, opts.judgeKeysEnv);
  if (judgeKeys.length === 0) throw new Error(`Judge API key env ${judgeKeyEnv} is not set`);
  const judgeKeyPool = new KeyPool(judgeKeys, 1);
  const temperature = Number(opts.temperature);
  const maxContextTokens = Number(opts.maxContextTokens);
  const retries = Number(opts.retries);
  const answerMaxTokens = parseOptionalPositiveInt(opts.answerMaxTokens, '--answer-max-tokens');
  const judgeMaxTokens = parseOptionalPositiveInt(opts.judgeMaxTokens, '--judge-max-tokens');

  const caseRows = readJsonl(path.join(runDir, 'cases.jsonl')) as unknown as EvalCaseRow[];
  const resultRows = readJsonl(path.join(runDir, 'results.jsonl')) as unknown as ResultRow[];
  const resultMap = new Map(resultRows.map(row => [row.id, row]));
  const retrievalManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  // A page dump (made elsewhere, with no model and no key) must be the dump its manifest describes before anything is spent; its
  // provenance (which caches its pages came from) goes into this run's manifest, which outlives the dump directory.
  const pageDump = verifyPageDump(runDir, retrievalManifest);

  const ablation = {
    contextDates: Boolean(opts.contextDates || opts.recencyOrder),
    suppressHeaderOnly: Boolean(opts.suppressHeaderOnly),
    stripExcerptMeta: Boolean(opts.stripExcerptMeta),
    recencyOrder: Boolean(opts.recencyOrder),
    answerStyle: (opts.answerStyle ?? 'direct') as 'direct' | 'cot' | 'sum' | 'preference' | 'bestguess' | 'chrono' | 'enumerate',
    evidenceCompletion: Boolean(opts.completionRun),
    temporalSidecar: Boolean(opts.temporalSidecar),
    factsTable: Boolean(opts.factsFile),
    factsFallback: Boolean(opts.factsFallback),
    chronicleTable: Boolean(opts.chronicleFile),
    prefsTable: Boolean(opts.prefsFile),
    routerCtxThreshold: Number(opts.routerCtxThreshold ?? 0),
    routerTabledCats: (opts.routerTabledCats ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
  if (!['direct', 'cot', 'sum', 'preference', 'bestguess', 'chrono', 'enumerate'].includes(ablation.answerStyle)) {
    throw new Error(`--answer-style must be direct|cot|sum|preference|bestguess|chrono|enumerate (got ${ablation.answerStyle})`);
  }
  let idFilter: Set<string> | undefined;
  if (opts.idsFile) {
    const raw = fs.readFileSync(path.resolve(opts.idsFile), 'utf8');
    idFilter = new Set(raw.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim()).filter(Boolean));
    if (idFilter.size === 0) throw new Error(`--ids-file is empty: ${opts.idsFile}`);
  }
  // Evidence completion: deep candidate pool (same corpus, deeper K). Gold-blind
  // trigger on aggregation/enumeration intent in the question; one chunk per
  // unrepresented note; bounded by chunks and tokens. Never re-ranks the primary window.
  const completionDir = opts.completionRun ? path.resolve(opts.completionRun) : null;
  const candidateMap = completionDir
    ? new Map((readJsonl(path.join(completionDir, 'results.jsonl')) as unknown as ResultRow[]).map(row => [row.id, row]))
    : null;
  const completionMaxChunks = Number(opts.completionMaxChunks ?? '10');
  const factsMap = opts.factsFile
    ? new Map(
        Object.entries(
          JSON.parse(fs.readFileSync(path.resolve(opts.factsFile), 'utf8')) as Record<
            string,
            Array<{ value: number; unit?: string; verb?: string; object?: string; event?: string }>
          >,
        ),
      )
    : null;
  const completionTokenBudget = Number(opts.completionTokenBudget ?? '1500');
  const chronicleMap = opts.chronicleFile
    ? new Map(
        Object.entries(
          JSON.parse(fs.readFileSync(path.resolve(opts.chronicleFile), 'utf8')) as Record<
            string,
            Array<{ when?: string; event?: string; entities?: string }>
          >,
        ),
      )
    : null;
  const prefsMap = opts.prefsFile
    ? new Map(
        Object.entries(
          JSON.parse(fs.readFileSync(path.resolve(opts.prefsFile), 'utf8')) as Record<
            string,
            Array<{ statement?: string; kind?: string }>
          >,
        )
      )
    : null;
  const AGGREGATE_INTENT = /\b(how many|how much|in total|total|altogether|combined|all of the|all the)\b/i;

  // context700 campaign: optional delegation of the whole context-assembly block
  // to the campaign compiler (src/eval/<name>-candidate.ts). When set, the
  // compiler is the single source of context for every question in this run.
  // The compiler is gold-blind; this harness passes only product-available inputs.
  const compilerName = opts.contextCompiler ?? '';
  const compiler = compilerName
    ? await import(`../../src/eval/${compilerName.replace(/[^a-z0-9-]/g, '')}-candidate.ts`)
    : null;
  if (compiler && typeof compiler.compileContext !== 'function') {
    throw new Error(`context compiler ${compilerName} does not export compileContext()`);
  }
  let datasetRows: Map<string, { haystack_session_ids: string[]; haystack_dates: string[] }> | undefined;
  if (ablation.contextDates || ablation.recencyOrder) {
    if (!opts.dataset) throw new Error('--dataset is required for date-aware ablations');
    const rows = JSON.parse(fs.readFileSync(path.resolve(opts.dataset), 'utf8')) as Array<{ question_id: string; haystack_session_ids: string[]; haystack_dates: string[] }>;
    datasetRows = new Map(rows.map(row => [row.question_id, row]));
  }

  const scoped = idFilter ? caseRows.filter(row => idFilter.has(row.id)) : caseRows;
  if (idFilter) {
    const missing = [...idFilter].filter(id => !caseRows.some(row => row.id === id));
    if (missing.length) throw new Error(`--ids-file ids not in retrieval run: ${missing.join(',')}`);
  }
  // Before the output directory is claimed or any provider is called: a
  // configuration already on the run ledger is refused (src/eval/runLedger.ts).
  // The inputs are fingerprinted by content, so the same retrieval artifacts in
  // another directory are the same input.
  const admission = admitRun({
    ledgerPath: resolveRunLedgerPath(process.env),
    runner: 'longmemeval-qa',
    config: {
      runner: 'longmemeval-qa',
      benchmark: 'longmemeval-s-qa-end-to-end',
      retrievalRun: {
        casesSha256: fileSha256(path.join(runDir, 'cases.jsonl')),
        resultsSha256: fileSha256(path.join(runDir, 'results.jsonl')),
      },
      questions: questionSet(scoped.map(row => row.id)),
      answer: { model: opts.answerModel, baseUrl: opts.baseUrl },
      judge: { model: opts.judgeModel, baseUrl: judgeBaseUrl },
      ablation,
      closedBook: Boolean(opts.closedBook),
      completion: completionDir
        ? { resultsSha256: fileSha256(path.join(completionDir, 'results.jsonl')), maxChunks: completionMaxChunks, tokenBudget: completionTokenBudget }
        : null,
      tables: {
        facts: opts.factsFile ? fileSha256(opts.factsFile) : null,
        chronicle: opts.chronicleFile ? fileSha256(opts.chronicleFile) : null,
        prefs: opts.prefsFile ? fileSha256(opts.prefsFile) : null,
      },
      contextCompiler: compilerName || null,
      datasetSha256: datasetRows && opts.dataset ? fileSha256(opts.dataset) : null,
      maxContextTokens,
      answerMaxTokens: answerMaxTokens ?? null,
      judgeMaxTokens: judgeMaxTokens ?? null,
      temperature,
      cache: opts.cache !== false,
      codeSha256: codeIdentity(process.cwd(), QA_RUN_CODE_ROOTS),
    },
    outputDir,
    resuming,
    rerunReason: opts.rerunReason,
  });
  if (!resuming) claimDirectory(outputDir);
  const done = readCheckpoint(checkpointPath);
  const todo = scoped.filter(row => !done.has(row.id));
  process.stderr.write(`[QA] ${scoped.length} cases, ${done.size} already done, ${todo.length} to run\n`);

  const git = gitState(process.cwd());
  // On the ledger before the first provider call (the sentinels), so a run
  // that is killed is still on record. Nothing left to do spends nothing.
  const ledgerRecord = todo.length > 0
    ? recordRun(admission, { gitSha: git.sha, gitDirty: git.dirty, perQuestionResults: checkpointPath })
    : null;
  const evaluator = evaluatorSourceHash(process.cwd());
  const startedAt = new Date().toISOString();

  const cacheEnabled = opts.cache !== false;
  const evalCachePath = cacheEnabled
    ? (opts.cacheDir ? path.resolve(opts.cacheDir) : resolveEvalCachePath(process.env))
    : null;
  const evalCache = evalCachePath ? new EvalCache(evalCachePath) : null;
  const canonicalCacheEnabled = Boolean(EXPLICIT_CACHE_SCOPE?.trim());
  // Reads use the canonical identity when explicitly pinned. Live misses always
  // write to the unique routing-session identity first; canonical promotion is
  // deferred until the run has completed cleanly and post-flight health passes.
  const cacheReadScope = resolveCacheScope({
    explicit: EXPLICIT_CACHE_SCOPE,
    session: EFFECTIVE_QA_SESSION,
  });
  const cacheWriteScope = `x-opencode-session:${EFFECTIVE_QA_SESSION}`;
  const pendingCachePromotions = new Map<string, EvalCacheEntry>();
  // Live answer+judge calls this run made, with or without a cache (the cache report's authoritative count).
  let liveModelCalls = 0;

  interface SentinelResult {
    target: 'answerer' | 'judge';
    keyLabel: string;
    ok: boolean;
    latencyMs: number;
    error?: string;
  }
  const sentinelResults: SentinelResult[] = [];

  if (todo.length > 0) {
    process.stderr.write(`[Sentinel] Running pre-flight health checks...\n`);
    // 1. Answerer sentinel (bypasses cache)
    const ansStart = Date.now();
    try {
      const sentinel = await chatCall({
        baseUrl: opts.baseUrl,
        apiKey,
        requestBody: {
          model: opts.answerModel,
          messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }],
          temperature: 0,
        },
        timeoutMs: 30_000,
        retries: 2,
      });
      const sentinelContent = sentinel.body.choices?.[0]?.message?.content?.trim() ?? '';
      if (!/^ok[.!]?$/i.test(sentinelContent)) {
        throw new Error(`unexpected sentinel response: ${JSON.stringify(sentinelContent.slice(0, 120))}`);
      }
      sentinelResults.push({ target: 'answerer', keyLabel: 'answer-key', ok: true, latencyMs: Date.now() - ansStart });
      process.stderr.write(`[Sentinel] Answerer (${opts.answerModel}): OK (${Date.now() - ansStart}ms)\n`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sentinelResults.push({ target: 'answerer', keyLabel: 'answer-key', ok: false, latencyMs: Date.now() - ansStart, error: errMsg });
      throw new Error(`[Sentinel] Answerer pre-flight check failed on ${opts.baseUrl} (${opts.answerModel}): ${errMsg}`);
    }

    // 2. Judge keys sentinel (test EACH judge key independently, bypasses cache)
    for (let i = 0; i < judgeKeys.length; i++) {
      const key = judgeKeys[i];
      const label = `key-${i + 1}`;
      const jStart = Date.now();
      try {
        const sentinel = await chatCall({
          baseUrl: judgeBaseUrl,
          apiKey: key,
          requestBody: {
            model: opts.judgeModel,
            messages: [{ role: 'user', content: 'Reply with exactly 1 and nothing else.' }],
            temperature: 0,
          },
          timeoutMs: 30_000,
          retries: 1,
          onHttpError: (status, retryAfterMs) => {
            judgeKeyPool.reportError(label, status, retryAfterMs);
          },
        });
        const sentinelContent = sentinel.body.choices?.[0]?.message?.content ?? '';
        if (parseVerdict(sentinelContent) !== 1) {
          throw new Error(`unexpected sentinel response: ${JSON.stringify(sentinelContent.trim().slice(0, 120))}`);
        }
        sentinelResults.push({ target: 'judge', keyLabel: label, ok: true, latencyMs: Date.now() - jStart });
        process.stderr.write(`[Sentinel] Judge ${label} (${opts.judgeModel}): OK (${Date.now() - jStart}ms)\n`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sentinelResults.push({ target: 'judge', keyLabel: label, ok: false, latencyMs: Date.now() - jStart, error: errMsg });
        process.stderr.write(`[Sentinel] Judge ${label} failed: ${errMsg}\n`);
      }
    }

    if (judgeKeyPool.size === 0) {
      throw new Error(`[Sentinel] All judge keys failed pre-flight health checks on ${judgeBaseUrl}`);
    }
  }

  // Resolve the default after sentinels, because failed credentials may have
  // been disabled during pre-flight and should not inflate worker concurrency.
  const concurrency = resolveWorkerConcurrency(opts.concurrency, judgeKeyPool.size);
  const workerPool = new WorkerPool(concurrency);
  process.stderr.write(`[QA] Judge keys: ${judgeKeyPool.size}, Concurrency: ${concurrency}, Cache: ${evalCache ? evalCachePath : 'DISABLED (cold run)'}\n`);

  let completedCount = done.size;
  let writeQueue = Promise.resolve();
  const appendCheckpoint = (rec: QaCase): Promise<void> => {
    const p = writeQueue.then(() => {
      fs.appendFileSync(checkpointPath, JSON.stringify(rec) + '\n', 'utf8');
      if (ledgerRecord) archiveRow(ledgerRecord, JSON.stringify(rec));
    });
    writeQueue = p.catch(() => {});
    return p;
  };

  await Promise.all(
    todo.map((row) =>
      workerPool.run(async () => {
        const result = resultMap.get(row.id);
        if (!result) throw new Error(`No retrieval result for ${row.id}`);

        // Query is "Question date: <date>\n<question>"
        const queryMatch = row.query.match(/^Question date: (.*)\n([\s\S]*)$/);
        const questionDate = queryMatch?.[1] ?? '';
        const question = queryMatch?.[2] ?? row.query;

        // context700 campaign: when a context compiler is active it owns the ENTIRE
        // assembly (raw selection, ordering, tables, budgets). Ablation flags are
        // ignored under a compiler except --context-dates (dateMap input) and
        // --recency-order (forwarded as recencyOrder so v0 stays N22-equivalent).
        const dateMap = ablation.contextDates && datasetRows
          ? buildDateMap(datasetRows.get(row.id) ?? { haystack_session_ids: [], haystack_dates: [] })
          : undefined;
        let context: string;
        let tokens = 0;
        let hitsUsed = 0;
        let hitsSuppressed = 0;
        let factsTokens: number;
        let chronicleTokens: number;
        let prefsTokens: number;
        let completionActivated = false;
        let completionAdded = 0;
        let completionTokens = 0;
        let temporalTokens = 0;
        if (compiler) {
          const compiled = compiler.compileContext({
            question: { id: row.id, category: row.category, query: row.query, questionDate, question, shouldAbstain: row.shouldAbstain },
            hits: result.hits,
            tables: {
              facts: factsMap?.get(row.id) ?? [],
              chronicle: chronicleMap?.get(row.id) ?? [],
              prefs: prefsMap?.get(row.id) ?? [],
            },
            dateMap: dateMap ?? null,
            maxContextTokens,
            compilerVersion: compiler.COMPILER_VERSION ?? compilerName,
            recencyOrder: ablation.recencyOrder,
          });
          context = compiled.context;
          tokens = compiled.tokens;
          factsTokens = compiled.parts.factsTokens;
          chronicleTokens = compiled.parts.chronicleTokens;
          prefsTokens = compiled.parts.prefsTokens;
          hitsUsed = result.hits.length;
          hitsSuppressed = 0;
        } else {
          factsTokens = 0;
          chronicleTokens = 0;
          prefsTokens = 0;
          // Context: top-K hits in rank order, exact-duplicate texts collapsed, token-capped.
          // Ablations: suppress header-only excerpts; annotate session dates; newest-first.
          const seen = new Set<string>();
          type Excerpt = { text: string; date: string | null };
          const excerpts: Excerpt[] = [];
          tokens = 0;
          hitsUsed = 0;
          hitsSuppressed = 0;
          for (const hit of result.hits) {
            const text = (hit.text ?? '').trim();
            if (!text || seen.has(text)) continue;
            if (ablation.suppressHeaderOnly && isHeaderOnly(text)) { hitsSuppressed++; continue; }
            const sessionDate = dateMap?.get(canonicalSegment(hit.notePath)) ?? null;
            const dateLine = sessionDate ? `Session date: ${sessionDate}\n` : '';
            const candidate = ablation.stripExcerptMeta
              ? stripExcerptMetaLines(`[Excerpt ${excerpts.length + 1}]\n${dateLine}${text}`) // strip mode drops [Excerpt N]; date footer kept
              : `[Excerpt ${excerpts.length + 1}]\n${dateLine}${text}`;
            const candidateTokens = countTextTokens(candidate);
            if (tokens + candidateTokens > maxContextTokens) break;
            seen.add(text);
            excerpts.push({ text: candidate, date: sessionDate });
            tokens += candidateTokens;
            hitsUsed++;
          }
          // Evidence completion: one bounded second pass over the deep candidate pool.
          // Gold-blind trigger; adds only chunks from notes absent from the primary window.
          let completionActivated = false;
          let completionAdded = 0;
          let completionTokens = 0;
          const candidateHits = candidateMap?.get(row.id)?.hits ?? [];
          if (ablation.evidenceCompletion && candidateHits.length > 0 && AGGREGATE_INTENT.test(question)) {
            completionActivated = true;
            const coveredNotes = new Set(result.hits.map(h => canonicalSegment(h.notePath)));
            for (const hit of candidateHits) {
              if (completionAdded >= completionMaxChunks) break;
              if (completionTokens >= completionTokenBudget) break;
              const noteSeg = canonicalSegment(hit.notePath);
              if (coveredNotes.has(noteSeg)) continue;
              const text = (hit.text ?? '').trim();
              if (!text || seen.has(text)) continue;
              if (isHeaderOnly(text)) continue; // prefer contentful chunks: stubs add dates, not evidence
              const sessionDate = dateMap?.get(noteSeg) ?? null;
              const dateLine = sessionDate ? `Session date: ${sessionDate}\n` : '';
              const candidate = ablation.stripExcerptMeta
                ? stripExcerptMetaLines(`[Excerpt ${excerpts.length + 1}]\n${dateLine}${text}`) // strip mode drops [Excerpt N]; date footer kept
                : `[Excerpt ${excerpts.length + 1}]\n${dateLine}${text}`;
              const candidateTokens = countTextTokens(candidate);
              if (tokens + candidateTokens > maxContextTokens) break;
              if (completionTokens + candidateTokens > completionTokenBudget) continue;
              coveredNotes.add(noteSeg);
              seen.add(text);
              excerpts.push({ text: candidate, date: sessionDate });
              tokens += candidateTokens;
              completionTokens += candidateTokens;
              completionAdded++;
            }
          }
          if (ablation.recencyOrder && dateMap) {
            excerpts.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
            excerpts.forEach((excerpt, index) => {
              excerpt.text = excerpt.text.replace(/^\[Excerpt \d+\]$/, `[Excerpt ${index + 1}]`);
            });
          }
          // Temporal sidecar: deterministic timeline derived ONLY from excerpt session
          // dates already present (incl. header-only stubs) plus the question date.
          // No calendar graph; no invented dates. Day deltas computed in code so the
          // answer model does not have to do date arithmetic.
          let temporalTokens = 0;
          if (ablation.temporalSidecar && dateMap) {
            const parseLme = (s: string): number | null => {
              const m = /^(\d{4})\/(\d{2})\/(\d{2}) \((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\) (\d{2}):(\d{2})$/.exec((s ?? '').trim());
              if (!m) return null;
              const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
              return Number.isFinite(ms) ? ms : null;
            };
            const questionMs = parseLme(questionDate);
            const idxByDate = new Map<string, number[]>();
            excerpts.forEach((excerpt, index) => {
              if (!excerpt.date) return;
              const list = idxByDate.get(excerpt.date) ?? [];
              list.push(index + 1);
              idxByDate.set(excerpt.date, list);
            });
            const dated = [...idxByDate.entries()]
              .map(([date, idxs]) => ({ date, ms: parseLme(date), idxs: idxs.join(', ') }))
              .filter(entry => entry.ms !== null)
              .sort((a, b) => (a.ms as number) - (b.ms as number));
            if (dated.length > 0) {
              const day = 86_400_000;
              const lines = dated.map(entry => {
                const before = questionMs !== null ? Math.round(((questionMs - (entry.ms as number)) / day) * 10) / 10 : null;
                return `- ${entry.date} — Excerpt ${entry.idxs}` + (before !== null ? ` — ${before} days before the question` : '');
              });
              for (let i = 1; i < dated.length; i++) {
                const gap = Math.round((((dated[i].ms as number) - (dated[i - 1].ms as number)) / day) * 10) / 10;
                if (gap > 0) lines.push(`- gap: ${dated[i - 1].date} → ${dated[i].date} = ${gap} days`);
              }
              const block = `Derived timeline (from excerpt session dates only; do not invent dates):\n${lines.join('\n')}`;
              const blockTokens = countTextTokens(block);
              excerpts.push({ text: block, date: null });
              tokens += blockTokens;
              temporalTokens = blockTokens;
            }
          }
          // H2 router: tables only when (category eligible) AND (raw retrieval ctx < threshold).
          // Decision is deterministic and gold-blind; when router is off (threshold 0) everything is allowed.
          const routerActive = ablation.routerCtxThreshold > 0 && factsMap;
          const rawRetrievalTokens = tokens; // retrieval excerpt tokens before any table blocks
          const tablesAllowed = !routerActive
            ? true
            : (ablation.routerTabledCats.length === 0 || ablation.routerTabledCats.includes(row.category))
              && rawRetrievalTokens < ablation.routerCtxThreshold;
          if (ablation.factsTable && factsMap && tablesAllowed) {
            const rows = factsMap.get(row.id) ?? [];
            if (rows.length) {
              const lines = rows.map(f => {
                const co = (f as { coexist?: string }).coexist;
                const coNote = co ? ` (also reported: ${co})` : '';
                return `- ${f.value} ${f.unit ?? ''} | ${f.verb ?? ''} | ${f.object ?? ''}${f.event ? ` | ${f.event}` : ''}${coNote}`.replace(/\s+/g, ' ').trim();
              });
              const block = `User-asserted numeric facts extracted from memory (with sources):\n${lines.join('\n')}\nUse this table when relevant; cite only values present here.${ablation.factsFallback ? ' If the table does not contain the value needed to answer, use the excerpts instead.' : ''}`;
              const blockTokens = countTextTokens(block);
              excerpts.push({ text: block, date: null });
              tokens += blockTokens;
              factsTokens = blockTokens;
            }
          }
          if (ablation.chronicleTable && chronicleMap && tablesAllowed) {
            const rows = chronicleMap.get(row.id) ?? [];
            if (rows.length) {
              const lines = rows.map(e => `- ${e.when ?? ''} | ${e.event ?? ''}${e.entities ? ` | ${e.entities}` : ''}`.replace(/\s+/g, ' ').trim());
              const block = `User events chronicle extracted from memory:\n${lines.join('\n')}\nUse this chronicle when relevant; cite only events present here. If the chronicle does not contain what is needed to answer, use the excerpts instead.`;
              const blockTokens = countTextTokens(block);
              excerpts.push({ text: block, date: null });
              tokens += blockTokens;
              chronicleTokens = blockTokens;
            }
          }
          if (ablation.prefsTable && prefsMap && tablesAllowed) {
            const rows = prefsMap.get(row.id) ?? [];
            if (rows.length) {
              const lines = rows.map(p => `- (${p.kind ?? 'pref'}) ${p.statement ?? ''}`.replace(/\s+/g, ' ').trim());
              const block = `User standing preferences and constraints extracted from memory:\n${lines.join('\n')}\nWhen the question touches a preference or constraint, apply the matching entry to your answer as a standing rule. If nothing here is relevant, use the excerpts instead.`;
              const blockTokens = countTextTokens(block);
              excerpts.push({ text: block, date: null });
              tokens += blockTokens;
              prefsTokens = blockTokens;
            }
          }
          context = excerpts.map(excerpt => excerpt.text).join('\n\n');
        }

        const record: QaCase = {
          id: row.id, category: row.category, shouldAbstain: row.shouldAbstain, questionDate,
          hitsUsed, hitsSuppressed, contextTokens: tokens, answer: null, judge: null,
          completionActivated, completionAdded, completionTokens, temporalTokens, factsTokens, chronicleTokens,
        };
        try {
          const answerRequestBody = {
            model: opts.answerModel,
            messages: [
              { role: 'system', content: opts.closedBook ? CLOSED_BOOK_SYSTEM_PROMPT : ANSWER_SYSTEM_PROMPT },
              { role: 'user', content: opts.closedBook
                  ? `Question (asked on ${questionDate}): ${question}\n\n${CLOSED_BOOK_INSTRUCTION}`
                  : answerUserPrompt(questionDate, question, context, opts.answerStyle ?? 'direct') },
            ],
            temperature,
            ...(answerMaxTokens !== undefined ? { max_tokens: answerMaxTokens } : {}),
          };
          const answerNamespace = `${opts.baseUrl}#${opts.answerModel}`;
          const answerReadKey = evalCache ? EvalCache.computeKey(answerNamespace, answerRequestBody, cacheReadScope) : null;
          const answerWriteKey = evalCache ? EvalCache.computeKey(answerNamespace, answerRequestBody, cacheWriteScope) : null;

          let answerText = '';
          let answerModelEcho = '';
          let answerFinishReason = '';
          let answerAttempts = 1;
          let answerLatencyMs = 0;
          let answerPromptTokens = 0;
          let answerCompletionTokens = 0;
          let answerFromCache = false;

          const cachedAnswer = evalCache && answerReadKey ? evalCache.get(answerReadKey, 'answer') : null;
          if (cachedAnswer) {
            answerText = cachedAnswer.rawContent;
            answerModelEcho = cachedAnswer.modelEcho;
            answerFinishReason = cachedAnswer.finishReason;
            answerAttempts = 1;
            answerLatencyMs = cachedAnswer.latencyMs;
            answerPromptTokens = cachedAnswer.promptTokens;
            answerCompletionTokens = cachedAnswer.completionTokens;
            answerFromCache = true;
          } else {
            liveModelCalls++;
            const answerCall = await chatCall({
              baseUrl: opts.baseUrl,
              apiKey,
              requestBody: answerRequestBody,
              timeoutMs: 120_000,
              retries,
            });
            answerText = answerCall.body.choices?.[0]?.message?.content ?? '';
            answerModelEcho = answerCall.body.model ?? '';
            answerFinishReason = answerCall.body.choices?.[0]?.finish_reason ?? '';
            answerAttempts = answerCall.attempts;
            answerLatencyMs = answerCall.latencyMs;
            answerPromptTokens = answerCall.body.usage?.prompt_tokens ?? 0;
            answerCompletionTokens = answerCall.body.usage?.completion_tokens ?? 0;

            if (evalCache && answerWriteKey) {
              const liveEntry: EvalCacheEntry = {
                cacheKey: answerWriteKey,
                providerNamespace: answerNamespace,
                callType: 'answer',
                questionId: row.id,
                rawContent: answerText,
                modelEcho: answerModelEcho,
                finishReason: answerFinishReason,
                promptTokens: answerPromptTokens,
                completionTokens: answerCompletionTokens,
                latencyMs: answerLatencyMs,
                requestBody: answerRequestBody,
              };
              evalCache.put(liveEntry);
              if (
                canonicalCacheEnabled
                && answerReadKey
                && answerReadKey !== answerWriteKey
                && !pendingCachePromotions.has(answerReadKey)
              ) {
                pendingCachePromotions.set(answerReadKey, { ...liveEntry, cacheKey: answerReadKey });
              }
            }
          }

          record.answer = {
            text: answerText,
            modelEcho: answerModelEcho,
            finishReason: answerFinishReason,
            attempts: answerAttempts,
            latencyMs: answerLatencyMs,
            usage: {
              promptTokens: answerPromptTokens,
              completionTokens: answerCompletionTokens,
            },
            fromCache: answerFromCache,
            cacheKey: (answerFromCache ? answerReadKey : answerWriteKey) ?? undefined,
          };

          const judgeRequestBody = {
            model: opts.judgeModel,
            messages: [
              { role: 'system', content: JUDGE_SYSTEM_PROMPT },
              { role: 'user', content: judgeUserPrompt(question, row.expectedAnswer, answerText) },
            ],
            temperature,
            ...(judgeMaxTokens !== undefined ? { max_tokens: judgeMaxTokens } : {}),
          };
          const judgeNamespace = `${judgeBaseUrl}#${opts.judgeModel}`;
          const judgeReadKey = evalCache ? EvalCache.computeKey(judgeNamespace, judgeRequestBody, cacheReadScope) : null;
          const judgeWriteKey = evalCache ? EvalCache.computeKey(judgeNamespace, judgeRequestBody, cacheWriteScope) : null;
          // The judge memo (EvalCache.computeJudgeMemoKey): the same question, gold, answer, judge and prompt are never judged twice,
          // whatever the routing session. The reader's answer above is not memoized this way, so independent draws stay independent.
          const judgeMemoKey = evalCache ? EvalCache.computeJudgeMemoKey(judgeNamespace, row.id, judgeRequestBody) : null;

          let raw = '';
          let judgeModelEcho = '';
          let judgeAttempts = 1;
          let judgeLatencyMs = 0;
          let judgePromptTokens = 0;
          let judgeCompletionTokens = 0;
          let judgeFromCache = false;

          const memoJudge = evalCache && judgeMemoKey ? evalCache.getJudgeMemo(judgeMemoKey) : null;
          const cachedJudge = memoJudge ?? (evalCache && judgeReadKey ? evalCache.get(judgeReadKey, 'judge') : null);
          if (cachedJudge) {
            raw = cachedJudge.rawContent;
            judgeModelEcho = cachedJudge.modelEcho;
            judgeAttempts = 1;
            judgeLatencyMs = cachedJudge.latencyMs;
            judgePromptTokens = cachedJudge.promptTokens;
            judgeCompletionTokens = cachedJudge.completionTokens;
            judgeFromCache = true;
          } else {
            liveModelCalls++;
            const pooledJudge = await runWithKeyPoolRetries(
              judgeKeyPool,
              retries,
              async ({ key: slotKey, label: slotLabel }) => chatCall({
                baseUrl: judgeBaseUrl,
                apiKey: slotKey,
                requestBody: judgeRequestBody,
                timeoutMs: 60_000,
                retries: 1,
                onHttpError: (status, retryAfterMs) => {
                  judgeKeyPool.reportError(slotLabel, status, retryAfterMs);
                },
              }),
            );
            const judgeCall = pooledJudge.value;
            raw = judgeCall.body.choices?.[0]?.message?.content ?? '';
            judgeModelEcho = judgeCall.body.model ?? '';
            judgeAttempts = pooledJudge.attempts;
            judgeLatencyMs = judgeCall.latencyMs;
            judgePromptTokens = judgeCall.body.usage?.prompt_tokens ?? 0;
            judgeCompletionTokens = judgeCall.body.usage?.completion_tokens ?? 0;

            if (evalCache && judgeWriteKey) {
              const liveEntry: EvalCacheEntry = {
                cacheKey: judgeWriteKey,
                providerNamespace: judgeNamespace,
                callType: 'judge',
                questionId: row.id,
                rawContent: raw,
                modelEcho: judgeModelEcho,
                finishReason: judgeCall.body.choices?.[0]?.finish_reason ?? '',
                promptTokens: judgePromptTokens,
                completionTokens: judgeCompletionTokens,
                latencyMs: judgeLatencyMs,
                requestBody: judgeRequestBody,
              };
              evalCache.put(liveEntry);
              if (
                canonicalCacheEnabled
                && judgeReadKey
                && judgeReadKey !== judgeWriteKey
                && !pendingCachePromotions.has(judgeReadKey)
              ) {
                pendingCachePromotions.set(judgeReadKey, { ...liveEntry, cacheKey: judgeReadKey });
              }
            }
          }

          const verdict = parseVerdict(raw);
          // Only a verdict that parsed is memoized: the next run asks again about one that did not.
          if (evalCache && judgeMemoKey && !judgeFromCache && verdict !== null) {
            evalCache.putJudgeMemo({
              cacheKey: judgeMemoKey,
              providerNamespace: judgeNamespace,
              callType: 'judge',
              questionId: row.id,
              rawContent: raw,
              modelEcho: judgeModelEcho,
              finishReason: '',
              promptTokens: judgePromptTokens,
              completionTokens: judgeCompletionTokens,
              latencyMs: judgeLatencyMs,
              requestBody: judgeRequestBody,
            });
          }
          record.judge = {
            raw, verdict, parseOk: verdict !== null,
            modelEcho: judgeModelEcho,
            attempts: judgeAttempts, latencyMs: judgeLatencyMs,
            usage: {
              promptTokens: judgePromptTokens,
              completionTokens: judgeCompletionTokens,
            },
            fromCache: judgeFromCache,
            cacheKey: (judgeFromCache ? (memoJudge ? judgeMemoKey : judgeReadKey) : judgeWriteKey) ?? undefined,
          };
          if (verdict === null) record.error = 'judge-unparseable';
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
        }

        await appendCheckpoint(record);
        completedCount++;
        const status = record.error
          ? 'ERROR:' + record.error
          : record.judge?.verdict === 1
            ? 'correct'
            : record.judge?.verdict === 0
              ? 'wrong'
              : '?';
        const cacheTag = `${record.answer?.fromCache ? 'A:hit' : 'A:live'} ${record.judge?.fromCache ? 'J:hit' : 'J:live'}`;
        process.stderr.write(`[QA] ${completedCount}/${scoped.length} ${row.id} ${status} [${cacheTag}]\n`);
      })
    )
  );

  // Manifest + aggregate usage from the checkpoint file (crash-safe re-computation).
  const all = readJsonl(checkpointPath) as unknown as QaCase[];
  const finishedAt = new Date().toISOString();
  // Recompute provider usage from crash-safe checkpoint rows instead of relying
  // on in-memory cache stats. This keeps cold --no-cache runs and resumed runs
  // scientifically honest.
  const tokenUsage = summarizeQaTokenUsage(all);
  const answerErrors = all.filter(c => !c.answer).length;
  const judgeParseFailures = all.filter(c => c.judge && !c.judge.parseOk).length;

  let cachePromotionHealth: { checked: boolean; ok: boolean; errors: string[] } = {
    checked: false,
    ok: true,
    errors: [],
  };
  let promotedCacheEntries = 0;
  if (evalCache && canonicalCacheEnabled && pendingCachePromotions.size > 0) {
    const postflight = await verifyCanonicalPromotionHealth({
      answerBaseUrl: opts.baseUrl,
      answerApiKey: apiKey,
      answerModel: opts.answerModel,
      judgeBaseUrl,
      judgeKeys,
      judgeModel: opts.judgeModel,
    });
    cachePromotionHealth = { checked: true, ...postflight };
    const preflightHealthy = sentinelResults.length > 0 && sentinelResults.every(result => result.ok);
    const runClean = answerErrors === 0 && judgeParseFailures === 0;
    if (preflightHealthy && runClean && postflight.ok) {
      for (const entry of pendingCachePromotions.values()) {
        if (evalCache.promote(entry)) promotedCacheEntries++;
      }
      process.stderr.write(`[Cache] Promoted ${promotedCacheEntries} verified entries to canonical scope ${cacheReadScope}\n`);
    } else {
      process.stderr.write(
        `[Cache] Skipped canonical promotion (preflightHealthy=${preflightHealthy}, runClean=${runClean}, postflightHealthy=${postflight.ok})\n`,
      );
    }
  }

  const manifest = {
    // Product-truth contract: this runner is and stays RESEARCH execution.
    // Watermark + null public entry point make the manifest machine-refusable
    // for product labels (score-longmemeval-qa fail-closed rules).
    ...researchTruthFields({
      coverage: { casesTotal: scoped.length, casesCompleted: all.length, answerErrors, judgeParseFailures },
      composition: {
        arms: [ablation.answerStyle],
        live: (evalCache?.stats.answerMisses ?? 0) + (evalCache?.stats.judgeMisses ?? 0),
        cacheHits: (evalCache?.stats.answerHits ?? 0) + (evalCache?.stats.judgeHits ?? 0),
        mergedFrom: null,
      },
      cache: {
        enabled: Boolean(evalCache),
        arm: 'iteration' as const,
        scope: cacheReadScope,
        reads: (evalCache?.stats.answerHits ?? 0) + (evalCache?.stats.answerMisses ?? 0)
          + (evalCache?.stats.judgeHits ?? 0) + (evalCache?.stats.judgeMisses ?? 0),
        hits: (evalCache?.stats.answerHits ?? 0) + (evalCache?.stats.judgeHits ?? 0),
        writes: (evalCache?.stats.answerMisses ?? 0) + (evalCache?.stats.judgeMisses ?? 0),
        dbPath: evalCachePath,
      },
    }),
    schemaVersion: 1,
    benchmark: 'longmemeval-s-qa-end-to-end',
    answerModelRequested: opts.answerModel,
    judgeModelRequested: opts.judgeModel,
    answerModelEchoes: [...new Set(all.map(c => c.answer?.modelEcho).filter(Boolean))],
    judgeModelEchoes: [...new Set(all.map(c => c.judge?.modelEcho).filter(Boolean))],
    baseUrl: opts.baseUrl,
    judgeBaseUrl,
    temperature,
    maxContextTokens,
    answerMaxTokens,
    judgeMaxTokens,
    retries,
    qaSession: EFFECTIVE_QA_SESSION,
    qaSessionSource: EXPLICIT_QA_SESSION ? 'explicit' : 'auto',
    cacheScope: cacheReadScope,
    cacheWriteScope,
    cacheScopeSource: canonicalCacheEnabled ? 'canonical' : 'session',
    prompts: {
      answerSystem: ANSWER_SYSTEM_PROMPT,
      answerUserTemplate: `Conversation memory excerpts (retrieved from long-term memory, highest relevance first):\n\n{context}\n\nQuestion (asked on {questionDate}): {question}\n\n${ANSWER_STYLE_INSTRUCTION[ablation.answerStyle]}`,
      judgeSystem: JUDGE_SYSTEM_PROMPT,
      judgeUserTemplate: 'Question: {question}\n\nGround truth answer: {gold}\n\nAssistant\'s answer: {answer}\n\nDoes the assistant\'s answer agree with the ground truth in substance (correct fact, person, value, or the required "I don\'t know")? Respond with ONLY the single digit 1 if correct, or 0 if incorrect, incomplete, or evasive. Output nothing else.',
    },
    retrievalRun: {
      dir: runDir,
      gitSha: retrievalManifest.gitSha,
      evaluatorSha256: retrievalManifest.evaluatorSha256,
      datasetSha256: retrievalManifest.datasetSha256,
      topK: retrievalManifest.topK,
      metricProtocol: retrievalManifest.metricProtocol,
      pageDump,
    },
    gitSha: git.sha,
    gitDirty: git.dirty,
    evaluatorSha256: evaluator,
    ablation,
    evalCache: {
      enabled: Boolean(evalCache),
      schemaVersion: CACHE_SCHEMA_VERSION,
      dbPath: evalCachePath,
      sessionScoped: !canonicalCacheEnabled,
      canonicalPromotion: {
        pendingEntries: pendingCachePromotions.size,
        promotedEntries: promotedCacheEntries,
        postflightHealth: cachePromotionHealth,
      },
      concurrency,
      judgeKeysConfigured: judgeKeys.length,
      answerHits: evalCache?.stats.answerHits ?? 0,
      answerMisses: evalCache?.stats.answerMisses ?? 0,
      judgeHits: evalCache?.stats.judgeHits ?? 0,
      judgeMisses: evalCache?.stats.judgeMisses ?? 0,
      judgeMemoHits: evalCache?.stats.judgeMemoHits ?? 0,
      judgeMemoMisses: evalCache?.stats.judgeMemoMisses ?? 0,
      avoidedTokens: tokenUsage.avoided,
      liveTokens: tokenUsage.live,
      avgLookupMs: evalCache && evalCache.stats.cacheLookupCount > 0
        ? Math.round((evalCache.stats.cacheLookupTotalMs / evalCache.stats.cacheLookupCount) * 100) / 100
        : 0,
      sentinels: sentinelResults,
    },
    completion: ablation.evidenceCompletion ? {
      candidateRun: completionDir,
      maxChunks: completionMaxChunks,
      tokenBudget: completionTokenBudget,
      activated: all.filter(c => c.completionActivated).length,
      meanAddedChunks: all.filter(c => c.completionActivated).reduce((n, c) => n + (c.completionAdded ?? 0), 0) / Math.max(1, all.filter(c => c.completionActivated).length),
      meanAddedTokens: all.filter(c => c.completionActivated).reduce((n, c) => n + (c.completionTokens ?? 0), 0) / Math.max(1, all.filter(c => c.completionActivated).length),
    } : undefined,
    temporal: ablation.temporalSidecar ? {
      meanTokens: all.reduce((n, c) => n + (c.temporalTokens ?? 0), 0) / Math.max(1, all.filter(c => (c.temporalTokens ?? 0) > 0).length),
      withTimeline: all.filter(c => (c.temporalTokens ?? 0) > 0).length,
    } : undefined,

    datasetSha256: ablation.contextDates && opts.dataset ? sha256(fs.readFileSync(path.resolve(opts.dataset), 'utf8')) : undefined,
    startedAt, finishedAt,
    casesTotal: scoped.length,
    idsFile: opts.idsFile ? path.resolve(opts.idsFile) : undefined,
    casesCompleted: all.length,
    answerErrors,
    judgeParseFailures,
    usage: {
      answer: {
        promptTokens: all.reduce((n, c) => n + (c.answer?.usage?.promptTokens ?? 0), 0),
        completionTokens: all.reduce((n, c) => n + (c.answer?.usage?.completionTokens ?? 0), 0),
      },
      judge: {
        promptTokens: all.reduce((n, c) => n + (c.judge?.usage?.promptTokens ?? 0), 0),
        completionTokens: all.reduce((n, c) => n + (c.judge?.usage?.completionTokens ?? 0), 0),
      },
    },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  await fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'qa-cases.sha256'), sha256(fs.readFileSync(checkpointPath, 'utf8')) + '\n', 'utf8');
  // Pre-flight probes, plus the post-flight round (one answerer + one per judge key) that runs before a promotion.
  const healthProbes = sentinelResults.length + (cachePromotionHealth.checked ? 1 + judgeKeys.length : 0);
  emitCacheReport(buildCacheReport({ evalCache: evalCache?.stats, liveModelCalls, pinnedScope: canonicalCacheEnabled, healthProbes }), outputDir);
  evalCache?.close();
  const correct = all.filter(c => c.judge?.verdict === 1).length;
  if (ledgerRecord) {
    saveRunOutcome(ledgerRecord, {
      status: all.filter(c => !c.error).length === scoped.length ? 'complete' : 'incomplete',
      finishedAt,
      casesTotal: scoped.length,
      casesCompleted: all.length,
      correct,
      answerErrors,
      judgeParseFailures,
      liveModelCalls,
    });
  }
  console.log(JSON.stringify({ outputDir, completed: all.length, correct, errors: manifest.answerErrors, judgeParseFailures: manifest.judgeParseFailures }, null, 2));
}

main().catch(error => {
  console.error(error instanceof RunRefusedError ? error.message : error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});