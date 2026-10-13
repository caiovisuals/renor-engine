import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import { replyTokens } from '../../src/mvp/agentMemory';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { CachingEmbeddingProvider, CountingEmbeddingProvider, embeddingCallStats, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { buildCacheReport, emitCacheReport } from '../../src/eval/cacheReport';
import type { EvalCase } from '../../src/eval/scoring';
import { DOCUMENTS_CONTEXT_MAX_TOKENS, documentsReplyTokens, scoreDocumentsArm, type DocumentsResult } from '../../src/eval/renorbenchDocuments';
import { HASH_RELEVANCE_BAR, PRODUCT_SUITES, scoreProductArm, type ProductResult, type ProductSuiteName, type ProductVerdict } from '../../src/eval/renorbenchProduct';
import { evaluatorSourceHash, gitState, packageLockSha256 } from '../../src/eval/runManifest';
import { claimDirectory, assertRegularTree } from '../../src/eval/artifacts';
import { EVAL_NOW, applyRelativeMtimes, hashFixture, jsonl, rankedAsPresented, readJsonl, sha256Buffer, type FixtureMeta } from './renorbench-common';

/**
 * RenorBench, product arm: the same questions as the chunk arm (run-renorbench.ts), answered by the shipped
 * `search_memory` tool, in process, and scored on the reply an agent receives (src/eval/renorbenchProduct.ts). Two
 * suites run through it (`--suite`): v1, the questions the chunk arm asks, and v2, a larger vault of chats and logs with
 * questions built to need session expansion, the newest-value rules and the verdict (generate-renorbench-v2.ts). A third,
 * `documents`, is a vault of handbook-style notes (generate-renorbench-docs.ts): its cases are read by `search_memory` AND by
 * `get_context` at 800 tokens, and scored by whether the probed section reaches the reply (src/eval/renorbenchDocuments.ts).
 *
 * The runner is a client and a scorer, as the product-benchmark policy asks (engine/AGENTS.md): it copies the vault,
 * has the product index it with the `index_memory` tool, and sends the case's query to `search_memory` over the MCP
 * client the SDK provides, against the real server (`createMvpApp`: the same tool handlers the hosted service
 * serves). Only the query is sent; no gold, label or category reaches the product. The reply is read as the agent
 * reads it: its hits, its `relevance` verdict and its size.
 *
 * What stays out, and why: the HTTP transport and OAuth (they carry the reply, they do not shape it); the evidence
 * table, because it needs an extraction model and this arm must stay free and deterministic; the facts lane, because
 * the vault holds notes only and the arm may not add facts of its own.
 *
 * Free by construction on the hash embedder: no network (a call to fetch fails the run), no key (every model key and
 * RENOR_* flag of the caller's shell is dropped before the product reads its environment), a frozen clock (the
 * product's recency and as-of reading are relative to `Date.now()`, which is pinned to the chunk arm's EVAL_NOW).
 * The product runs at its shipped defaults: the arm sends no top_k, no scope, no history flag. A flag armed on
 * purpose (`--env NAME=VALUE`, for an ablation) is recorded in the manifest and moves the run's identity, so such a
 * run is never held to the baseline of the defaults.
 */

/** Where the verdict's bar came from, for the manifest. */
interface RelevanceBar {
  source: string;
  value: number | null;
}

/** Variables of the caller's shell the product must not see: model keys and its own flags. Names only are ever recorded. */
const DROPPED_ENV = /^(RENOR_|MVP_|OLLAMA_|EMBEDDING_|OPENAI_|VOYAGE_|ANTHROPIC_|GOOGLE_APPLICATION_CREDENTIALS$)/;
/** An armed flag must be a product flag, never a credential. */
const ARMABLE_FLAG = /^RENOR_[A-Z0-9_]+$/;
/** A credential's name. TOKEN is a secret, TOKENS a count (RENOR_SESSION_EXPAND_TOKENS): only the first is refused. */
const SECRET_NAME = /KEY|TOKEN(?!S)|SECRET|PASSWORD|CREDENTIAL/;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseArmedFlags(raw: string[]): Array<[string, string]> {
  return raw.map(entry => {
    const at = entry.indexOf('=');
    const name = at < 0 ? entry : entry.slice(0, at);
    if (at < 0 || !ARMABLE_FLAG.test(name) || SECRET_NAME.test(name)) throw new Error(`--env takes NAME=VALUE for a RENOR_ product flag (never a key): ${name}`);
    if (name === 'RENOR_CONTEXT_RELEVANCE_MIN') throw new Error('the verdict bar is set with --relevance-bar, so that the manifest names where it came from');
    return [name, entry.slice(at + 1)] as [string, string];
  });
}

interface ProviderMeta {
  kind: 'hash' | 'vertex';
  model: string;
  dimensions: number;
  qualityEligible: boolean;
}

function makeProvider(kind: string): { provider: EmbeddingProvider; meta: ProviderMeta; warmUp?: () => Promise<unknown> } {
  if (kind === 'hash') {
    // The hash stand-in is local and free: there is no provider call to cache or count.
    const provider = new EvalHashEmbeddingProvider();
    return { provider, meta: { kind: 'hash', model: 'eval-hash-v1', dimensions: provider.dimensions, qualityEligible: false } };
  }
  if (kind === 'vertex') {
    // Real embeddings, for a number to quote beside the hash tripwire: the same cached route as the chunk arm
    // (every text is embedded once), never a local model. The provider and the cache read their settings now; the
    // caller's shell is dropped from the environment afterwards.
    const inner = new VertexEmbeddingProvider();
    const cachePath = resolveEmbeddingCachePath();
    const provider = cachePath ? new CachingEmbeddingProvider(inner, { cachePath }) : new CountingEmbeddingProvider(inner);
    // The provider signs its token request with the clock, and the run pins the clock: the token is fetched first (the
    // provider then reuses it for the whole run, as a clock that does not move never expires it). Three tokens of text.
    return { provider, meta: { kind: 'vertex', model: inner.model, dimensions: inner.dimensions, qualityEligible: true }, warmUp: () => inner.embed(['access token warm-up']) };
  }
  throw new Error(`Unknown provider ${kind}; the product arm runs on hash (the free gate arm) or vertex (cached real embeddings), never a local model`);
}

interface Workspace {
  app: MvpApp;
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** The real MCP server of the product, served to an MCP client over an in-memory transport. */
async function openWorkspace(provider: EmbeddingProvider): Promise<Workspace> {
  const app = createMvpApp(loadMvpConfig(), provider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'renorbench-product', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    app,
    client,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as Array<{ type: string; text?: string }>;
      return { text: content[0]?.text ?? '', isError: res.isError === true };
    },
    async close() {
      await client.close();
      await app.close();
    },
  };
}

async function main(): Promise<void> {
  const program = new Command()
    .name('run-renorbench-product')
    .description('Run synthetic RenorBench through the shipped search_memory tool, in process, and score the reply')
    .option('--suite <name>', `which suite: ${Object.keys(PRODUCT_SUITES).join(', ')} (v1 is the chunk arm\'s questions, the default; v2 a larger vault of chats and logs; documents a vault of handbook-style notes); it names the cases, the fixture and the benchmark id`, 'v1')
    .option('--cases <path>', "JSONL benchmark cases (default: the suite's)")
    .option('--fixture <path>', "fixture directory containing fixture.json and vault/ (default: the suite's)")
    .option('--provider <kind>', 'embedding provider: hash (default, free, no network) or vertex (cached real embeddings)', 'hash')
    .option('--top-k <n>', "send top_k to search_memory (default: not sent, so the tool's own default applies)")
    .option('--relevance-bar <n>', "the verdict's bar; default the product's calibrated bar for the model, or the harness bar for hash")
    .option('--env <name=value>', 'arm a RENOR_ product flag for an ablation (repeatable); recorded, and the run is then not the defaults', collect, [] as string[])
    .option('--output <path>', 'artifact directory; default .eval-runs/<timestamp>')
    .option('--keep-workdir', 'preserve the isolated temporary vault/database')
    .option('--allow-dirty', 'allow a dirty working tree; the run is recorded as non-promotable')
    .parse(process.argv);

  const opts = program.opts<{
    suite: string;
    cases?: string;
    fixture?: string;
    provider: string;
    topK?: string;
    relevanceBar?: string;
    env: string[];
    output?: string;
    keepWorkdir?: boolean;
    allowDirty?: boolean;
  }>();

  const repoRoot = process.cwd();
  if (!Object.hasOwn(PRODUCT_SUITES, opts.suite)) throw new Error(`--suite must be ${Object.keys(PRODUCT_SUITES).join(' or ')}, not ${opts.suite}`);
  const suite = PRODUCT_SUITES[opts.suite as ProductSuiteName];
  // The documents suite also reads every question through get_context, and scores delivery alone.
  const documents = opts.suite === 'documents';
  const casesPath = path.resolve(repoRoot, opts.cases ?? suite.cases);
  const fixtureDir = path.resolve(repoRoot, opts.fixture ?? suite.fixture);
  assertRegularTree(fixtureDir);
  const sourceVault = path.join(fixtureDir, 'vault');
  const fixtureMeta = JSON.parse(await fsp.readFile(path.join(fixtureDir, 'fixture.json'), 'utf8')) as FixtureMeta;
  const cases = readJsonl<EvalCase>(casesPath);
  if (cases.length === 0) throw new Error('No eval cases loaded');
  const armed = parseArmedFlags(opts.env);
  // Before anything is created: a provider that is refused (a local model never runs here) leaves nothing behind.
  const { provider, meta: providerMeta, warmUp } = makeProvider(opts.provider);
  const free = providerMeta.kind === 'hash';
  const topK = opts.topK === undefined ? undefined : Number(opts.topK);
  if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 50)) throw new Error('--top-k must be an integer between 1 and 50');
  const explicitBar = opts.relevanceBar === undefined ? undefined : Number(opts.relevanceBar);
  if (explicitBar !== undefined && !Number.isFinite(explicitBar)) throw new Error('--relevance-bar must be a number');

  const git = gitState(repoRoot);
  if (git.dirty && !opts.allowDirty) {
    throw new Error(
      `Working tree is dirty; git SHA ${git.sha} would not describe the executed code. ` +
      'Commit or stash changes before running the benchmark, or pass --allow-dirty to record the run as non-promotable.',
    );
  }
  const evaluatorSha256 = evaluatorSourceHash(repoRoot);
  const lockSha256 = packageLockSha256(repoRoot);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(repoRoot, opts.output ?? path.join('.eval-runs', timestamp));
  claimDirectory(outputDir);

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-eval-product-'));
  const vaultDir = path.join(workDir, 'vault');
  const casesBytes = await fsp.readFile(casesPath);
  const casesHash = sha256Buffer(casesBytes);
  const fixtureHash = await hashFixture(fixtureDir);
  await fsp.cp(sourceVault, vaultDir, { recursive: true });
  await applyRelativeMtimes(vaultDir, fixtureMeta);

  await warmUp?.();

  // --- The product's world: the caller's shell dropped, the product's own settings set, the clock frozen, the network
  // closed when the arm must be free. Nothing below this line may read an ambient variable the manifest does not name.
  const ignoredAmbient = Object.keys(process.env).filter(name => DROPPED_ENV.test(name)).sort();
  for (const name of ignoredAmbient) delete process.env[name];
  const authDir = path.join(workDir, 'auth');
  fs.mkdirSync(authDir, { mode: 0o700 });
  Object.assign(process.env, {
    MVP_MEMORY_DIR: vaultDir,
    MVP_DB_PATH: path.join(workDir, 'index.db'),
    MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    // The provider is injected below, which is how a harness brings its own; the configured one stays off.
    MVP_EMBEDDING_PROVIDER: 'none',
  });
  for (const [name, value] of armed) process.env[name] = value;
  const bar: RelevanceBar = explicitBar !== undefined
    ? { source: '--relevance-bar', value: explicitBar }
    : free
      ? { source: 'harness bar for the hash embedder, which has no calibrated one', value: HASH_RELEVANCE_BAR }
      : { source: "the product's calibrated bar for the model (CALIBRATED_BARS)", value: null };
  if (bar.value !== null) process.env.RENOR_CONTEXT_RELEVANCE_MIN = String(bar.value);

  const realNow = Date.now;
  Date.now = () => EVAL_NOW;
  const realFetch = globalThis.fetch;
  let blockedFetches = 0;
  if (free) {
    globalThis.fetch = (() => {
      blockedFetches += 1;
      throw new Error('the free RenorBench arm makes no network call');
    }) as typeof fetch;
  }
  // The product logs one line per tool call and per migration to stdout; the runner prints its own result there.
  const realLog = console.log;
  const realInfo = console.info;
  console.log = () => {};
  console.info = () => {};

  const startedAt = new Date().toISOString();
  let workspace: Workspace | undefined;
  let completed = false;
  try {
    workspace = await openWorkspace(provider);
    const indexStarted = performance.now();
    let indexed = JSON.parse((await workspace.call('index_memory')).text) as { total: number; indexed: number; errors: number };
    let indexDurationMs = performance.now() - indexStarted;
    if (indexed.errors > 0) throw new Error(`Indexing completed with ${indexed.errors} error(s)`);

    let erasure: { deleted: string[]; rebuildIndexMs: number } | null = null;
    const deletedPaths = fixtureMeta.deleteAfterIndex ?? [];
    if (deletedPaths.length > 0) {
      for (const relative of deletedPaths) {
        const target = path.resolve(vaultDir, relative);
        const root = path.resolve(vaultDir);
        if (!(target === root || target.startsWith(root + path.sep))) {
          throw new Error(`Fixture deleteAfterIndex path escapes vault: ${relative}`);
        }
        await fsp.rm(target, { force: true });
      }
      // Tear the product down completely, then start it again on the vault WITHOUT the deleted notes: a restart must
      // not resurrect erased content.
      await workspace.close();
      workspace = undefined;
      for (const suffix of ['', '-wal', '-shm']) await fsp.rm(path.join(workDir, 'index.db') + suffix, { force: true });
      const rebuildStarted = performance.now();
      workspace = await openWorkspace(provider);
      indexed = JSON.parse((await workspace.call('index_memory')).text) as typeof indexed;
      if (indexed.errors > 0) throw new Error(`Indexing completed with ${indexed.errors} error(s)`);
      erasure = { deleted: deletedPaths, rebuildIndexMs: performance.now() - rebuildStarted };
      indexDurationMs += erasure.rebuildIndexMs;
    }

    const results: Array<ProductResult | DocumentsResult> = [];
    let sessionExpandReplies = 0;
    let contextExpandReplies = 0;
    let factHitReplies = 0;
    let evidenceReplies = 0;
    const bars = new Set<number>();
    for (const test of cases) {
      const started = performance.now();
      // The query is all the product is told: not the id, the category, the gold or the abstention label.
      const reply = await workspace.call('search_memory', { query: test.query, ...(topK === undefined ? {} : { top_k: topK }) });
      const latencyMs = performance.now() - started;
      if (reply.isError) throw new Error(`search_memory failed on ${test.id}: ${reply.text.slice(0, 240)}`);
      const body = JSON.parse(reply.text) as {
        ok: boolean;
        hits: Array<{ notePath: string; headingPath?: string; text: string; score?: number; reason?: string; session_date?: string }>;
        relevance?: { relevant: boolean; similarity: number | null; bar: number; reason?: string };
        evidence?: unknown;
      };
      if (body.ok !== true) throw new Error(`search_memory did not answer ${test.id}: ${reply.text.slice(0, 240)}`);
      const hits = rankedAsPresented(body.hits.map(hit => ({
        text: hit.text,
        notePath: hit.notePath,
        ...(hit.headingPath === undefined ? {} : { headingPath: hit.headingPath }),
        score: hit.score ?? 0,
        reason: hit.reason,
        ...(hit.session_date === undefined ? {} : { session_date: hit.session_date }),
      })));
      if (hits.some(hit => hit.reason === SESSION_EXPAND_REASON)) sessionExpandReplies += 1;
      if (hits.some(hit => hit.reason === 'fact')) factHitReplies += 1;
      if (body.evidence !== undefined) evidenceReplies += 1;
      const verdict: (ProductVerdict & { reason?: string }) | null = body.relevance
        ? { relevant: body.relevance.relevant, similarity: body.relevance.similarity, bar: body.relevance.bar, ...(body.relevance.reason === undefined ? {} : { reason: body.relevance.reason }) }
        : null;
      if (verdict) bars.add(verdict.bar);
      const searched: ProductResult = { id: test.id, hits, verdict, replyTokens: replyTokens(reply.text), latencyMs };
      if (!documents) {
        results.push(searched);
        continue;
      }
      // get_context at its default budget: the read an agent makes first. Only the query is sent.
      const ctx = await workspace.call('get_context', { query: test.query, max_tokens: DOCUMENTS_CONTEXT_MAX_TOKENS });
      if (ctx.isError) throw new Error(`get_context failed on ${test.id}: ${ctx.text.slice(0, 240)}`);
      const ctxBody = JSON.parse(ctx.text) as { ok?: boolean; memories?: Array<{ notePath: string; headingPath?: string; text: string; score?: number; reason?: string }> };
      if (ctxBody.ok !== true || !Array.isArray(ctxBody.memories)) throw new Error(`get_context did not answer ${test.id}: ${ctx.text.slice(0, 240)}`);
      const contextHits = ctxBody.memories.map(memory => ({
        text: memory.text,
        notePath: memory.notePath,
        ...(memory.headingPath === undefined ? {} : { headingPath: memory.headingPath }),
        score: memory.score ?? 0,
        reason: memory.reason,
      }));
      if (contextHits.some(hit => hit.reason === SESSION_EXPAND_REASON)) contextExpandReplies += 1;
      results.push({ ...searched, context: { hits: contextHits, replyTokens: replyTokens(ctx.text) } });
    }
    if (blockedFetches > 0) throw new Error(`the free RenorBench arm tried ${blockedFetches} network call(s)`);

    const summary = documents ? scoreDocumentsArm(cases, results as DocumentsResult[]) : scoreProductArm(cases, results);
    const summaryWithProductPath = {
      ...summary,
      ...(documents ? {
        documentsPath: {
          replies: results.length,
          sessionExpandReplies,
          contextExpandReplies,
          replyTokens: documentsReplyTokens(results as DocumentsResult[]),
          note: 'sessionExpandReplies and contextExpandReplies: replies of search_memory and of get_context that carried session-expansion statements. replyTokens is what the replies cost: recorded here for the reader, not part of the score.',
        },
      } : {}),
      productPath: {
        replies: results.length,
        sessionExpandReplies,
        factHitReplies,
        evidenceReplies,
        verdictBars: [...bars].sort((a, b) => a - b),
        note: 'sessionExpandReplies: replies that carried session-expansion statements (0 means the expansion never fired). factHitReplies and evidenceReplies are 0 by construction: the vault holds notes only, and the evidence table needs a model.',
      },
    };
    const finishedAt = new Date().toISOString();
    if (sha256Buffer(await fsp.readFile(casesPath)) !== casesHash || await hashFixture(fixtureDir) !== fixtureHash) {
      throw new Error('Eval inputs changed during run');
    }
    const manifest = {
      schemaVersion: 2,
      benchmark: suite.benchmark,
      arm: 'product',
      split: [...new Set(cases.map(test => test.split))],
      gitSha: git.sha,
      gitDirty: git.dirty,
      gitStatusSha256: git.statusSha256,
      evaluatorSha256,
      packageLockSha256: lockSha256,
      // The product's own chunking: index_memory passes no chunk options, so the indexer's defaults apply (400 tokens, no overlap).
      chunking: { maxTokens: 400, overlapTokens: 0 },
      entryPoint: {
        kind: 'mcp-in-process',
        server: 'createMvpApp (the tool handlers the hosted service serves)',
        transport: 'MCP SDK Client over InMemoryTransport',
        indexTool: 'index_memory',
        searchTool: 'search_memory',
        searchArguments: topK === undefined
          ? 'query only: top_k, scope and include_history left at the tool defaults'
          : `query and top_k=${topK}: scope and include_history left at the tool defaults`,
        ...(documents ? { contextTool: 'get_context', contextArguments: `query and max_tokens=${DOCUMENTS_CONTEXT_MAX_TOKENS}: scope and the rest left at the tool defaults` } : {}),
      },
      productMode: {
        overrides: armed.map(([name, value]) => `${name}=${value}`).sort(),
        relevanceBar: bar,
        evidence: 'no model configured: no evidence pass',
        embeddedBy: providerMeta.kind === 'hash' ? 'injected eval-hash provider (no network)' : 'injected cached Vertex provider',
      },
      conditions: { recencyClock: EVAL_NOW, clockPinned: true, tokenEstimator: 'engine o200k, over the reply text the tool returned' },
      ambientEnvIgnored: ignoredAmbient,
      network: { blockedFetchCalls: blockedFetches, guarded: free },
      startedAt,
      finishedAt,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider: provider instanceof CachingEmbeddingProvider ? { ...providerMeta, cache: provider.describe().cache } : providerMeta,
      caseCount: cases.length,
      casesPath: path.relative(repoRoot, casesPath).replaceAll(path.sep, '/'),
      casesSha256: casesHash,
      resultsSha256: sha256Buffer(jsonl(results)),
      caseSnapshotSha256: sha256Buffer(jsonl(cases)),
      fixturePath: path.relative(repoRoot, fixtureDir).replaceAll(path.sep, '/'),
      fixtureSha256: fixtureHash,
      index: { total: indexed.total, indexed: indexed.indexed, errors: indexed.errors, durationMs: Math.round(indexDurationMs * 100) / 100 },
      erasure,
      qualityEligible: providerMeta.qualityEligible,
      warning: providerMeta.qualityEligible
        ? null
        : 'Hash embeddings are infrastructure-only and MUST NOT be reported as a Renor quality score; the verdict bar is a harness constant for them.',
    };

    await Promise.all([
      fsp.writeFile(path.join(outputDir, 'cases.jsonl'), jsonl(cases), 'utf8'),
      fsp.writeFile(path.join(outputDir, 'results.jsonl'), jsonl(results), 'utf8'),
      fsp.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summaryWithProductPath, null, 2) + '\n', 'utf8'),
      fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    ]);

    completed = true;
    emitCacheReport(buildCacheReport({ embedding: embeddingCallStats(provider) }), outputDir);
    process.stdout.write(`${JSON.stringify({ outputDir, manifest, summary: summaryWithProductPath }, null, 2)}\n`);
  } finally {
    console.log = realLog;
    console.info = realInfo;
    Date.now = realNow;
    globalThis.fetch = realFetch;
    await workspace?.close().catch(() => undefined);
    if (!opts.keepWorkdir) {
      await fsp.rm(workDir, { recursive: true, force: true });
    } else {
      console.error(`[eval] kept isolated workdir: ${workDir}`);
    }
    if (!completed) {
      console.error(`[eval] failed; artifact directory retained: ${outputDir}`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
