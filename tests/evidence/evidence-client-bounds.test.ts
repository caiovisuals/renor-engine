import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvidenceExtractor, resolveEvidenceBounds, resolveEvidenceProvider, resolveEvidenceToolOptions } from '../../src/evidence/options';
import { EvidenceCache } from '../../src/evidence/evidenceCache';
import { createOllamaChat } from '../../src/evidence/ollamaChat';
import { collectOllamaKeys, ollamaKeysForEndpoint } from '../../src/evidence/keyPool';
import { renderEvidencePrompt, type EvidenceSessionInput } from '../../src/evidence/secondPass';
import { attachSearchEvidence, collectEvidence, productEvidenceReport } from '../../src/evidence/attach';
import { resolveRouterProvider, resolveSessionRouterOptions } from '../../src/router/sessionRouter';
import { completion, EVIDENCE_PROVIDER_ENV, startStubChat, type StubChat } from '../helpers/stubChat';

/**
 * The evidence client, made safe to point at a reasoning model and at a new provider.
 *
 * Measured 2026-10-03 (extractor-attribution study, sections 6.2 and 8.2): the client sent
 * `{model, messages, temperature}` and nothing else, so a reasoning extractor ran to the
 * provider's own ceiling (32,768 reasoning tokens and no content; one 8K prompt cost 17,346
 * completion tokens and 267 s), and the Ollama key pool was appended to whatever endpoint
 * RENOR_EVIDENCE_BASE_URL named, so a switch to another provider would have sent every
 * OLLAMA_* key to it.
 *
 * Nothing here changes a default: unset, the request is the same bytes as before and the
 * cache key is the legacy key.
 */

const ITEMS = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });
const SESSIONS: EvidenceSessionInput[] = [{ stem: '/vault/Sessions/a.md', date: '2023/05/29', text: 'We went camping for 3 days.' }];
const QUERY = 'How many days did we camp?';

const saved: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];
const servers: StubChat[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-bounds-'));
  tmpDirs.push(dir);
  return dir;
}

async function stub(reply: Parameters<typeof startStubChat>[0]): Promise<StubChat> {
  const server = await startStubChat(reply);
  servers.push(server);
  return server;
}

/** Only what a test sets: never a key or endpoint from the developer's shell. */
function envWith(values: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of EVIDENCE_PROVIDER_ENV) delete env[name];
  // The engine's unset evidence mode is off (src/evidence/gate.ts): these cases turn the pass on, as hosted Renor does.
  return { ...env, RENOR_EVIDENCE_MODE: 'always', ...values };
}

function vaultWithNote(): { vault: string; hits: Array<{ notePath: string; chunkId: number; headingPath: string; text: string; score: number; reason: string }> } {
  const vault = path.join(tmpDir(), 'vault');
  fs.mkdirSync(vault);
  const note = path.join(vault, 'a.md');
  fs.writeFileSync(note, '# A\n\nWe went camping for 3 days.');
  return { vault, hits: [{ notePath: note, chunkId: 1, headingPath: '', text: 'chunk', score: 0.9, reason: 'semantic' }] };
}

