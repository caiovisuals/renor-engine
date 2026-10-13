import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { indexVault } from '../../src/indexer/pipeline';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import {
  CachingEmbeddingProvider,
  CountingEmbeddingProvider,
  describeEmbeddingCache,
  embeddingCallStats,
  invalidateEmbeddingCache,
} from '../../src/embeddings/caching';
import { LocalEmbeddingProvider } from '../../src/embeddings/local';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { EvalCache } from '../../src/eval/evalCache';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import {
  buildCacheReport,
  cacheHitRate,
  formatCacheReport,
  PER_RUN_EVIDENCE_BLOCKER,
  proxyWindow,
  readProxyCounters,
  UNCACHED_EMBEDDING_BLOCKER,
  UNCACHED_MODEL_BLOCKER,
  UNPINNED_SCOPE_BLOCKER,
} from '../../src/eval/cacheReport';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { runEvalCacheCommand } from '../../scripts/eval/eval-cache';
import { tmpPath } from '../helpers/tmpPath';

const DIMS = 8;

/** Deterministic stub: a vector derived from the text, with every provider call counted. */
function stubProvider(opts: { withQuery: boolean; dims?: number; model?: string }): EmbeddingProvider & { embedCalls: number; embeddedTexts: number; queryCalls: number } {
  const dims = opts.dims ?? DIMS;
  const vec = (text: string, salt: number) => Array.from({ length: dims }, (_, i) => ((text.length * (i + 3) + salt + text.charCodeAt(i % text.length)) % 31) / 31);
  const provider: EmbeddingProvider & { embedCalls: number; embeddedTexts: number; queryCalls: number } = {
    dimensions: dims,
    identity: { kind: 'stub', model: opts.model ?? 'model-a' },
    embedCalls: 0,
    embeddedTexts: 0,
    queryCalls: 0,
    async embed(texts: string[]) {
      provider.embedCalls += 1;
      provider.embeddedTexts += texts.length;
      return texts.map(t => vec(t, 0));
    },
  };
  if (opts.withQuery) {
    provider.embedQuery = async (text: string) => {
      provider.queryCalls += 1;
      return vec(text, 7);
    };
  }
  return provider;
}

function writeVault(root: string): string {
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const notes: Record<string, string> = {
    'a.md': '# Project Atlas\n\nAtlas ships the billing export on Fridays.\n\n## Owners\n\nPriya owns billing. Marco owns the exporter.\n',
    'b.md': '# Travel\n\nBooked the Lisbon trip for March 14. Hotel is near the river.\n',
    'c.md': '# Preferences\n\nPrefers dark roast coffee and window seats on long flights.\n',
  };
  for (const [name, body] of Object.entries(notes)) fs.writeFileSync(path.join(vault, name), body);
  return vault;
}

/** One full "retrieval eval case": index a fresh DB from the vault, then answer the queries. */
async function runCase(vault: string, provider: EmbeddingProvider, tag: string, queries: string[]): Promise<string[]> {
  const dbPath = tmpPath(`case-${tag}.db`);
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    vectorIndex.initTable();
    const stats = await indexVault(db, vault, { embeddingProvider: provider, vectorIndex, chunkOptions: { maxTokens: 400, overlapTokens: 50 } }, 2);
    expect(stats.errors).toBe(0);
    const out: string[] = [];
    for (const query of queries) {
      const result = await retrieveContext(db, vectorIndex, provider, query, 3, []);
      out.push(JSON.stringify(result.hits.map(h => [h.notePath.split('/').pop(), h.text])));
    }
    return out;
  } finally {
    db.close();
  }
}

const QUERIES = ['who owns billing', 'when is the Lisbon trip', 'what coffee do I like'];

describe('repeat eval runs cost nothing (stub provider, zero real calls)', () => {
  for (const withQuery of [true, false]) {
    it(`second identical retrieval run makes zero provider calls and returns identical hits (inner embedQuery: ${withQuery})`, async () => {
      const root = tmpPath(`repeat-${withQuery}`);
      fs.mkdirSync(root, { recursive: true });
      const vault = writeVault(root);
      const cachePath = path.join(root, 'embed-cache.db');

      const inner = stubProvider({ withQuery });
      const cold = new CachingEmbeddingProvider(inner, { cachePath });
      const first = await runCase(vault, cold, `cold-${withQuery}`, QUERIES);
      const callsAfterFirst = { embed: inner.embedCalls, query: inner.queryCalls };
      expect(callsAfterFirst.embed).toBeGreaterThan(0);
      cold.close();

      // Fresh process-equivalent: new wrapper, same cache file, fresh index DB.
      const warm = new CachingEmbeddingProvider(inner, { cachePath });
      const second = await runCase(vault, warm, `warm-${withQuery}`, QUERIES);
      expect(second).toEqual(first);
      expect({ embed: inner.embedCalls, query: inner.queryCalls }).toEqual(callsAfterFirst); // ZERO new provider calls
      expect(warm.stats.misses).toBe(0);
      expect(warm.stats.hits).toBeGreaterThan(0);
      expect(cacheHitRate(warm.stats)).toBe(1);
      warm.close();
    });
  }

  it('a query embedding is cached even when the inner provider has no embedQuery (OpenAI-compatible providers)', async () => {
    const inner = stubProvider({ withQuery: false });
    const cached = new CachingEmbeddingProvider(inner, { cachePath: tmpPath('noquery.db') });
    const v1 = await cached.embedQuery('same query');
    const v2 = await cached.embedQuery('same query');
    expect(v2).toEqual(Array.from(new Float32Array(v1))); // a hit is the Float32 copy of the provider vector
    expect(inner.embedCalls).toBe(1);
    cached.close();
  });

  it('keys pin the model: a provider that declares another model never replays', async () => {
    const cachePath = tmpPath('keys.db');
    const innerA = stubProvider({ withQuery: true, model: 'model-a' });
    const innerB = stubProvider({ withQuery: true, model: 'model-b' });
    const a = new CachingEmbeddingProvider(innerA, { cachePath });
    const b = new CachingEmbeddingProvider(innerB, { cachePath });
    await a.embed(['text']);
    await b.embed(['text']);
    expect(innerA.embeddedTexts).toBe(1);
    expect(innerB.embeddedTexts).toBe(1);
    a.close();
    b.close();
  });

  it('keys pin the dimensions on their own: one model at another width never replays a vector of the wrong size', async () => {
    const cachePath = tmpPath('dims.db');
    const narrow = new CachingEmbeddingProvider(stubProvider({ withQuery: true, dims: DIMS }), { cachePath });
    await narrow.embed(['text']);
    narrow.close();
    const wideInner = stubProvider({ withQuery: true, dims: DIMS * 2 });
    const wide = new CachingEmbeddingProvider(wideInner, { cachePath });
    const [vector] = await wide.embed(['text']);
    expect(vector).toHaveLength(DIMS * 2);
    expect(wideInner.embeddedTexts).toBe(1); // a miss, not a wrong-sized replay
    wide.close();
    // the width in the namespace is the provider's own, never a label a caller typed
    expect(describeEmbeddingCache(cachePath)).toEqual([
      { namespace: `stub/model-a/${DIMS * 2}`, rows: 1 }, // listed by namespace string: '16' sorts before '8'
      { namespace: `stub/model-a/${DIMS}`, rows: 1 },
    ]);
  });
});

