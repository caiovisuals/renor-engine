import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { encode } from 'gpt-tokenizer';
import { openDb } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/schema';
import { VectorIndex } from '../../../src/embeddings/vectorIndex';
import { CachingEmbeddingProvider, CountingEmbeddingProvider } from '../../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../../src/embeddings/types';
import { indexVault } from '../../../src/indexer/pipeline';
import { retrieveContext } from '../../../src/retrieval/orchestrator';
import { claimDirectory } from '../../../src/eval/artifacts';
import { WorkerPool } from '../../../src/eval/evalCache';
import { gitState, packageLockSha256, researchTruthFields } from '../../../src/eval/runManifest';
import { admitRun, archiveRow, codeIdentity, productEnvironment, questionSet, recordRun, saveRunOutcome, type RunRecord } from '../../../src/eval/runLedger';
import { categoryOf, haystackKey, loadLmeV2, renderTrajectory, safeSegment, type LmeV2Domain, type LmeV2Question, type LmeV2Tier } from './data';
import {
  aggregateMetrics, buildJudgeMessages, evalName, extractBoxedAnswer, isLlmJudged, isUnknown, parseEvalSpec, parseJudgeLabel,
  scoreDeterministic, type LlmEvalFunction, type ScoredRecord,
} from './metrics';

/**
 * LongMemEval-V2 two-stage runner (RESEARCH execution: it calls the shipped indexer and retrieval in-process, not
 * through a public MCP/API/CLI entry point, so nothing it produces is a Renor product score).
 *
 *   retrieval  data root -> one isolated Renor workspace per distinct haystack (every trajectory one markdown note,
 *              indexed by the real indexVault()) -> retrieveContext() on the question text -> cases/results.jsonl
 *   qa         retrieval run -> upstream reader prompt over the retrieved excerpts -> upstream eval function
 *              (deterministic, or LLM judge for abstention/gotchas) -> qa-cases.jsonl + upstream-shaped metrics
 *
 * Gold isolation: the answer and eval function are written to cases.jsonl for scoring; the retrieval query is
 * the question text only and the reader prompt never contains the answer, the eval function or the category.
 */

export const LME_V2_SCOPE = 'lme-v2-v1';
export const LME_V2_UPSTREAM = { repo: 'https://github.com/xiaowu0162/LongMemEval-V2', commit: '2cc8c540bdb87fe6761629b585e727e1c4704520', dataset: 'huggingface:xiaowu0162/longmemeval-v2', paper: 'arXiv:2605.12493' } as const;
export const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..');
export const RETRIEVAL_RUN_CODE_ROOTS = ['src', 'scripts/eval/longmemeval-v2', 'scripts/eval/run-longmemeval-v2.ts', 'package-lock.json'] as const;
export const QA_RUN_CODE_ROOTS = ['src/eval', 'scripts/eval/longmemeval-v2', 'scripts/eval/run-longmemeval-v2.ts', 'package-lock.json'] as const;
const CHUNKING = { maxTokens: 400, overlapTokens: 50 };
/** Trajectories carry no wall-clock time; each note's mtime is its insertion position, one minute apart, from this epoch. */
const POSITION_EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const round2 = (value: number) => Math.round(value * 100) / 100;
const mean = (values: number[]) => (values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null);

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T);
}

/** Tolerates a torn trailing line from a crash mid-append. */
function readCheckpoint<T extends { id: string }>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(line) as T); } catch { /* partial trailing line */ }
  }
  return rows;
}

export function readIdsFile(file: string): Set<string> {
  const ids = new Set(fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim()).filter(Boolean));
  if (ids.size === 0) throw new Error(`--ids-file is empty: ${file}`);
  return ids;
}

type Log = (line: string) => void;
const stderrLog: Log = line => process.stderr.write(`${line}\n`);

// ---------------------------------------------------------------- retrieval stage

export interface V2CaseRow {
  id: string;
  domain: LmeV2Domain;
  questionType: string;
  category: string;
  evalFunction: string;
  isAbstentionProblem: boolean;
  question: string;
  hasImage: boolean;
  /** Gold: read only by the QA scorer and the LLM judge prompt. */
  expectedAnswer: string;
  haystackKey: string;
  haystackSize: number;
}

export interface V2Hit { text: string; notePath: string; trajectoryId: string | null; score: number }
export interface V2ResultRow { id: string; hits: V2Hit[]; latencyMs: number; contextTokens: number }

