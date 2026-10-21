#!/usr/bin/env node
/**
 * Part 1 of GOAL-better-all-benchmarks, inventory step: count the distinct texts the PRODUCT would embed for one
 * benchmark corpus, subtract what the shared Vertex cache already holds, and price the rest at the list price.
 * Records only: it calls no provider, writes no cache row, and opens every cache file read-only.
 *
 * The texts are the product's own. A corpus of markdown notes is parsed and chunked with the indexer's `parseNote`
 * and `chunkNote`; a LongMemEval dataset is rendered with the product runner's `renderSession`. A query is the text
 * the product searches with (`Question date: <date>` then the question) and is embedded as RETRIEVAL_QUERY. Keys
 * follow src/embeddings/caching.ts: sha256 over namespace, task, dimensions and text, namespace
 * `vertex/gemini-embedding-001/768`, so a text the cache already holds under that key is not paid for again.
 *
 *   node --import tsx scripts/eval/benchmark-embed-inventory.ts --corpus longmemeval --label longmemeval-s \
 *     --source ~/bench-data/longmemeval_s.json --cache ~/.local/share/renor/embed-cache.db \
 *     --cache ~/bench-data/stack-cache/embed-cache.db --out plan.json
 *   node --import tsx scripts/eval/benchmark-embed-inventory.ts --corpus notes --label beam-1m \
 *     --source <dir of conv-NN/Sessions/*.md> --queries <cases.jsonl> --query-field question \
 *     --cache <db> --out plan.json --emit-missing /dev/shm/beam-1m-missing.jsonl
 *
 * Token counts are the chunker's own o200k counts (the counter the spend guard uses). Vertex bills its own
 * `token_count`, so the priced figure is an estimate until a write run reports Vertex's count.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { type LongMemInstance, validateLongMemRows } from '../../src/eval/longmemeval';
import { chunkNote } from '../../src/indexer/chunker';
import { countO200k } from '../../src/indexer/o200k';
import { parseNote } from '../../src/indexer/parser';
import { renderSession, safeSegment } from './run-longmemeval-product';

export const EMBED_NAMESPACE = 'vertex/gemini-embedding-001/768';
export const EMBED_DIMENSIONS = 768;
/** A float32 vector as the cache stores it: 768 values, four bytes each. */
export const EMBED_VECTOR_BYTES = EMBED_DIMENSIONS * 4;
export const TASK_DOCUMENT = 'RETRIEVAL_DOCUMENT';
export const TASK_QUERY = 'RETRIEVAL_QUERY';
/** Vertex list price of gemini-embedding-001 input, US$ per 1M tokens (data/renor-gcp-credits/report.md, section 1). */
export const USD_PER_MILLION_TOKENS = 0.15;
/** Banco Central PTAX selling rate used by that credit report, R$ per US$ (2026-10-13). */
export const PTAX_BRL_PER_USD = 5.0096;

export type EmbedTask = typeof TASK_DOCUMENT | typeof TASK_QUERY;

export interface MissingText {
  task: EmbedTask;
  text: string;
  tokens: number;
}

/** The key src/embeddings/caching.ts writes for a text: sha256 over namespace, task, dimensions and text. */
export function embeddingKey(task: EmbedTask, text: string): string {
  return crypto.createHash('sha256').update(`${EMBED_NAMESPACE}\0${task}\0${EMBED_DIMENSIONS}\0${text}`).digest('hex');
}

export function usdForTokens(tokens: number): number {
  return (tokens * USD_PER_MILLION_TOKENS) / 1_000_000;
}

/**
 * The product's chunking, as its CLI reads it (src/config.ts): CHUNK_MAX_TOKENS (default 400) and CHUNK_OVERLAP_TOKENS
 * (default 50). A text is cached only when it is chunked the way the product chunks it, so the overlap is part of the key.
 */
export function productChunkOptions(env: NodeJS.ProcessEnv = process.env): { maxTokens: number; overlapTokens: number } {
  const maxTokens = Number(env.CHUNK_MAX_TOKENS ?? 400);
  const overlapTokens = Number(env.CHUNK_OVERLAP_TOKENS ?? 50);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('CHUNK_MAX_TOKENS must be a positive integer');
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error('CHUNK_OVERLAP_TOKENS must be a non-negative integer below CHUNK_MAX_TOKENS');
  }
  return { maxTokens, overlapTokens };
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Read-only view of one or more embedding caches; a text counts as cached when any of them holds its vector. */
export class CacheIndex {
  private readonly dbs: Database.Database[];
  private readonly lookups: Database.Statement[];

