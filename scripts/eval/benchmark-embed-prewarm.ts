#!/usr/bin/env node
/**
 * Part 1 of GOAL-better-all-benchmarks, write step: embed the texts that an inventory (benchmark-embed-inventory.ts
 * --emit-missing) found missing from the shared cache, with the product's provider (Vertex gemini-embedding-001,
 * 768-d) and the product's cache writer (CachingEmbeddingProvider), so every row lands under the key the runners read.
 * Rows a cache already holds are skipped by the cache itself, so a stopped run resumes from what it wrote.
 *
 * Money: --max-usd is a hard cap at list price. Before a batch goes out, its o200k token count is added to the planned
 * spend, and the batch waits if that would pass the cap. The Vertex provider also refuses once Vertex's own
 * `token_count` passes the same cap. Progress is written after every batch.
 *
 *   set -a; source ~/.config/agent-secrets/.env; set +a   # never print these values
 *   node --import tsx scripts/eval/benchmark-embed-prewarm.ts --missing /dev/shm/beam-1m-missing.jsonl \
 *     --cache ~/.local/share/renor/embed-cache.db --max-usd 5 --progress /dev/shm/beam-1m-progress.json
 *
 * Exit codes: 0 done, 3 stopped at the cap (rerun with a higher cap to continue), 1 failed.
 *
 * ON A SPOT VM, RUN IT IN BATCHES THROUGH gcp/durable-batches.sh (owner's order after 2026-10-26, when a preempted VM took
 * the only copy of a 5.6 GB cache with it). With --batch-index K --checkpoint-out DIR it embeds only batch K (texts
 * K*N .. K*N+N-1 of --missing, N = --checkpoint-texts), then writes DIR/cache-rows.db (the cache rows of this batch's
 * texts, by key, same table as the cache) and DIR/report.json. A rerun never empties or rewrites a completed batch. The driver copies DIR to the durable host and verifies it before it
 * starts batch K+1. What it wrote is exported even when the batch fails or stops at the cap. --max-usd still caps the whole
 * run: the planned tokens of the batches already in DIR's parent count against it. Exit 10: there is no batch K (done).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import { CachingEmbeddingProvider, exportRowsByKey } from '../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { MetadataVertexEmbeddingProvider } from './benchmark-embed-vertex';
import {
  EMBED_DIMENSIONS,
  TASK_DOCUMENT,
  embeddingKey,
  TASK_QUERY,
  USD_PER_MILLION_TOKENS,
  expandHome,
  usdForTokens,
  type MissingText,
} from './benchmark-embed-inventory';

/** A provider that reports the input tokens it has been billed for (VertexEmbeddingProvider does). */
export type MeteredProvider = EmbeddingProvider & { readonly usage?: { inputTokens: number } };

export interface PrewarmOptions {
  missingPath: string;
  cachePath: string;
  maxUsd: number;
  provider: MeteredProvider;
  /** Texts per batch. Default 320: ten provider requests of 32. */
  batchTexts?: number;
  /** Batches in flight at once. Default 4. */
  concurrency?: number;
  progressPath?: string;
  /** Only these lines of --missing (0-based start, count): one durable batch. */
  slice?: { start: number; count: number };
  /** Tokens earlier batches of the same run already planned: they count against the cap. */
  priorTokens?: number;
}

export interface PrewarmReport {
  status: 'running' | 'done' | 'capped' | 'failed' | 'nothing-left';
  total: number;
  done: number;
  documents: number;
  queries: number;
  plannedTokens: number;
  vertexInputTokens: number;
  plannedUsd: number;
  vertexUsd: number;
  capUsd: number;
  error?: string;
}

