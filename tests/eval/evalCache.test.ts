import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EvalCache, CACHE_SCHEMA_VERSION, KeyPool, WorkerPool, resolveEvalCachePath, resolveJudgeKeys, runWithKeyPoolRetries, parseRetryAfterMs, resolveWorkerConcurrency, summarizeQaTokenUsage, resolveCacheScope } from '../../src/eval/evalCache';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcache-test-'));
  return path.join(dir, 'test-eval-cache.db');
}

describe('EvalCache', () => {
  let cache: EvalCache;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    cache = new EvalCache(dbPath);
  });

  afterEach(() => {
    cache.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ok */ }
  });

  it('computes deterministic keys from full request bodies', () => {
    const body = { model: 'gemma4:31b', messages: [{ role: 'user', content: 'Hello' }], temperature: 0 };
    const key1 = EvalCache.computeKey('ollama', body);
    const key2 = EvalCache.computeKey('ollama', body);
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64); // sha256 hex
  });

  it('different request bodies produce different keys', () => {
    const body1 = { model: 'gemma4:31b', messages: [{ role: 'user', content: 'Hello' }], temperature: 0 };
    const body2 = { model: 'gemma4:31b', messages: [{ role: 'user', content: 'Hello ' }], temperature: 0 };
    expect(EvalCache.computeKey('ollama', body1)).not.toBe(EvalCache.computeKey('ollama', body2));
  });

  it('different providers produce different keys for same body', () => {
    const body = { model: 'gemma4:31b', messages: [{ role: 'user', content: 'Hello' }] };
    expect(EvalCache.computeKey('ollama', body)).not.toBe(EvalCache.computeKey('opencodego', body));
  });

  it('different routing scopes produce different keys for the same provider and body', () => {
    const body = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hello' }] };
    const sessionA = EvalCache.computeKey('opencodego', body, 'x-opencode-session:session-a');
    const sessionB = EvalCache.computeKey('opencodego', body, 'x-opencode-session:session-b');
    expect(sessionA).not.toBe(sessionB);
  });

  it('schema version change invalidates all keys', () => {
    const body = { model: 'test', messages: [] };
    const key = EvalCache.computeKey('ollama', body);
    // Manually compute with a different version
    const crypto = require('node:crypto');
    const altKey = crypto.createHash('sha256')
      .update(`evalcache-other-version\0ollama\0\0${JSON.stringify(body)}`)
      .digest('hex');
    expect(key).not.toBe(altKey);
  });

  it('returns null on cache miss and tracks stats', () => {
    const result = cache.get('nonexistent-key', 'answer');
    expect(result).toBeNull();
    expect(cache.stats.answerMisses).toBe(1);
    expect(cache.stats.answerHits).toBe(0);
  });

  it('stores and retrieves answer responses with raw content', () => {
    const body = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'test' }] };
    const key = EvalCache.computeKey('opencodego', body);

    cache.put({
      cacheKey: key, providerNamespace: 'opencodego', callType: 'answer',
      questionId: 'q-001', rawContent: 'The answer is 42',
      modelEcho: 'deepseek-v4.1-flash', finishReason: 'stop',
      promptTokens: 1200, completionTokens: 50, latencyMs: 800,
      requestBody: body,
    });

    const hit = cache.get(key, 'answer');
    expect(hit).not.toBeNull();
    expect(hit!.rawContent).toBe('The answer is 42');
    expect(hit!.modelEcho).toBe('deepseek-v4.1-flash');
    expect(hit!.finishReason).toBe('stop');
    expect(hit!.promptTokens).toBe(1200);
    expect(hit!.completionTokens).toBe(50);
    expect(hit!.latencyMs).toBe(800);
    expect(hit!.providerNamespace).toBe('opencodego');

    expect(cache.stats.answerHits).toBe(1);
    expect(cache.stats.avoidedAnswerPromptTokens).toBe(1200);
    expect(cache.stats.avoidedAnswerCompletionTokens).toBe(50);
    expect(cache.stats.liveAnswerPromptTokens).toBe(1200);
    expect(cache.stats.liveAnswerCompletionTokens).toBe(50);
  });

  it('stores and retrieves judge responses', () => {
    const body = { model: 'gemma4:31b', messages: [{ role: 'user', content: 'judge this' }], temperature: 0 };
    const key = EvalCache.computeKey('ollama', body);

    cache.put({
      cacheKey: key, providerNamespace: 'ollama', callType: 'judge',
      questionId: 'q-002', rawContent: '1',
      modelEcho: 'gemma4:31b', finishReason: 'stop',
      promptTokens: 800, completionTokens: 1, latencyMs: 500,
      requestBody: body,
    });

    const hit = cache.get(key, 'judge');
    expect(hit).not.toBeNull();
    expect(hit!.rawContent).toBe('1');
    expect(cache.stats.judgeHits).toBe(1);
    expect(cache.stats.avoidedJudgePromptTokens).toBe(800);
  });

  it('INSERT OR IGNORE preserves first-seen response', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'q1' }] };
    const key = EvalCache.computeKey('provider', body);

    cache.put({
      cacheKey: key, providerNamespace: 'provider', callType: 'answer',
      questionId: 'q-003', rawContent: 'FIRST answer',
      modelEcho: 'test', finishReason: 'stop',
      promptTokens: 100, completionTokens: 10, latencyMs: 200,
      requestBody: body,
    });
    cache.put({
      cacheKey: key, providerNamespace: 'provider', callType: 'answer',
      questionId: 'q-003', rawContent: 'SECOND answer (different draw)',
      modelEcho: 'test', finishReason: 'stop',
      promptTokens: 100, completionTokens: 15, latencyMs: 150,
      requestBody: body,
    });

    const hit = cache.get(key, 'answer');
    expect(hit!.rawContent).toBe('FIRST answer');
  });

  it('promotes a verified response without counting a second live provider call', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'promote me' }] };
    const sessionKey = EvalCache.computeKey('provider', body, 'x-opencode-session:run-1');
    const canonicalKey = EvalCache.computeKey('provider', body, 'scope:lme-h10-v1');
    const entry = {
      cacheKey: sessionKey,
      providerNamespace: 'provider',
      callType: 'answer' as const,
      questionId: 'q-promote',
      rawContent: 'verified answer',
      modelEcho: 'test',
      finishReason: 'stop',
      promptTokens: 100,
      completionTokens: 10,
      latencyMs: 50,
      requestBody: body,
    };

    cache.put(entry);
    expect(cache.stats.liveAnswerPromptTokens).toBe(100);
    expect(cache.promote({ ...entry, cacheKey: canonicalKey })).toBe(true);
    expect(cache.promote({ ...entry, cacheKey: canonicalKey })).toBe(false);
    expect(cache.stats.liveAnswerPromptTokens).toBe(100);
    expect(cache.rowCount()).toBe(2);
    expect(cache.get(canonicalKey, 'answer')?.rawContent).toBe('verified answer');
  });

  it('rowCount returns accurate count', () => {
    expect(cache.rowCount()).toBe(0);
    const body = { model: 'test', messages: [] };
    const key = EvalCache.computeKey('p', body);
    cache.put({
      cacheKey: key, providerNamespace: 'p', callType: 'judge',
      questionId: 'q-1', rawContent: '0', modelEcho: '', finishReason: 'stop',
      promptTokens: 0, completionTokens: 0, latencyMs: 0, requestBody: body,
    });
    expect(cache.rowCount()).toBe(1);
  });

  it('survives close and reopen', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'persist' }] };
    const key = EvalCache.computeKey('p', body);
    cache.put({
      cacheKey: key, providerNamespace: 'p', callType: 'answer',
      questionId: 'q-persist', rawContent: 'durable', modelEcho: 'test',
      finishReason: 'stop', promptTokens: 50, completionTokens: 5,
      latencyMs: 100, requestBody: body,
    });
    cache.close();

    const cache2 = new EvalCache(dbPath);
    const hit = cache2.get(key, 'answer');
    expect(hit).not.toBeNull();
    expect(hit!.rawContent).toBe('durable');
    cache2.close();
    // Prevent double close in afterEach
    cache = new EvalCache(dbPath);
  });
});