  constructor(readonly paths: readonly string[]) {
    this.dbs = paths.map(file => new Database(file, { readonly: true, fileMustExist: true }));
    this.lookups = this.dbs.map(db => db.prepare(
      'SELECT 1 FROM embeddings WHERE key = ? AND namespace = ? AND dims = ? AND length(vec) = ? LIMIT 1',
    ));
  }

  has(key: string): boolean {
    return this.lookups.some(stmt => stmt.get(key, EMBED_NAMESPACE, EMBED_DIMENSIONS, EMBED_VECTOR_BYTES) !== undefined);
  }

  /** Rows per namespace in each file, as `eval:cache stats` reports them. */
  describe(): Array<{ path: string; rows: Array<{ namespace: string; rows: number }> }> {
    return this.dbs.map((db, i) => ({
      path: this.paths[i],
      rows: db.prepare('SELECT namespace, COUNT(*) AS rows FROM embeddings GROUP BY namespace ORDER BY namespace')
        .all() as Array<{ namespace: string; rows: number }>,
    }));
  }

  close(): void {
    for (const db of this.dbs) db.close();
  }
}

export interface ClassCount {
  /** Distinct texts of this task, after de-duplication by key. */
  texts: number;
  tokens: number;
  cached: number;
  cachedTokens: number;
  missing: number;
  missingTokens: number;
}

const emptyCount = (): ClassCount => ({ texts: 0, tokens: 0, cached: 0, cachedTokens: 0, missing: 0, missingTokens: 0 });

/** Counts each distinct (task, text) once, however many notes or questions contain it, as the cache does. */
export class Inventory {
  readonly documents = emptyCount();
  readonly queries = emptyCount();
  notes = 0;
  chunks = 0;
  readonly chunking = productChunkOptions();
  private readonly seen = new Set<string>();

  constructor(
    private readonly cache: CacheIndex,
    private readonly onMissing?: (row: MissingText) => void,
  ) {}

  add(task: EmbedTask, text: string, tokens: number): void {
    const key = embeddingKey(task, text);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const bucket = task === TASK_DOCUMENT ? this.documents : this.queries;
    bucket.texts += 1;
    bucket.tokens += tokens;
    if (this.cache.has(key)) {
      bucket.cached += 1;
      bucket.cachedTokens += tokens;
    } else {
      bucket.missing += 1;
      bucket.missingTokens += tokens;
      this.onMissing?.({ task, text, tokens });
    }
  }

  addNote(notePath: string, content: string): void {
    const chunks = chunkNote(parseNote(notePath, content), this.chunking);
    this.notes += 1;
    this.chunks += chunks.length;
    for (const chunk of chunks) this.add(TASK_DOCUMENT, chunk.text, chunk.tokenCount);
  }

  /** The product's LongMemEval vault: one note per haystack session, and one query per question. */
  addLongMemEval(rows: LongMemInstance[]): void {
    validateLongMemRows(rows);
    for (const row of rows) {
      row.haystack_sessions.forEach((turns, index) => {
        const id = row.haystack_session_ids[index];
        this.addNote(`Sessions/${safeSegment(id)}.md`, renderSession(id, row.haystack_dates[index], turns));
      });
      const query = `Question date: ${row.question_date}\n${row.question}`;
      this.add(TASK_QUERY, query, countO200k(query));
    }
  }

  addQueries(queries: string[]): void {
    for (const query of queries) this.add(TASK_QUERY, query, countO200k(query));
  }
}

/** Markdown files under a directory, in name order, so the inventory is the same on every run. */
export function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  visit(root);
  return out;
}

export function readJsonlField(file: string, field: string): string[] {
  const out: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const value = (JSON.parse(line) as Record<string, unknown>)[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`no ${field} text in a row of ${file}`);
    out.push(value);
  }
  return out;
}

export interface PlanInput {
  label: string;
  corpus: 'longmemeval' | 'notes';
  source: string;
  cachePaths: string[];
  queries?: { file: string; field: string };
}

