import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { EVIDENCE_FAILURE_TTL_MS, EvidenceCache } from '../../src/evidence/evidenceCache';
import {
  EvidenceExtractor,
  loadEvidenceSessionsFromVault,
  type EvidenceChat,
  type EvidenceChatRequest,
} from '../../src/evidence/secondPass';
import { attachSearchEvidence, collectEvidence, productEvidenceReport, type CollectEvidenceArgs } from '../../src/evidence/attach';
import { EvidenceFlights } from '../../src/evidence/background';
import { createOllamaChat } from '../../src/evidence/ollamaChat';
import { createEvidenceExtractor, resolveEvidenceToolOptions } from '../../src/evidence/options';
import { completion, EVIDENCE_PROVIDER_ENV, startStubChat, type StubChat, type StubChatReply } from '../helpers/stubChat';

/**
 * A failed evidence extraction is remembered, so the same request does not pay for it again.
 *
 * Measured 2026-10-03 (GLM-5.3-Flash on Nebius, dev100): 39% of extraction spend went to replies that reasoned to the
 * provider's 8,192-token cap and came back empty. Only tables were cached, so every repeat of such a search paid for
 * its three attempts again (the D arm re-tried the 7 failed searches in 17 calls, and 5 of the 7 failed again). A
 * reply the parser rejects is now remembered under the table's own key for EVIDENCE_FAILURE_TTL_MS and said again
 * with `fromCache: true`; an error before any reply (a 429, a 5xx, a timeout, a refused request) never is.
 *
 * Every provider here is a stub on 127.0.0.1 that counts the requests it receives, and the clock is faked (Date only)
 * to cross the TTL.
 */

const QUERY = 'Can you recommend a camping spot for us?';
const ITEMS = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });
/** What the product reports for a reply that reasoned to the cap and came back empty, as GLM-5.3-Flash on Nebius did. */
const OVERRUN_ERROR = 'extractor reply stopped at the token limit (finish_reason=length): extractor response did not contain a JSON object';
const T0 = Date.parse('2026-10-03T21:00:00.000Z');

type Hit = { notePath: string; chunkId: number; headingPath: string; text: string; score: number; reason: string; session_date: string };

const saved: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const openCaches: EvidenceCache[] = [];