describe('EvalCache v4 key integrity (raw body hash; pinned scope for cross-run)', () => {
  let cache: EvalCache;
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDbPath();
    cache = new EvalCache(dbPath);
  });
  afterEach(() => {
    cache.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ok */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ok */ }
  });

  const mkBody = (question: string, context: string) => ({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
    ],
    temperature: 0,
  });

  it('schema version is evalcache-v4', () => {
    expect(CACHE_SCHEMA_VERSION).toBe('evalcache-v4');
  });

  it('(i) different model-visible strings with path-shaped tokens produce DIFFERENT keys', () => {
    const bodyA = mkBody('What does Alex drink?', 'from /tmp/renor-product-Ab3d9F/vault/Sessions/x.md');
    const bodyB = mkBody('What does Alex drink?', 'from /tmp/renor-product-Zq7w2E/vault/Sessions/x.md');
    expect(JSON.stringify(bodyA)).not.toBe(JSON.stringify(bodyB));
    // Integrity: never collapse distinct contexts into one key.
    expect(EvalCache.computeKey('ns', bodyA)).not.toBe(EvalCache.computeKey('ns', bodyB));
    expect(EvalCache.computeKey('ns', bodyA, 'scope:pinned'))
      .not.toBe(EvalCache.computeKey('ns', bodyB, 'scope:pinned'));
  });

  it('(ii) identical request bodies produce identical keys (incl. pinned scope)', () => {
    const body = mkBody('What does Alex drink?', 'Alex drinks mango juice.');
    expect(EvalCache.computeKey('ns', body)).toBe(EvalCache.computeKey('ns', { ...body }));
    expect(EvalCache.computeKey('ns', body, 'scope:pinned'))
      .toBe(EvalCache.computeKey('ns', body, 'scope:pinned'));
    // Different scopes still differ (v3 behavior preserved).
    expect(EvalCache.computeKey('ns', body, 'scope:a'))
      .not.toBe(EvalCache.computeKey('ns', body, 'scope:b'));
    expect(EvalCache.computeKey('ns-a', body)).not.toBe(EvalCache.computeKey('ns-b', body));
  });

  it('(b) different question text produces a different key', () => {
    expect(EvalCache.computeKey('ns', mkBody('What does Alex drink?', 'ctx')))
      .not.toBe(EvalCache.computeKey('ns', mkBody('What does Alex eat?', 'ctx')));
  });

  it('(c) different retrieval content produces a different key', () => {
    expect(EvalCache.computeKey('ns', mkBody('q', 'Alex drinks mango juice.')))
      .not.toBe(EvalCache.computeKey('ns', mkBody('q', 'Alex drinks orange juice.')));
  });

  it('(d) old evalcache-v3 rows are never hit by v4 keys', () => {
    const body = mkBody('q', 'ctx');
    const crypto = require('node:crypto');
    // Exact v3 key derivation (raw JSON body, v3 version string).
    const v3Key = crypto.createHash('sha256')
      .update(`evalcache-v3\0ns\0\0${JSON.stringify(body)}`)
      .digest('hex');
    const v4Key = EvalCache.computeKey('ns', body);
    expect(v4Key).not.toBe(v3Key);
    cache.put({
      cacheKey: v3Key, providerNamespace: 'ns', callType: 'answer', questionId: 'q-old',
      rawContent: 'stale-v3', modelEcho: 'm', finishReason: 'stop',
      promptTokens: 1, completionTokens: 1, latencyMs: 1, requestBody: body,
    });
    expect(cache.get(v4Key, 'answer')).toBeNull();
    expect(cache.get(v3Key, 'answer')).not.toBeNull();
  });
});