export interface Plan {
  label: string;
  corpus: string;
  source: string;
  generatedAt: string;
  tokenizer: string;
  chunking: { maxTokens: number; overlapTokens: number };
  namespace: string;
  pricing: { usdPerMillionTokens: number; ptaxBrlPerUsd: number };
  caches: Array<{ path: string; rows: Array<{ namespace: string; rows: number }> }>;
  notes: number;
  chunks: number;
  documents: ClassCount;
  queries: ClassCount;
  missingTokens: number;
  missingUsd: number;
  missingBrlAtPtax: number;
}

export function planCorpus(input: PlanInput, onMissing?: (row: MissingText) => void): Plan {
  const cache = new CacheIndex(input.cachePaths);
  try {
    const inventory = new Inventory(cache, onMissing);
    if (input.corpus === 'longmemeval') {
      inventory.addLongMemEval(JSON.parse(fs.readFileSync(input.source, 'utf8')) as LongMemInstance[]);
    } else {
      for (const file of markdownFiles(input.source)) {
        inventory.addNote(path.relative(input.source, file), fs.readFileSync(file, 'utf8'));
      }
    }
    if (input.queries) inventory.addQueries(readJsonlField(input.queries.file, input.queries.field));
    const missingTokens = inventory.documents.missingTokens + inventory.queries.missingTokens;
    return {
      label: input.label,
      corpus: input.corpus,
      source: input.source,
      generatedAt: new Date().toISOString(),
      tokenizer: 'o200k (the chunker tokenCount and countO200k)',
      chunking: inventory.chunking,
      namespace: EMBED_NAMESPACE,
      pricing: { usdPerMillionTokens: USD_PER_MILLION_TOKENS, ptaxBrlPerUsd: PTAX_BRL_PER_USD },
      caches: cache.describe(),
      notes: inventory.notes,
      chunks: inventory.chunks,
      documents: inventory.documents,
      queries: inventory.queries,
      missingTokens,
      missingUsd: usdForTokens(missingTokens),
      missingBrlAtPtax: usdForTokens(missingTokens) * PTAX_BRL_PER_USD,
    };
  } finally {
    cache.close();
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function runInventoryCli(argv: string[]): Plan {
  const program = new Command()
    .requiredOption('--corpus <kind>', 'longmemeval (a dataset JSON file) or notes (a directory of markdown notes)')
    .requiredOption('--source <path>', 'the dataset file or the notes directory')
    .requiredOption('--label <name>', 'the corpus name for the report')
    .option('--queries <file>', 'a JSONL file of query texts (notes corpora)')
    .option('--query-field <name>', 'the field of --queries that holds the query text', 'question')
    .option('--cache <file>', 'an embedding cache to check, repeatable: a text is cached if any of them holds it', collect, [])
    .option('--out <file>', 'write the plan JSON here as well as printing it')
    .option('--emit-missing <file>', 'write every text no cache holds as JSONL: {task, text, tokens}')
    .parse(argv, { from: 'user' });
  const opts = program.opts() as {
    corpus: string; source: string; label: string; queries?: string; queryField: string;
    cache: string[]; out?: string; emitMissing?: string;
  };
  if (opts.corpus !== 'longmemeval' && opts.corpus !== 'notes') throw new Error('--corpus must be longmemeval or notes');
  if (opts.cache.length === 0) throw new Error('pass at least one --cache (an existing embedding cache file)');
  let fd: number | undefined;
  if (opts.emitMissing) fd = fs.openSync(expandHome(opts.emitMissing), 'w');
  let plan: Plan;
  try {
    plan = planCorpus({
      label: opts.label,
      corpus: opts.corpus,
      source: expandHome(opts.source),
      cachePaths: opts.cache.map(expandHome),
      queries: opts.queries ? { file: expandHome(opts.queries), field: opts.queryField } : undefined,
    }, row => {
      if (fd !== undefined) fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  if (opts.out) fs.writeFileSync(expandHome(opts.out), text);
  process.stdout.write(text);
  return plan;
}

const invokedDirectly = process.argv[1]?.endsWith('benchmark-embed-inventory.ts') === true;
if (invokedDirectly) {
  try {
    runInventoryCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