beforeEach(() => {
  for (const name of EVIDENCE_PROVIDER_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of EVIDENCE_PROVIDER_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('3a: a token bound and a reasoning-effort bound, sent only when the operator sets them', () => {
  it('unset, the request on the wire is byte-identical to the shipped request', async () => {
    const chat = await stub(() => ({ body: completion(ITEMS) }));
    const options = resolveEvidenceToolOptions({ dbPath: path.join(tmpDir(), 'product.db') }, envWith({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    }));
    expect(options.bounds).toBeUndefined();
    await createEvidenceExtractor(options)!.extract(QUERY, SESSIONS);

    expect(chat.requests).toHaveLength(1);
    // The exact bytes main sends: model, one user turn, temperature 0, nothing else.
    expect(chat.requests[0].body).toBe(JSON.stringify({
      model: 'stub-extractor',
      messages: [{ role: 'user', content: renderEvidencePrompt(QUERY, SESSIONS) }],
      temperature: 0,
    }));
  });

  it('set, RENOR_EVIDENCE_MAX_TOKENS and RENOR_EVIDENCE_REASONING_EFFORT reach the provider as max_tokens and reasoning_effort', async () => {
    const chat = await stub(() => ({ body: completion(ITEMS) }));
    const options = resolveEvidenceToolOptions({ dbPath: path.join(tmpDir(), 'product.db') }, envWith({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
      RENOR_EVIDENCE_MAX_TOKENS: '4096', RENOR_EVIDENCE_REASONING_EFFORT: 'low',
    }));
    expect(options.bounds).toEqual({ maxTokens: 4096, reasoningEffort: 'low' });
    const result = await createEvidenceExtractor(options)!.extract(QUERY, SESSIONS);
    expect(result.items).toHaveLength(1);

    const body = JSON.parse(chat.requests[0].body) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
    expect(body.reasoning_effort).toBe('low');
    expect(body.model).toBe('stub-extractor');
    expect(body.temperature).toBe(0);
  });

  it('each bound can be set alone', () => {
    expect(resolveEvidenceBounds(envWith({ RENOR_EVIDENCE_MAX_TOKENS: ' 2048 ' }))).toEqual({ maxTokens: 2048 });
    expect(resolveEvidenceBounds(envWith({ RENOR_EVIDENCE_REASONING_EFFORT: 'NONE' }))).toEqual({ reasoningEffort: 'none' });
    expect(resolveEvidenceBounds(envWith({ RENOR_EVIDENCE_MAX_TOKENS: '', RENOR_EVIDENCE_REASONING_EFFORT: '  ' }))).toEqual({});
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high']) {
      expect(resolveEvidenceBounds(envWith({ RENOR_EVIDENCE_REASONING_EFFORT: effort }))).toEqual({ reasoningEffort: effort });
    }
  });

  it('a bound that does not parse refuses, instead of running unbounded', () => {
    for (const value of ['4k', '0', '-5', '1.5', '1e3', '0x100', '4,096', 'NaN', 'Infinity', '9007199254740993']) {
      expect(() => resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, envWith({ RENOR_EVIDENCE_MAX_TOKENS: value })),
        `RENOR_EVIDENCE_MAX_TOKENS=${value}`).toThrow(/RENOR_EVIDENCE_MAX_TOKENS/);
    }
    for (const value of ['lowest', 'max', '1', 'xhigh-ish']) {
      expect(() => resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, envWith({ RENOR_EVIDENCE_REASONING_EFFORT: value })),
        `RENOR_EVIDENCE_REASONING_EFFORT=${value}`).toThrow(/RENOR_EVIDENCE_REASONING_EFFORT/);
    }
  });

  it('unset, the cache key is the legacy key; a bound is part of the key', () => {
    const prompt = renderEvidencePrompt(QUERY, SESSIONS);
    const legacy = crypto.createHash('sha256').update(`evidence-v1\0gemma4:31b\0${prompt}`).digest('hex');
    expect(EvidenceCache.computeKey('gemma4:31b', prompt)).toBe(legacy);
    expect(EvidenceCache.computeKey('gemma4:31b', prompt, {})).toBe(legacy);

    const keys = [
      EvidenceCache.computeKey('gemma4:31b', prompt, { maxTokens: 4096 }),
      EvidenceCache.computeKey('gemma4:31b', prompt, { maxTokens: 8192 }),
      EvidenceCache.computeKey('gemma4:31b', prompt, { reasoningEffort: 'low' }),
      EvidenceCache.computeKey('gemma4:31b', prompt, { reasoningEffort: 'high' }),
      EvidenceCache.computeKey('gemma4:31b', prompt, { maxTokens: 4096, reasoningEffort: 'low' }),
    ];
    expect(new Set([legacy, ...keys]).size).toBe(keys.length + 1);
  });

  it('a bounded arm never replays an unbounded arm\'s table, and the unbounded arm still replays its own', async () => {
    const chat = await stub(() => ({ body: completion(ITEMS) }));
    const dir = tmpDir();
    const common = {
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
      RENOR_EVIDENCE_CACHE: path.join(dir, 'evidence-cache.db'),
    };
    const unbounded = resolveEvidenceToolOptions({ dbPath: path.join(dir, 'product.db') }, envWith(common));
    const bounded = resolveEvidenceToolOptions({ dbPath: path.join(dir, 'product.db') }, envWith({ ...common, RENOR_EVIDENCE_MAX_TOKENS: '4096' }));

    expect((await createEvidenceExtractor(unbounded)!.extract(QUERY, SESSIONS)).fromCache).toBe(false);
    expect(chat.requests).toHaveLength(1);
    expect((await createEvidenceExtractor(bounded)!.extract(QUERY, SESSIONS)).fromCache).toBe(false);
    expect(chat.requests).toHaveLength(2);
    expect((await createEvidenceExtractor(unbounded)!.extract(QUERY, SESSIONS)).fromCache).toBe(true);
    expect((await createEvidenceExtractor(bounded)!.extract(QUERY, SESSIONS)).fromCache).toBe(true);
    expect(chat.requests).toHaveLength(2);
  });

  it('a reply cut at the token limit says so, after the same three attempts as any reply the parser rejects', async () => {
    const chat = await stub(() => ({ body: completion('{"items":[{"item":"camp', 'length') }));
    const dir = tmpDir();
    const vault = path.join(dir, 'vault');
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, 'a.md'), '# A\n\nWe went camping for 3 days.');
    const options = resolveEvidenceToolOptions({ dbPath: path.join(dir, 'product.db') }, envWith({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
      RENOR_EVIDENCE_MAX_TOKENS: '64',
    }));
    const attachment = await collectEvidence({
      query: QUERY,
      hits: [{ notePath: path.join(vault, 'a.md'), text: 'chunk', session_date: '2023/05/29' }],
      vaultPath: vault,
      options,
      extractor: createEvidenceExtractor(options),
    });
    expect(attachment.status).toBe('skipped');
    expect(attachment.reason).toBe('extractor-parse-error');
    expect(attachment.error).toMatch(/finish_reason=length/);
    // The parse-retry policy is unchanged: three attempts, each bounded.
    expect(chat.requests).toHaveLength(3);
    for (const request of chat.requests) expect((JSON.parse(request.body) as { max_tokens?: number }).max_tokens).toBe(64);
  });

  it('a reply with no content names its finish reason', async () => {
    const chat = await stub(() => ({ body: completion(undefined, 'length') }));
    const send = createOllamaChat({ baseUrl: chat.baseUrl, keys: ['k'], maxRetries: 0 });
    await expect(send({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0 }))
      .rejects.toThrow(/missing choices\[0\]\.message\.content \(finish_reason=length\)/);
  });
});