describe('invalidation', () => {
  it('invalidating an embedding namespace forces the next run to re-call the provider; other namespaces survive', async () => {
    const cachePath = tmpPath('inval-embed.db');
    const innerA = stubProvider({ withQuery: true, model: 'model-a' });
    const innerB = stubProvider({ withQuery: true, model: 'model-b' });
    const a = new CachingEmbeddingProvider(innerA, { cachePath });
    const b = new CachingEmbeddingProvider(innerB, { cachePath });
    await a.embed(['one', 'two']);
    await b.embed(['one']);
    a.close();
    b.close();

    expect(describeEmbeddingCache(cachePath)).toEqual([
      { namespace: `stub/model-a/${DIMS}`, rows: 2 },
      { namespace: `stub/model-b/${DIMS}`, rows: 1 },
    ]);
    expect(invalidateEmbeddingCache(cachePath, { namespace: `stub/model-a/${DIMS}` })).toBe(2);
    expect(describeEmbeddingCache(cachePath)).toEqual([{ namespace: `stub/model-b/${DIMS}`, rows: 1 }]);

    const beforeA = innerA.embeddedTexts;
    const again = new CachingEmbeddingProvider(innerA, { cachePath });
    await again.embed(['one', 'two']);
    expect(innerA.embeddedTexts).toBe(beforeA + 2); // model-a was invalidated: the provider is called again
    again.close();
    const beforeB = innerB.embeddedTexts;
    const keep = new CachingEmbeddingProvider(innerB, { cachePath });
    await keep.embed(['one']);
    expect(innerB.embeddedTexts).toBe(beforeB); // model-b is still cached
    keep.close();
  });

  it('refuses an unscoped invalidation: wiping everything must be explicit', () => {
    const cachePath = tmpPath('inval-refuse.db');
    new CachingEmbeddingProvider(stubProvider({ withQuery: true }), { cachePath }).close();
    expect(() => invalidateEmbeddingCache(cachePath, {})).toThrow(/namespace|all/i);
    expect(() => new EvalCache(tmpPath('inval-refuse-eval.db')).invalidate({})).toThrow(/providerNamespace|callType|all/i);
  });

  it('invalidates eval-cache model-call rows by provider namespace, call type, or all', () => {
    const cache = new EvalCache(tmpPath('inval-eval.db'));
    const put = (ns: string, callType: 'answer' | 'judge', n: number) => {
      const requestBody = { model: ns, n };
      cache.put({
        cacheKey: EvalCache.computeKey(ns, requestBody), providerNamespace: ns, callType, questionId: `q${n}`,
        rawContent: 'x', modelEcho: ns, finishReason: 'stop', promptTokens: 1, completionTokens: 1, latencyMs: 1, requestBody,
      });
    };
    put('p#m1', 'answer', 1);
    put('p#m1', 'judge', 2);
    put('p#m2', 'answer', 3);
    expect(cache.rowCount()).toBe(3);
    expect(cache.invalidate({ providerNamespace: 'p#m1', callType: 'judge' })).toBe(1);
    expect(cache.invalidate({ providerNamespace: 'p#m2' })).toBe(1);
    expect(cache.rowCount()).toBe(1);
    expect(cache.invalidate({ all: true })).toBe(1);
    expect(cache.rowCount()).toBe(0);
    cache.close();
  });
});

describe('cache hit-rate report', () => {
  const evalCache = { answerHits: 5, answerMisses: 5, judgeHits: 0, judgeMisses: 10 };

  it('computes per-layer hit rates and names every reason an identical repeat run would still miss', () => {
    expect(cacheHitRate({ hits: 0, misses: 0 })).toBeNull();
    expect(cacheHitRate({ hits: 3, misses: 1 })).toBe(0.75);

    // 100 lookups: 90 hits, 10 misses of which only 8 texts (in 4 calls) were sent, because a text repeated in a batch is sent once
    const report = buildCacheReport({ embedding: { hits: 90, misses: 10, sent: { texts: 8, calls: 4 } }, evidence: { hits: 3, misses: 7 }, evalCache });
    expect(report.embedding).toEqual({ hits: 90, misses: 10, hitRate: 0.9 });
    expect(report.embeddingSent).toEqual({ texts: 8, calls: 4 });
    expect(report.evidence).toEqual({ hits: 3, misses: 7, hitRate: 0.3 });
    expect(report.answer).toEqual({ hits: 5, misses: 5, hitRate: 0.5 });
    expect(report.judge).toEqual({ hits: 0, misses: 10, hitRate: 0 });
    expect(report.liveProviderCalls).toBe(4 + 7 + 5 + 10);
    expect(report.repeatRunBlockers).toEqual([PER_RUN_EVIDENCE_BLOCKER, UNPINNED_SCOPE_BLOCKER]);
    const text = formatCacheReport(report);
    expect(text).toMatch(/embedding 90\/100 \(90\.0%\), 8 texts in 4 calls \| evidence 3\/10 \(30\.0%\) \| answer 5\/10 \(50\.0%\) \| judge 0\/10 \(0\.0%\) \| live provider calls 26/);
    expect(text).toMatch(/a repeat run will miss: .*RENOR_QA_CACHE_SCOPE/);
    expect(text).toMatch(/a repeat run will miss: .*RENOR_EVIDENCE_CACHE/);
  });

  it('is silent about replay when every layer in use can replay, and never claims "no caches" falsely', () => {
    const replayable = buildCacheReport({ embedding: { hits: 1, misses: 0 }, evidence: { hits: 1, misses: 0 }, evidenceCacheShared: true, evalCache, pinnedScope: true });
    expect(replayable.repeatRunBlockers).toEqual([]);
    expect(formatCacheReport(replayable)).not.toMatch(/repeat run will miss/);
    // an embedding-only run has no model-call layer to block anything, and a layer with no lookups blocks nothing
    expect(buildCacheReport({ embedding: { hits: 1, misses: 0 } }).repeatRunBlockers).toEqual([]);
    const idle = buildCacheReport({ evidence: { hits: 0, misses: 0 }, evalCache: { answerHits: 0, answerMisses: 0, judgeHits: 0, judgeMisses: 0 } });
    expect(idle.repeatRunBlockers).toEqual([]);
    expect(formatCacheReport(buildCacheReport({}))).toBe('[cache] no caches in use | live provider calls 0');
  });

  it('counts health probes beside live calls, so a fully replayed run is not reported as making no provider calls', () => {
    const replay = buildCacheReport({ evalCache: { answerHits: 4, answerMisses: 0, judgeHits: 4, judgeMisses: 0 }, pinnedScope: true, healthProbes: 3 });
    expect(replay.liveProviderCalls).toBe(0);
    expect(replay.healthProbeCalls).toBe(3);
    expect(formatCacheReport(replay)).toMatch(/live provider calls 0 \(\+3 health probes, never cached\)/);
    expect(formatCacheReport(buildCacheReport({ embedding: { hits: 1, misses: 0 } }))).not.toMatch(/health probes/);
  });
});