beforeEach(() => {
  for (const name of EVIDENCE_PROVIDER_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const name of EVIDENCE_PROVIDER_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const cache of openCaches.splice(0)) cache.close();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-negative-cache-'));
  tmpDirs.push(dir);
  return dir;
}

async function stub(reply: (n: number) => StubChatReply): Promise<StubChat> {
  let n = 0;
  const server = await startStubChat(() => reply(n++));
  servers.push(server);
  return server;
}

/** A provider that takes every request and never answers it. */
async function silentProvider(): Promise<{ baseUrl: string }> {
  const server = http.createServer(req => {
    req.resume();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

function workspace(): { dir: string; vault: string; hits: Hit[] } {
  const dir = tmpDir();
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  const note = path.join(vault, 'trip.md');
  fs.writeFileSync(note, '# Trip\n\nWe went camping for 3 days near the lake and want to go back.\n');
  return {
    dir,
    vault,
    hits: [{ notePath: note, chunkId: 1, headingPath: '', text: 'chunk', score: 0.9, reason: 'semantic', session_date: '2023/05/29' }],
  };
}

/** The product's evidence settings for a stub provider, with one evidence cache file for the whole workspace. */
function productEnv(provider: { baseUrl: string }, dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of EVIDENCE_PROVIDER_ENV) delete env[name];
  return {
    ...env,
    RENOR_EVIDENCE_BASE_URL: provider.baseUrl,
    RENOR_EVIDENCE_API_KEY: 'k',
    RENOR_EVIDENCE_MODEL: 'stub-extractor',
    RENOR_EVIDENCE_CACHE: path.join(dir, 'evidence-cache.db'),
  };
}

/**
 * One search's evidence report. Each search builds its own extractor and opens the cache file anew, as each
 * `renor search` process and each MCP session does.
 */
async function search(env: NodeJS.ProcessEnv, ws: { dir: string; vault: string; hits: Hit[] }) {
  const options = resolveEvidenceToolOptions({ dbPath: path.join(ws.dir, 'index.db') }, env);
  const attached = await attachSearchEvidence({
    query: QUERY, hits: ws.hits, vaultPath: ws.vault, options, extractor: createEvidenceExtractor(options), enabled: true,
  });
  return productEvidenceReport(attached.evidence);
}

function failureRows(cachePath: string): number {
  const db = new Database(cachePath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM evidence_failures').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('a reply the parser rejects is paid for once per request within EVIDENCE_FAILURE_TTL_MS', () => {
  it('a prompt that always overruns the token limit costs one extraction across repeated searches within the TTL, and a new one after it', async () => {
    const provider = await stub(() => ({ body: completion('', 'length') }));
    const ws = workspace();
    const env = productEnv(provider, ws.dir);

    const first = await search(env, ws);
    // A live failure reads exactly as it did before, after the unchanged three attempts of the parse-retry policy.
    expect(provider.requests).toHaveLength(3);
    expect(first).toEqual({
      status: 'skipped',
      reason: 'extractor-parse-error',
      model: 'stub-extractor',
      error: OVERRUN_ERROR,
      state: 'failed',
      note: expect.stringMatching(/answered in a shape the parser rejects/),
    });
    expect(first).not.toHaveProperty('fromCache');

    for (const later of [1, 60_000, EVIDENCE_FAILURE_TTL_MS - 1]) {
      vi.setSystemTime(T0 + later);
      // Said again, and says it was remembered; the provider is not asked.
      expect(await search(env, ws), `${later} ms later`).toEqual({ ...first, fromCache: true });
    }
    expect(provider.requests).toHaveLength(3);

    vi.setSystemTime(T0 + EVIDENCE_FAILURE_TTL_MS);
    expect(await search(env, ws)).toEqual(first);
    expect(provider.requests).toHaveLength(6);
    // Remembered again from that failure on.
    vi.setSystemTime(T0 + EVIDENCE_FAILURE_TTL_MS + 1);
    expect(await search(env, ws)).toEqual({ ...first, fromCache: true });
    expect(provider.requests).toHaveLength(6);
  });

  it('a request answered with a table once the TTL is over caches it, and the table answers from then on', async () => {
    // Three empty replies at the cap, then a table.
    const provider = await stub(n => ({ body: n < 3 ? completion('', 'length') : completion(ITEMS) }));
    const ws = workspace();
    const env = productEnv(provider, ws.dir);

    expect(await search(env, ws)).toMatchObject({ state: 'failed', reason: 'extractor-parse-error' });
    vi.setSystemTime(T0 + 60 * 60 * 1000);
    expect(await search(env, ws)).toMatchObject({ state: 'failed', fromCache: true });
    expect(provider.requests).toHaveLength(3);

    vi.setSystemTime(T0 + EVIDENCE_FAILURE_TTL_MS);
    expect(await search(env, ws)).toMatchObject({ state: 'ok', fromCache: false, items: [{ item: 'camping trip' }] });
    expect(provider.requests).toHaveLength(4);
    vi.setSystemTime(T0 + EVIDENCE_FAILURE_TTL_MS + 1);
    expect(await search(env, ws)).toMatchObject({ state: 'ok', fromCache: true, items: [{ item: 'camping trip' }] });
    expect(provider.requests).toHaveLength(4);
  });

  it('a malformed reply is remembered like an empty one', async () => {
    const provider = await stub(() => ({ body: completion('Here are the items: {"items": [}]') }));
    const ws = workspace();
    const env = productEnv(provider, ws.dir);
    const first = await search(env, ws);
    expect(first).toMatchObject({ state: 'failed', reason: 'extractor-parse-error', error: expect.stringMatching(/^extractor returned malformed JSON/) });
    expect(first).not.toHaveProperty('fromCache');
    expect(await search(env, ws)).toEqual({ ...first, fromCache: true });
    expect(provider.requests).toHaveLength(3);
  });

  it('another question, other notes, another model or another bound is asked at once', async () => {
    const provider = await stub(() => ({ body: completion('', 'length') }));
    const ws = workspace();
    const env = productEnv(provider, ws.dir);
    await search(env, ws);
    expect(provider.requests).toHaveLength(3);

    const options = resolveEvidenceToolOptions({ dbPath: path.join(ws.dir, 'index.db') }, env);
    const otherQuestion = await attachSearchEvidence({
      query: 'Where did we go camping?', hits: ws.hits, vaultPath: ws.vault, options, extractor: createEvidenceExtractor(options), enabled: true,
    });
    expect(otherQuestion.evidence).not.toHaveProperty('fromCache');
    expect(provider.requests).toHaveLength(6);

    fs.appendFileSync(ws.hits[0].notePath, 'We also bought a tent.\n');
    expect(await search(env, ws)).not.toHaveProperty('fromCache');
    expect(provider.requests).toHaveLength(9);

    expect(await search({ ...env, RENOR_EVIDENCE_MODEL: 'other-extractor' }, ws)).not.toHaveProperty('fromCache');
    expect(provider.requests).toHaveLength(12);

    expect(await search({ ...env, RENOR_EVIDENCE_REASONING_EFFORT: 'low' }, ws)).not.toHaveProperty('fromCache');
    expect(provider.requests).toHaveLength(15);
    // ...and each of them is remembered under its own key.
    expect(await search({ ...env, RENOR_EVIDENCE_REASONING_EFFORT: 'low' }, ws)).toMatchObject({ fromCache: true });
    expect(provider.requests).toHaveLength(15);
  });

  it('a table cached for the same request wins over a remembered failure', async () => {
    const provider = await stub(() => ({ body: completion('', 'length') }));
    const ws = workspace();
    const env = productEnv(provider, ws.dir);
    await search(env, ws);
    expect(await search(env, ws)).toMatchObject({ state: 'failed', fromCache: true });
    expect(provider.requests).toHaveLength(3);

    // Another process (or an extraction already in the air) stored a table for this very request meanwhile.
    const options = resolveEvidenceToolOptions({ dbPath: path.join(ws.dir, 'index.db') }, env);
    const key = createEvidenceExtractor(options)!.cacheKey(QUERY, await loadEvidenceSessionsFromVault(ws.hits, ws.vault));
    const cache = new EvidenceCache(options.cachePath!);
    openCaches.push(cache);
    cache.put(key, {
      items: [{ item: 'camping trip' }], sessions: [], model: 'stub-extractor',
      question: QUERY, promptTokens: 10, completionTokens: 5, createdAt: new Date().toISOString(),
    });

    expect(await search(env, ws)).toMatchObject({ state: 'ok', fromCache: true, items: [{ item: 'camping trip' }] });
    expect(provider.requests).toHaveLength(3);
  });

  it('a failure the cache cannot store is still reported as before, and only the next search pays again', async () => {
    const provider = await stub(() => ({ body: completion('', 'length') }));
    const ws = workspace();
    const env = productEnv(provider, ws.dir);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(EvidenceCache.prototype, 'putFailure').mockImplementation(() => {
      throw new Error('database or disk is full');
    });
    const first = await search(env, ws);
    expect(first).toMatchObject({ state: 'failed', reason: 'extractor-parse-error', error: OVERRUN_ERROR });
    expect(first).not.toHaveProperty('fromCache');
    expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain('[evidence] could not remember a failed extraction: database or disk is full');
    expect(await search(env, ws)).toEqual(first);
    expect(provider.requests).toHaveLength(6);
  });
});

describe('an error before any reply is never remembered: the next search asks again', () => {
  /** The real client, without its own retries, so each search is one request per attempt. */
  function extractorFor(baseUrl: string, cachePath: string, chat: EvidenceChat = createOllamaChat({ baseUrl, keys: ['k'], maxRetries: 0 })): EvidenceExtractor {
    const cache = new EvidenceCache(cachePath);
    openCaches.push(cache);
    return new EvidenceExtractor({ chat, cache, model: 'stub-extractor' });
  }

  const cases: Array<{ name: string; reply: StubChatReply; reason: string; error: RegExp; perSearch: number }> = [
    { name: 'a 429', reply: { status: 429, body: { error: 'rate limited' } }, reason: 'extractor-error', error: /returned 429/, perSearch: 1 },
    { name: 'a 503', reply: { status: 503, body: { error: 'overloaded' } }, reason: 'extractor-error', error: /returned 503/, perSearch: 1 },
    { name: 'a refused request', reply: { status: 400, body: { error: 'model not served' } }, reason: 'extractor-error', error: /returned 400/, perSearch: 1 },
    // These two read as parse failures (the words name JSON) and are retried as such, but no reply was parsed.
    { name: 'a refused request whose words name JSON', reply: { status: 400, body: { error: 'could not parse the JSON body' } }, reason: 'extractor-parse-error', error: /returned 400/, perSearch: 3 },
    { name: 'a page that is not an API answer', reply: { status: 200, body: '<html>bad gateway</html>' }, reason: 'extractor-parse-error', error: /not valid JSON/, perSearch: 3 },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const provider = await stub(() => c.reply);
      const ws = workspace();
      const extractor = extractorFor(provider.baseUrl, path.join(ws.dir, 'evidence-cache.db'));
      const searchOnce = async () => productEvidenceReport((await attachSearchEvidence({
        query: QUERY, hits: ws.hits, vaultPath: ws.vault,
        options: { mode: 'always', model: 'stub-extractor', maxSessions: 20, charCap: 6000 }, extractor, enabled: true,
      })).evidence);
      const first = await searchOnce();
      expect(first).toMatchObject({ status: 'skipped', reason: c.reason, model: 'stub-extractor', state: 'failed', error: expect.stringMatching(c.error) });
      expect(first).not.toHaveProperty('fromCache');
      expect(provider.requests).toHaveLength(c.perSearch);
      vi.setSystemTime(T0 + 1000);
      expect(await searchOnce()).toEqual(first);
      expect(provider.requests).toHaveLength(2 * c.perSearch);
    });
  }

  it('a timeout', async () => {
    const provider = await silentProvider();
    const ws = workspace();
    // Counted at the client: under load the abort can win the race with the request's arrival at the provider.
    const chat = vi.fn(createOllamaChat({ baseUrl: provider.baseUrl, keys: ['k'], maxRetries: 0, timeoutMs: 300 }));
    const extractor = extractorFor(provider.baseUrl, path.join(ws.dir, 'evidence-cache.db'), chat);
    const searchOnce = async () => productEvidenceReport((await attachSearchEvidence({
      query: QUERY, hits: ws.hits, vaultPath: ws.vault,
      options: { mode: 'always', model: 'stub-extractor', maxSessions: 20, charCap: 6000 }, extractor, enabled: true,
    })).evidence);
    const first = await searchOnce();
    expect(first).toMatchObject({ status: 'skipped', reason: 'extractor-error', state: 'failed', error: expect.stringMatching(/abort/i) });
    expect(first).not.toHaveProperty('fromCache');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(await searchOnce()).toEqual(first);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe('a bounded-wait extraction (RENOR_EVIDENCE_ASYNC) that fails is remembered too', () => {
  /** A model that replies at the cap with nothing, once the test opens it. */
  function gatedOverrun() {
    let isOpen = false;
    const parked: Array<() => void> = [];
    const chat = vi.fn(async (_request: EvidenceChatRequest) => {
      if (!isOpen) await new Promise<void>(resolve => parked.push(resolve));
      return { content: '', finishReason: 'length', latencyMs: 7 };
    });
    return {
      chat: chat as EvidenceChat & typeof chat,
      open() {
        isOpen = true;
        for (const resume of parked.splice(0)) resume();
      },
    };
  }

  it('the search after a "pending" one whose extraction failed says the failure and starts nothing', async () => {
    const ws = workspace();
    const model = gatedOverrun();
    const cachePath = path.join(ws.dir, 'evidence-cache.db');
    const cache = new EvidenceCache(cachePath);
    openCaches.push(cache);
    const extractor = new EvidenceExtractor({ chat: model.chat, cache, model: 'stub-model' });
    const flights = new EvidenceFlights();
    const bounded: CollectEvidenceArgs = {
      query: QUERY, hits: ws.hits, vaultPath: ws.vault, extractor,
      options: { mode: 'always', maxSessions: 20, charCap: 6000, cachePath, background: { waitMs: 30, flights } },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await collectEvidence(bounded)).toEqual({ status: 'skipped', reason: 'pending' });
    model.open();
    await flights.idle();
    expect(model.chat).toHaveBeenCalledTimes(3);
    expect(flights.counts).toMatchObject({ started: 1, failed: 1 });
    expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain('ended without a table (extractor-parse-error)');

    const again = await collectEvidence(bounded);
    expect(again).toEqual({ status: 'skipped', reason: 'extractor-parse-error', fromCache: true, model: 'stub-model', error: OVERRUN_ERROR });
    expect(model.chat).toHaveBeenCalledTimes(3);
    expect(flights.counts.started).toBe(1);
  });
});

describe('the store', () => {
  it('remembers a failure for 24 hours, as engine/README.md documents', () => {
    expect(EVIDENCE_FAILURE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('drops expired failures when it writes one, so it never holds more than one TTL of them', () => {
    const cachePath = path.join(tmpDir(), 'evidence-cache.db');
    const cache = new EvidenceCache(cachePath);
    openCaches.push(cache);
    cache.putFailure('a', { model: 'm', error: 'e', failedAt: Date.now() });
    vi.setSystemTime(T0 + EVIDENCE_FAILURE_TTL_MS - 1);
    expect(cache.getFailure('a')).toEqual({ model: 'm', error: 'e', failedAt: T0 });
    cache.putFailure('b', { model: 'm', error: 'e', failedAt: Date.now() });
    expect(failureRows(cachePath)).toBe(2);
    vi.setSystemTime(T0 + EVIDENCE_FAILURE_TTL_MS);
    expect(cache.getFailure('a')).toBeNull();
    cache.putFailure('c', { model: 'm', error: 'e', failedAt: Date.now() });
    expect(failureRows(cachePath)).toBe(2);
    expect(cache.getFailure('b')).not.toBeNull();
    expect(cache.getFailure('c')).not.toBeNull();
  });

  it('opens a cache file written before failures were remembered: its tables replay, and failures never count as tables', () => {
    const cachePath = path.join(tmpDir(), 'evidence-cache.db');
    // The schema and one row exactly as the previous release wrote them.
    const old = new Database(cachePath);
    old.exec(`CREATE TABLE evidence_cache (
      cache_key TEXT PRIMARY KEY, schema_version TEXT NOT NULL, model TEXT NOT NULL, question TEXT NOT NULL,
      sessions_json TEXT NOT NULL, items_json TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_used_at TEXT, hits INTEGER NOT NULL DEFAULT 0
    )`);
    old.prepare(`INSERT INTO evidence_cache VALUES ('k', 'evidence-v1', 'm', 'q', '[]', '[{"item":"a"}]', 10, 2, '2026-09-19T00:00:00.000Z', NULL, 0)`).run();
    old.close();

    const cache = new EvidenceCache(cachePath);
    openCaches.push(cache);
    expect(cache.get('k')?.items).toEqual([{ item: 'a' }]);
    expect(cache.getFailure('k')).toBeNull();
    cache.putFailure('other', { model: 'm', error: 'e', failedAt: Date.now() });
    expect(cache.stats()).toEqual({ entries: 1, hits: 1, promptTokens: 10, completionTokens: 2 });
  });
});

describe('with no evidence model configured nothing changes', () => {
  it('the same answer, no call, and no evidence cache file', async () => {
    const ws = workspace();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of EVIDENCE_PROVIDER_ENV) delete env[name];
    const options = resolveEvidenceToolOptions({ dbPath: path.join(ws.dir, 'index.db') }, env);
    expect(options.chat).toBeUndefined();
    const extractor = createEvidenceExtractor(options);
    expect(extractor).toBeNull();
    for (let i = 0; i < 2; i++) {
      const attached = await attachSearchEvidence({ query: QUERY, hits: ws.hits, vaultPath: ws.vault, options, extractor, enabled: true });
      expect(attached.hits).toEqual(ws.hits);
      expect(attached.evidence).toEqual({ status: 'skipped', reason: 'extractor-unavailable' });
    }
    expect(fs.existsSync(options.cachePath!)).toBe(false);
  });
});