export interface RetrievalStageOptions {
  dataRoot: string;
  tier: LmeV2Tier;
  domain: LmeV2Domain;
  outputDir: string;
  provider: EmbeddingProvider;
  providerMeta: Record<string, unknown>;
  /** null: count embedding calls without a cache. */
  embeddingCachePath: string | null;
  topK: number;
  limit: number;
  offset: number;
  ids?: Set<string>;
  maxStateChars: number;
  indexConcurrency: number;
  keepWorkdirs?: boolean;
  /** null: no run-ledger record (the dry run). */
  ledgerPath: string | null;
  rerunReason?: string;
  engineRoot?: string;
  log?: Log;
}

export function selectQuestions(all: LmeV2Question[], domain: LmeV2Domain, opts: { ids?: Set<string>; offset: number; limit: number }): LmeV2Question[] {
  let rows = all.filter(row => row.domain === domain);
  if (opts.ids) {
    const missing = [...opts.ids].filter(id => !rows.some(row => row.id === id));
    if (missing.length) throw new Error(`Unknown question ids for domain ${domain}: ${missing.join(', ')}`);
    rows = rows.filter(row => opts.ids!.has(row.id));
  }
  rows = rows.slice(opts.offset, opts.limit === 0 ? undefined : opts.offset + opts.limit);
  if (rows.length === 0) throw new Error('No LongMemEval-V2 questions selected');
  return rows;
}

