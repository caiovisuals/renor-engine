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
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { Command } from 'commander';
import { CachingEmbeddingProvider } from '../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { MetadataVertexEmbeddingProvider } from './benchmark-embed-vertex';
import {
  EMBED_DIMENSIONS,
  TASK_DOCUMENT,
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
}

export interface PrewarmReport {
  status: 'running' | 'done' | 'capped' | 'failed';
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

async function* readBatches(file: string, size: number): AsyncGenerator<MissingText[]> {
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let batch: MissingText[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
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
  const cache = new CachingEmbeddingProvider(options.provider, { cachePath: options.cachePath });
  const report: PrewarmReport = {
    status: 'running',
    total: await countLines(options.missingPath),
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
    for await (const batch of readBatches(options.missingPath, batchTexts)) {
      if (failure !== undefined) break;
      const cost = batch.reduce((sum, row) => sum + row.tokens, 0);
      if (report.plannedTokens + cost > capTokens) {
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
    .parse(argv, { from: 'user' });
  const opts = program.opts() as {
    missing: string; cache: string; maxUsd: number; batchTexts: number; concurrency: number; progress?: string;
    auth: string; vertexProject?: string; vertexLocation?: string;
  };
  if (opts.auth !== 'keyfile' && opts.auth !== 'metadata') throw new Error('--auth must be keyfile or metadata');
  const report = await prewarm({
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
      process.exitCode = report.status === 'done' ? 0 : report.status === 'capped' ? 3 : 1;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