describe('shared embed-proxy window', () => {
  const lifetime = { startedAt: '2026-09-21T00:00:00.000Z', cacheHits: 900, cacheMisses: 100 };

  it('a run owns only the change in the proxy counters, not the proxy lifetime totals', () => {
    expect(proxyWindow(lifetime, { ...lifetime, cacheHits: 908, cacheMisses: 102 })).toEqual({ hits: 8, misses: 2 });
    expect(proxyWindow(lifetime, lifetime)).toEqual({ hits: 0, misses: 0 }); // a fully idle window is zero, not unknown
    // a proxy that counts what it sent upstream: the window carries that too (1 text in 1 call for 2 lookup misses)
    const counting = { ...lifetime, upstreamTexts: 100, upstreamCalls: 40 };
    expect(proxyWindow(counting, { ...counting, cacheHits: 908, cacheMisses: 102, upstreamTexts: 101, upstreamCalls: 41 }))
      .toEqual({ hits: 8, misses: 2, sent: { texts: 1, calls: 1 } });
    expect(proxyWindow(null, { ...counting, upstreamTexts: 5, upstreamCalls: 2 })).toMatchObject({ sent: { texts: 5, calls: 2 } });
    // counters missing on either side (a proxy that predates them) mean the sent figures are unknown, never zero
    expect(proxyWindow(lifetime, { ...counting, cacheHits: 908 })?.sent).toBeUndefined();
    expect(proxyWindow(counting, { ...lifetime, cacheHits: 908 })?.sent).toBeUndefined();
    expect(proxyWindow(null, { ...lifetime, cacheHits: 5, cacheMisses: 1 })).toEqual({ hits: 5, misses: 1 }); // proxy started with this run
    expect(proxyWindow(lifetime, null)).toBeUndefined();
  });

  it('is unknown when the proxy restarted mid-run, because its counters were reset', () => {
    expect(proxyWindow(lifetime, { startedAt: '2026-09-21T05:00:00.000Z', cacheHits: 3, cacheMisses: 0 })).toBeUndefined();
  });

  it('reads counters from the stats file and ignores a missing or malformed one', () => {
    const file = tmpPath('proxy-stats.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    expect(readProxyCounters(undefined)).toBeNull();
    expect(readProxyCounters(file)).toBeNull();
    fs.writeFileSync(file, '{ not json');
    expect(readProxyCounters(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ cacheHits: 'x', cacheMisses: 1 }));
    expect(readProxyCounters(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...lifetime, requests: 12 }));
    expect(readProxyCounters(file)).toEqual(lifetime);
    fs.writeFileSync(file, JSON.stringify({ ...lifetime, upstreamTexts: 7, upstreamCalls: 3 }));
    expect(readProxyCounters(file)).toEqual({ ...lifetime, upstreamTexts: 7, upstreamCalls: 3 });
    fs.writeFileSync(file, JSON.stringify({ ...lifetime, upstreamTexts: 'x', upstreamCalls: 3 }));
    expect(readProxyCounters(file)).toEqual(lifetime); // a malformed sent counter is ignored, not trusted
  });
});