export async function runRetrievalStage(opts: RetrievalStageOptions) {
  const log = opts.log ?? stderrLog;
  const engineRoot = opts.engineRoot ?? ENGINE_ROOT;
  const outputDir = path.resolve(opts.outputDir);
  const data = loadLmeV2(opts.dataRoot, opts.tier);
  const selected = selectQuestions(data.questions, opts.domain, opts);
  const groups = new Map<string, { trajectoryIds: string[]; questions: LmeV2Question[] }>();
  for (const question of selected) {
    const ids = data.haystacks[question.id];
    const key = haystackKey(ids);
    const group = groups.get(key) ?? { trajectoryIds: ids, questions: [] };
    group.questions.push(question);
    groups.set(key, group);
  }
  const git = gitState(engineRoot);

  const config = {
    runner: 'longmemeval-v2-retrieval',
    benchmark: 'longmemeval-v2-retrieval',
    scope: LME_V2_SCOPE,
    upstream: LME_V2_UPSTREAM,
    datasetSha256: data.sha256,
    tier: opts.tier,
    domain: opts.domain,
    questions: questionSet(selected.map(row => row.id)),
    provider: opts.providerMeta,
    topK: opts.topK,
    chunking: CHUNKING,
    maxStateChars: opts.maxStateChars,
    indexConcurrency: opts.indexConcurrency,
    productEnv: productEnvironment(process.env),
    codeSha256: codeIdentity(engineRoot, RETRIEVAL_RUN_CODE_ROOTS),
  };
  // Refused before the output directory is claimed or any provider is called (src/eval/runLedger.ts).
  const admission = opts.ledgerPath
    ? admitRun({ ledgerPath: opts.ledgerPath, runner: config.runner, config, outputDir, resuming: false, rerunReason: opts.rerunReason })
    : null;
  claimDirectory(outputDir);
  const ledgerRecord: RunRecord | null = admission
    ? recordRun(admission, { gitSha: git.sha, gitDirty: git.dirty, perQuestionResults: path.join(outputDir, 'results.jsonl') })
    : null;

  const embeddingProvider = opts.embeddingCachePath
    ? new CachingEmbeddingProvider(opts.provider, { cachePath: opts.embeddingCachePath })
    : new CountingEmbeddingProvider(opts.provider);
  const startedAt = new Date().toISOString();
  const cases: V2CaseRow[] = [];
  const results: V2ResultRow[] = [];
  const perCase: Array<Record<string, unknown>> = [];
  const haystackStats: Array<Record<string, unknown>> = [];

  let groupIndex = 0;
  for (const [key, group] of groups) {
    groupIndex++;
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-lme-v2-'));
    const vaultDir = path.join(workDir, 'vault');
    let db: ReturnType<typeof openDb> | undefined;
    try {
      const trajectoryByNote = new Map<string, string>();
      await fsp.mkdir(path.join(vaultDir, 'Trajectories'), { recursive: true });
      for (let position = 0; position < group.trajectoryIds.length; position++) {
        const id = group.trajectoryIds[position];
        const relative = `Trajectories/${String(position + 1).padStart(4, '0')}-${safeSegment(id)}.md`;
        const full = path.join(vaultDir, relative);
        await fsp.writeFile(full, renderTrajectory(data.readTrajectory(id), position + 1, opts.maxStateChars), 'utf8');
        const mtime = new Date(POSITION_EPOCH_MS + position * 60_000);
        await fsp.utimes(full, mtime, mtime);
        trajectoryByNote.set(relative, id);
      }
      db = openDb(path.join(workDir, 'index.db'));
      runMigrations(db);
      const vectorIndex = new VectorIndex(db, opts.provider.dimensions);
      vectorIndex.initTable();
      const indexStarted = performance.now();
      const indexStats = await indexVault(db, vaultDir, { embeddingProvider, vectorIndex, chunkOptions: CHUNKING }, opts.indexConcurrency);
      const indexDurationMs = performance.now() - indexStarted;
      if (indexStats.errors > 0) throw new Error(`haystack ${key.slice(0, 12)}: indexing had ${indexStats.errors} error(s)`);
      const chunks = (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c;
      haystackStats.push({ haystackKey: key, trajectories: group.trajectoryIds.length, questions: group.questions.length, notesIndexed: indexStats.indexed, chunks, indexDurationMs: round2(indexDurationMs) });
      // Retrieval "now" is just after the last insertion, so recency ranking sees insertion order.
      const nowMs = POSITION_EPOCH_MS + group.trajectoryIds.length * 60_000;

      for (const question of group.questions) {
        const started = performance.now();
        const retrieved = await retrieveContext(db, vectorIndex, embeddingProvider, question.question, opts.topK, [], { nowMs });
        const latencyMs = round2(performance.now() - started);
        const hits: V2Hit[] = retrieved.hits.map(hit => {
          const notePath = hit.notePath.startsWith('_renor/') ? hit.notePath : path.relative(vaultDir, hit.notePath).replaceAll(path.sep, '/');
          return { text: hit.text ?? '', notePath, trajectoryId: trajectoryByNote.get(notePath) ?? null, score: hit.score };
        });
        const contextTokens = encode(hits.map(hit => hit.text).join('\n\n')).length;
        const result: V2ResultRow = { id: question.id, hits, latencyMs, contextTokens };
        results.push(result);
        if (ledgerRecord) archiveRow(ledgerRecord, JSON.stringify(result));
        const category = categoryOf(question.question_type);
        cases.push({
          id: question.id,
          domain: question.domain,
          questionType: question.question_type,
          category,
          evalFunction: question.eval_function,
          isAbstentionProblem: evalName(question.eval_function) === 'llm_abstention_checker',
          question: question.question,
          hasImage: question.image != null,
          expectedAnswer: question.answer,
          haystackKey: key,
          haystackSize: group.trajectoryIds.length,
        });
        perCase.push({ id: question.id, category, haystackKey: key, hits: hits.length, retrievalDurationMs: latencyMs, contextTokens });
      }
      log(`[LME-V2] haystack ${groupIndex}/${groups.size}: ${group.trajectoryIds.length} trajectories, ${chunks} chunks, ${group.questions.length} question(s)`);
    } finally {
      db?.close();
      if (!opts.keepWorkdirs) await fsp.rm(workDir, { recursive: true, force: true });
      else log(`[LME-V2] kept ${workDir}`);
    }
  }

  const byCategory: Record<string, unknown> = {};
  for (const category of [...new Set(cases.map(row => row.category))].sort()) {
    const rows = perCase.filter(row => row.category === category);
    byCategory[category] = {
      count: rows.length,
      meanContextTokens: mean(rows.map(row => Number(row.contextTokens))),
      meanRetrievalMs: mean(rows.map(row => Number(row.retrievalDurationMs))),
    };
  }
  // No gold evidence locations ship with V2, so there is no retrieval accuracy: this stage reports what it gathered.
  const summary = {
    benchmark: 'longmemeval-v2-retrieval',
    overall: {
      cases: cases.length,
      haystacks: groups.size,
      meanContextTokens: mean(perCase.map(row => Number(row.contextTokens))),
      meanRetrievalMs: mean(perCase.map(row => Number(row.retrievalDurationMs))),
      imageQuestions: cases.filter(row => row.hasImage).length,
    },
    byCategory,
  };
  const finishedAt = new Date().toISOString();
  const describe = (embeddingProvider as { describe?: () => Record<string, unknown> }).describe?.() ?? {};
  const manifest = {
    ...researchTruthFields({ coverage: { casesTotal: selected.length, casesCompleted: cases.length, answerErrors: 0, judgeParseFailures: 0 } }),
    schemaVersion: 1,
    benchmark: 'longmemeval-v2-retrieval',
    scope: LME_V2_SCOPE,
    metricProtocol: 'lme-v2-context-gathering-text-only-v1',
    upstream: LME_V2_UPSTREAM,
    dataRoot: path.basename(data.root),
    datasetSha256: data.sha256,
    tier: opts.tier,
    domain: opts.domain,
    fullDomainQuestions: data.questions.filter(row => row.domain === opts.domain).length,
    selectedCases: selected.length,
    selectionIds: selected.map(row => row.id),
    completeDataset: selected.length === data.questions.filter(row => row.domain === opts.domain).length,
    provider: { ...opts.providerMeta, ...describe },
    topK: opts.topK,
    chunking: CHUNKING,
    maxStateChars: opts.maxStateChars,
    indexConcurrency: opts.indexConcurrency,
    query: 'question text only',
    recencyClock: 'haystack insertion position (1 min apart from 2026-01-01T00:00Z)',
    haystacks: haystackStats,
    resultsSha256: sha256(jsonl(results)),
    casesSha256: sha256(jsonl(cases)),
    gitSha: git.sha,
    gitDirty: git.dirty,
    packageLockSha256: packageLockSha256(engineRoot),
    runLedgerRecordId: ledgerRecord?.id ?? null,
    startedAt,
    finishedAt,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  await Promise.all([
    fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'cases.jsonl'), jsonl(cases), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'results.jsonl'), jsonl(results), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'per-case.jsonl'), jsonl(perCase), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8'),
  ]);
  if (ledgerRecord) {
    saveRunOutcome(ledgerRecord, { status: 'complete', finishedAt, casesTotal: selected.length, casesCompleted: cases.length, metrics: summary.overall });
  }
  return { outputDir, manifest, summary };
}