describe('KeyPool', () => {
  it('requires at least one key', () => {
    expect(() => new KeyPool([])).toThrow('at least one');
  });

  it('acquires and releases keys in round-robin order', async () => {
    const pool = new KeyPool(['key-a', 'key-b', 'key-c'], 1);
    const acquired: string[] = [];

    for (let i = 0; i < 6; i++) {
      const { label, release } = await pool.acquire();
      acquired.push(label);
      release();
    }
    // Should rotate: key-1, key-2, key-3, key-1, key-2, key-3
    expect(acquired).toEqual(['key-1', 'key-2', 'key-3', 'key-1', 'key-2', 'key-3']);
  });

  it('blocks when all keys are in-flight and resolves on release', async () => {
    const pool = new KeyPool(['key-a'], 1);
    const first = await pool.acquire();
    expect(pool.totalInFlight).toBe(1);

    let resolved = false;
    const pending = pool.acquire().then(s => { resolved = true; return s; });

    // Should not resolve immediately
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    first.release();
    const second = await pending;
    expect(resolved).toBe(true);
    second.release();
  });

  it('permanently disables a key on 401', () => {
    const pool = new KeyPool(['key-a', 'key-b'], 1);
    expect(pool.size).toBe(2);
    pool.reportError('key-1', 401);
    expect(pool.size).toBe(1);
  });

  it('throws when all keys are disabled', () => {
    const pool = new KeyPool(['key-a'], 1);
    expect(() => pool.reportError('key-1', 403)).toThrow('All API keys');
  });

  it('applies cooldown on 429', async () => {
    const pool = new KeyPool(['key-a'], 1);
    pool.reportError('key-1', 429, 50); // 50ms cooldown

    // Should still be acquirable after cooldown
    await new Promise(r => setTimeout(r, 60));
    const slot = await pool.acquire();
    expect(slot.label).toBe('key-1');
    slot.release();
  });

  it('rotates a pooled retry away from a 429-limited key', async () => {
    const pool = new KeyPool(['key-a', 'key-b', 'key-c'], 1);
    const seen: string[] = [];
    const result = await runWithKeyPoolRetries(
      pool,
      2,
      async ({ label }, attempt) => {
        seen.push(label);
        if (attempt === 1) {
          pool.reportError(label, 429, 10_000);
          throw new Error('HTTP 429');
        }
        return label;
      },
      () => 0,
    );
    expect(seen).toEqual(['key-1', 'key-2']);
    expect(result).toEqual({ value: 'key-2', attempts: 2 });
  });

  it('never reuses a key disabled by 401 on the next pooled retry', async () => {
    const pool = new KeyPool(['key-a', 'key-b'], 1);
    const seen: string[] = [];
    const result = await runWithKeyPoolRetries(
      pool,
      2,
      async ({ label }, attempt) => {
        seen.push(label);
        if (attempt === 1) {
          pool.reportError(label, 401);
          throw new Error('HTTP 401');
        }
        return label;
      },
      () => 0,
    );
    expect(seen).toEqual(['key-1', 'key-2']);
    expect(result.value).toBe('key-2');
  });

  it('rejects queued acquirers when every key becomes disabled', async () => {
    const pool = new KeyPool(['key-a'], 1);
    const first = await pool.acquire();
    const pending = pool.acquire();
    const pendingExpectation = expect(pending).rejects.toThrow('All API keys');
    expect(() => pool.reportError('key-1', 403)).toThrow('All API keys');
    first.release();
    await pendingExpectation;
  });
});

