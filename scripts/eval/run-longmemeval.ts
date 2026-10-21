import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { attachSearchEvidence, evidenceItemsToFactRows, searchEvidenceEnabled } from '../../src/evidence/attach';
import { createEvidenceExtractor, resolveEvidenceToolOptions } from '../../src/evidence/options';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';

import { type LongMemTurn, type LongMemInstance, parseTimestamp, validateLongMemRows } from '../../src/eval/longmemeval';
import { claimDirectory, safeEndpoint, sha256 as sha256Buffer } from '../../src/eval/artifacts';
import { evaluatorSourceHash, gitState, packageLockSha256, researchTruthFields } from '../../src/eval/runManifest';
import { admitRun, archiveRow, codeIdentity, productEnvironment, questionSet, recordRun, resolveRunLedgerPath, RUN_LEDGER_ENV, RunRefusedError, saveRunOutcome } from '../../src/eval/runLedger';

/** The code a retrieval run executes in-process: the product indexer/retrieval/evidence code, this runner and the locked dependencies. */
const RETRIEVAL_RUN_CODE_ROOTS = ['src', 'scripts/eval/run-longmemeval.ts', 'package-lock.json'] as const;

interface ProviderMeta {
  kind: 'local' | 'openai' | 'vertex';
  model: string;
  dimensions: number;
  baseURL?: string;
}

function providerDescribe(provider: unknown): Record<string, unknown> {
  const described = (provider as { describe?: () => Record<string, unknown> }).describe?.();
  if (!described) throw new Error('Vertex runs must record provider usage in the manifest');
  return described;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const prefix = normalized.slice(0, 100) || 'session';
  return `${prefix}-${sha256(value).slice(0, 10)}`;
}

function renderSession(id: string, date: string, turns: LongMemTurn[]): string {
  const body = turns.map((turn, index) => {
    const role = turn.role === 'assistant' ? 'Assistant' : turn.role === 'user' ? 'User' : turn.role;
    return `### Turn ${index + 1} — ${role}\n\n${turn.content}`;
  }).join('\n\n');
  return `---\nkind: longmemeval-session\nsession_id: ${JSON.stringify(id)}\nsession_date: ${JSON.stringify(date)}\n---\n# Session ${id}\n\nTimestamp: ${date}\n\n${body}\n`;
}

