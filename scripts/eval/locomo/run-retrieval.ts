/**
 * Renor-on-LoCoMo retrieval runner (scripts/eval/locomo/).
 *
 * Reuses Renor's unmodified indexing + retrieval stack (src/indexer/pipeline,
 * src/retrieval/orchestrator) over the adapter's per-conversation corpora.
 *
 * Isolation decision (documented in the manifest): each LoCoMo conversation
 * gets its own fresh vault + sqlite index and its QA cases are retrieved ONLY
 * from that conversation's index. This mirrors LongMemEval per-question
 * isolation semantics (each question is retrieved against its own haystack) —
 * cross-conversation contamination is impossible by construction. The adapter
 * writes one corpus dir per conversation; this runner indexes each corpus dir
 * once, runs every case of that conversation, and appends checkpoints.
 *
 * Embedding provider: Vertex AI gemini-embedding-001 (768-d) by default, with
 * content-addressed cache. `--provider local` remains for offline debugging
 * and is provider-incomparable with Vertex/LME numbers. The 2026-09-17 30.7%
 * baseline used local e5; after the Vertex switch it must be labelled and is
 * not the locomo-cats14-v1 headline.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from '../../../src/db/sqlite';
import { countTextTokens } from '../../../src/eval/textTokens';
import { openDb } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/schema';
import { VectorIndex } from '../../../src/embeddings/vectorIndex';
import { LocalEmbeddingProvider } from '../../../src/embeddings/local';
import { VertexEmbeddingProvider } from '../../../src/embeddings/vertex';
import { EvalHashEmbeddingProvider } from '../../../src/eval/hashEmbedding';
import { CachingEmbeddingProvider, CountingEmbeddingProvider, embeddingCallStats, resolveEmbeddingCachePath } from '../../../src/embeddings/caching';
import { buildCacheReport, emitCacheReport } from '../../../src/eval/cacheReport';
import type { EmbeddingProvider } from '../../../src/embeddings/types';
import { indexVault } from '../../../src/indexer/pipeline';
import { retrieveContext } from '../../../src/retrieval/orchestrator';
import { evaluatorSourceHash, gitState } from '../../../src/eval/runManifest';
import { claimDirectory } from '../../../src/eval/artifacts';

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

interface CaseRow {
  id: string;
  query: string;
  corpusDir: string;
  relevant: Array<{ match: string; notePath: string; role: string }>;
  expectedAnswer: string;
  shouldAbstain: boolean;
  category: string;
  goldTurns: Array<{ sessionNo: number; turn: number; fp: string }>;
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function main(): Promise<void> {
  const program = (await import('commander')).Command;
  const cmd = new program()
    .name('run-locomo-retrieval')
    .requiredOption('--cases <path>', 'adapter cases.jsonl')
    .requiredOption('--output <dir>', 'output run directory')
    .option('--top-k <n>', 'retrieval depth', '20')
    .option('--concurrency <n>', 'index concurrency', '2')
    .option('--provider <kind>', 'embedding provider: local, vertex, or eval-hash (offline wiring smoke, never a score)', process.env.RENOR_EVAL_PROVIDER ?? 'vertex')
    .option('--model <name>', 'embedding model override')
    .option('--limit <n>', 'maximum cases to run (0 = all)', '0')
    .option('--offset <n>', 'offset into cases', '0')
    .parse(process.argv);
  const opts = cmd.opts<{
    cases: string;
    output: string;
    topK: string;
    concurrency: string;
    provider: string;
    model?: string;
    limit: string;
    offset: string;
  }>();

  const topK = Number(opts.topK);
  const concurrency = Number(opts.concurrency);
  const casesPath = path.resolve(opts.cases);
  const outputDir = path.resolve(opts.output);
  const checkpoint = path.join(outputDir, 'results.jsonl');
  const perCasePath = path.join(outputDir, 'per-case.jsonl');
  // fresh run claims an empty dir; resume runs must already hold a results checkpoint
  if (fs.existsSync(outputDir)) {
    if (!fs.existsSync(checkpoint)) throw new Error(`Output exists without results.jsonl (refusing to clobber): ${outputDir}`);
  } else {
    claimDirectory(outputDir);
  }

  const rawCases = readJsonl(casesPath) as unknown as CaseRow[];
  const offset = Number(opts.offset ?? 0);
  const limit = Number(opts.limit ?? 0);
  const allCases = limit > 0 ? rawCases.slice(offset, offset + limit) : (offset > 0 ? rawCases.slice(offset) : rawCases);
  const byCorpus = new Map<string, CaseRow[]>();
  for (const row of allCases) {
    const list = byCorpus.get(row.corpusDir) ?? [];
    list.push(row);
    byCorpus.set(row.corpusDir, list);
  }

  const done = new Set<string>();
  const existingResults: Array<Record<string, unknown>> = [];
  const existingPerCase: Array<Record<string, unknown>> = [];
  if (fs.existsSync(checkpoint)) {
    for (const line of fs.readFileSync(checkpoint, 'utf8').split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line) as { id: string };
        done.add(row.id);
        existingResults.push(row);
      } catch { /* partial trailing line */ }
    }
  }
  if (fs.existsSync(perCasePath)) {
    for (const line of fs.readFileSync(perCasePath, 'utf8').split('\n').filter(Boolean)) {
      try { existingPerCase.push(JSON.parse(line)); } catch { /* partial */ }
    }
  }

  let baseProvider: EmbeddingProvider;
  let providerMeta: { kind: 'local' | 'vertex' | 'eval-hash'; model: string; dimensions: number; location?: string };
  if (opts.provider === 'local') {
    const modelName = opts.model ?? 'Xenova/multilingual-e5-base';
    const p = new LocalEmbeddingProvider(modelName);
    baseProvider = p;
    providerMeta = { kind: 'local', model: modelName, dimensions: p.dimensions };
  } else if (opts.provider === 'vertex') {
    const p = new VertexEmbeddingProvider(opts.model ? { model: opts.model } : undefined);
    baseProvider = p;
    providerMeta = {
      kind: 'vertex',
      model: p.model,
      dimensions: p.dimensions,
      location: (p.describe() as { location?: string }).location,
    };
  } else if (opts.provider === 'eval-hash') {
    const p = new EvalHashEmbeddingProvider();
    baseProvider = p;
    providerMeta = { kind: 'eval-hash', model: p.identity.model, dimensions: p.dimensions };
  } else {
    throw new Error(`Unsupported provider: ${opts.provider}; expected local, vertex or eval-hash`);
  }

  const cachePath = resolveEmbeddingCachePath();
  // With the cache off the calls are still counted for the cache report.
  const provider: EmbeddingProvider = cachePath
    ? new CachingEmbeddingProvider(baseProvider, { cachePath })
    : new CountingEmbeddingProvider(baseProvider);
  const startedAt = new Date().toISOString();
  const repoRoot = fs.existsSync(path.join(process.cwd(), 'package.json'))
    ? process.cwd()
    : path.resolve(__dirname, '../../..');
  const git = gitState(repoRoot);
  const evaluator = evaluatorSourceHash(repoRoot);

  let corpusIdx = 0;
  for (const [corpusDir, corpusCases] of byCorpus) {
    corpusIdx++;
    const todo = corpusCases.filter(row => !done.has(row.id));
    if (todo.length === 0) { process.stderr.write(`[loco-retr] corpus ${corpusIdx}/${byCorpus.size} already complete\n`); continue; }
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-locomo-'));
    const vaultDir = path.join(workDir, 'vault');
    let db: ReturnType<typeof openDb> | undefined;
    try {
      // copy the adapter's rendered vault (Sessions/*.md) into the isolated workdir
      await fsp.cp(corpusDir, vaultDir, { recursive: true });
      db = openDb(path.join(workDir, 'index.db'));
      runMigrations(db);
      const vectorIndex = new VectorIndex(db, provider.dimensions);
      vectorIndex.initTable();
      const indexStarted = performance.now();
      const stats = await indexVault(
        db,
        vaultDir,
        { embeddingProvider: provider, vectorIndex, chunkOptions: { maxTokens: 400, overlapTokens: 50 } },
        concurrency,
      );
      const indexDurationMs = performance.now() - indexStarted;
      if (stats.errors > 0) throw new Error(`${corpusDir}: indexing had ${stats.errors} error(s)`);
      const chunkCount = (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c;
      const indexMs = Math.round(indexDurationMs * 100) / 100;
      process.stderr.write(`[loco-retr] corpus ${corpusIdx}/${byCorpus.size} ${path.basename(corpusDir)} indexed=${stats.indexed} chunks=${chunkCount} indexMs=${indexMs}\n`);

      for (const row of todo) {
        const retrievalStarted = performance.now();
        const retrieved = await retrieveContext(db, vectorIndex, provider, row.query, topK, [], {});
        const latencyMs = performance.now() - retrievalStarted;
        const hits = retrieved.hits.map(hit => ({
          text: hit.text,
          notePath: path.relative(vaultDir, hit.notePath).replaceAll(path.sep, '/'),
          score: hit.score,
        }));
        const contextTokens = countTextTokens(hits.map(hit => hit.text ?? '').join('\n\n'));
        const result = { id: row.id, hits, latencyMs: Math.round(latencyMs * 1000) / 1000, contextTokens };
        fs.appendFileSync(checkpoint, JSON.stringify(result) + '\n', 'utf8');
        fs.appendFileSync(perCasePath, JSON.stringify({
          id: row.id,
          corpus: path.basename(corpusDir),
          sessions: (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c,
          chunks: chunkCount,
          indexDurationMs: indexMs,
          retrievalDurationMs: Math.round(latencyMs * 100) / 100,
          contextTokens,
        }) + '\n', 'utf8');
        process.stderr.write(`[loco-retr] ${row.id} hits=${hits.length} ${Math.round(latencyMs)}ms\n`);
      }
    } finally {
      db?.close();
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  // manifest from the final on-disk state
  const results = fs.existsSync(checkpoint)
    ? (fs.readFileSync(checkpoint, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) as Array<Record<string, unknown>>)
    : [];
  const perCase = fs.existsSync(perCasePath)
    ? (fs.readFileSync(perCasePath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) as Array<Record<string, unknown>>)
    : [];
  const finishedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    benchmark: 'locomo10-retrieval',
    metricProtocol: 'renor-chunk-to-evidence-session-v1-not-official',
    isolation: 'per-conversation isolated vault+index; cases retrieved only from their own conversation (mirrors LongMemEval per-question haystack isolation)',
    casesPath: casesPath,
    casesTotal: allCases.length,
    resultsCompleted: results.length,
    provider: {
      ...providerMeta,
      usage: (baseProvider as { describe?: () => Record<string, unknown> }).describe?.() ?? providerMeta,
      cache: provider instanceof CachingEmbeddingProvider ? provider.stats : undefined,
    },
    providerNote: opts.provider === 'vertex'
      ? 'Vertex AI gemini-embedding-001 (768-d) per canonical benchmark protocol'
      : opts.provider === 'eval-hash'
        ? 'eval-hash lexical hash (256-d): offline wiring smoke only, no semantic-quality claim'
        : 'local e5 (Xenova/multilingual-e5-base 768-d)',
    qualityEligible: opts.provider !== 'eval-hash',
    topK,
    chunking: { maxTokens: 400, overlapTokens: 50 },
    corpusDirs: [...byCorpus.keys()],
    resultsSha256: sha256(jsonl(results)),
    perCaseSha256: sha256(jsonl(perCase)),
    gitSha: git.sha,
    gitDirty: git.dirty,
    evaluatorSha256: evaluator,
    startedAt, finishedAt,
    timing: {
      // per-conversation index time counted once (per-case rows repeat it for every case)
      totalIndexMs: Math.round(
        [...new Set(perCase.map(r => r.corpus))]
          .map(corpus => Math.max(...perCase.filter(r => r.corpus === corpus).map(r => Number(r.indexDurationMs ?? 0))))
          .reduce((s, v) => s + v, 0) * 100,
      ) / 100,
      totalRetrievalMs: Math.round(perCase.reduce((s, r) => s + Number(r.retrievalDurationMs ?? 0), 0) * 100) / 100,
    },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  await fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'cases.jsonl'), jsonl(allCases), 'utf8');
  emitCacheReport(buildCacheReport({ embedding: embeddingCallStats(provider) }), outputDir);
  console.log(JSON.stringify({ outputDir, results: results.length, cases: allCases.length }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});