describe('eval-cache CLI', () => {
  it('reports and invalidates both caches by explicit selector, and refuses a bare invalidate', async () => {
    const embedDb = tmpPath('cli-embed.db');
    const evalDb = tmpPath('cli-eval.db');
    const inner = stubProvider({ withQuery: true });
    const e = new CachingEmbeddingProvider(inner, { cachePath: embedDb });
    await e.embed(['one', 'two']);
    e.close();
    const cache = new EvalCache(evalDb);
    const requestBody = { model: 'm' };
    cache.put({ cacheKey: EvalCache.computeKey('p#m', requestBody), providerNamespace: 'p#m', callType: 'judge', questionId: 'q', rawContent: '1', modelEcho: 'm', finishReason: 'stop', promptTokens: 1, completionTokens: 1, latencyMs: 1, requestBody });
    cache.close();

    const dbs = ['--embed-db', embedDb, '--eval-db', evalDb];
    const stats = runEvalCacheCommand(['stats', ...dbs]);
    expect(stats).toMatch(new RegExp(`stub/model-a/${DIMS}: 2 vectors`));
    expect(stats).toMatch(/p#m \[judge\]: 1 responses/);
    expect(() => runEvalCacheCommand(['invalidate', ...dbs])).toThrow(/needs --embedding-namespace/);
    expect(runEvalCacheCommand(['invalidate', '--embedding-namespace', `stub/model-a/${DIMS}`, ...dbs])).toMatch(/vectors removed: 2/);
    expect(runEvalCacheCommand(['invalidate', '--eval-provider', 'p#m', '--call-type', 'judge', ...dbs])).toMatch(/responses removed: 1/);
    expect(runEvalCacheCommand(['stats', ...dbs])).not.toMatch(/vectors|responses/);
  });

  it('never creates a cache as a side effect, and refuses a --call-type that would not narrow anything', () => {
    const dbs = ['--embed-db', tmpPath('cli-missing-embed.db'), '--eval-db', tmpPath('cli-missing-eval.db')];
    expect(runEvalCacheCommand(['stats', ...dbs])).toMatch(/model-call cache/);
    expect(runEvalCacheCommand(['invalidate', '--all', ...dbs])).toMatch(/embedding vectors removed: 0\nmodel-call responses removed: 0/);
    expect(fs.existsSync(dbs[1])).toBe(false);
    expect(fs.existsSync(dbs[3])).toBe(false);
    // `--all --call-type judge` reads as narrow but would drop everything: it is refused instead.
    expect(() => runEvalCacheCommand(['invalidate', '--all', '--call-type', 'judge', ...dbs])).toThrow(/pass both/);
    expect(() => runEvalCacheCommand(['invalidate', '--embedding-namespace', 'a/b/1', '--call-type', 'judge', ...dbs])).toThrow(/pass both/);
  });

  it('prints usage for --help and a readable error for a bad command', () => {
    expect(runEvalCacheCommand(['--help'])).toMatch(/stats[\s\S]*invalidate/);
    expect(() => runEvalCacheCommand(['nonsense'])).toThrow(/unknown command/i);
  });
});

describe('Vertex embedding path: second identical run makes zero Vertex calls (stubbed transport)', () => {
  it('the real VertexEmbeddingProvider behind the default cache is never contacted on a repeat run', async () => {
    const root = tmpPath('vertex-repeat');
    fs.mkdirSync(root, { recursive: true });
    const vault = writeVault(root);
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const keyFile = path.join(root, 'sa.json');
    fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'stub@example.invalid', private_key: privateKey, token_uri: 'https://oauth.stub.invalid/token' }));

    const seen: Array<{ url: string; taskTypes: string[] }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url === 'https://oauth.stub.invalid/token') {
        seen.push({ url, taskTypes: [] });
        return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), { status: 200 });
      }
      if (url.startsWith('https://europe-west4-aiplatform.googleapis.com/')) {
        const instances = (JSON.parse(String(init?.body)) as { instances: Array<{ content: string; task_type: string }> }).instances;
        seen.push({ url, taskTypes: instances.map(i => i.task_type) });
        const predictions = instances.map(i => ({ embeddings: { values: Array.from({ length: 768 }, (_, k) => ((i.content.length + k) % 17) / 17), statistics: { token_count: 3 } } }));
        return new Response(JSON.stringify({ predictions }), { status: 200 });
      }
      throw new Error(`unexpected network call in test: ${url}`);
    }) as typeof fetch;

    try {
      const cachePath = path.join(root, 'embed-cache.db');
      const makeRun = () => {
        const vertex = new VertexEmbeddingProvider({ keyFile, project: 'stub-project', location: 'europe-west4', model: 'gemini-embedding-001', dimensions: 768 });
        return { vertex, cached: new CachingEmbeddingProvider(vertex, { cachePath }) };
      };

      const first = makeRun();
      const hitsFirst = await runCase(vault, first.cached, 'vertex-cold', QUERIES);
      const coldCalls = seen.length;
      expect(coldCalls).toBeGreaterThan(1);
      expect(seen.some(c => c.taskTypes.includes('RETRIEVAL_QUERY'))).toBe(true);
      expect(seen.some(c => c.taskTypes.includes('RETRIEVAL_DOCUMENT'))).toBe(true);
      first.cached.close();

      const second = makeRun();
      const hitsSecond = await runCase(vault, second.cached, 'vertex-warm', QUERIES);
      expect(hitsSecond).toEqual(hitsFirst);
      expect(seen.length).toBe(coldCalls); // zero token exchanges, zero predict calls
      expect(second.vertex.usage.requests).toBe(0);
      expect(cacheHitRate(second.cached.stats)).toBe(1);
      second.cached.close();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

const ENGINE_ROOT = path.resolve(__dirname, '../..');

/** An OpenAI-compatible /v1/embeddings endpoint serving the eval-hash stub's vectors, counting every request. */
async function startEmbeddingEndpoint(): Promise<{ baseUrl: string; calls: { requests: number; inputs: number }; close(): Promise<void> }> {
  const hash = new EvalHashEmbeddingProvider();
  const calls = { requests: 0, inputs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      void (async () => {
        const { input, encoding_format: encoding } = JSON.parse(body) as { input: string | string[]; encoding_format?: string };
        const texts = Array.isArray(input) ? input : [input];
        calls.requests += 1;
        calls.inputs += texts.length;
        const vectors = await hash.embed(texts);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          model: 'stub-eval-hash',
          data: vectors.map((vector, index) => ({
            object: 'embedding',
            index,
            embedding: encoding === 'base64' ? Buffer.from(new Float32Array(vector).buffer).toString('base64') : vector,
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }));
      })();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Run the real RenorBench retrieval runner as a child process (async: the endpoint above lives in this process). */
function runRenorBench(cases: string, output: string, env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A whitelisted environment: no ambient key or provider setting can leak a real call into the test.
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/eval/run-renorbench.ts', '--provider', 'openai', '--allow-dirty', '--cases', cases, '--output', output], {
      cwd: ENGINE_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

const retrievedHits = (output: string): Array<[string, unknown]> =>
  fs.readFileSync(path.join(output, 'results.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { id: string; hits: unknown })
    .map(row => [row.id, row.hits]);

describe('the real RenorBench runner against a stub provider endpoint', () => {
  it('a second identical run makes zero provider calls, returns identical hits, and an invalidation makes the third run pay again', async () => {
    const endpoint = await startEmbeddingEndpoint();
    const root = tmpPath('runner-e2e');
    fs.mkdirSync(root, { recursive: true });
    const cachePath = path.join(root, 'embed-cache.db');
    // Every 16th dev case: a fixed 12-case slice across categories keeps the three real runs fast.
    const cases = path.join(root, 'cases.jsonl');
    const devCases = fs.readFileSync(path.join(ENGINE_ROOT, 'docs/evals/renorbench-v1.dev.jsonl'), 'utf8').trim().split('\n');
    fs.writeFileSync(cases, devCases.filter((_, index) => index % 16 === 0).join('\n') + '\n');
    const env = {
      RENOR_EVAL_EMBEDDING_BASE_URL: endpoint.baseUrl,
      RENOR_EVAL_EMBEDDING_API_KEY: 'stub-key',
      RENOR_EVAL_MODEL: 'stub-eval-hash',
      RENOR_EVAL_EMBEDDING_DIMS: '256',
      RENOR_EVAL_EMBED_CACHE: cachePath,
    };
    const report = (output: string) => JSON.parse(fs.readFileSync(path.join(output, 'cache-report.json'), 'utf8'));
    try {
      const [cold, warm, repaid] = [path.join(root, 'cold'), path.join(root, 'warm'), path.join(root, 'repaid')];

      const first = await runRenorBench(cases, cold, env);
      expect(first.code, first.stderr).toBe(0);
      const coldCalls = { ...endpoint.calls };
      expect(coldCalls.inputs).toBeGreaterThan(0);
      expect(report(cold).embedding.misses).toBeGreaterThan(0);
      // the report equals what the endpoint received: every text, and no more calls than HTTP requests
      expect(report(cold).embeddingSent.texts).toBe(coldCalls.inputs);
      expect(report(cold).embeddingSent.calls).toBeGreaterThan(0);
      expect(report(cold).embeddingSent.calls).toBeLessThanOrEqual(coldCalls.requests);
      expect(report(cold).liveProviderCalls).toBe(report(cold).embeddingSent.calls);

      const second = await runRenorBench(cases, warm, env);
      expect(second.code, second.stderr).toBe(0);
      expect(endpoint.calls).toEqual(coldCalls); // ZERO provider requests in the identical second run
      expect(report(warm)).toMatchObject({ embedding: { misses: 0, hitRate: 1 }, embeddingSent: { texts: 0, calls: 0 }, liveProviderCalls: 0, repeatRunBlockers: [] });
      expect(second.stderr).toMatch(/\[cache\] embedding (\d+)\/\1 \(100\.0%\), 0 texts in 0 calls \| live provider calls 0/);
      expect(retrievedHits(warm)).toEqual(retrievedHits(cold)); // replay changes no retrieval result

      expect(runEvalCacheCommand(['invalidate', '--embedding-namespace', 'openai/stub-eval-hash/256', '--embed-db', cachePath])).toMatch(/vectors removed: [1-9]/);
      const third = await runRenorBench(cases, repaid, env);
      expect(third.code, third.stderr).toBe(0);
      expect(endpoint.calls.inputs).toBeGreaterThan(coldCalls.inputs); // the provider is called again after invalidation
      expect(report(repaid).embedding.misses).toBeGreaterThan(0);
      expect(report(repaid).embeddingSent.texts).toBe(endpoint.calls.inputs - coldCalls.inputs); // exactly this run's share
      expect(retrievedHits(repaid)).toEqual(retrievedHits(cold));
    } finally {
      await endpoint.close();
    }
  }, 180_000);
});

describe('the embedding cache counts what reached the provider, not lookup misses', () => {
  it('an empty batch never reaches the provider, so the counter and the real call boundary agree', async () => {
    let actual = 0;
    const inner: EmbeddingProvider = { dimensions: 3, embed: async (texts: string[]) => { actual += 1; return texts.map(() => [0, 0, 0]); } };
    const counting = new CountingEmbeddingProvider(inner);
    expect(await counting.embed([])).toEqual([]);
    // the review's repro had the provider invoked once while the report said zero calls
    expect({ actual, sent: counting.callStats.sent }).toEqual({ actual: 0, sent: { texts: 0, calls: 0 } });
    await counting.embed(['a']);
    expect({ actual, sent: counting.callStats.sent }).toEqual({ actual: 1, sent: { texts: 1, calls: 1 } });
  });

  for (const withQuery of [true, false]) {
    it(`both wrappers report exactly what the wrapped provider received after every step of a mixed sequence with empty batches (inner embedQuery: ${withQuery})`, async () => {
      const steps: Array<{ batch?: string[]; query?: string }> = [
        { batch: [] }, { batch: ['a'] }, { batch: ['a', 'a'] }, { batch: [] }, { query: 'q' },
        { batch: ['b', 'a', 'b'] }, { query: 'q' }, { batch: [] }, { batch: ['c', 'c', 'c'] },
      ];
      const innerCached = stubProvider({ withQuery });
      const innerCounted = stubProvider({ withQuery });
      const cached = new CachingEmbeddingProvider(innerCached, { cachePath: tmpPath(`sequence-${withQuery}.db`) });
      const counting = new CountingEmbeddingProvider(innerCounted);
      for (const step of steps) {
        for (const [wrapper, inner] of [[cached, innerCached], [counting, innerCounted]] as const) {
          if (step.query !== undefined) await wrapper.embedQuery(step.query);
          else await wrapper.embed(step.batch!);
          // `sent` is the provider's own view: texts it was handed and times it was invoked
          expect({ texts: wrapper.callStats.sent.texts, calls: wrapper.callStats.sent.calls })
            .toEqual({ texts: inner.embeddedTexts + inner.queryCalls, calls: inner.embedCalls + inner.queryCalls });
        }
      }
      cached.close();
    });
  }

  it('a text repeated inside one batch is sent once: lookups keep their miss count, the sent counter does not', async () => {
    const batches: string[][] = [];
    const inner = stubProvider({ withQuery: true });
    const embed = inner.embed.bind(inner);
    inner.embed = async (texts: string[]) => { batches.push([...texts]); return embed(texts); };
    const cached = new CachingEmbeddingProvider(inner, { cachePath: tmpPath('dup.db') });

    await cached.embed(['same', 'same']);
    expect(batches).toEqual([['same']]); // the provider received one text in one call
    expect(cached.stats).toEqual({ hits: 0, misses: 2 }); // lookups: both occurrences missed
    expect(embeddingCallStats(cached)).toEqual({ hits: 0, misses: 2, cached: true, sent: { texts: 1, calls: 1 } });

    const report = buildCacheReport({ embedding: embeddingCallStats(cached) });
    expect(report.liveProviderCalls).toBe(1); // the second review's repro reported 2
    expect(report.embeddingSent).toEqual({ texts: 1, calls: 1 });
    expect(report.embedding).toEqual({ hits: 0, misses: 2, hitRate: 0 });
    cached.close();
  });

  for (const withQuery of [true, false]) {
    it(`counts a mixed batch and a query by what was sent, and equals what the provider received (inner embedQuery: ${withQuery})`, async () => {
      const inner = stubProvider({ withQuery });
      const cached = new CachingEmbeddingProvider(inner, { cachePath: tmpPath(`mixed-${withQuery}.db`) });
      await cached.embed(['b']); // 1 text in 1 call
      await cached.embed(['a', 'b', 'a', 'c']); // 'b' hits; 'a' twice and 'c' miss: 2 unique texts in 1 call
      expect(cached.stats).toEqual({ hits: 1, misses: 4 });
      expect(embeddingCallStats(cached)!.sent).toEqual({ texts: 3, calls: 2 });

      await cached.embedQuery('q'); // a miss: 1 text in 1 call (through embed() when the provider has no embedQuery)
      await cached.embedQuery('q'); // a hit: nothing sent
      await cached.embed([]); // an empty batch is no call
      expect(embeddingCallStats(cached)!.sent).toEqual({ texts: 4, calls: 3 });
      expect(inner.embeddedTexts + inner.queryCalls).toBe(4); // exactly what the provider received
      expect(inner.embedCalls + inner.queryCalls).toBe(3);
      cached.close();
    });
  }
});

describe('the report counts the calls a run actually made, cached or not', () => {
  it('uses the runner\'s own live-call count, with a cache off and when a retry made a call without a lookup', () => {
    // cache off: there is no counter to read misses from, yet four calls reached the provider
    const off = buildCacheReport({ liveModelCalls: 4, healthProbes: 2 });
    expect(off.liveProviderCalls).toBe(4);
    expect(off.uncached).toEqual({ model: 4 });
    expect(off.repeatRunBlockers).toEqual([UNCACHED_MODEL_BLOCKER]);
    expect(formatCacheReport(off)).toMatch(/answer\/judge uncached 4 \| live provider calls 4 \(\+2 health probes, never cached\)/);
    expect(formatCacheReport(off)).toMatch(/a repeat run will miss: .*eval cache off/);

    // cache on: a forced-live retry skips the lookup, so the runner's count is the one that is true
    const on = buildCacheReport({ evalCache: { answerHits: 0, answerMisses: 1, judgeHits: 0, judgeMisses: 1 }, liveModelCalls: 4, pinnedScope: true });
    expect(on.liveProviderCalls).toBe(4);
    expect(on.uncached).toBeUndefined();
    expect(on.repeatRunBlockers).toEqual([]);

    // a run that made no model calls stays quiet
    expect(buildCacheReport({ liveModelCalls: 0 }).repeatRunBlockers).toEqual([]);
  });

  it('counts embedding calls that no cache stood in front of, instead of printing "no caches in use ... 0"', () => {
    const off = buildCacheReport({ embedding: { hits: 0, misses: 242, cached: false, sent: { texts: 242, calls: 218 } } });
    expect(off.embedding).toBeUndefined();
    expect(off.embeddingSent).toEqual({ texts: 242, calls: 218 });
    expect(off.uncached).toEqual({ embedding: 218 });
    expect(off.liveProviderCalls).toBe(218);
    expect(off.repeatRunBlockers).toEqual([UNCACHED_EMBEDDING_BLOCKER]);
    expect(formatCacheReport(off)).toBe(`[cache] embedding uncached, 242 texts in 218 calls | live provider calls 218\n[cache] a repeat run will miss: ${UNCACHED_EMBEDDING_BLOCKER}`);

    // a cached layer is unchanged by the new field, and an uncached run that embedded nothing blocks nothing
    expect(buildCacheReport({ embedding: { hits: 3, misses: 1, cached: true } }).embedding).toEqual({ hits: 3, misses: 1, hitRate: 0.75 });
    expect(buildCacheReport({ embedding: { hits: 0, misses: 0, cached: false, sent: { texts: 0, calls: 0 } } }).repeatRunBlockers).toEqual([]);
  });

  it('counts the embedding calls a cached run made from what was sent, and says so when only lookup misses are known', () => {
    // 2 lookups missed but one text went out once: the review's repro reported 2 live calls here
    const dup = buildCacheReport({ embedding: { hits: 0, misses: 2, cached: true, sent: { texts: 1, calls: 1 } } });
    expect(dup.liveProviderCalls).toBe(1);
    expect(dup.embeddingSent).toEqual({ texts: 1, calls: 1 });
    expect(dup.embedding).toEqual({ hits: 0, misses: 2, hitRate: 0 }); // the hit rate stays a lookup rate
    expect(dup.embeddingCallsUpperBound).toBeUndefined();
    expect(formatCacheReport(dup)).toBe('[cache] embedding 0/2 (0.0%), 1 text in 1 call | live provider calls 1');

    // a fully replayed run sent nothing
    expect(formatCacheReport(buildCacheReport({ embedding: { hits: 118, misses: 0, sent: { texts: 0, calls: 0 } } })))
      .toBe('[cache] embedding 118/118 (100.0%), 0 texts in 0 calls | live provider calls 0');

    // an embed-proxy that predates the sent counters: the lookup misses are an upper bound, flagged instead of presented as exact
    const old = buildCacheReport({ embedding: { hits: 8, misses: 2 } });
    expect(old.liveProviderCalls).toBe(2);
    expect(old.embeddingSent).toBeUndefined();
    expect(old.embeddingCallsUpperBound).toBe(true);
    expect(formatCacheReport(old)).toBe('[cache] embedding 8/10 (80.0%), calls counted as lookup misses (upper bound) | live provider calls 2');
  });

  for (const withQuery of [true, false]) {
    it(`CountingEmbeddingProvider returns the provider's vectors untouched and counts every text it is asked for (inner embedQuery: ${withQuery})`, async () => {
      const inner = stubProvider({ withQuery });
      const reference = stubProvider({ withQuery });
      const counting = new CountingEmbeddingProvider(inner);
      expect(counting.dimensions).toBe(DIMS);
      expect(counting.identity).toEqual(inner.identity);

      const docs = await counting.embed(['a', 'b', 'a']);
      const query = await counting.embedQuery('q');
      expect(docs).toEqual(await reference.embed(['a', 'b', 'a']));
      expect(query).toEqual(withQuery ? await reference.embedQuery!('q') : (await reference.embed(['q']))[0]);

      expect(counting.callStats).toEqual({ hits: 0, misses: 4, cached: false, sent: { texts: 4, calls: 2 } });
      expect(inner.embeddedTexts + inner.queryCalls).toBe(4); // what the provider really received
      expect(inner.embedCalls + inner.queryCalls).toBe(counting.callStats.sent.calls);
      expect(embeddingCallStats(counting)).toEqual(counting.callStats);

      // nothing is deduplicated on this path, so a repeated text is sent twice and counted twice
      await counting.embed(['x', 'x']);
      expect(counting.callStats.sent).toEqual({ texts: 6, calls: 3 });

      // an empty batch never reaches the provider (checked against the provider's own counters), so it is no call
      const reached = { embedCalls: inner.embedCalls, embeddedTexts: inner.embeddedTexts };
      expect(await counting.embed([])).toEqual([]);
      expect({ embedCalls: inner.embedCalls, embeddedTexts: inner.embeddedTexts }).toEqual(reached);
      expect(counting.callStats.sent).toEqual({ texts: 6, calls: 3 });
      expect(inner.embedCalls + inner.queryCalls).toBe(counting.callStats.sent.calls);
    });
  }

  it('embeddingCallStats reads the cache counters when a cache stood in front, and nothing for a bare provider', async () => {
    const cached = new CachingEmbeddingProvider(stubProvider({ withQuery: true }), { cachePath: tmpPath('callstats.db') });
    await cached.embed(['x', 'x']);
    await cached.embed(['x']);
    expect(embeddingCallStats(cached)).toEqual({ hits: 1, misses: 2, cached: true, sent: { texts: 1, calls: 1 } }); // 'x' twice in one batch: 2 misses, 1 text sent
    cached.close();
    expect(embeddingCallStats(stubProvider({ withQuery: true }))).toBeUndefined();
  });

  it('the real RenorBench runner with the embedding cache off reports every text its provider received', async () => {
    const endpoint = await startEmbeddingEndpoint();
    const root = tmpPath('runner-cache-off');
    fs.mkdirSync(root, { recursive: true });
    const cases = path.join(root, 'cases.jsonl');
    const devCases = fs.readFileSync(path.join(ENGINE_ROOT, 'docs/evals/renorbench-v1.dev.jsonl'), 'utf8').trim().split('\n');
    fs.writeFileSync(cases, devCases.filter((_, index) => index % 16 === 0).join('\n') + '\n');
    const output = path.join(root, 'out');
    try {
      const run = await runRenorBench(cases, output, {
        RENOR_EVAL_EMBEDDING_BASE_URL: endpoint.baseUrl,
        RENOR_EVAL_EMBEDDING_API_KEY: 'stub-key',
        RENOR_EVAL_MODEL: 'stub-eval-hash',
        RENOR_EVAL_EMBEDDING_DIMS: '256',
        RENOR_EVAL_EMBED_CACHE: 'off',
      });
      expect(run.code, run.stderr).toBe(0);
      const report = JSON.parse(fs.readFileSync(path.join(output, 'cache-report.json'), 'utf8'));
      expect(endpoint.calls.inputs).toBeGreaterThan(0);
      expect(report.embeddingSent.texts).toBe(endpoint.calls.inputs); // not "0": the provider received that many texts
      expect(report.liveProviderCalls).toBe(report.embeddingSent.calls);
      expect(report.embeddingSent.calls).toBeLessThanOrEqual(endpoint.calls.requests);
      expect(report).toMatchObject({ uncached: { embedding: report.embeddingSent.calls }, healthProbeCalls: 0, repeatRunBlockers: [UNCACHED_EMBEDDING_BLOCKER] });
      expect(report.embedding).toBeUndefined();
      expect(run.stderr).toMatch(/\[cache\] embedding uncached, \d+ texts? in \d+ calls? \| live provider calls \d+/);
    } finally {
      await endpoint.close();
    }
  }, 120_000);
});

/** An OpenAI-compatible /chat/completions endpoint that answers health probes as the runners expect, counting every request. */
async function startChatEndpoint(): Promise<{ baseUrl: string; calls: { total: number }; close(): Promise<void> }> {
  const calls = { total: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.total += 1;
      const request = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
      const last = request.messages[request.messages.length - 1].content;
      const content = /Reply with exactly OK/.test(last) ? 'OK' : request.model === 'stub-judge' ? '1' : 'mango juice';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: request.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/**
 * Run the real LongMemEval QA runner as a child process against the endpoint above. The stub URL is a required
 * argument and is also the env default of --base-url, so the runner can never fall back to its real default endpoint.
 * The run ledger is a file beside the outputs, never the machine's shared one (src/eval/runLedger.ts).
 */
function runQa(baseUrl: string, runDir: string, output: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/eval/run-longmemeval-qa.ts', '--run', runDir, '--output', output,
      '--base-url', baseUrl, '--answer-model', 'stub-answer', '--judge-model', 'stub-judge', '--api-key-env', 'STUB_QA_KEY', '--retries', '1', ...args], {
      cwd: ENGINE_ROOT,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', STUB_QA_KEY: 'stub-key', RENOR_QA_BASE_URL: baseUrl,
        RENOR_EVAL_RUN_LEDGER: path.join(path.dirname(output), 'run-ledger.jsonl'), ...env,
      },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

describe('the real QA runner accounts for every request its provider received', () => {
  it('live calls plus health probes equal the requests served, with a cache, on replay, and with the cache off', async () => {
    const endpoint = await startChatEndpoint();
    const root = tmpPath('qa-e2e');
    const runDir = path.join(root, 'retrieval');
    fs.mkdirSync(runDir, { recursive: true });
    // A minimal completed retrieval run: two cases, one excerpt each.
    const caseRows = ['c1', 'c2'].map(id => ({ id, category: 'stable_fact', query: `What does ${id} drink?`, relevant: [], expectedAnswer: 'mango juice', shouldAbstain: false }));
    const resultRows = caseRows.map(row => ({ id: row.id, hits: [{ text: `${row.id} drinks mango juice every morning.`, notePath: `People/${row.id}.md`, score: 1 }], latencyMs: 1, contextTokens: 9 }));
    fs.writeFileSync(path.join(runDir, 'cases.jsonl'), caseRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(runDir, 'results.jsonl'), resultRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(runDir, 'manifest.json'), '{}\n');
    const cacheDb = path.join(root, 'eval-cache.db');
    const pinned = { RENOR_QA_CACHE_SCOPE: 'qa-e2e-honesty' };
    const report = (output: string) => JSON.parse(fs.readFileSync(path.join(output, 'cache-report.json'), 'utf8'));
    try {
      // 1. cold, pinned scope: 2 answers + 2 judges live; probes before (1 answerer + 1 judge key) and again before promoting
      let before = endpoint.calls.total;
      const first = await runQa(endpoint.baseUrl, runDir, path.join(root, 'cold'), ['--cache-dir', cacheDb], pinned);
      expect(first.code, first.stderr).toBe(0);
      expect(report(path.join(root, 'cold'))).toMatchObject({ liveProviderCalls: 4, healthProbeCalls: 4 });
      expect(endpoint.calls.total - before).toBe(8); // 4 live + 4 probes: nothing unaccounted for

      // 2. identical repeat: everything replays; only the pre-flight probes remain (nothing to promote, so no post-flight).
      // The run ledger refuses an exact repeat unless it is stated, and this repeat is the point of the test.
      before = endpoint.calls.total;
      const second = await runQa(endpoint.baseUrl, runDir, path.join(root, 'warm'), ['--cache-dir', cacheDb, '--rerun-reason', 'an identical repeat must replay every answer and judge'], pinned);
      expect(second.code, second.stderr).toBe(0);
      expect(report(path.join(root, 'warm'))).toMatchObject({ liveProviderCalls: 0, healthProbeCalls: 2, repeatRunBlockers: [] });
      expect(endpoint.calls.total - before).toBe(2);

      // 3. cache off: every call is live and the report must say so instead of "no caches in use ... 0"
      before = endpoint.calls.total;
      const third = await runQa(endpoint.baseUrl, runDir, path.join(root, 'nocache'), ['--no-cache'], {});
      expect(third.code, third.stderr).toBe(0);
      expect(report(path.join(root, 'nocache'))).toMatchObject({ liveProviderCalls: 4, healthProbeCalls: 2, uncached: { model: 4 }, repeatRunBlockers: [UNCACHED_MODEL_BLOCKER] });
      expect(endpoint.calls.total - before).toBe(6);
      expect(third.stderr).toMatch(/answer\/judge uncached 4 \| live provider calls 4 \(\+2 health probes/);
    } finally {
      await endpoint.close();
    }
  }, 180_000);
});

describe('embedding cache identity: the provider and model are pinned by the provider, not by a label', () => {
  const vectors = (value: number, identity?: { kind: string; model: string }): EmbeddingProvider => ({
    dimensions: 2,
    ...(identity ? { identity } : {}),
    embed: async (texts: string[]) => texts.map(() => [value, value]),
  });

  it('two providers that declare different models never share a cached vector, whatever the cache options', async () => {
    const cachePath = tmpPath('identity.db');
    const a = new CachingEmbeddingProvider(vectors(1, { kind: 'stub', model: 'model-a' }), { cachePath });
    expect(await a.embed(['text'])).toEqual([[1, 1]]);
    a.close();
    const b = new CachingEmbeddingProvider(vectors(9, { kind: 'stub', model: 'model-b' }), { cachePath });
    expect(await b.embed(['text'])).toEqual([[9, 9]]); // the review's repro returned [[1, 1]] here
    expect(b.stats).toEqual({ hits: 0, misses: 1 });
    b.close();
    // and the cache really works under a derived identity: model-b's own vector is replayed, model-a's is untouched
    const again = new CachingEmbeddingProvider(vectors(9, { kind: 'stub', model: 'model-b' }), { cachePath });
    expect(await again.embed(['text'])).toEqual([[9, 9]]);
    expect(again.stats).toEqual({ hits: 1, misses: 0 });
    again.close();
    expect(describeEmbeddingCache(cachePath)).toEqual([
      { namespace: 'stub/model-a/2', rows: 1 },
      { namespace: 'stub/model-b/2', rows: 1 },
    ]);
  });

  it('refuses the old opaque namespace, the very label whose reuse served one model\'s vector for another', () => {
    const cachePath = tmpPath('legacy.db');
    expect(() => new CachingEmbeddingProvider(vectors(9, { kind: 'stub', model: 'model-b' }), { cachePath, namespace: 'same/model/2' } as never)).toThrow(/namespace.*identity/i);
  });

  it('refuses a provider that declares no identity unless the caller states one, and a stated identity must agree with a declared one', async () => {
    const cachePath = tmpPath('declared.db');
    expect(() => new CachingEmbeddingProvider(vectors(1), { cachePath })).toThrow(/identity/i);
    expect(() => new CachingEmbeddingProvider(vectors(1, { kind: 'stub', model: 'model-a' }), { cachePath, identity: { kind: 'stub', model: 'model-b' } })).toThrow(/contradicts/i);
    expect(() => new CachingEmbeddingProvider(vectors(1), { cachePath, identity: { kind: 'bad kind!', model: 'model-a' } })).toThrow(/invalid/i);

    // stated for a provider that cannot declare itself, or repeated by one that can: accepted, and the namespace is derived
    const stated = new CachingEmbeddingProvider(vectors(1), { cachePath, identity: { kind: 'stub', model: 'model-x' } });
    await stated.embed(['text']);
    stated.close();
    const repeated = new CachingEmbeddingProvider(vectors(1, { kind: 'stub', model: 'model-y' }), { cachePath, identity: { kind: 'stub', model: 'model-y' } });
    await repeated.embed(['text']);
    repeated.close();
    expect(describeEmbeddingCache(cachePath)).toEqual([
      { namespace: 'stub/model-x/2', rows: 1 },
      { namespace: 'stub/model-y/2', rows: 1 },
    ]);
  });

  it('the shipped providers declare their own identity, and it derives the namespaces the paid caches already use', () => {
    const credentials = tmpPath('identity-sa');
    fs.mkdirSync(credentials, { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const keyFile = path.join(credentials, 'sa.json');
    fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'stub@example.invalid', private_key: privateKey, token_uri: 'https://oauth.stub.invalid/token' }));

    const namespaceOf = (provider: EmbeddingProvider): string => {
      const wrapped = new CachingEmbeddingProvider(provider, { cachePath: tmpPath('shipped.db') });
      const { namespace } = wrapped.describe().cache as { namespace: string };
      wrapped.close();
      return namespace;
    };
    expect(namespaceOf(new VertexEmbeddingProvider({ keyFile, project: 'stub-project', location: 'europe-west4', model: 'gemini-embedding-001', dimensions: 768 }))).toBe('vertex/gemini-embedding-001/768');
    expect(namespaceOf(new OpenAIEmbeddingProvider(['stub-key'], 'voyage-4-large', 'http://127.0.0.1:1/v1', 1024))).toBe('openai/voyage-4-large/1024');
    expect(namespaceOf(new LocalEmbeddingProvider('Xenova/multilingual-e5-base'))).toBe('local/Xenova/multilingual-e5-base/768'); // constructed only: no model is ever loaded
  });
});