/** The token cap that a US$ cap buys at list price. */
export function capTokensFor(maxUsd: number): number {
  if (!(Number.isFinite(maxUsd) && maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  return Math.floor((maxUsd * 1_000_000) / USD_PER_MILLION_TOKENS);
}

async function countLines(file: string): Promise<number> {
  let n = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) n += 1;
  return n;
}

async function* readBatches(file: string, size: number, slice?: { start: number; count: number }): AsyncGenerator<MissingText[]> {
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let batch: MissingText[] = [];
  let index = -1;
  for await (const line of lines) {
    if (!line.trim()) continue;
    index += 1;
    if (slice && index < slice.start) continue;
    if (slice && index >= slice.start + slice.count) break;
    batch.push(JSON.parse(line) as MissingText);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

async function embedBatch(cache: CachingEmbeddingProvider, batch: MissingText[]): Promise<void> {
  const documents = batch.filter(row => row.task === TASK_DOCUMENT).map(row => row.text);
  if (documents.length > 0) await cache.embed(documents);
  for (const row of batch) {
    if (row.task === TASK_QUERY) await cache.embedQuery(row.text);
  }
}

function writeProgress(file: string, report: PrewarmReport): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export async function prewarm(options: PrewarmOptions): Promise<PrewarmReport> {
  const capTokens = capTokensFor(options.maxUsd);
  const batchTexts = options.batchTexts ?? 320;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(batchTexts) || batchTexts < 1) throw new Error('batchTexts must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const priorTokens = options.priorTokens ?? 0;
  const lineCount = await countLines(options.missingPath);
  const total = options.slice ? Math.max(0, Math.min(options.slice.count, lineCount - options.slice.start)) : lineCount;
  const cache = new CachingEmbeddingProvider(options.provider, { cachePath: options.cachePath });
  const report: PrewarmReport = {
    status: 'running',
    total,
    done: 0,
    documents: 0,
    queries: 0,
    plannedTokens: 0,
    vertexInputTokens: 0,
    plannedUsd: 0,
    vertexUsd: 0,
    capUsd: options.maxUsd,
  };
  const refresh = (): void => {
    report.vertexInputTokens = options.provider.usage?.inputTokens ?? 0;
    report.plannedUsd = usdForTokens(report.plannedTokens);
    report.vertexUsd = usdForTokens(report.vertexInputTokens);
    if (options.progressPath) writeProgress(expandHome(options.progressPath), report);
  };
  const inFlight = new Set<Promise<void>>();
  let failure: unknown;
  try {
    for await (const batch of readBatches(options.missingPath, batchTexts, options.slice)) {
      if (failure !== undefined) break;
      const cost = batch.reduce((sum, row) => sum + row.tokens, 0);
      if (priorTokens + report.plannedTokens + cost > capTokens) {
        report.status = 'capped';
        break;
      }
      report.plannedTokens += cost;
      while (inFlight.size >= concurrency) await Promise.race(inFlight);
      const job = embedBatch(cache, batch).then(
        () => {
          report.done += batch.length;
          report.documents += batch.filter(row => row.task === TASK_DOCUMENT).length;
          report.queries += batch.filter(row => row.task === TASK_QUERY).length;
          refresh();
        },
        error => {
          failure = error;
        },
      );
      inFlight.add(job);
      void job.finally(() => inFlight.delete(job));
    }
    await Promise.all(inFlight);
    if (failure !== undefined) {
      report.status = 'failed';
      report.error = failure instanceof Error ? failure.message : String(failure);
    }
    if (report.status === 'running') report.status = 'done';
    refresh();
    return report;
  } finally {
    cache.close();
  }
}

/** Tokens the other batches of this run (the batch-* directories beside `checkpointOut`) planned, from their report.json. */
export function plannedByOtherBatches(checkpointOut: string): number {
  const parent = path.dirname(checkpointOut);
  if (!fs.existsSync(parent)) return 0;
  let sum = 0;
  for (const name of fs.readdirSync(parent)) {
    const dir = path.join(parent, name);
    if (!name.startsWith('batch-') || path.resolve(dir) === path.resolve(checkpointOut)) continue;
    const file = path.join(dir, 'report.json');
    if (!fs.existsSync(file)) continue;
    const planned = (JSON.parse(fs.readFileSync(file, 'utf8')) as { plannedTokens?: unknown }).plannedTokens;
    if (typeof planned === 'number' && Number.isFinite(planned)) sum += planned;
  }
  return sum;
}

export interface CheckpointReport extends PrewarmReport {
  batchIndex: number;
  /** This batch's rows found in the cache, all of them in checkpointOut/cache-rows.db. */
  rowsExported: number;
}

/** Writes `value` as JSON to `file` through a temporary file and a rename, so a crash leaves the old file or the new one whole. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The cache keys of the texts in lines [start, start + count) of --missing: the rows one batch owns. */
async function sliceKeys(missingPath: string, start: number, count: number): Promise<string[]> {
  const keys: string[] = [];
  for await (const batch of readBatches(missingPath, 1024, { start, count })) {
    for (const row of batch) keys.push(embeddingKey(row.task, row.text));
  }
  return keys;
}

/**
 * One durable batch: embeds batch `batchIndex` of `checkpointTexts` texts, then exports its rows to
 * `checkpointOut`/cache-rows.db and writes `checkpointOut`/report.json, whatever the batch's outcome. `nothing-left` (and
 * no files) when the batch starts past the end of --missing.
 *
 * Safe to rerun after a crash at any point: a batch whose report.json says `done` is returned as it is and nothing in
 * `checkpointOut` is touched (it may already be on the durable host). Otherwise the rows are exported BY KEY, so a rerun
 * that finds them already cached still exports every one of them, and both files are replaced atomically (report.json
 * last: its presence marks the batch complete).
 */
export async function prewarmBatch(
  options: Omit<PrewarmOptions, 'slice' | 'priorTokens'> & { batchIndex: number; checkpointTexts: number; checkpointOut: string },
): Promise<CheckpointReport> {
  const { batchIndex, checkpointTexts, checkpointOut } = options;
  if (!Number.isInteger(batchIndex) || batchIndex < 0) throw new Error('--batch-index must be a non-negative integer');
  if (!Number.isInteger(checkpointTexts) || checkpointTexts < 1) throw new Error('--checkpoint-texts must be a positive integer');
  const start = batchIndex * checkpointTexts;
  if (start >= await countLines(options.missingPath)) {
    return {
      status: 'nothing-left', total: 0, done: 0, documents: 0, queries: 0, plannedTokens: 0, vertexInputTokens: 0,
      plannedUsd: 0, vertexUsd: 0, capUsd: options.maxUsd, batchIndex, rowsExported: 0,
    };
  }
  const reportFile = path.join(checkpointOut, 'report.json');
  if (fs.existsSync(reportFile)) {
    const earlier = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as CheckpointReport;
    if (earlier.status === 'done' && earlier.batchIndex === batchIndex) return earlier;
  }
  fs.mkdirSync(checkpointOut, { recursive: true });
  let report: PrewarmReport;
  try {
    report = await prewarm({
      ...options,
      slice: { start, count: checkpointTexts },
      priorTokens: plannedByOtherBatches(checkpointOut),
    });
  } catch (error) {
    report = {
      status: 'failed', total: 0, done: 0, documents: 0, queries: 0, plannedTokens: 0, vertexInputTokens: 0,
      plannedUsd: 0, vertexUsd: 0, capUsd: options.maxUsd, error: error instanceof Error ? error.message : String(error),
    };
  }
  const keys = await sliceKeys(options.missingPath, start, checkpointTexts);
  const rowsExported = exportRowsByKey(options.cachePath, keys, path.join(checkpointOut, 'cache-rows.db'));
  const result: CheckpointReport = { ...report, batchIndex, rowsExported };
  writeJsonAtomic(reportFile, result);
  return result;
}

export async function runPrewarmCli(argv: string[]): Promise<PrewarmReport> {
  const program = new Command()
    .requiredOption('--missing <file>', 'the JSONL the inventory wrote with --emit-missing')
    .requiredOption('--cache <file>', 'the embedding cache to write (the product path reads it)')
    .requiredOption('--max-usd <n>', 'hard cap on this run, in US$ at list price', (v: string) => Number(v))
    .option('--batch-texts <n>', 'texts per batch', (v: string) => Number(v), 320)
    .option('--concurrency <n>', 'batches in flight', (v: string) => Number(v), 4)
    .option('--progress <file>', 'write a progress JSON here, rewritten after every batch')
    .option('--auth <kind>', 'keyfile (GOOGLE_APPLICATION_CREDENTIALS) or metadata (the instance service account)', 'keyfile')
    .option('--vertex-project <id>', 'Vertex project for --auth metadata (default RENOR_EVAL_VERTEX_PROJECT)')
    .option('--vertex-location <loc>', 'Vertex location for --auth metadata (default RENOR_EVAL_VERTEX_LOCATION)')
    .option('--batch-index <k>', 'durable batch mode (gcp/durable-batches.sh): embed only batch k', (v: string) => Number(v))
    .option('--checkpoint-out <dir>', 'durable batch mode: write this batch\'s cache rows and report here')
    .option('--checkpoint-texts <n>', 'durable batch mode: texts per batch', (v: string) => Number(v), 1280)
    .parse(argv, { from: 'user' });
  const opts = program.opts() as {
    missing: string; cache: string; maxUsd: number; batchTexts: number; concurrency: number; progress?: string;
    auth: string; vertexProject?: string; vertexLocation?: string;
    batchIndex?: number; checkpointOut?: string; checkpointTexts: number;
  };
  if (opts.auth !== 'keyfile' && opts.auth !== 'metadata') throw new Error('--auth must be keyfile or metadata');
  if ((opts.batchIndex === undefined) !== (opts.checkpointOut === undefined)) {
    throw new Error('--batch-index and --checkpoint-out go together (durable batch mode)');
  }
  const run = (common: Omit<PrewarmOptions, 'slice' | 'priorTokens'>): Promise<PrewarmReport> =>
    opts.batchIndex !== undefined && opts.checkpointOut !== undefined
      ? prewarmBatch({ ...common, batchIndex: opts.batchIndex, checkpointTexts: opts.checkpointTexts, checkpointOut: expandHome(opts.checkpointOut) })
      : prewarm(common);
  const report = await run({
    missingPath: expandHome(opts.missing),
    cachePath: expandHome(opts.cache),
    maxUsd: opts.maxUsd,
    provider: opts.auth === 'metadata'
      ? new MetadataVertexEmbeddingProvider({
        project: opts.vertexProject ?? process.env.RENOR_EVAL_VERTEX_PROJECT ?? '',
        location: opts.vertexLocation ?? process.env.RENOR_EVAL_VERTEX_LOCATION ?? '',
        maxInputTokens: capTokensFor(opts.maxUsd),
      })
      : new VertexEmbeddingProvider({
        model: 'gemini-embedding-001',
        dimensions: EMBED_DIMENSIONS,
        maxInputTokens: capTokensFor(opts.maxUsd),
      }),
    batchTexts: opts.batchTexts,
    concurrency: opts.concurrency,
    progressPath: opts.progress,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedDirectly = process.argv[1]?.endsWith('benchmark-embed-prewarm.ts') === true;
if (invokedDirectly) {
  runPrewarmCli(process.argv.slice(2))
    .then(report => {
      process.exitCode = report.status === 'done' ? 0 : report.status === 'capped' ? 3 : report.status === 'nothing-left' ? 10 : 1;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