describe('WorkerPool', () => {
  it('requires concurrency >= 1', () => {
    expect(() => new WorkerPool(0)).toThrow('concurrency');
  });

  it('runs tasks up to concurrency limit', async () => {
    const pool = new WorkerPool(2);
    let maxConcurrent = 0;
    let current = 0;

    const task = async (ms: number) => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise(r => setTimeout(r, ms));
      current--;
    };

    await Promise.all([
      pool.run(() => task(30)),
      pool.run(() => task(30)),
      pool.run(() => task(30)),
      pool.run(() => task(30)),
    ]);

    expect(maxConcurrent).toBe(2);
    expect(current).toBe(0);
  });

  it('propagates errors from tasks', async () => {
    const pool = new WorkerPool(1);
    await expect(pool.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe('eval cache utilities', () => {
  it('defaults worker concurrency to active judge keys capped at 3', () => {
    expect(resolveWorkerConcurrency(undefined, 1)).toBe(1);
    expect(resolveWorkerConcurrency(undefined, 3)).toBe(3);
    expect(resolveWorkerConcurrency(undefined, 7)).toBe(3);
    expect(resolveWorkerConcurrency('5', 3)).toBe(5);
    expect(() => resolveWorkerConcurrency('0', 3)).toThrow('--concurrency');
    expect(() => resolveWorkerConcurrency('nope', 3)).toThrow('--concurrency');
  });

  it('parses Retry-After delta-seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-18T20:00:00Z');
    expect(parseRetryAfterMs('2', now)).toBe(2000);
    expect(parseRetryAfterMs('Fri, 18 Sep 2026 20:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfterMs('invalid', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('counts cold no-cache records as live provider usage', () => {
    const usage = summarizeQaTokenUsage([
      {
        answer: { usage: { promptTokens: 100, completionTokens: 10 } },
        judge: { fromCache: false, usage: { promptTokens: 40, completionTokens: 1 } },
      },
      {
        answer: { fromCache: true, usage: { promptTokens: 200, completionTokens: 20 } },
        judge: { fromCache: true, usage: { promptTokens: 50, completionTokens: 1 } },
      },
    ]);
    expect(usage.live).toEqual({
      answerPrompt: 100,
      answerCompletion: 10,
      judgePrompt: 40,
      judgeCompletion: 1,
    });
    expect(usage.avoided).toEqual({
      answerPrompt: 200,
      answerCompletion: 20,
      judgePrompt: 50,
      judgeCompletion: 1,
    });
  });
});

describe('resolveEvalCachePath', () => {
  it('returns default path when unset', () => {
    const result = resolveEvalCachePath({ HOME: '/home/test' });
    expect(result).toBe('/home/test/.local/share/renor/eval-cache.db');
  });

  it('returns null when off', () => {
    expect(resolveEvalCachePath({ RENOR_EVAL_CACHE: 'off' })).toBeNull();
    expect(resolveEvalCachePath({ RENOR_EVAL_CACHE: '0' })).toBeNull();
  });

  it('returns explicit path', () => {
    const result = resolveEvalCachePath({ RENOR_EVAL_CACHE: '/tmp/my-cache.db' });
    expect(result).toBe('/tmp/my-cache.db');
  });
});

describe('resolveJudgeKeys', () => {
  it('reads numbered keys', () => {
    const keys = resolveJudgeKeys({
      JUDGE_API_KEY_1: 'k1',
      JUDGE_API_KEY_2: 'k2',
      JUDGE_API_KEY_3: 'k3',
    } as unknown as NodeJS.ProcessEnv, 'OLLAMA_API_KEY');
    expect(keys).toEqual(['k1', 'k2', 'k3']);
  });

  it('reads numbered keys with OLLAMA_API_KEY prefix', () => {
    const keys = resolveJudgeKeys({
      OLLAMA_API_KEY_1: 'ollama-1',
      OLLAMA_API_KEY_2: 'ollama-2',
      OLLAMA_API_KEY_3: 'ollama-3',
    } as unknown as NodeJS.ProcessEnv, 'OLLAMA_API_KEY');
    expect(keys).toEqual(['ollama-1', 'ollama-2', 'ollama-3']);
  });

  it('parses comma-separated keys from fallback env', () => {
    const keys = resolveJudgeKeys({
      OLLAMA_API_KEY: 'key-alpha, key-beta, key-gamma',
    } as unknown as NodeJS.ProcessEnv, 'OLLAMA_API_KEY');
    expect(keys).toEqual(['key-alpha', 'key-beta', 'key-gamma']);
  });

  it('falls back to single key', () => {
    const keys = resolveJudgeKeys({ OLLAMA_API_KEY: 'single' } as unknown as NodeJS.ProcessEnv, 'OLLAMA_API_KEY');
    expect(keys).toEqual(['single']);
  });

  it('returns empty when no keys set', () => {
    const keys = resolveJudgeKeys({} as unknown as NodeJS.ProcessEnv, 'MISSING');
    expect(keys).toEqual([]);
  });
});

describe('resolveCacheScope', () => {
  it('falls back to the routing session by default (contamination guard)', () => {
    expect(resolveCacheScope({ session: 'renor-eval-123' })).toBe('x-opencode-session:renor-eval-123');
    expect(resolveCacheScope({ explicit: undefined, session: 's1' })).toBe('x-opencode-session:s1');
  });

  it('uses the canonical scope when RENOR_QA_CACHE_SCOPE is pinned', () => {
    expect(resolveCacheScope({ explicit: 'lme-h10-v1', session: 'unique-run-42' })).toBe('scope:lme-h10-v1');
  });

  it('ignores whitespace-only explicit scopes', () => {
    expect(resolveCacheScope({ explicit: '   ', session: 's2' })).toBe('x-opencode-session:s2');
  });

  it('does not alias legacy pinned-session keys into canonical scope keys', () => {
    const canonical = resolveCacheScope({ explicit: 'lme-h10-v1', session: 'fresh-run' });
    const legacyPinnedSession = resolveCacheScope({ session: 'lme-h10-v1' });
    expect(canonical).not.toBe(legacyPinnedSession);
  });

  it('canonical scopes are stable across differently-sessioned runs (reuse)', () => {
    const a = resolveCacheScope({ explicit: 'beam-1m-v1', session: 'run-a' });
    const b = resolveCacheScope({ explicit: 'beam-1m-v1', session: 'run-b' });
    expect(a).toBe(b);
  });
});
