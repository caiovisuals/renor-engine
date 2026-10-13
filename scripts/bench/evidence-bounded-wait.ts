/**
 * Bounded-wait evidence (RENOR_EVIDENCE_ASYNC), measured: what get_context and search_memory cost and return when the
 * evidence model is slow, on the repo's fixed dev questions (the 191 of docs/evals/renorbench-v1.dev.jsonl, asked of
 * fixtures/eval/renorbench-v1), through the REAL MVP tools (createMvpApp, the registered tools, JSON serialization) over
 * an in-memory MCP transport. The evidence model is a loopback stub that sleeps --sleep-ms before answering every
 * request with a table derived from the prompt, so the measured time is the product's, not a provider's.
 *
 *   npx tsx scripts/bench/evidence-bounded-wait.ts --arm off|on --tool get_context|search_memory
 *       [--protocol paced|burst] [--sleep-ms 8000] [--wait-ms 2000] [--embeddings vertex|hash] [--limit N] [--out f.json]
 *   npx tsx scripts/bench/evidence-bounded-wait.ts --report a.json,b.json,...
 *
 * Protocols:
 *   paced  every question is asked, then (flag on) the background extraction it started is let finish, then it is asked
 *          again: one person asking and following up. The queue never builds up, so this is the latency a request sees.
 *   burst  (flag on) every question back to back, then the queue drains, then every question again: what the
 *          single-flight and the queue bound do when requests arrive faster than the model answers.
 * Both end with a single-flight probe: 8 identical requests at once for each of 5 questions nobody asked before.
 *
 * Embeddings: `vertex` (gemini-embedding-001, 768-d) through the repo's persistent content-addressed cache, so every
 * text is paid for once and reruns are free; `hash` is the eval-hash stub, for a free rerun anywhere. No local model.
 * The environment is scrubbed as in mcp-latency.ts (no telemetry, no real extractor key); the only evidence key is a
 * synthetic one for the loopback stub. One arm per process: the process's extraction flights are shared state.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { CachingEmbeddingProvider, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import { sharedEvidenceFlights } from '../../src/evidence/background';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { FROZEN_NOW_MS, stat, withBenchEnv, type Stat } from './mcp-latency';

const ENGINE = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ENGINE, 'fixtures', 'eval', 'renorbench-v1');
const QUESTIONS = path.join(ENGINE, 'docs', 'evals', 'renorbench-v1.dev.jsonl');
const DAY_MS = 86_400_000;
const PROBE_QUESTIONS = 5;
const PROBE_FANOUT = 8;

type Tool = 'get_context' | 'search_memory';
interface Question { id: string; category: string; query: string }
interface Answer { ms: number; state: string; table: boolean }
interface Options {
  arm: 'off' | 'on'; tool: Tool; protocol: 'paced' | 'burst'; sleepMs: number; waitMs: number;
  embeddings: 'vertex' | 'hash'; limit?: number;
}

/** The evidence model: sleeps, then answers one item per session block of the prompt. Counts what it was asked. */
async function sleepingModel(sleepMs: number) {
  let requests = 0, inFlight = 0, maxInFlight = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const prompt = String(JSON.parse(raw).messages?.[0]?.content ?? '');
      const dates = [...prompt.matchAll(/^--- Session dated (.*) ---$/gm)].map(m => m[1]);
      const items = dates.map((date, i) => ({ item: `item ${i + 1}`, action: 'mentioned', amount: '', date }));
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 40 } }));
      }, sleepMs);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`,
    counts: () => ({ requests, maxInFlight }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function provider(kind: Options['embeddings']): { provider: EmbeddingProvider; close(): void } {
  if (kind === 'hash') return { provider: Object.assign(new EvalHashEmbeddingProvider(), { dimensions: 768 }), close() {} };
  const cachePath = resolveEmbeddingCachePath();
  if (!cachePath) throw new Error('--embeddings vertex needs the persistent embedding cache (unset RENOR_EVAL_EMBED_CACHE=off)');
  const cached = new CachingEmbeddingProvider(new VertexEmbeddingProvider({ dimensions: 768, maxInputTokens: 2_000_000 }), { cachePath });
  return { provider: cached, close: () => cached.close() };
}

/** The fixture vault, every note dated as the fixture says relative to the frozen clock; erasure notes left out. */
function writeVault(memoryDir: string): void {
  fs.cpSync(path.join(FIXTURE, 'vault'), memoryDir, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'fixture.json'), 'utf8')) as {
    relativeMtimeDays: Record<string, number>; deleteAfterIndex?: string[];
  };
  for (const gone of meta.deleteAfterIndex ?? []) fs.rmSync(path.join(memoryDir, gone));
  for (const [rel, days] of Object.entries(meta.relativeMtimeDays)) {
    const file = path.join(memoryDir, rel);
    if (fs.existsSync(file)) fs.utimesSync(file, new Date(FROZEN_NOW_MS - days * DAY_MS), new Date(FROZEN_NOW_MS - days * DAY_MS));
  }
}

function readQuestions(limit?: number): Question[] {
  const all = fs.readFileSync(QUESTIONS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Question);
  return limit ? all.slice(0, limit) : all;
}

export async function runArm(o: Options, log: (line: string) => void = () => {}) {
  const model = await sleepingModel(o.sleepMs);
  const vectors = provider(o.embeddings);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `evidence-bounded-wait-${o.arm}-`));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  writeVault(memoryDir);
  const authDir = fs.mkdtempSync(path.join(root, 'auth-')); // the OAuth client store wants its own 0700 directory
  try {
    return await withBenchEnv(o.embeddings === 'vertex', 'default', async () => {
      Object.assign(process.env, {
        MVP_MEMORY_DIR: memoryDir,
        MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
        MVP_BASE_URL: 'http://127.0.0.1:1',
        MVP_OWNER_EMAIL: 'bench@example.test',
        MVP_OWNER_PASSWORD: 'synthetic-bench-secret-123',
        MVP_PORT: '1',
        MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
        RENOR_EVIDENCE_BASE_URL: model.url,
        RENOR_EVIDENCE_API_KEY: 'synthetic-loopback-key',
        ...(o.arm === 'on' ? { RENOR_EVIDENCE_ASYNC: '1', RENOR_EVIDENCE_WAIT_MS: String(o.waitMs) } : {}),
      });
      const app = createMvpApp(loadMvpConfig(), vectors.provider);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await app.server.connect(serverSide);
      const client = new Client({ name: 'evidence-bounded-wait-bench', version: '0' });
      await client.connect(clientSide);
      const realNow = Date.now;
      try {
        const t0 = performance.now();
        await client.callTool({ name: 'index_memory', arguments: {} }, undefined, { timeout: 600_000 });
        log(`  indexed the fixture in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        const questions = readQuestions(o.limit);
        const probeQuery = (q: Question): string => `${q.query} List everything relevant.`;
        // Every query vector the run needs, embedded now, on the real clock and the way retrieval asks for it: the
        // clock is frozen next, and a Vertex token minted on a frozen clock is refused (400). After this the provider
        // is never called, so the run measures evidence, not embedding hops.
        for (const text of [...questions.map(q => q.query), ...questions.slice(0, PROBE_QUESTIONS).map(probeQuery)]) {
          await vectors.provider.embedQuery?.(text);
        }
        Date.now = () => FROZEN_NOW_MS; // retrieval's recency scoring must not drift during the run

        const ask = async (query: string): Promise<Answer> => {
          const started = performance.now();
          const res = await client.callTool({ name: o.tool, arguments: { query } }, undefined, { timeout: 600_000 });
          const ms = performance.now() - started;
          const text = (res.content as Array<{ text: string }>)[0].text;
          if (res.isError) throw new Error(`${o.tool} failed: ${text.slice(0, 300)}`);
          const body = JSON.parse(text);
          if (body.ok === false) throw new Error(`${o.tool} failed: ${text.slice(0, 300)}`);
          const table = o.tool === 'search_memory'
            ? body.hits?.[0]?.reason === 'evidence'
            : (body.memories ?? []).some((m: { reason?: string }) => m.reason === 'evidence');
          // search_memory always names the evidence state; get_context names it only when the table is missing for want of time.
          const state = body.evidence?.state ?? (table ? 'ok' : 'none');
          return { ms: Math.round(ms * 10) / 10, state, table };
        };
        const drain = async (): Promise<number> => {
          const started = performance.now();
          await sharedEvidenceFlights().idle();
          return Math.round(performance.now() - started);
        };

        const rows: Array<{ id: string; category: string; first: Answer; drainMs?: number; repeat: Answer }> = [];
        let burst: { first: Answer[]; drainMs: number; repeat: Answer[] } | undefined;
        if (o.protocol === 'paced') {
          for (const [i, q] of questions.entries()) {
            const first = await ask(q.query);
            const drainMs = o.arm === 'on' ? await drain() : undefined;
            const repeat = await ask(q.query);
            rows.push({ id: q.id, category: q.category, first, ...(drainMs !== undefined ? { drainMs } : {}), repeat });
            if ((i + 1) % 25 === 0) log(`  ${i + 1}/${questions.length}`);
          }
        } else {
          const first: Answer[] = [];
          for (const q of questions) first.push(await ask(q.query));
          const drainMs = await drain();
          const repeat: Answer[] = [];
          for (const q of questions) repeat.push(await ask(q.query));
          burst = { first, drainMs, repeat };
        }
        const beforeProbe = model.counts().requests;
        const probe: Array<{ id: string; requests: number; answers: Answer[] }> = [];
        for (const q of questions.slice(0, PROBE_QUESTIONS)) {
          const sent = model.counts().requests;
          const query = probeQuery(q);
          const answers = await Promise.all(Array.from({ length: PROBE_FANOUT }, () => ask(query)));
          if (o.arm === 'on') await drain();
          probe.push({ id: q.id, requests: model.counts().requests - sent, answers });
        }
        return {
          meta: {
            arm: o.arm, tool: o.tool, protocol: o.protocol, sleepMs: o.sleepMs, waitMs: o.arm === 'on' ? o.waitMs : null,
            embeddings: o.embeddings, questions: questions.length, commit: gitHead(), node: process.version,
            startedAt: new Date().toISOString(), host: os.hostname(), loadavg: os.loadavg().map(x => Math.round(x * 10) / 10),
          },
          model: { requests: beforeProbe, maxConcurrent: model.counts().maxInFlight },
          rows, burst, probe,
        };
      } finally {
        Date.now = realNow;
        await sharedEvidenceFlights().idle();
        await client.close();
        await app.close();
      }
    });
  } finally {
    vectors.close();
    await model.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type ArmResult = Awaited<ReturnType<typeof runArm>>;

function gitHead(): string {
  try {
    const head = execFileSync('git', ['-C', ENGINE, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', ENGINE, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${head}+dirty` : head;
  } catch {
    return 'unknown';
  }
}

const s1 = (x: number): string => (x / 1000).toFixed(x < 10_000 ? 2 : 1);
const pct = (n: number, d: number): string => `${n}/${d} (${d ? Math.round((n / d) * 100) : 0}%)`;
const lat = (st: Stat): string => `${s1(st.medianMs)} / ${s1(st.p95Ms)} / ${s1(st.maxMs)}`;
const states = (answers: Answer[]): string => {
  const counts = new Map<string, number>();
  for (const a of answers) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${k} ${v}`).join(', ');
};

/** Markdown tables over several arms' JSON results. */
export function report(results: ArmResult[]): string[] {
  const lines: string[] = [];
  const paced = results.filter(r => r.meta.protocol === 'paced');
  if (paced.length) {
    lines.push('| tool | flag | model sleeps | wait | first ask: s median / p95 / max | table on first ask | repeat: s median / p95 / max | table on repeat | model calls | 8 identical requests at once: model calls |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of paced) {
      const firsts = r.rows.map(row => row.first);
      const repeats = r.rows.map(row => row.repeat);
      lines.push(`| ${r.meta.tool} | ${r.meta.arm} | ${s1(r.meta.sleepMs)} s | ${r.meta.waitMs === null ? '-' : `${s1(r.meta.waitMs)} s`} | ${lat(stat(firsts.map(a => a.ms)))} | ${pct(firsts.filter(a => a.table).length, firsts.length)} | ${lat(stat(repeats.map(a => a.ms)))} | ${pct(repeats.filter(a => a.table).length, repeats.length)} | ${r.model.requests} | ${r.probe.map(p => p.requests).join(', ')} |`);
    }
  }
  const bursts = results.filter(r => r.burst);
  if (bursts.length) {
    lines.push('');
    lines.push('| tool | model sleeps | wait | burst: s median / p95 / max | burst states | drain | repeat states | model calls | most at once |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of bursts) {
      const b = r.burst!;
      lines.push(`| ${r.meta.tool} | ${s1(r.meta.sleepMs)} s | ${s1(r.meta.waitMs ?? 0)} s | ${lat(stat(b.first.map(a => a.ms)))} | ${states(b.first)} | ${s1(b.drainMs)} s | ${states(b.repeat)} | ${r.model.requests} | ${r.model.maxConcurrent} |`);
    }
  }
  lines.push('');
  for (const r of results) lines.push(`- ${r.meta.tool} ${r.meta.arm} ${r.meta.protocol}: ${r.meta.questions} questions, embeddings ${r.meta.embeddings}, ${r.meta.commit}, Node ${r.meta.node}, load ${r.meta.loadavg.join(' ')} at ${r.meta.startedAt}`);
  return lines;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const say = (line: string) => process.stdout.write(line + '\n');
  const reportList = arg('report');
  if (reportList) {
    report(reportList.split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8')) as ArmResult)).forEach(say);
    return;
  }
  const arm = arg('arm');
  const tool = arg('tool');
  const protocol = arg('protocol') ?? 'paced';
  const embeddings = arg('embeddings') ?? 'vertex';
  if (arm !== 'off' && arm !== 'on') throw new Error('--arm must be off or on');
  if (tool !== 'get_context' && tool !== 'search_memory') throw new Error('--tool must be get_context or search_memory');
  if (protocol !== 'paced' && protocol !== 'burst') throw new Error('--protocol must be paced or burst');
  if (protocol === 'burst' && arm === 'off') throw new Error('--protocol burst measures the queue: it needs --arm on');
  if (embeddings !== 'vertex' && embeddings !== 'hash') throw new Error('--embeddings must be vertex or hash');
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  say(`evidence-bounded-wait: ${tool} flag ${arm}, ${protocol}, model sleeps ${arg('sleep-ms') ?? 8000} ms, wait ${arg('wait-ms') ?? 2000} ms, ${embeddings}`);
  const result = await runArm({
    arm, tool, protocol, embeddings, limit,
    sleepMs: Number(arg('sleep-ms') ?? 8000),
    waitMs: Number(arg('wait-ms') ?? 2000),
  }, say);
  report([result]).forEach(say);
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