describe('3b: a failed extraction says which extractor failed', () => {
  it('a provider refusal is "failed" and carries the model and the provider status', async () => {
    const chat = await stub(() => ({ status: 400, body: { error: 'model not served' } }));
    const { vault, hits } = vaultWithNote();
    const options = resolveEvidenceToolOptions({ dbPath: path.join(vault, '..', 'product.db') }, envWith({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    }));
    const attached = await attachSearchEvidence({
      query: QUERY, hits, vaultPath: vault, options, extractor: createEvidenceExtractor(options), enabled: true,
    });
    expect(attached.hits).toEqual(hits);
    const report = productEvidenceReport(attached.evidence);
    expect(report.state).toBe('failed');
    expect(report.reason).toBe('extractor-error');
    expect(report.model).toBe('stub-extractor');
    expect(report.error).toMatch(/400/);
  });

  it('an unparseable reply is "failed" and carries the model', async () => {
    const chat = await stub(() => ({ body: completion('not json') }));
    const { vault, hits } = vaultWithNote();
    const options = resolveEvidenceToolOptions({ dbPath: path.join(vault, '..', 'product.db') }, envWith({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    }));
    const attached = await attachSearchEvidence({
      query: QUERY, hits, vaultPath: vault, options, extractor: createEvidenceExtractor(options), enabled: true,
    });
    const report = productEvidenceReport(attached.evidence);
    expect(report.state).toBe('failed');
    expect(report.reason).toBe('extractor-parse-error');
    expect(report.model).toBe('stub-extractor');
  });
});