function makeProvider(kind: string, modelArg?: string): { provider: EmbeddingProvider; meta: ProviderMeta } {
  if (kind === 'local') {
    const model = modelArg ?? process.env.RENOR_EVAL_MODEL ?? 'Xenova/multilingual-e5-base';
    const provider = new LocalEmbeddingProvider(model);
    return { provider, meta: { kind: 'local', model, dimensions: provider.dimensions } };
  }

  if (kind === 'vertex') {
    const provider = new VertexEmbeddingProvider();
    return {
      provider,
      meta: {
        kind: 'vertex',
        model: provider.model,
        dimensions: provider.dimensions,
        ...(kind === 'vertex' ? { location: provider.describe().location } : {}),
      } as ProviderMeta,
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
    return { provider, meta: { kind: 'openai', model, dimensions, baseURL } };
  }

  throw new Error(`Unknown provider ${kind}; expected local or openai`);
}

function selectShard<T>(rows: T[], shardIndex: number, shardCount: number): T[] {
  return rows.filter((_, index) => index % shardCount === shardIndex);
}

function jsonl(rows: unknown[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

async function writeQuestionVault(root: string, row: LongMemInstance): Promise<Map<string, string>> {
  if (row.haystack_session_ids.length !== row.haystack_sessions.length
      || row.haystack_dates.length !== row.haystack_sessions.length) {
    throw new Error(`Malformed LongMemEval instance ${row.question_id}: haystack arrays differ in length`);
  }

  const sessionPaths = new Map<string, string>();
  const sessionsDir = path.join(root, 'Sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const occurrences = new Map<string, number>();

  for (let index = 0; index < row.haystack_sessions.length; index++) {
    const id = row.haystack_session_ids[index];
    const dateText = row.haystack_dates[index];
    const nth = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, nth);
    // Repeated noise sessions get an occurrence suffix so no haystack content is
    // silently overwritten; answer sessions are unique (validated), so their
    // canonical filename is reserved for the first occurrence.
    const segment = nth === 1 ? safeSegment(id) : `${safeSegment(id)}-occ${nth}`;
    const relative = `Sessions/${segment}.md`;
    const full = path.join(root, relative);
    await fsp.writeFile(full, renderSession(id, dateText, row.haystack_sessions[index]), 'utf8');
    const timestamp = parseTimestamp(dateText);
    await fsp.utimes(full, timestamp, timestamp);
    if (nth === 1) sessionPaths.set(id, relative);
  }
  return sessionPaths;
}

async function main(): Promise<void> {
  const program = new Command()
    .name('run-longmemeval')
    .requiredOption('--dataset <path>', 'path to official longmemeval_s.json')
    .option('--provider <kind>', 'embedding provider: vertex (default, cached), local, or openai', process.env.RENOR_EVAL_PROVIDER ?? 'vertex')
    .option('--model <name>', 'embedding model override')
    .option('--top-k <n>', 'retrieval depth', '10')
    .option('--limit <n>', 'maximum selected questions after sharding; 0 = all', '20')
    .option('--offset <n>', 'skip selected questions before limit', '0')
    .option('--shard-index <n>', 'zero-based shard index', '0')
    .option('--shard-count <n>', 'number of deterministic shards', '1')
    .option('--include-abstention', 'include _abs cases in Renor abstention scoring; official retrieval normally skips them')
    .option('--output <path>', 'artifact directory; default .eval-runs/longmemeval-<timestamp>')
    .option('--keep-workdirs', 'preserve per-question temporary vaults/databases for debugging')
    .option('--product-evidence', 'run the shipped search-path evidence attach (RENOR_SEARCH_EVIDENCE) after retrieval; hydrates full markdown notes, not dataset turns')
    .option('--product-evidence-on-abstention', 'do not use the benchmark abstention label to skip evidence; let the shipped gold-blind gate decide')
    .option('--rerun-reason <text>', `run even though this exact configuration is already on the run ledger (${RUN_LEDGER_ENV}); the reason is recorded with the run`)
    .parse(process.argv);

  const opts = program.opts<{
    dataset: string;
    provider: string;
    model?: string;
    topK: string;
    limit: string;
    offset: string;
    shardIndex: string;
    shardCount: string;
    includeAbstention?: boolean;
    output?: string;
    keepWorkdirs?: boolean;
    productEvidence?: boolean;
    productEvidenceOnAbstention?: boolean;
    rerunReason?: string;
  }>();

  const repoRoot = process.cwd();
  const datasetPath = path.resolve(opts.dataset);
  const datasetBytes = await fsp.readFile(datasetPath);
  const allRows = JSON.parse(datasetBytes.toString('utf8')) as LongMemInstance[];
  validateLongMemRows(allRows);
  const git = gitState(repoRoot);
  const evaluator = evaluatorSourceHash(repoRoot);
  const revision = git.sha;
  const concurrency = Number(process.env.RENOR_EVAL_INDEX_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid index concurrency');

  const topK = Number(opts.topK);
  const limit = Number(opts.limit);
  const offset = Number(opts.offset);
  const shardIndex = Number(opts.shardIndex);
  const shardCount = Number(opts.shardCount);
  for (const [name, value, min] of [
    ['top-k', topK, 1],
    ['limit', limit, 0],
    ['offset', offset, 0],
    ['shard-index', shardIndex, 0],
    ['shard-count', shardCount, 1],
  ] as Array<[string, number, number]>) {
    if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`);
  }
  if (shardIndex >= shardCount) throw new Error('--shard-index must be smaller than --shard-count');

  const sharded = selectShard(allRows, shardIndex, shardCount);
  const selected = sharded.slice(offset, limit === 0 ? undefined : offset + limit);
  if (selected.length === 0) throw new Error('No LongMemEval instances selected');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(opts.output ?? path.join('.eval-runs', `longmemeval-${timestamp}`));

  const { provider, meta: providerMeta } = makeProvider(opts.provider, opts.model);
  const productEvidence = Boolean(opts.productEvidence) || searchEvidenceEnabled();
  if (opts.productEvidence) process.env.RENOR_SEARCH_EVIDENCE = '1';
  // The engine's unset evidence mode is off (src/evidence/gate.ts); an evidence arm keeps the hosted value, always.
  if (productEvidence && !process.env.RENOR_EVIDENCE_MODE?.trim()) process.env.RENOR_EVIDENCE_MODE = 'always';
  const evidenceCacheShared = Boolean(process.env.RENOR_EVIDENCE_CACHE?.trim());
  const evidenceCachePath = process.env.RENOR_EVIDENCE_CACHE?.trim()
    || path.join(outputDir, 'evidence-cache.db');
  if (productEvidence && !process.env.RENOR_EVIDENCE_CACHE) {
    process.env.RENOR_EVIDENCE_CACHE = evidenceCachePath;
  }
  const evidenceOptions = productEvidence
    ? resolveEvidenceToolOptions({ dbPath: path.join(outputDir, 'index.db') })
    : null;
  // Before the output directory is claimed or any provider is called: a
  // configuration already on the run ledger is refused (src/eval/runLedger.ts).
  // This runner has no resume, so every run is a new one.
  const admission = admitRun({
    ledgerPath: resolveRunLedgerPath(process.env),
    runner: 'longmemeval-retrieval',
    config: {
      runner: 'longmemeval-retrieval',
      benchmark: 'longmemeval-s-retrieval',
      datasetSha256: sha256(datasetBytes),
      questions: questionSet(selected.map(row => row.question_id)),
      includeAbstention: Boolean(opts.includeAbstention),
      provider: providerMeta,
      topK,
      chunking: { maxTokens: 400, overlapTokens: 50 },
      indexConcurrency: concurrency,
      // The product code runs in this process and reads its settings from this environment
      // (RENOR_NEWEST_FIRST, RENOR_TEMPORAL_RANKING, ...), including what this runner set above.
      productEnv: productEnvironment(process.env),
      evidence: evidenceOptions
        ? {
            mode: evidenceOptions.mode,
            model: evidenceOptions.model,
            maxSessions: evidenceOptions.maxSessions,
            charCap: evidenceOptions.charCap,
            baseUrl: process.env.RENOR_EVIDENCE_BASE_URL ?? null,
            extractorConfigured: Boolean(evidenceOptions.chat),
            cacheShared: evidenceCacheShared,
            goldBlindAbstention: Boolean(opts.productEvidenceOnAbstention),
          }
        : null,
      codeSha256: codeIdentity(repoRoot, RETRIEVAL_RUN_CODE_ROOTS),
    },
    outputDir,
    resuming: false,
    rerunReason: opts.rerunReason,
  });
  claimDirectory(outputDir);
  // On the ledger before the first provider call, so a run that is killed is still on record.
  const ledgerRecord = recordRun(admission, { gitSha: git.sha, gitDirty: git.dirty, perQuestionResults: path.join(outputDir, 'results.jsonl') });

  // Embedding cache: re-runs of the same corpus must not re-pay the provider. With the cache off the calls are
  // still counted for the cache report.
  const cachePath = resolveEmbeddingCachePath();
  const embeddingProvider = cachePath
    ? new CachingEmbeddingProvider(provider, { cachePath })
    : new CountingEmbeddingProvider(provider);
  const results: EvalResult[] = [];
  const retrievalOnlyResults: EvalResult[] = [];
  const cases: EvalCase[] = [];
  const perCase: Array<Record<string, unknown>> = [];
  const startedAt = new Date().toISOString();
  const evidenceExtractor = evidenceOptions ? createEvidenceExtractor(evidenceOptions) : null;
  const evidenceFacts: Record<string, ReturnType<typeof evidenceItemsToFactRows>> = {};
  const evidencePerCase: Array<Record<string, unknown>> = [];

  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
    const row = selected[selectedIndex];
    const isAbstention = row.question_id.endsWith('_abs');
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-longmemeval-'));
    const vaultDir = path.join(workDir, 'vault');
    const dbPath = path.join(workDir, 'index.db');
    let db: ReturnType<typeof openDb> | undefined;

    try {
      await fsp.mkdir(vaultDir, { recursive: true });
      db = openDb(dbPath);
      const sessionPaths = await writeQuestionVault(vaultDir, row);
      const missingAnswers = row.answer_session_ids.filter(id => !sessionPaths.has(id));
      if (!isAbstention && missingAnswers.length > 0) {
        throw new Error(`${row.question_id}: answer session ids absent from haystack: ${missingAnswers.join(', ')}`);
      }

      runMigrations(db);
      const vectorIndex = new VectorIndex(db, provider.dimensions);
      vectorIndex.initTable();
      const indexStarted = performance.now();
      const indexStats = await indexVault(
        db,
        vaultDir,
        {
          embeddingProvider: embeddingProvider,
          vectorIndex,
          chunkOptions: { maxTokens: 400, overlapTokens: 50 },
        },
        concurrency,
      );
      const indexDurationMs = performance.now() - indexStarted;
      if (indexStats.errors > 0) throw new Error(`${row.question_id}: indexing had ${indexStats.errors} error(s)`);

      const query = `Question date: ${row.question_date}\n${row.question}`;
      const retrievalStarted = performance.now();
      const retrieved = await retrieveContext(db, vectorIndex, embeddingProvider, query, topK, [], { nowMs: parseTimestamp(row.question_date).getTime() });
      const retrievalDurationMs = performance.now() - retrievalStarted;
      const evidenceStarted = performance.now();
      const runGoldBlindAbstention = isAbstention && Boolean(opts.productEvidenceOnAbstention);
      const attached = productEvidence && evidenceOptions && (!isAbstention || runGoldBlindAbstention)
        ? await attachSearchEvidence({
            query: row.question,
            hits: retrieved.hits,
            vaultPath: vaultDir,
            options: evidenceOptions,
            extractor: evidenceExtractor,
            enabled: true,
            force: !isAbstention,
          })
        : {
            hits: retrieved.hits,
            evidence: {
              status: 'skipped' as const,
              reason: !productEvidence ? 'flag-off' as const : isAbstention ? 'intent' as const : 'flag-off' as const,
            },
          };
      const evidenceDurationMs = performance.now() - evidenceStarted;
      const toEvalHit = (hit: typeof retrieved.hits[number]) => ({
        text: hit.text,
        notePath: hit.notePath.startsWith('_renor/')
          ? hit.notePath
          : path.relative(vaultDir, hit.notePath).replaceAll(path.sep, '/'),
        score: hit.score,
        reason: hit.reason,
        ...(hit.session_date ? { session_date: hit.session_date } : {}),
      });
      const hits = attached.hits.map(toEvalHit);
      const retrievalHits = retrieved.hits.map(toEvalHit);
      const contextTokens = countTextTokens(hits.map(hit => hit.text ?? '').join('\n\n'));
      const retrievalContextTokens = countTextTokens(retrievalHits.map(hit => hit.text ?? '').join('\n\n'));
      if (attached.evidence.status === 'ok' && attached.evidence.items) {
        evidenceFacts[row.question_id] = evidenceItemsToFactRows(attached.evidence.items);
      }
      evidencePerCase.push({
        id: row.question_id,
        status: attached.evidence.status,
        reason: attached.evidence.reason ?? null,
        fromCache: attached.evidence.fromCache ?? false,
        itemCount: attached.evidence.items?.length ?? 0,
        sessionCount: attached.evidence.sessions?.length ?? 0,
        promptTokens: attached.evidence.usage?.promptTokens ?? 0,
        completionTokens: attached.evidence.usage?.completionTokens ?? 0,
        extractorLatencyMs: attached.evidence.latencyMs ?? 0,
        attachDurationMs: Math.round(evidenceDurationMs * 100) / 100,
        retrievalDurationMs: Math.round(retrievalDurationMs * 100) / 100,
      });

      const relevant = (isAbstention ? [] : row.answer_session_ids).map(id => ({
        match: safeSegment(id),
        notePath: sessionPaths.get(id),
        relevance: 1,
        // LongMemEval answer sessions are ungraded gold evidence, not
        // superseded contradictions: without an explicit role, relevance 1
        // defaults to forbidden under RenorBench role semantics and every
        // binary metric would score zero.
        role: 'positive' as const,
      }));
      cases.push({
        id: row.question_id,
        category: isAbstention ? 'abstention' : row.question_type,
        query,
        relevant,
        expectedAnswer: row.answer,
        shouldAbstain: isAbstention,
        split: 'test',
      });
      const result: EvalResult = {
        id: row.question_id,
        hits,
        latencyMs: retrievalDurationMs,
        contextTokens,
      };
      results.push(result);
      // Into the run's archive as it is produced, so a run that stops halfway still leaves its rows.
      archiveRow(ledgerRecord, JSON.stringify(result));
      retrievalOnlyResults.push({
        id: row.question_id,
        hits: retrievalHits,
        latencyMs: retrievalDurationMs,
        contextTokens: retrievalContextTokens,
      });
      perCase.push({
        id: row.question_id,
        questionType: row.question_type,
        abstention: isAbstention,
        sessions: row.haystack_sessions.length,
        indexDurationMs: Math.round(indexDurationMs * 100) / 100,
        retrievalDurationMs: Math.round(retrievalDurationMs * 100) / 100,
        evidenceDurationMs: Math.round(evidenceDurationMs * 100) / 100,
        evidenceStatus: attached.evidence.status,
        evidenceFromCache: attached.evidence.fromCache ?? false,
        contextTokens,
        notesIndexed: indexStats.indexed,
        chunks: (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c,
      });
      process.stderr.write(`[LongMemEval] ${selectedIndex + 1}/${selected.length} ${row.question_id} indexed=${indexStats.indexed} retrieval=${retrievalDurationMs.toFixed(1)}ms\n`);
    } finally {
      db?.close();
      if (!opts.keepWorkdirs) await fsp.rm(workDir, { recursive: true, force: true });
      else process.stderr.write(`[LongMemEval] kept ${workDir}\n`);
    }
  }

  const scoredPairs = cases
    .map((test, index) => ({ test, result: results[index] }))
    .filter(pair => opts.includeAbstention || !pair.test.shouldAbstain);
  const scoredCases = scoredPairs.map(pair => pair.test);
  const scoredResults = scoredPairs.map(pair => pair.result);
  if (!scoredCases.length) throw new Error('No answerable questions selected; no retrieval score');
  const summary = scoreRetrieval(scoredCases, scoredResults);
  const finishedAt = new Date().toISOString();
  const totalIndexMs = perCase.reduce((sum, item) => sum + Number(item.indexDurationMs ?? 0), 0);
  const totalRetrievalMs = perCase.reduce((sum, item) => sum + Number(item.retrievalDurationMs ?? 0), 0);

  if (revision !== gitState(repoRoot).sha || evaluator !== evaluatorSourceHash(repoRoot)
      || sha256Buffer(datasetBytes) !== sha256Buffer(await fsp.readFile(datasetPath))) throw new Error('Source/dataset changed during run');
  const manifest = {
    // Product-truth contract: this runner is and stays RESEARCH execution.
    ...researchTruthFields({
      coverage: { casesTotal: selected.length, casesCompleted: perCase.length, answerErrors: 0, judgeParseFailures: 0 },
      cache: null,
    }),
    packageLockSha256: packageLockSha256(repoRoot),
    schemaVersion: 2,
    benchmark: 'longmemeval-s-retrieval',
    metricProtocol: 'renor-chunk-to-evidence-session-v1-not-official',
    includeAbstention: Boolean(opts.includeAbstention),
    selectionIds: selected.map(row => row.question_id),
    datasetIds: allRows.map(row => row.question_id),
    conditions: { concurrency, recencyClock: 'question_date/UTC', tokenEstimator: 'gpt-tokenizer/join-text-v1' },
    resultsSha256: sha256(jsonl(results)),
    caseSnapshotSha256: sha256(jsonl(cases)),
    perCaseSha256: sha256(jsonl(perCase)),
    gitSha: revision,
    gitDirty: git.dirty,
    gitStatusSha256: git.statusSha256,
    evaluatorSha256: evaluator,
    startedAt,
    finishedAt,
    datasetPath: path.basename(datasetPath),
    datasetSha256: sha256(datasetBytes),
    fullDatasetCases: allRows.length,
    selectedCases: selected.length,
    scoredCases: scoredCases.length,
    abstentionCasesExcludedFromOfficialStyleRetrieval: opts.includeAbstention
      ? 0
      : cases.filter(test => test.shouldAbstain).length,
    shard: { index: shardIndex, count: shardCount, offset, limit },
    provider: providerDescribe(embeddingProvider),
    topK,
    productEvidence,
    evidence: productEvidence ? {
      mode: evidenceOptions?.mode ?? null,
      model: evidenceOptions?.model ?? null,
      maxSessions: evidenceOptions?.maxSessions ?? null,
      charCap: evidenceOptions?.charCap ?? null,
      cachePath: evidenceCachePath,
      searchEvidence: true,
      forceAnswerable: true,
      goldBlindAbstention: Boolean(opts.productEvidenceOnAbstention),
      hydration: 'full-source-note',
    } : undefined,
    chunking: { maxTokens: 400, overlapTokens: 50 },
    timing: {
      totalIndexMs: Math.round(totalIndexMs * 100) / 100,
      totalRetrievalMs: Math.round(totalRetrievalMs * 100) / 100,
    },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };

  await Promise.all([
    fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(outputDir, 'cases.jsonl'), jsonl(cases), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'results.jsonl'), jsonl(results), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'per-case.jsonl'), jsonl(perCase), 'utf8'),
    fsp.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8'),
    ...(productEvidence ? [
      fsp.writeFile(path.join(outputDir, 'evidence.jsonl'), jsonl(evidencePerCase), 'utf8'),
      fsp.writeFile(path.join(outputDir, 'facts-product-v4.json'), JSON.stringify(evidenceFacts, null, 1) + '\n', 'utf8'),
      fsp.writeFile(path.join(outputDir, 'results-retrieval-only.jsonl'), jsonl(retrievalOnlyResults), 'utf8'),
    ] : []),
  ]);

  const evidenceRuns = evidencePerCase.filter(c => c.status === 'ok');
  emitCacheReport(buildCacheReport({
    embedding: embeddingCallStats(embeddingProvider),
    evidence: productEvidence ? { hits: evidenceRuns.filter(c => c.fromCache).length, misses: evidenceRuns.filter(c => !c.fromCache).length } : undefined,
    evidenceCacheShared,
  }), outputDir);
  saveRunOutcome(ledgerRecord, {
    status: 'complete',
    finishedAt,
    casesTotal: selected.length,
    casesCompleted: perCase.length,
    metrics: summary.overall,
  });
  console.log(JSON.stringify({ outputDir, manifest, summary }, null, 2));
}

main().catch(error => {
  console.error(error instanceof RunRefusedError ? error.message : error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
