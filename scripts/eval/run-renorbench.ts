import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Command } from 'commander';
import { countTextTokens } from '../../src/eval/textTokens';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { LocalEmbeddingProvider } from '../../src/embeddings/local';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { CachingEmbeddingProvider, CountingEmbeddingProvider, embeddingCallStats, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import { buildCacheReport, emitCacheReport } from '../../src/eval/cacheReport';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { indexVault } from '../../src/indexer/pipeline';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';
import { evaluatorSourceHash, gitState, packageLockSha256 } from '../../src/eval/runManifest';
import { claimDirectory, assertRegularTree, safeEndpoint } from '../../src/eval/artifacts';
import { EVAL_NOW, applyRelativeMtimes, hashFixture, jsonl, rankedAsPresented, readJsonl, sha256Buffer, type FixtureMeta } from './renorbench-common';

interface ProviderMeta {
  kind: 'hash' | 'local' | 'openai' | 'vertex';
  model: string;
  dimensions: number;
  baseURL?: string;
  qualityEligible: boolean;
}

class EvalHashEmbeddingProvider implements EmbeddingProvider {
  dimensions = 256;

  private vector(text: string): number[] {
    const out = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const word of words) {
      let hash = 2166136261;
      for (let i = 0; i < word.length; i++) {
        hash ^= word.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const index = (hash >>> 0) % this.dimensions;
      out[index] += 1;
    }
    const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
    return out.map(value => value / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}

const CHUNK_MAX_TOKENS = 400;
const CHUNK_OVERLAP_TOKENS = 50;

function makeProvider(kind: string, modelArg?: string): { provider: EmbeddingProvider; meta: ProviderMeta } {
  if (kind === 'hash') {
    const provider = new EvalHashEmbeddingProvider();
    return {
      provider,
      meta: {
        kind: 'hash',
        model: 'eval-hash-v1',
        dimensions: provider.dimensions,
        qualityEligible: false,
      },
    };
  }

  if (kind === 'local') {
    const model = modelArg ?? process.env.RENOR_EVAL_MODEL ?? 'Xenova/multilingual-e5-base';
    const provider = new LocalEmbeddingProvider(model);
    return {
      provider,
      meta: {
        kind: 'local',
        model,
        dimensions: provider.dimensions,
        qualityEligible: true,
      },
    };
  }

  if (kind === 'vertex') {
    const provider = new VertexEmbeddingProvider();
    return {
      provider,
      meta: {
        kind: 'vertex',
        model: provider.model,
        dimensions: provider.dimensions,
        qualityEligible: true,
      },
    };
  }

  if (kind === 'openai') {
    const rawKeys = process.env.RENOR_EVAL_EMBEDDING_API_KEY
      ?? process.env.MVP_EMBEDDING_API_KEY
      ?? process.env.OPENAI_API_KEY
      ?? '';
    const keys = rawKeys.split(',').map(value => value.trim()).filter(Boolean);
    if (keys.length === 0) {
      throw new Error('OpenAI-compatible eval provider requires RENOR_EVAL_EMBEDDING_API_KEY, MVP_EMBEDDING_API_KEY, or OPENAI_API_KEY');
    }
    const model = modelArg ?? process.env.RENOR_EVAL_MODEL ?? 'voyage-4-large';
    const baseURL = safeEndpoint(process.env.RENOR_EVAL_EMBEDDING_BASE_URL
      ?? process.env.MVP_EMBEDDING_BASE_URL
      ?? 'https://api.voyageai.com/v1');
    const dimensions = Number(process.env.RENOR_EVAL_EMBEDDING_DIMS ?? 1024);
    if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 8192) {
      throw new Error('RENOR_EVAL_EMBEDDING_DIMS must be an integer between 8 and 8192');
    }
    const provider = new OpenAIEmbeddingProvider(keys, model, baseURL, dimensions);
    return {
      provider,
      meta: {
        kind: 'openai',
        model,
        dimensions,
        baseURL,
        qualityEligible: true,
      },
    };
  }

  throw new Error(`Unknown provider ${kind}; expected hash, local, vertex, or openai`);
}

async function main(): Promise<void> {
  const program = new Command()
    .name('run-renorbench')
    .description('Run synthetic RenorBench retrieval against the real Renor index/retrieval path')
    .option('--cases <path>', 'JSONL benchmark cases', 'docs/evals/renorbench-v1.dev.jsonl')
    .option('--fixture <path>', 'fixture directory containing fixture.json and vault/', 'fixtures/eval/renorbench-v1')
    .option('--provider <kind>', 'embedding provider: vertex (default, cached), local, openai, or hash', process.env.RENOR_EVAL_PROVIDER ?? 'vertex')
    .option('--model <name>', 'embedding model override')
    .option('--top-k <n>', 'retrieval depth; >=10 keeps Hit@10 meaningful', '10')
    .option('--output <path>', 'artifact directory; default .eval-runs/<timestamp>')
    .option('--keep-workdir', 'preserve the isolated temporary vault/database')
    .option('--allow-dirty', 'allow a dirty working tree; the run is recorded as non-promotable')
    .parse(process.argv);

  const opts = program.opts<{
    cases: string;
    fixture: string;
    provider: string;
    model?: string;
    topK: string;
    output?: string;
    keepWorkdir?: boolean;
    allowDirty?: boolean;
  }>();

  const repoRoot = process.cwd();
  const casesPath = path.resolve(repoRoot, opts.cases);
  const fixtureDir = path.resolve(repoRoot, opts.fixture);
  assertRegularTree(fixtureDir);
  const sourceVault = path.join(fixtureDir, 'vault');
  const fixtureMeta = JSON.parse(await fsp.readFile(path.join(fixtureDir, 'fixture.json'), 'utf8')) as FixtureMeta;
  const cases = readJsonl<EvalCase>(casesPath);
  if (cases.length === 0) throw new Error('No eval cases loaded');

  const git = gitState(repoRoot);
  if (git.dirty && !opts.allowDirty) {
    throw new Error(
      `Working tree is dirty; git SHA ${git.sha} would not describe the executed code. ` +
      'Commit or stash changes before running the benchmark, or pass --allow-dirty to record the run as non-promotable.',
    );
  }
  const evaluatorSha256 = evaluatorSourceHash(repoRoot);
  const lockSha256 = packageLockSha256(repoRoot);

  const topK = Number(opts.topK);
  if (!Number.isInteger(topK) || topK < 10 || topK > 100) {
    throw new Error('--top-k must be an integer between 10 and 100');
  }
  const concurrency = Number(process.env.RENOR_EVAL_INDEX_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid index concurrency');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(repoRoot, opts.output ?? path.join('.eval-runs', timestamp));
  claimDirectory(outputDir);

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-eval-'));
  const vaultDir = path.join(workDir, 'vault');
  const dbPath = path.join(workDir, 'index.db');
  const casesBytes = await fsp.readFile(casesPath);
  const casesHash = sha256Buffer(casesBytes);
  const fixtureHash = await hashFixture(fixtureDir);
  await fsp.cp(sourceVault, vaultDir, { recursive: true });
  await applyRelativeMtimes(vaultDir, fixtureMeta);

  const { provider, meta: providerMeta } = makeProvider(opts.provider, opts.model);
  // Embedding cache: re-runs of the same fixture must not re-pay the provider. With the cache off the calls are
  // still counted for the cache report. The hash stub is local and free: there is no provider call to cache or count.
  const cachePath = providerMeta.kind === 'hash' ? null : resolveEmbeddingCachePath();
  const embeddingProvider = providerMeta.kind === 'hash'
    ? provider
    : cachePath
      ? new CachingEmbeddingProvider(provider, { cachePath })
      : new CountingEmbeddingProvider(provider);
  const startedAt = new Date().toISOString();
  let db: ReturnType<typeof openDb> | undefined;
  let completed = false;

  try {
    const buildIndex = async () => {
      db = db ?? openDb(dbPath);
      runMigrations(db);
      const vectorIndex = new VectorIndex(db, provider.dimensions);
      vectorIndex.initTable();
      const indexBuildStarted = performance.now();
      const stats = await indexVault(
        db!,
        vaultDir,
        {
          embeddingProvider: embeddingProvider,
          vectorIndex,
          chunkOptions: { maxTokens: CHUNK_MAX_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS },
        },
        concurrency,
      );
      if (stats.errors > 0) {
        throw new Error(`Indexing completed with ${stats.errors} error(s)`);
      }
      return { stats, vectorIndex, durationMs: performance.now() - indexBuildStarted };
    };

    const indexStarted = performance.now();
    let { stats: indexStats, vectorIndex } = await buildIndex();
    let indexDurationMs = performance.now() - indexStarted;

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
      // Tear the index down completely, then rebuild from the vault WITHOUT
      // the deleted notes — a restart must not resurrect erased content.
      db!.close();
      db = undefined;
      for (const suffix of ['', '-wal', '-shm']) {
        await fsp.rm(dbPath + suffix, { force: true });
      }
      const rebuildStarted = performance.now();
      ({ stats: indexStats, vectorIndex } = await buildIndex());
      erasure = { deleted: deletedPaths, rebuildIndexMs: performance.now() - rebuildStarted };
      indexDurationMs += erasure.rebuildIndexMs;
    }

    const results: EvalResult[] = [];
    // Tool-path observability: `reason === 'fact'` marks a lifecycle fact card
    // prepended by factsFirst() inside retrieveContext — the production path.
    // Zero here means the hardcoded cue table never fired for this fixture,
    // i.e. the temporal mechanism under test is pure chunk ranking.
    let factCardPrependedCases = 0;
    for (const test of cases) {
      const started = performance.now();
      const result = await retrieveContext(db!, vectorIndex, embeddingProvider, test.query, topK, [], { nowMs: EVAL_NOW });
      const latencyMs = performance.now() - started;
      const contextTokens = countTextTokens(result.hits.map(hit => hit.text).join('\n\n'));
      if (result.hits.slice(0, 3).some(h => h.reason === 'fact')) factCardPrependedCases += 1;
      results.push({
        id: test.id,
        hits: rankedAsPresented(result.hits).map(hit => ({
          text: hit.text,
          notePath: path.relative(vaultDir, hit.notePath).replaceAll(path.sep, '/'),
          score: hit.score,
          reason: hit.reason,
        })),
        latencyMs,
        contextTokens,
      });
    }

    const summary = scoreRetrieval(cases, results);
    const summaryWithToolPath = {
      ...summary,
      toolPath: {
        factCardPrependedCases,
        factCardRate: cases.length ? Math.round((factCardPrependedCases / cases.length) * 10000) / 10000 : 0,
        note: "fact cards come from factsFirst() hardcoded predicate cues — 0 means the lifecycle prepend path did not fire for this fixture",
      },
    };
    const finishedAt = new Date().toISOString();
    if (sha256Buffer(await fsp.readFile(casesPath)) !== casesHash || await hashFixture(fixtureDir) !== fixtureHash) {
      throw new Error('Eval inputs changed during run');
    }
    const manifest = {
      schemaVersion: 2,
      benchmark: 'renorbench-v1',
      split: [...new Set(cases.map(test => test.split))],
      gitSha: git.sha,
      gitDirty: git.dirty,
      gitStatusSha256: git.statusSha256,
      evaluatorSha256,
      packageLockSha256: lockSha256,
      chunking: { maxTokens: CHUNK_MAX_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS },
      conditions: { recencyClock: EVAL_NOW, concurrency, priorityPaths: [], tokenEstimator: 'gpt-tokenizer/join-text-v1' },
      startedAt,
      finishedAt,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider: embeddingProvider instanceof CachingEmbeddingProvider
        ? { ...providerMeta, cache: embeddingProvider.describe().cache }
        : providerMeta,
      topK,
      caseCount: cases.length,
      casesPath: path.relative(repoRoot, casesPath).replaceAll(path.sep, '/'),
      casesSha256: casesHash,
      resultsSha256: sha256Buffer(jsonl(results)),
      caseSnapshotSha256: sha256Buffer(jsonl(cases)),
      fixturePath: path.relative(repoRoot, fixtureDir).replaceAll(path.sep, '/'),
      fixtureSha256: fixtureHash,
      index: {
        ...indexStats,
        durationMs: Math.round(indexDurationMs * 100) / 100,
      },
      erasure,
      qualityEligible: providerMeta.qualityEligible,
      warning: providerMeta.qualityEligible
        ? null
        : 'Hash embeddings are infrastructure-only and MUST NOT be reported as a Renor quality score.',
    };

    await Promise.all([
      fsp.writeFile(path.join(outputDir, 'cases.jsonl'), jsonl(cases), 'utf8'),
      fsp.writeFile(path.join(outputDir, 'results.jsonl'), jsonl(results), 'utf8'),
      fsp.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summaryWithToolPath, null, 2) + '\n', 'utf8'),
      fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    ]);

    completed = true;
    emitCacheReport(buildCacheReport({ embedding: embeddingCallStats(embeddingProvider) }), outputDir);
    console.log(JSON.stringify({ outputDir, manifest, summary: summaryWithToolPath }, null, 2));
  } finally {
    db?.close();
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