// ---------------------------------------------------------------- reader / judge transport

export interface ChatRequestBody {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number;
  max_tokens?: number;
}
export interface ChatReply {
  content: string;
  modelEcho: string;
  finishReason: string;
  attempts: number;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number };
}
export type ChatFn = (target: 'reader' | 'judge', body: ChatRequestBody) => Promise<ChatReply>;

const QA_SESSION = process.env.RENOR_QA_SESSION ?? `renor-eval-${process.pid}-${Date.now().toString(36)}`;

/** OpenAI-compatible chat transport with the QA runner's semantics: the timeout stays armed while the body is read, 429/5xx retry with backoff, empty content is a failure. */
export function httpChat(endpoints: Record<'reader' | 'judge', { baseUrl: string; apiKey: string }>, opts: { retries: number; timeoutMs?: number }): ChatFn {
  return async (target, body) => {
    const { baseUrl, apiKey } = endpoints[target];
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= opts.retries; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'user-agent': process.env.RENOR_QA_USER_AGENT ?? 'renor-eval/1.0',
            'x-opencode-session': QA_SESSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
        const json = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) throw new Error('empty/missing assistant content');
        return {
          content,
          modelEcho: json.model ?? '',
          finishReason: json.choices?.[0]?.finish_reason ?? '',
          attempts: attempt,
          latencyMs: Date.now() - started,
          usage: { promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0 },
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < opts.retries) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`API failed after ${opts.retries} attempts: ${lastError}`);
  };
}

/** The dry-run model: no network, no key. The reader always abstains; the judge always grades 0. Exercises wiring only. */
export const stubChat: ChatFn = async (target, body) => ({
  content: target === 'reader' ? '\\boxed{UNKNOWN}' : '{"label": 0, "reason": "stub judge"}',
  modelEcho: body.model,
  finishReason: 'stop',
  attempts: 1,
  latencyMs: 0,
  usage: { promptTokens: 0, completionTokens: 0 },
});

// ---------------------------------------------------------------- qa stage

/**
 * Upstream DOMAIN_SYSTEM_PROMPTS, byte for byte. The second "\boxed{}" is a Python "\b" (backspace) in the
 * upstream source; the JS literal below has the same escape, so the reader sees exactly what upstream's sees.
 */
export const DOMAIN_SYSTEM_PROMPTS: Record<LmeV2Domain, string> = {
  web: 'You are an experienced colleague in a web browsing environment that has '
    + 'a customized magento-based shopping website, a customized magento-based '
    + 'shopping admin cms website, as well as a customized forum website based '
    + 'on reddit/postmill. Answer based on your memory of the environment. '
    + 'If you do not know the answer, output exactly \\boxed{UNKNOWN}. '
    + 'Do not guess. Never attempt to guess an answer if you are not sure. '
    + 'If you believe the question\'s construction/premise is wrong, provide an '
    + 'explanation in \boxed{} explaining why the question is flawed.',
  enterprise: 'You are an experienced colleague working in a customized ServiceNow '
    + 'environment. Answer based on your memory of the environment. '
    + 'If you do not know the answer, output exactly \\boxed{UNKNOWN}. '
    + 'Do not guess. Never attempt to guess an answer if you are not sure. '
    + 'If you believe the question\'s construction/premise is wrong, provide an '
    + 'explanation in \boxed{} explaining why the question is flawed.',
};

