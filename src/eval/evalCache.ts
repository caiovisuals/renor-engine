import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from '../db/sqlite';

/**
 * Content-addressed eval cache for LongMemEval QA runs.
 *
 * Architecture: full-request hashing → raw-response replay.
 *
 * Key = sha256(CACHE_SCHEMA_VERSION + providerNamespace + JSON.stringify(requestBody)).
 * No .trim(), no selected-field hashing. Any prompt edit, temperature change,
 * or model swap automatically invalidates the cache because the full request
 * body changes.
 *
 * Stores raw model responses (not parsed verdicts). Parsing happens at read
 * time so future parser improvements don't require re-running models.
 *
 * The cache is "frozen replay": it stores the exact bytes a model returned for
 * a given request. It does NOT assume LLM calls are deterministic — even at
 * temperature 0, provider drift can produce different outputs for identical
 * prompts. The cache replays the first-seen draw. Authoritative promotion
 * runs should use --no-cache for a cold full-500.
 *
 * Design follows the existing embedding cache (src/embeddings/caching.ts):
 * SQLite + WAL + busy_timeout=10000 + INSERT OR IGNORE.
 */

/**
 * Bump this on any change to key computation or stored schema.
 *
 * v2 (2026-09-18): invalidated all v1 entries after the degraded shared-session
 * incident.
 *
 * v3 (2026-09-19): adds an explicit cache scope to key computation. The QA
 * runner passes the effective x-opencode-session as that scope, so a response
 * produced by one routed backend session can never be replayed into another.
 *
 * v4 (2026-09-22 / integrity fix 2026-09-23): documents the campaign finding
 * that cross-run replay needs a pinned cache scope + shared --cache-dir (and
 * shared evidence cache for evidence arms) — NOT body rewriting. The
 * path-variance diagnostic (scripts/eval/diagnose-evalcache-path-variance.ts)
 * measured runner-assembly answer/judge bodies as ALREADY byte-identical across
 * different per-case temp dirs (notePaths relativized; evidence tables emit
 * item/action/amount/date only). A brief experiment that rewrote
 * /tmp/renor-product-XXXXXX tokens inside the hashed JSON was rejected before
 * merge: model-visible path-shaped strings must remain part of the key, or two
 * different contexts can collide and replay the wrong answer.
 *
 * Key formula is unchanged from v3 aside from the version string: sha256 of
 * CACHE_SCHEMA_VERSION \0 providerNamespace \0 cacheScope \0
 * JSON.stringify(requestBody) with NO body mutation. Keeping the v4 label
 * intentionally invalidates v3 rows: a brief pre-merge canonicalize experiment
 * may have written experimental v4 keys on developer machines, and a clean
 * version cut avoids mixed semantics (cheaper than subtle collisions between
 * v3 and any experimental v4 rows). Scoring stays fail-closed on the schema
 * recorded in the run manifest.
 */
export const CACHE_SCHEMA_VERSION = 'evalcache-v4';

/** Routing-free scope of the judge memo (see EvalCache.computeJudgeMemoKey). Bump with its key formula. */
export const JUDGE_MEMO_SCOPE = 'judge-memo-v1';

export interface CachedResponse {
  rawContent: string;
  modelEcho: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** The original provider namespace this response came from. */
  providerNamespace: string;
}

export interface QaUsageRecord {
  answer?: { fromCache?: boolean; usage?: { promptTokens?: number; completionTokens?: number } } | null;
  judge?: { fromCache?: boolean; usage?: { promptTokens?: number; completionTokens?: number } } | null;
}

