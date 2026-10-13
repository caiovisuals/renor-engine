/**
 * Latency of the get_context relevance signal, measured on a fixed fixture.
 *
 *   npx tsx scripts/eval/relevance-latency.ts [--runs 7] [--cold-embed-ms 300]
 *
 * 1. warm: the same get_context requests with the signal off and on (interleaved, same process,
 *    deterministic eval-hash embeddings so no network noise): per-call median and p95.
 * 2. fact lane: the pure compute of the signal as the number of current facts grows, up to the ceiling
 *    it compares (768 dims), warm.
 * 3. cold: a fresh process-equivalent (empty fact-vector store) against an embedding backend that
 *    takes --cold-embed-ms per request: the first call must not wait for it.
 *
 * Synthetic fixture text only (fixtures/relevance, workspace a with its distractors).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { buildAgentContext } from '../../src/mvp/agentMemory';
import { FACT_CEILING, factLane, warmFactVectors } from '../../src/mvp/contextRelevance';
import type { Engine } from '../../src/mvp/engine';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { loadQuestions, loadWorkspace, seedWorkspace } from './relevance-calibration';

const OFF = { RENOR_CONTEXT_RELEVANCE: '0' } as NodeJS.ProcessEnv;
const ON = { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.3' } as NodeJS.ProcessEnv;
/** A bar high enough that a stray request is judged not relevant by the (lexical) hash embeddings. */
const STRICT = { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0.7' } as NodeJS.ProcessEnv;

function stats(ms: number[]): string {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const mean = ms.reduce((s, x) => s + x, 0) / ms.length;
  return `n=${ms.length} median ${at(0.5).toFixed(2)} ms  p95 ${at(0.95).toFixed(2)} ms  mean ${mean.toFixed(2)} ms`;
}

class SlowEmbed implements EmbeddingProvider {
  readonly inner = new EvalHashEmbeddingProvider();
  dimensions = this.inner.dimensions;
  constructor(private readonly delayMs: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return this.inner.embed(texts);
  }
  async embedQuery(text: string): Promise<number[]> { return this.inner.embedQuery(text); }
}

async function workspace(provider: EmbeddingProvider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-latency-'));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const db = openDb(path.join(root, 'index.db'));
  runMigrations(db);
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, loadWorkspace('a', 'large'));
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 4);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'eval-hash:latency:256' };
  return { root, db, memoryDir, engine };
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function main(): Promise<void> {
  const program = new Command().option('--runs <n>', 'passes over the question set per arm', '7').option('--cold-embed-ms <n>', 'simulated embedding latency for the cold run', '300');
  program.parse();
  const opts = program.opts<{ runs: string; coldEmbedMs: string }>();
  const runs = Number(opts.runs);
  const questions = loadQuestions('dev').map(q => q.q);

  // 1. warm, off vs on
  const provider = new EvalHashEmbeddingProvider();
  const w = await workspace(provider);
  await warmFactVectors(w.db, provider);
  const arms: Record<'off' | 'on', number[]> = { off: [], on: [] };
  for (const q of questions.slice(0, 5)) { // warm the SQLite page cache and JIT identically for both arms
    await buildAgentContext(w.db, w.engine, w.memoryDir, { query: q, env: OFF });
    await buildAgentContext(w.db, w.engine, w.memoryDir, { query: q, env: ON });
  }
  for (let run = 0; run < runs; run++) {
    for (const [i, q] of questions.entries()) {
      const order: Array<'off' | 'on'> = (i + run) % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
      for (const arm of order) arms[arm].push(await timed(() => buildAgentContext(w.db, w.engine, w.memoryDir, { query: q, env: arm === 'on' ? ON : OFF })));
    }
  }
  console.log(`warm get_context, workspace a large (${(w.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c} chunks), ${questions.length} questions x ${runs} runs, interleaved`);
  console.log(`  signal off  ${stats(arms.off)}`);
  console.log(`  signal on   ${stats(arms.on)}`);
  w.db.close();
  fs.rmSync(w.root, { recursive: true, force: true });

  // 2. the signal's own compute as the fact count grows, up to the ceiling it compares: x 768 dims
  const dims = 768;
  const wide: EmbeddingProvider = {
    dimensions: dims,
    async embed(texts) { return texts.map(t => Array.from({ length: dims }, (_, k) => Math.sin(k * 12.9898 + t.length * 78.233 + t.charCodeAt(t.length - 1) + t.charCodeAt(5)))); },
  };
  const query = Array.from({ length: dims }, (_, k) => Math.cos(k * 0.37));
  console.log('\nfact lane, warm (SQL read of the current facts + a dot product each), 768 dims');
  for (const count of [500, 2000, FACT_CEILING]) {
    const bigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-latency-facts-'));
    fs.mkdirSync(path.join(bigRoot, 'memory'));
    const big = openDb(path.join(bigRoot, 'index.db'));
    runMigrations(big);
    await seedWorkspace(big, path.join(bigRoot, 'memory'), {
      facts: Array.from({ length: count }, (_, i) => ({ subject: 'user', predicate: `attribute_${i}`, object: `value number ${i}` })),
      notes: [],
    });
    await warmFactVectors(big, wide);
    const lane: number[] = [];
    for (let i = 0; i < 200; i++) lane.push(await timed(async () => factLane(big, wide, query)));
    console.log(`  ${String(count).padStart(5)} facts  ${stats(lane.slice(20))}`);
    big.close();
    fs.rmSync(bigRoot, { recursive: true, force: true });
  }

  // 3. cold: the first call must not wait for the fact fill
  const delay = Number(opts.coldEmbedMs);
  const slow = new SlowEmbed(delay);
  const c = await workspace(slow);
  const first = { off: 0, on: 0 };
  first.off = await timed(() => buildAgentContext(c.db, c.engine, c.memoryDir, { query: questions[0], env: OFF }));
  first.on = await timed(() => buildAgentContext(c.db, c.engine, c.memoryDir, { query: questions[0], env: ON }));
  const stray = 'quantum chromodynamics gluon lagrangian';
  const cold = await buildAgentContext(c.db, c.engine, c.memoryDir, { query: stray, env: STRICT }) as { relevance?: unknown };
  const warmedAt = performance.now();
  await warmFactVectors(c.db, slow);
  const warm = await buildAgentContext(c.db, c.engine, c.memoryDir, { query: stray, env: STRICT }) as { relevance?: unknown };
  console.log(`\ncold start, embedding backend ${delay} ms per request, fact vectors empty`);
  console.log(`  first call, signal off ${first.off.toFixed(1)} ms; signal on ${first.on.toFixed(1)} ms (the fill runs in the background)`);
  console.log(`  verdict on a stray request while filling: ${cold.relevance === undefined ? 'absent (withheld, not guessed)' : JSON.stringify(cold.relevance)}`);
  console.log(`  fill complete after ${(performance.now() - warmedAt).toFixed(0)} ms more; same request now: ${warm.relevance === undefined ? 'absent' : JSON.stringify(warm.relevance)}`);
  c.db.close();
  fs.rmSync(c.root, { recursive: true, force: true });
}

main().catch(err => { console.error(err); process.exit(1); });