/** Upstream build_messages layout, text only: the memory context, then the question. */
export function readerUserPrompt(context: string, question: string): string {
  return `### Memory context:\n${context || '(empty)'}\n\n### Question to answer:\n${question}`;
}

/** Retrieved hits in rank order, exact duplicates collapsed, capped at maxContextTokens. */
export function assembleContext(hits: V2Hit[], maxContextTokens: number): { context: string; tokens: number; hitsUsed: number; truncated: boolean } {
  const seen = new Set<string>();
  const parts: string[] = [];
  let tokens = 0;
  let truncated = false;
  for (const hit of hits) {
    const text = hit.text.trim();
    if (!text || seen.has(text)) continue;
    const block = `[Excerpt ${parts.length + 1}]\n${text}`;
    const blockTokens = encode(block).length;
    if (tokens + blockTokens > maxContextTokens) { truncated = true; break; }
    seen.add(text);
    parts.push(block);
    tokens += blockTokens;
  }
  return { context: parts.join('\n\n'), tokens, hitsUsed: parts.length, truncated };
}

export interface V2QaCase {
  id: string;
  domain: LmeV2Domain;
  category: string;
  questionType: string;
  evalFunction: string;
  isAbstentionProblem: boolean;
  hitsUsed: number;
  contextTokens: number;
  contextTruncated: boolean;
  reader: (Omit<ChatReply, 'content'> & { raw: string; parsedBoxed: string }) | null;
  judge: (Omit<ChatReply, 'content'> & { raw: string; label: 0 | 1 | null }) | null;
  /** Why no judge call was made for an LLM-judged question: the reply was UNKNOWN (scores 0) or empty. */
  judgeSkipped?: 'unknown' | 'empty';
  isUnknown: boolean | null;
  scoreBool: boolean | null;
  error?: string;
}

export interface QaStageOptions {
  runDir: string;
  outputDir: string;
  chat: ChatFn;
  /** Recorded as the models' identity; the dry run passes 'stub'. */
  reader: { model: string; baseUrl: string };
  judge: { model: string; baseUrl: string };
  maxContextTokens: number;
  answerMaxTokens?: number;
  judgeMaxTokens?: number;
  temperature: number;
  concurrency: number;
  ids?: Set<string>;
  /** Live runs probe both models once before the first question. */
  preflight: boolean;
  stub: boolean;
  ledgerPath: string | null;
  rerunReason?: string;
  engineRoot?: string;
  log?: Log;
}

export function scoredRecords(rows: V2QaCase[]): ScoredRecord[] {
  return rows.filter(row => !row.error && row.scoreBool !== null).map(row => ({
    category: row.category,
    isAbstentionProblem: row.isAbstentionProblem,
    isUnknown: Boolean(row.isUnknown),
    scoreBool: Boolean(row.scoreBool),
  }));
}

/** Per-category accuracy (pct_correct, 0-100) beside upstream's aggregated shape, for the run registry. */
export function summarizeQa(rows: V2QaCase[]) {
  const scored = scoredRecords(rows);
  const aggregated = scored.length ? aggregateMetrics(scored) : null;
  const pct = (value: number | null | undefined) => (value == null ? null : Math.round(value * 10000) / 100);
  const byCategory: Record<string, { count: number; accuracyPct: number | null; unknownPct: number | null }> = {};
  if (aggregated) {
    for (const [cat, b] of [...Object.entries(aggregated.non_abstention_by_category), ...Object.entries(aggregated.abstention_by_category)]) {
      byCategory[cat] = { count: b.count, accuracyPct: pct(b.pct_correct), unknownPct: pct(b.pct_unknown) };
    }
  }
  const readerErrors = rows.filter(row => !row.reader).length;
  const judgeErrors = rows.filter(row => row.reader && row.error).length;
  return {
    overall: {
      total: rows.length,
      scored: scored.length,
      correct: scored.filter(r => r.scoreBool).length,
      accuracyFullSetPct: pct(aggregated?.overall.overall_full_set),
      accuracyNonAbstentionPct: pct(aggregated?.overall.overall_non_abstention_only),
      accuracyAbstentionPct: pct(aggregated?.overall.overall_abstention_only),
      readerErrors,
      judgeErrors,
    },
    byCategory,
    aggregated,
  };
}