export function summarizeQaTokenUsage(records: QaUsageRecord[]): {
  live: { answerPrompt: number; answerCompletion: number; judgePrompt: number; judgeCompletion: number };
  avoided: { answerPrompt: number; answerCompletion: number; judgePrompt: number; judgeCompletion: number };
} {
  return {
    live: {
      answerPrompt: records.reduce((n, c) => n + (!c.answer?.fromCache ? (c.answer?.usage?.promptTokens ?? 0) : 0), 0),
      answerCompletion: records.reduce((n, c) => n + (!c.answer?.fromCache ? (c.answer?.usage?.completionTokens ?? 0) : 0), 0),
      judgePrompt: records.reduce((n, c) => n + (!c.judge?.fromCache ? (c.judge?.usage?.promptTokens ?? 0) : 0), 0),
      judgeCompletion: records.reduce((n, c) => n + (!c.judge?.fromCache ? (c.judge?.usage?.completionTokens ?? 0) : 0), 0),
    },
    avoided: {
      answerPrompt: records.reduce((n, c) => n + (c.answer?.fromCache ? (c.answer?.usage?.promptTokens ?? 0) : 0), 0),
      answerCompletion: records.reduce((n, c) => n + (c.answer?.fromCache ? (c.answer?.usage?.completionTokens ?? 0) : 0), 0),
      judgePrompt: records.reduce((n, c) => n + (c.judge?.fromCache ? (c.judge?.usage?.promptTokens ?? 0) : 0), 0),
      judgeCompletion: records.reduce((n, c) => n + (c.judge?.fromCache ? (c.judge?.usage?.completionTokens ?? 0) : 0), 0),
    },
  };
}

export interface EvalCacheStats {
  answerHits: number;
  answerMisses: number;
  judgeHits: number;
  judgeMisses: number;
  /** Tokens that were NOT sent to the provider thanks to cache hits. */
  avoidedAnswerPromptTokens: number;
  avoidedAnswerCompletionTokens: number;
  avoidedJudgePromptTokens: number;
  avoidedJudgeCompletionTokens: number;
  /** Tokens actually sent to the provider (live calls only). */
  liveAnswerPromptTokens: number;
  liveAnswerCompletionTokens: number;
  liveJudgePromptTokens: number;
  liveJudgeCompletionTokens: number;
  /** Cache lookup latency tracking. */
  cacheLookupTotalMs: number;
  cacheLookupCount: number;
  /** Judge verdicts replayed from the judge memo (also counted in judgeHits) and judge-memo lookups that found nothing. */
  judgeMemoHits: number;
  judgeMemoMisses: number;
}

export interface EvalCacheEntry {
  cacheKey: string;
  providerNamespace: string;
  callType: 'answer' | 'judge';
  questionId: string;
  rawContent: string;
  modelEcho: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  requestBody: Record<string, unknown>;
}

export class EvalCache {
  private db: Database.Database;
  readonly stats: EvalCacheStats = {
    answerHits: 0, answerMisses: 0,
    judgeHits: 0, judgeMisses: 0,
    avoidedAnswerPromptTokens: 0, avoidedAnswerCompletionTokens: 0,
    avoidedJudgePromptTokens: 0, avoidedJudgeCompletionTokens: 0,
    liveAnswerPromptTokens: 0, liveAnswerCompletionTokens: 0,
    liveJudgePromptTokens: 0, liveJudgeCompletionTokens: 0,
    cacheLookupTotalMs: 0, cacheLookupCount: 0,
    judgeMemoHits: 0, judgeMemoMisses: 0,
  };