describe('OLLAMA_* keys go to Ollama Cloud only', () => {
  const OLLAMA_VALUES: Record<string, string> = {
    OLLAMA_CLOUD_KEY_1: 'ollama-value-1', OLLAMA_CLOUD_KEY_2: 'ollama-value-2', OLLAMA_CLOUD_KEY_3: 'ollama-value-3',
    OLLAMA_CLOUD_KEY_4: 'ollama-value-4', OLLAMA_MAX_KEY: 'ollama-value-max', OLLAMA_API_KEY: 'ollama-value-api',
  };

  it('another provider\'s endpoint never receives an OLLAMA_* key, on any request of the rotation', async () => {
    const chat = await stub(() => ({ body: completion(ITEMS) }));
    const options = resolveEvidenceToolOptions({ dbPath: path.join(tmpDir(), 'product.db') }, envWith({
      ...OLLAMA_VALUES,
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'provider-key', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    }));
    // Round-robin would reach every key in the pool within seven calls.
    for (let i = 0; i < 7; i++) await options.chat!({ model: 'stub-extractor', messages: [{ role: 'user', content: `q${i}` }], temperature: 0 });

    expect(chat.requests).toHaveLength(7);
    expect(new Set(chat.requests.map(request => request.authorization))).toEqual(new Set(['Bearer provider-key']));
    for (const request of chat.requests) {
      for (const value of Object.values(OLLAMA_VALUES)) expect(request.authorization).not.toContain(value);
    }
  });

  it('with only OLLAMA_* keys, another provider gets no client at all, and a search says no evidence model is configured', async () => {
    const chat = await stub(() => ({ body: completion(ITEMS) }));
    const { vault, hits } = vaultWithNote();
    const options = resolveEvidenceToolOptions({ dbPath: path.join(vault, '..', 'product.db') }, envWith({
      ...OLLAMA_VALUES, RENOR_EVIDENCE_BASE_URL: chat.baseUrl,
    }));
    expect(options.chat).toBeUndefined();
    const extractor = createEvidenceExtractor(options);
    expect(extractor).toBeNull();
    const attached = await attachSearchEvidence({ query: QUERY, hits, vaultPath: vault, options, extractor, enabled: true });
    expect(chat.requests).toHaveLength(0);
    // The note is the agent's (re-check N9, tests/mvp/agent-facing-text.test.ts): which key is missing for which
    // endpoint stays in `reason` and engine/README.md.
    const report = productEvidenceReport(attached.evidence);
    expect(report).toMatchObject({ state: 'unavailable', reason: 'extractor-unavailable' });
    expect(report.note).toMatch(/no evidence model configured/i);
  });

  it('the session router, borrowing the evidence provider, never sends an OLLAMA_* key to another endpoint either', async () => {
    const chat = await stub(() => ({ body: completion('{}') }));
    // With no key of its own the router takes the evidence pass's provider as a unit (resolveRouterProvider), so
    // the one gate covers both callers.
    const env = { ...OLLAMA_VALUES, RENOR_SESSION_ROUTER: 'replace', RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'provider-key' };
    expect(resolveRouterProvider(env)).toEqual({ baseUrl: chat.baseUrl, keys: ['provider-key'], slot: 'evidence' });
    const router = resolveSessionRouterOptions({ dbPath: path.join(tmpDir(), 'product.db') }, env)!;
    // Round-robin would reach every key in the pool within seven calls.
    for (let i = 0; i < 7; i++) await router.routeChat!({ model: 'stub-router', messages: [{ role: 'user', content: `q${i}` }], temperature: 0 });
    expect(chat.requests).toHaveLength(7);
    expect(new Set(chat.requests.map(request => request.authorization))).toEqual(new Set(['Bearer provider-key']));
  });

  it('Ollama Cloud keeps the whole pool: unset, blank or an explicit https://ollama.com endpoint', () => {
    const env = envWith(OLLAMA_VALUES);
    const pool = collectOllamaKeys(env);
    expect(pool.keys).toHaveLength(6);
    for (const baseUrl of [undefined, '', '   ', 'https://ollama.com/v1', 'https://ollama.com/v1/', 'https://OLLAMA.com/v1', 'https://api.ollama.com/v1']) {
      expect(ollamaKeysForEndpoint(baseUrl, env), String(baseUrl)).toEqual(pool);
    }
    // The provider the evidence pass and the session router build their client from: a blank URL is the default
    // endpoint the pool was judged for, never an empty base URL.
    expect(resolveEvidenceProvider(envWith({ ...OLLAMA_VALUES, RENOR_EVIDENCE_BASE_URL: '   ' }))).toEqual({ baseUrl: undefined, keys: pool.keys });
    // The default endpoint still arms the evidence pass on Ollama keys alone (#222).
    expect(resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, env).chat).toBeDefined();
    expect(resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, envWith({ ...OLLAMA_VALUES, RENOR_EVIDENCE_BASE_URL: 'https://ollama.com/v1' })).chat).toBeDefined();
  });

  it('a look-alike, plaintext or unparseable endpoint is not Ollama Cloud', () => {
    const env = envWith(OLLAMA_VALUES);
    for (const baseUrl of [
      'https://ollama.com.evil.example/v1',
      'https://evil.example/ollama.com/v1',
      'https://evil.example/v1?host=ollama.com',
      'https://notollama.com/v1',
      'https://ollama.com@evil.example/v1',
      'http://ollama.com/v1',
      'ollama.com/v1',
      'https://api.fireworks.ai/inference/v1',
      'http://127.0.0.1:11434/v1',
    ]) {
      expect(ollamaKeysForEndpoint(baseUrl, env), baseUrl).toEqual({ keys: [], names: [] });
    }
  });
});