export async function runQaStage(opts: QaStageOptions) {
  const log = opts.log ?? stderrLog;
  const engineRoot = opts.engineRoot ?? ENGINE_ROOT;
  const runDir = path.resolve(opts.runDir);
  const outputDir = path.resolve(opts.outputDir);
  const checkpointPath = path.join(outputDir, 'qa-cases.jsonl');
  const resuming = fs.existsSync(checkpointPath);
  if (fs.existsSync(outputDir) && !resuming) throw new Error(`Output exists without qa-cases.jsonl (refusing to clobber): ${outputDir}`);

  const retrievalManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  if (retrievalManifest.benchmark !== 'longmemeval-v2-retrieval') throw new Error(`${runDir} is not a LongMemEval-V2 retrieval run`);
  const caseRows = readJsonl<V2CaseRow>(path.join(runDir, 'cases.jsonl'));
  const resultMap = new Map(readJsonl<V2ResultRow>(path.join(runDir, 'results.jsonl')).map(row => [row.id, row]));
  if (opts.ids) {
    const missing = [...opts.ids].filter(id => !caseRows.some(row => row.id === id));
    if (missing.length) throw new Error(`--ids-file ids not in retrieval run: ${missing.join(',')}`);
  }
  const scoped = opts.ids ? caseRows.filter(row => opts.ids!.has(row.id)) : caseRows;
  for (const row of scoped) parseEvalSpec(row.evalFunction);

  const config = {
    runner: 'longmemeval-v2-qa',
    benchmark: 'longmemeval-v2-qa',
    scope: LME_V2_SCOPE,
    retrievalRun: { casesSha256: sha256(fs.readFileSync(path.join(runDir, 'cases.jsonl'))), resultsSha256: sha256(fs.readFileSync(path.join(runDir, 'results.jsonl'))) },
    questions: questionSet(scoped.map(row => row.id)),
    reader: opts.reader,
    judge: opts.judge,
    stub: opts.stub,
    maxContextTokens: opts.maxContextTokens,
    answerMaxTokens: opts.answerMaxTokens ?? null,
    judgeMaxTokens: opts.judgeMaxTokens ?? null,
    temperature: opts.temperature,
    codeSha256: codeIdentity(engineRoot, QA_RUN_CODE_ROOTS),
  };
  const admission = opts.ledgerPath
    ? admitRun({ ledgerPath: opts.ledgerPath, runner: config.runner, config, outputDir, resuming, rerunReason: opts.rerunReason })
    : null;
  if (!resuming) claimDirectory(outputDir);
  const done = new Set(readCheckpoint<V2QaCase>(checkpointPath).map(row => row.id));
  const todo = scoped.filter(row => !done.has(row.id));
  log(`[LME-V2 QA] ${scoped.length} cases, ${done.size} already done, ${todo.length} to run`);
  const git = gitState(engineRoot);
  const ledgerRecord = admission && todo.length > 0
    ? recordRun(admission, { gitSha: git.sha, gitDirty: git.dirty, perQuestionResults: checkpointPath })
    : null;
  const startedAt = new Date().toISOString();
  let liveModelCalls = 0;

  const maxTokens = (n?: number) => (n !== undefined ? { max_tokens: n } : {});
  if (opts.preflight && todo.length > 0) {
    const readerProbe = await opts.chat('reader', { model: opts.reader.model, messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }], temperature: 0 });
    liveModelCalls++;
    if (!/^ok[.!]?$/i.test(readerProbe.content.trim())) throw new Error(`[Sentinel] reader ${opts.reader.model}: unexpected reply ${JSON.stringify(readerProbe.content.slice(0, 120))}`);
    if (todo.some(row => isLlmJudged(row.evalFunction))) {
      const judgeProbe = await opts.chat('judge', { model: opts.judge.model, messages: [{ role: 'user', content: 'Reply with exactly {"label": 1, "reason": "ok"} and nothing else.' }], temperature: 0 });
      liveModelCalls++;
      if (parseJudgeLabel(judgeProbe.content) !== 1) throw new Error(`[Sentinel] judge ${opts.judge.model}: unexpected reply ${JSON.stringify(judgeProbe.content.slice(0, 120))}`);
    }
  }

  let writeQueue = Promise.resolve();
  const append = (row: V2QaCase) => {
    const next = writeQueue.then(() => {
      fs.appendFileSync(checkpointPath, JSON.stringify(row) + '\n', 'utf8');
      if (ledgerRecord) archiveRow(ledgerRecord, JSON.stringify(row));
    });
    writeQueue = next.catch(() => {});
    return next;
  };
  const pool = new WorkerPool(opts.concurrency);
  let completed = done.size;

  await Promise.all(todo.map(row => pool.run(async () => {
    const result = resultMap.get(row.id);
    if (!result) throw new Error(`No retrieval result for ${row.id}`);
    const assembled = assembleContext(result.hits, opts.maxContextTokens);
    const record: V2QaCase = {
      id: row.id, domain: row.domain, category: row.category, questionType: row.questionType, evalFunction: row.evalFunction,
      isAbstentionProblem: row.isAbstentionProblem, hitsUsed: assembled.hitsUsed, contextTokens: assembled.tokens,
      contextTruncated: assembled.truncated, reader: null, judge: null, isUnknown: null, scoreBool: null,
    };
    try {
      const reply = await opts.chat('reader', {
        model: opts.reader.model,
        messages: [
          { role: 'system', content: DOMAIN_SYSTEM_PROMPTS[row.domain] },
          { role: 'user', content: readerUserPrompt(assembled.context, row.question) },
        ],
        temperature: opts.temperature,
        ...maxTokens(opts.answerMaxTokens),
      });
      liveModelCalls++;
      const raw = reply.content.trim();
      const parsedBoxed = extractBoxedAnswer(raw);
      const { content: _content, ...readerMeta } = reply;
      record.reader = { ...readerMeta, raw, parsedBoxed };
      record.isUnknown = isUnknown(parsedBoxed);
      const name = evalName(row.evalFunction);
      if (!isLlmJudged(row.evalFunction)) {
        record.scoreBool = !record.isUnknown && scoreDeterministic(row.evalFunction, parsedBoxed, row.expectedAnswer);
      } else if (record.isUnknown) {
        record.judgeSkipped = 'unknown';
        record.scoreBool = false;
      } else if (!raw || !row.expectedAnswer.trim() || !parsedBoxed) {
        record.judgeSkipped = 'empty';
        record.scoreBool = false;
      } else {
        const verdict = await opts.chat('judge', {
          model: opts.judge.model,
          messages: buildJudgeMessages(name as LlmEvalFunction, { question: row.question, reference: row.expectedAnswer, fullResponse: raw, finalAnswer: parsedBoxed }),
          temperature: opts.temperature,
          ...maxTokens(opts.judgeMaxTokens),
        });
        liveModelCalls++;
        const label = parseJudgeLabel(verdict.content);
        const { content: judgeRaw, ...judgeMeta } = verdict;
        record.judge = { ...judgeMeta, raw: judgeRaw, label };
        if (label === null) record.error = 'judge-unparseable';
        else record.scoreBool = label === 1;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    await append(record);
    completed++;
    log(`[LME-V2 QA] ${completed}/${scoped.length} ${row.id} ${record.error ? `ERROR:${record.error}` : record.scoreBool ? 'correct' : 'wrong'}`);
  })));
  await writeQueue;

  const all = readCheckpoint<V2QaCase>(checkpointPath);
  const summary = summarizeQa(all);
  const finishedAt = new Date().toISOString();
  const sum = (pick: (row: V2QaCase) => number | undefined) => all.reduce((n, row) => n + (pick(row) ?? 0), 0);
  const manifest = {
    ...researchTruthFields({
      coverage: { casesTotal: scoped.length, casesCompleted: all.length, answerErrors: summary.overall.readerErrors, judgeParseFailures: summary.overall.judgeErrors },
    }),
    schemaVersion: 1,
    benchmark: 'longmemeval-v2-qa',
    scope: LME_V2_SCOPE,
    metricProtocol: 'lme-v2-upstream-eval-functions-v1',
    upstream: LME_V2_UPSTREAM,
    stub: opts.stub,
    readerModelRequested: opts.reader.model,
    judgeModelRequested: opts.judge.model,
    readerBaseUrl: opts.reader.baseUrl,
    judgeBaseUrl: opts.judge.baseUrl,
    readerModelEchoes: [...new Set(all.map(row => row.reader?.modelEcho).filter(Boolean))],
    judgeModelEchoes: [...new Set(all.map(row => row.judge?.modelEcho).filter(Boolean))],
    temperature: opts.temperature,
    maxContextTokens: opts.maxContextTokens,
    answerMaxTokens: opts.answerMaxTokens ?? null,
    judgeMaxTokens: opts.judgeMaxTokens ?? null,
    prompts: {
      readerSystem: DOMAIN_SYSTEM_PROMPTS,
      readerUserTemplate: readerUserPrompt('{context}', '{question}'),
      judge: 'upstream qa_eval_metrics.py llm_abstention_checker / llm_gotchas_checker prompts (verbatim)',
    },
    retrievalRun: {
      dir: runDir,
      gitSha: retrievalManifest.gitSha,
      datasetSha256: retrievalManifest.datasetSha256,
      tier: retrievalManifest.tier,
      domain: retrievalManifest.domain,
      topK: retrievalManifest.topK,
      provider: retrievalManifest.provider,
      completeDataset: retrievalManifest.completeDataset,
    },
    domain: retrievalManifest.domain,
    tier: retrievalManifest.tier,
    // The embedding identity the context came from: register-run reads it, so a hash-embedded run (every dry run) is never quality-eligible.
    provider: retrievalManifest.provider,
    datasetSha256: retrievalManifest.datasetSha256,
    completeDataset: retrievalManifest.completeDataset === true && scoped.length === caseRows.length,
    selectedCases: scoped.length,
    scoredCases: summary.overall.scored,
    imageQuestionsTextOnly: scoped.filter(row => row.hasImage).length,
    usage: {
      reader: { promptTokens: sum(row => row.reader?.usage.promptTokens), completionTokens: sum(row => row.reader?.usage.completionTokens) },
      judge: { promptTokens: sum(row => row.judge?.usage.promptTokens), completionTokens: sum(row => row.judge?.usage.completionTokens) },
      judgeCalls: all.filter(row => row.judge).length,
    },
    gitSha: git.sha,
    gitDirty: git.dirty,
    runLedgerRecordId: ledgerRecord?.id ?? null,
    startedAt,
    finishedAt,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  await fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'qa-cases.sha256'), sha256(fs.readFileSync(checkpointPath)) + '\n', 'utf8');
  if (ledgerRecord) {
    saveRunOutcome(ledgerRecord, {
      status: all.filter(row => !row.error).length === scoped.length ? 'complete' : 'incomplete',
      finishedAt,
      casesTotal: scoped.length,
      casesCompleted: all.length,
      correct: summary.overall.correct,
      answerErrors: summary.overall.readerErrors,
      judgeParseFailures: summary.overall.judgeErrors,
      liveModelCalls,
      metrics: summary.overall,
    });
  }
  return { outputDir, manifest, summary };
}