  private readonly lookupStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_responses (
        cache_key TEXT PRIMARY KEY,
        cache_schema_version TEXT NOT NULL,
        provider_namespace TEXT NOT NULL,
        call_type TEXT NOT NULL,
        question_id TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        model_echo TEXT NOT NULL,
        finish_reason TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        request_body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_responses_qid ON eval_responses(question_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_responses_type ON eval_responses(call_type)`);

    this.lookupStmt = this.db.prepare(
      'SELECT raw_content, model_echo, finish_reason, prompt_tokens, completion_tokens, latency_ms, provider_namespace FROM eval_responses WHERE cache_key = ?'
    );
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO eval_responses
       (cache_key, cache_schema_version, provider_namespace, call_type, question_id,
        raw_content, model_echo, finish_reason, prompt_tokens, completion_tokens,
        latency_ms, request_body_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  /**
   * Compute a content-addressed cache key from the full API request plus an
   * optional routing scope.
   *
   * Key = sha256(CACHE_SCHEMA_VERSION \0 providerNamespace \0 cacheScope
   *              \0 requestBodyJSON).
   *
   * The request body is hashed as-is (no path rewriting). Cross-run replay
   * relies on pinned RENOR_QA_CACHE_SCOPE + shared --cache-dir, not on
   * mutating model-visible text before the key (v4 integrity fix).
   *
   * The QA runner uses the effective x-opencode-session as cacheScope because
   * that header has been empirically shown to affect backend routing/results.
   * Callers that have no routing-sensitive context may leave the scope empty.
   */
  static computeKey(
    providerNamespace: string,
    requestBody: Record<string, unknown>,
    cacheScope = '',
  ): string {
    // Hash the raw request body. Never rewrite model-visible text — path-shaped
    // tokens in context must produce distinct keys (integrity).
    return crypto.createHash('sha256')
      .update(`${CACHE_SCHEMA_VERSION}\0${providerNamespace}\0${cacheScope}\0${JSON.stringify(requestBody)}`)
      .digest('hex');
  }

  /**
   * Key of the judge memo: one judge verdict per (question id, judge endpoint and model, and the whole judge
   * request: system prompt, the question, the gold answer, the model answer, temperature and token cap).
   * No routing scope: a verdict is a function of what the judge was asked, so a later run with a new routing
   * session asks nothing new. The READER's answer is never keyed this way: it keeps the scope, so independent
   * draws stay independent (only an identical answer text earns an identical verdict).
   */
  static computeJudgeMemoKey(
    providerNamespace: string,
    questionId: string,
    requestBody: Record<string, unknown>,
  ): string {
    return crypto.createHash('sha256')
      .update(`${CACHE_SCHEMA_VERSION}\0${providerNamespace}\0${JUDGE_MEMO_SCOPE}\0${questionId}\0${JSON.stringify(requestBody)}`)
      .digest('hex');
  }

  /** Look up a memoized judge verdict. A hit counts as a judge hit (and its avoided tokens); a miss is only counted as a memo miss. */
  getJudgeMemo(memoKey: string): CachedResponse | null {
    const row = this.lookupStmt.get(memoKey) as {
      raw_content: string; model_echo: string; finish_reason: string;
      prompt_tokens: number; completion_tokens: number; latency_ms: number;
      provider_namespace: string;
    } | undefined;
    if (!row) {
      this.stats.judgeMemoMisses++;
      return null;
    }
    this.stats.judgeMemoHits++;
    this.stats.judgeHits++;
    this.stats.avoidedJudgePromptTokens += row.prompt_tokens;
    this.stats.avoidedJudgeCompletionTokens += row.completion_tokens;
    return {
      rawContent: row.raw_content,
      modelEcho: row.model_echo,
      finishReason: row.finish_reason,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      latencyMs: row.latency_ms,
      providerNamespace: row.provider_namespace,
    };
  }

  /**
   * Record a live judge verdict in the memo. Callers pass only verdicts that parsed: a response the parser
   * refuses is retried by the next run, not replayed. Not a live call: put() already counted it.
   */
  putJudgeMemo(entry: EvalCacheEntry): boolean {
    return this.insertEntry(entry) > 0;
  }

  /**
   * Look up a cached response. Returns null on miss.
   */
  get(cacheKey: string, callType: 'answer' | 'judge'): CachedResponse | null {
    const started = Date.now();
    const row = this.lookupStmt.get(cacheKey) as {
      raw_content: string; model_echo: string; finish_reason: string;
      prompt_tokens: number; completion_tokens: number; latency_ms: number;
      provider_namespace: string;
    } | undefined;
    this.stats.cacheLookupTotalMs += Date.now() - started;
    this.stats.cacheLookupCount++;

    if (!row) {
      if (callType === 'answer') this.stats.answerMisses++;
      else this.stats.judgeMisses++;
      return null;
    }

    if (callType === 'answer') {
      this.stats.answerHits++;
      this.stats.avoidedAnswerPromptTokens += row.prompt_tokens;
      this.stats.avoidedAnswerCompletionTokens += row.completion_tokens;
    } else {
      this.stats.judgeHits++;
      this.stats.avoidedJudgePromptTokens += row.prompt_tokens;
      this.stats.avoidedJudgeCompletionTokens += row.completion_tokens;
    }

    return {
      rawContent: row.raw_content,
      modelEcho: row.model_echo,
      finishReason: row.finish_reason,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      latencyMs: row.latency_ms,
      providerNamespace: row.provider_namespace,
    };
  }

  private insertEntry(params: EvalCacheEntry): number {
    const result = this.insertStmt.run(
      params.cacheKey,
      CACHE_SCHEMA_VERSION,
      params.providerNamespace,
      params.callType,
      params.questionId,
      params.rawContent,
      params.modelEcho,
      params.finishReason,
      params.promptTokens,
      params.completionTokens,
      params.latencyMs,
      JSON.stringify(params.requestBody),
      new Date().toISOString(),
    );
    return result.changes;
  }

  /**
   * Store a live response in the cache. INSERT OR IGNORE preserves first-seen semantics.
   */
  put(params: EvalCacheEntry): void {
    this.insertEntry(params);

    // Track live usage
    if (params.callType === 'answer') {
      this.stats.liveAnswerPromptTokens += params.promptTokens;
      this.stats.liveAnswerCompletionTokens += params.completionTokens;
    } else {
      this.stats.liveJudgePromptTokens += params.promptTokens;
      this.stats.liveJudgeCompletionTokens += params.completionTokens;
    }
  }

  /**
   * Promote an already-observed response into another cache identity without
   * counting it as a second live provider call. Returns true only when a new
   * cache row was inserted.
   */
  promote(params: EvalCacheEntry): boolean {
    return this.insertEntry(params) > 0;
  }

  /**
   * Invalidate recorded model calls. Filters combine (AND); an empty filter is
   * refused unless `all` is explicit. Returns the number of rows removed.
   */
  invalidate(filter: { providerNamespace?: string; callType?: 'answer' | 'judge'; all?: boolean }): number {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.providerNamespace) { clauses.push('provider_namespace = ?'); args.push(filter.providerNamespace); }
    if (filter.callType) { clauses.push('call_type = ?'); args.push(filter.callType); }
    if (clauses.length === 0 && !filter.all) throw new Error('EvalCache.invalidate: pass providerNamespace, callType, or all: true');
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`DELETE FROM eval_responses${where}`).run(...args).changes;
  }

  /** Cached row count per provider namespace and call type. */
  summary(): Array<{ providerNamespace: string; callType: string; rows: number }> {
    return (this.db.prepare('SELECT provider_namespace AS providerNamespace, call_type AS callType, COUNT(*) AS rows FROM eval_responses GROUP BY provider_namespace, call_type ORDER BY provider_namespace, call_type').all()) as Array<{ providerNamespace: string; callType: string; rows: number }>;
  }

  /** Row count for diagnostics. */
  rowCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM eval_responses').get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Multi-Key Round-Robin Pool ────────────────────────────────────────────────

export interface KeySlot {
  key: string;
  inFlight: number;
  disabled: boolean;
  cooldownUntil: number;
  /** Monotonic label for logging (never log the actual key). */
  label: string;
}

/**
 * Bounded concurrency key pool with per-key gating, 429 cooldown,
 * and permanent disable on 401/403.
 *
 * Supports genuine round-robin (rotates starting index) rather than
 * always grabbing the first free key.
 */
export interface KeyLease {
  key: string;
  label: string;
  release: () => void;
}

interface KeyWaiter {
  resolve: (lease: KeyLease) => void;
  reject: (error: Error) => void;
}

export class KeyPool {
  private slots: KeySlot[];
  private maxPerKey: number;
  private nextIndex: number = 0;
  private waiters: KeyWaiter[] = [];

  constructor(apiKeys: string[], maxPerKey = 1) {
    if (apiKeys.length === 0) throw new Error('KeyPool requires at least one API key');
    this.slots = apiKeys.map((key, i) => ({
      key,
      inFlight: 0,
      disabled: false,
      cooldownUntil: 0,
      label: `key-${i + 1}`,
    }));
    this.maxPerKey = maxPerKey;
  }

  get size(): number { return this.slots.filter(s => !s.disabled).length; }
  get totalInFlight(): number { return this.slots.reduce((n, s) => n + s.inFlight, 0); }

  private findAvailable(now: number): KeySlot | undefined {
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.nextIndex + i) % this.slots.length;
      const slot = this.slots[idx];
      if (!slot.disabled && slot.inFlight < this.maxPerKey && now >= slot.cooldownUntil) {
        this.nextIndex = (idx + 1) % this.slots.length;
        return slot;
      }
    }
    return undefined;
  }

  private lease(slot: KeySlot): KeyLease {
    slot.inFlight++;
    let released = false;
    return {
      key: slot.key,
      label: slot.label,
      release: () => {
        if (released) return;
        released = true;
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        this.drainWaiters();
      },
    };
  }

  /**
   * Acquire a key slot. Returns { key, label, release }.
   * release() is idempotent and should still be called in a finally block.
   */
  async acquire(): Promise<KeyLease> {
    if (this.size === 0) {
      throw new Error('All API keys have been permanently disabled (401/403)');
    }
    const slot = this.findAvailable(Date.now());
    if (slot) return this.lease(slot);

    // All usable keys are busy or cooling down. Queue and immediately drain so
    // cooldown-only waits get a wake-up timer even when no in-flight request
    // remains to call release().
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drainWaiters();
    });
  }

  private rejectAllWaiters(error: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  private drainWaiters(): void {
    if (this.waiters.length === 0) return;
    if (this.size === 0) {
      this.rejectAllWaiters(new Error('All API keys have been permanently disabled (401/403)'));
      return;
    }

    const now = Date.now();
    const slot = this.findAvailable(now);
    if (slot) {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(this.lease(slot));
      if (this.waiters.length > 0) queueMicrotask(() => this.drainWaiters());
      return;
    }

    // All usable keys are still busy or in cooldown. Busy keys will wake us on
    // release; cooldown-only waits need a timer for the nearest expiry.
    const nearestCooldown = this.slots
      .filter(s => !s.disabled && s.inFlight < this.maxPerKey && s.cooldownUntil > now)
      .reduce((min, s) => Math.min(min, s.cooldownUntil), Infinity);
    if (nearestCooldown < Infinity) {
      setTimeout(() => this.drainWaiters(), Math.max(0, nearestCooldown - now) + 10);
    }
  }

  /**
   * Report an HTTP error for a key. Handles cooldown and permanent disable.
   * Call this BEFORE release() if the error warrants special handling.
   */
  reportError(label: string, statusCode: number, retryAfterMs?: number): void {
    const slot = this.slots.find(s => s.label === label);
    if (!slot) return;
    if (statusCode === 401 || statusCode === 403) {
      slot.disabled = true;
      process.stderr.write(`[KeyPool] ${label} permanently disabled (HTTP ${statusCode})\n`);
      if (this.slots.every(s => s.disabled)) {
        const error = new Error('All API keys have been permanently disabled (401/403)');
        this.rejectAllWaiters(error);
        throw error;
      }
    } else if (statusCode === 429) {
      const cooldown = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : 60_000;
      slot.cooldownUntil = Date.now() + cooldown;
      process.stderr.write(`[KeyPool] ${label} rate-limited, cooldown ${cooldown}ms\n`);
    }
    this.drainWaiters();
  }
}

/**
 * Run a pooled operation with a fresh key acquisition on every attempt.
 * This is intentionally outside chatCall's internal retries so a 429/401 on
 * one credential cannot pin all retries to the same bad key.
 */
export async function runWithKeyPoolRetries<T>(
  pool: KeyPool,
  maxAttempts: number,
  fn: (slot: { key: string; label: string }, attempt: number) => Promise<T>,
  backoffMs: (attempt: number) => number = attempt => Math.min(1000 * 2 ** attempt, 8000),
): Promise<{ value: T; attempts: number }> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be an integer >= 1');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const lease = await pool.acquire();
    try {
      const value = await fn({ key: lease.key, label: lease.label }, attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
    } finally {
      lease.release();
    }

    if (attempt < maxAttempts) {
      const delay = backoffMs(attempt);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Pooled API failed after ${maxAttempts} attempts: ${String(lastError ?? 'unknown')}`);
}

/** Parse Retry-After as either delta-seconds or an HTTP date. */
export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Resolve runner concurrency, defaulting to usable judge-key capacity (capped at 3). */
export function resolveWorkerConcurrency(
  configured: string | undefined,
  activeJudgeKeys: number,
  defaultCap = 3,
): number {
  if (!Number.isInteger(activeJudgeKeys) || activeJudgeKeys < 1) {
    throw new Error('activeJudgeKeys must be an integer >= 1');
  }
  if (configured === undefined || configured.trim() === '') {
    return Math.min(defaultCap, activeJudgeKeys);
  }
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--concurrency must be an integer >= 1 (got ${configured})`);
  }
  return parsed;
}

// ─── Bounded Worker Pool ───────────────────────────────────────────────────────

/**
 * Simple bounded worker pool. Runs up to `concurrency` tasks at once.
 * Unlike p-limit, this is zero-dependency and supports our needs.
 */
export class WorkerPool {
  private concurrency: number;
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    if (concurrency < 1) throw new Error('WorkerPool concurrency must be >= 1');
    this.concurrency = concurrency;
  }

  /**
   * Run a task when a slot is available.
   * The returned promise resolves/rejects with the task's result.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ─── Cache Path Resolution ─────────────────────────────────────────────────────

/**
 * Resolve the cache scope that becomes part of the eval-cache key.
 *
 * Default: the effective routing session (`x-opencode-session:<session>`). The
 * session header affects backend routing, so it is part of cache identity and a
 * degraded routed session cannot poison later healthy runs (2026-09-18 incident).
 *
 * Benchmark runs that deliberately want cross-run reuse pin a canonical scope
 * via RENOR_QA_CACHE_SCOPE. The canonical registry is maintained by the
 * benchmark-infrastructure work (PR #67); the routing session stays unique for
 * health even when cache identity is shared.
 */
export function resolveCacheScope(args: { explicit?: string; session: string }): string {
  const explicit = (args.explicit ?? '').trim();
  return explicit ? `scope:${explicit}` : `x-opencode-session:${args.session}`;
}

/**
 * Resolve the eval cache path from environment.
 * RENOR_EVAL_CACHE=off → null (disabled).
 * RENOR_EVAL_CACHE=on or unset → default path.
 * RENOR_EVAL_CACHE=/path → explicit path.
 */
export function resolveEvalCachePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RENOR_EVAL_CACHE;
  if (raw === 'off' || raw === '0') return null;
  if (!raw || raw === 'on') {
    return path.join(env.HOME ?? '.', '.local', 'share', 'renor', 'eval-cache.db');
  }
  return path.resolve(raw);
}

/**
 * Parse judge API keys from environment.
 * Supports JUDGE_API_KEY_1, JUDGE_API_KEY_2, ... or falls back to single key.
 */
export function resolveJudgeKeys(env: NodeJS.ProcessEnv, fallbackKeyEnv: string, prefixEnv?: string): string[] {
  const keys: string[] = [];
  const prefixes = [prefixEnv, fallbackKeyEnv, 'JUDGE_API_KEY', 'OLLAMA_MAX_KEY', 'OLLAMA_API_KEY'].filter(Boolean) as string[];
  const seenPrefixes = new Set<string>();

  for (const prefix of prefixes) {
    if (seenPrefixes.has(prefix)) continue;
    seenPrefixes.add(prefix);
    for (let i = 1; i <= 10; i++) {
      const val = env[`${prefix}_${i}`];
      if (val && val.trim()) keys.push(val.trim());
    }
    if (keys.length > 0) return [...new Set(keys)];
  }

  // Check if prefixEnv or fallbackKeyEnv holds a comma-separated list or single key
  const single = (prefixEnv && env[prefixEnv]) || env[fallbackKeyEnv];
  if (single && single.trim()) {
    const split = single.split(',').map(s => s.trim()).filter(Boolean);
    if (split.length > 0) return split;
  }
  return [];
}
