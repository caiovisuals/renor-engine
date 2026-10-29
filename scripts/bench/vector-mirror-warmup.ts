/**
 * The first reply of a process started with a raised RENOR_VECTOR_MIRROR_MIB (see warmMirrorInBackground), measured on the
 * vector index alone, over one generated table of seeded 768-dimension vectors. Each arm runs in its own process, so each
 * starts cold. Run it on boxd, not on the laptop:
 *
 *   npx tsx scripts/bench/vector-mirror-warmup.ts --build [--vectors 100626] [--dir <dir>]
 *   npx tsx scripts/bench/vector-mirror-warmup.ts --arm sync [--dir <dir>]
 *   npx tsx scripts/bench/vector-mirror-warmup.ts --arm warm [--dir <dir>]
 *
 * sync: the first search builds the copy and waits for it, so the first reply pays for the whole copy.
 * warm: warmMirrorInBackground() runs at startup, as attachEngine calls it. The first search is asked at once, while the
 *       copy is still being read. Reported: that first reply, the time until the copy is ready, and the longest event-loop
 *       stall in that time (monitorEventLoopDelay).
 * Both arms answer the same queries, and the digest covers every answer: equal digests mean equal answers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';

const DIMS = 768;
const RAISED_MIB = '400';
const TOP_K = 40;

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** A seeded unit vector. The table is generated one vector at a time, so it is never held in memory. */
function vectorOf(seed: number): number[] {
  let state = ((seed * 2654435761) >>> 0) || 1;
  const raw = Array.from({ length: DIMS }, () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296 - 0.5;
  });
  const mag = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map(v => v / mag);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function digestOf(found: Array<{ chunkId: number; score: number }>): string {
  return crypto.createHash('sha256').update(JSON.stringify(found.map(r => [r.chunkId, r.score]))).digest('hex').slice(0, 16);
}

const dir = flag('dir') ?? path.join(os.tmpdir(), 'renor-vector-warmup');
const vectors = Number(flag('vectors') ?? 100626);
const file = path.join(dir, `vectors-${vectors}.db`);
// Queries that are not in the table: seeds below 1 are never used for a stored row.
const QUERIES = Array.from({ length: 5 }, (_, i) => vectorOf(-(i + 1)));

function build(): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const db = openDb(file);
  runMigrations(db);
  const idx = new VectorIndex(db, DIMS);
  idx.initTable();
  for (let from = 1; from <= vectors; from += 5000) {
    db.transaction(() => {
      for (let id = from; id < from + 5000 && id <= vectors; id++) idx.upsert(id, vectorOf(id));
    })();
  }
  db.close();
  console.log(JSON.stringify({ built: file, vectors }));
}

async function arm(name: 'sync' | 'warm'): Promise<void> {
  const db = openDb(file);
  runMigrations(db);
  // The cap is read when the index is made, so it is raised first.
  process.env.RENOR_VECTOR_MIRROR_MIB = RAISED_MIB;
  const idx = new VectorIndex(db, DIMS);
  idx.initTable();
  const mirrorReady = () => (idx as unknown as { mirror: unknown }).mirror !== null;
  const digests: string[] = [];
  const timed = (query: number[]): number => {
    const t = performance.now();
    const found = idx.search(query, TOP_K);
    const ms = performance.now() - t;
    digests.push(digestOf(found));
    return ms;
  };
  let firstReplyMs: number;
  let readyMs: number;
  let maxStallMs: number;
  if (name === 'sync') {
    firstReplyMs = timed(QUERIES[0]);
    readyMs = firstReplyMs;
    maxStallMs = firstReplyMs;
  } else {
    const monitor = monitorEventLoopDelay({ resolution: 1 });
    monitor.enable();
    const started = performance.now();
    idx.warmMirrorInBackground();
    firstReplyMs = timed(QUERIES[0]);
    while (!mirrorReady() && performance.now() - started < 120_000) await new Promise<void>(resolve => setImmediate(resolve));
    readyMs = performance.now() - started;
    monitor.disable();
    maxStallMs = monitor.max / 1e6;
  }
  const later = QUERIES.slice(1).map(timed);
  console.log(JSON.stringify({
    arm: name,
    vectors,
    firstReplyMs: Math.round(firstReplyMs * 10) / 10,
    readyMs: Math.round(readyMs * 10) / 10,
    maxStallMs: Math.round(maxStallMs * 10) / 10,
    laterMedianMs: Math.round(median(later) * 10) / 10,
    copyReady: mirrorReady(),
    digest: crypto.createHash('sha256').update(digests.join('|')).digest('hex').slice(0, 16),
  }));
  db.close();
}

const mode = flag('arm');
if (process.argv.includes('--build')) build();
else if (mode === 'sync' || mode === 'warm') void arm(mode);
else throw new Error('usage: --build | --arm sync | --arm warm');