// ---------------------------------------------------------------- scoring across domains

/**
 * Re-score one or more QA runs offline (no model calls) from their qa-cases.jsonl. Several runs are combined the
 * way the upstream leaderboard combines its web and enterprise runs; they must share reader, judge, tier and
 * dataset and cover distinct domains.
 */
export function scoreQaRuns(qaDirs: string[]) {
  if (qaDirs.length === 0) throw new Error('at least one --qa directory is required');
  const runs = qaDirs.map(dir => ({
    dir: path.resolve(dir),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, any>,
    rows: readCheckpoint<V2QaCase>(path.join(dir, 'qa-cases.jsonl')),
  }));
  for (const run of runs) {
    if (run.manifest.benchmark !== 'longmemeval-v2-qa') throw new Error(`${run.dir} is not a LongMemEval-V2 QA run`);
  }
  const same = (key: string) => {
    const values = new Set(runs.map(run => JSON.stringify(run.manifest[key] ?? null)));
    if (values.size > 1) throw new Error(`Refusing to combine runs with different ${key}: ${[...values].join(' vs ')}`);
  };
  ['readerModelRequested', 'judgeModelRequested', 'tier', 'datasetSha256', 'stub', 'temperature', 'maxContextTokens'].forEach(same);
  const domains = runs.map(run => String(run.manifest.domain));
  if (new Set(domains).size !== domains.length) throw new Error(`Refusing to combine two runs of the same domain: ${domains.join(', ')}`);

  const all = runs.flatMap(run => run.rows);
  const combined = summarizeQa(all);
  const stub = runs.some(run => run.manifest.stub === true);
  return {
    benchmark: 'longmemeval-v2-qa',
    scope: LME_V2_SCOPE,
    label: 'research',
    scoreAuthority: 'research',
    watermark: stub ? 'DRY-RUN STUB MODEL — NOT A SCORE' : 'RESEARCH-ONLY',
    stub,
    leaderboardComparable: false,
    tier: runs[0].manifest.tier ?? null,
    domains,
    readerModel: runs[0].manifest.readerModelRequested,
    judgeModel: runs[0].manifest.judgeModelRequested,
    completeDataset: runs.every(run => run.manifest.completeDataset === true),
    bothDomains: ['web', 'enterprise'].every(domain => domains.includes(domain)),
    ...combined,
    byDomain: Object.fromEntries(runs.map(run => [run.manifest.domain, summarizeQa(run.rows).overall])),
    failures: all.filter(row => row.error || row.scoreBool === false).map(row => ({
      id: row.id,
      domain: row.domain,
      category: row.category,
      evalFunction: row.evalFunction,
      outcome: row.error ? `error: ${row.error}` : row.isUnknown ? 'unknown' : 'wrong',
      parsedBoxed: row.reader?.parsedBoxed ?? null,
      contextTokens: row.contextTokens,
    })),
  };
}
