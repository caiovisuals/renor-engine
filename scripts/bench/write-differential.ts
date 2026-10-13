/**
 * Does a read-path change still answer the same once things are WRITTEN? The latency benchmark (mcp-latency.ts) proves
 * two trees answer alike on a workspace that does not change; this proves it on one that does: reads of every kind
 * (unscoped, three scopes, history, keyword, by subject) interleaved with a fact, its correction, a note and facts in
 * two scopes, a correction in a scope and a note in another, through the real MCP tools. Anything a tree keeps between
 * reads (a statement, the closed events, the chunks a scope holds) has to follow each of those writes.
 *
 *   # the same restored workspace for each tree: a workspace is only valid at the path it was built at
 *   npx tsx scripts/bench/mcp-latency.ts --shape live --runs 1 --dir /tmp/fx && cp -a /tmp/fx /tmp/fx-pristine
 *   for tree in old new; do
 *     rm -rf /tmp/fx && cp -a /tmp/fx-pristine /tmp/fx
 *     (cd <tree>/engine && npx tsx scripts/bench/write-differential.ts run /tmp/fx/n85-p10-f671-s220-hash768 /tmp/dw-$tree out-$tree.jsonl)
 *   done
 *   npx tsx scripts/bench/write-differential.ts compare out-old.jsonl out-new.jsonl      # exit 0: the same
 *
 * What makes two runs comparable (each of these was a real source of difference between two runs of ONE tree):
 *  - the clock: `Date` is replaced by one fixed instant per step, so the stamps notes and events carry are the same;
 *  - `Math.random`, which names every ledger event, is seeded: the id is part of the chunk text the hash embedding
 *    reads, so a different id moved a hit's score by a few hundredths;
 *  - after each write the run waits out the engine's clock tick, so how fast the machine is cannot pick another path;
 *  - ids and the like are normalised; scores are not part of the digest but are compared as numbers (a note's
 *    recency boost reads its file's real modification time, which differs by seconds between runs: ~1e-6).
 * Everything else, the order and the text of every hit and fact, must be equal.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

export interface StepRecord { label: string; ok: boolean; digest: string; bytes: number; scores: number[] }

/** The largest difference between two runs' scores that is still the same answer: runs of one tree differ by ~3e-6. */
export const SCORE_TOLERANCE = 2e-3;

const scoresOf = (text: string): number[] => [...text.matchAll(/"(?:score|similarity)":(-?\d+\.\d+)/g)].map(m => Number(m[1]));
const normalise = (text: string): string => text
  .replace(/"(score|similarity)":(-?\d+\.\d+)/g, (_m, key) => `"${key}":S`)
  .replace(/MEM_[A-Z0-9]+/gi, 'MEM_X')
  .replace(/entry:[^"#\s]*#[0-9a-f]+/g, 'entry:X')
  .replace(/"fact":\d+|"factId":\d+|"id":\d+/g, '"id":N');

/** What `compare` says of two runs: how many responses differ once scores are set aside, and the worst score gap. */
export function compareRuns(a: StepRecord[], b: StepRecord[]): { identical: boolean; lines: string[]; worstScoreGap: number } {
  const lines: string[] = [];
  let differing = a.length === b.length ? 0 : Math.abs(a.length - b.length);
  let worst = 0;
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    if (x.label !== y.label || x.ok !== y.ok || x.digest !== y.digest || x.bytes !== y.bytes || x.scores.length !== y.scores.length) {
      differing++;
      lines.push(`DIFF ${x.label}${x.ok === y.ok ? '' : ` (ok ${x.ok} vs ${y.ok})`}`);
      return;
    }
    x.scores.forEach((s, j) => { worst = Math.max(worst, Math.abs(s - y.scores[j])); });
  });
  const identical = differing === 0 && worst <= SCORE_TOLERANCE;
  lines.push(identical
    ? `IDENTICAL: ${a.length} responses, none differs once scores are set aside, largest score difference ${worst.toExponential(2)}`
    : `${differing} response(s) differ${worst > SCORE_TOLERANCE ? `, largest score difference ${worst.toExponential(2)} (over ${SCORE_TOLERANCE})` : ''}`);
  return { identical, lines, worstScoreGap: worst };
}

async function run(memoryDir: string, authDir: string, out: string): Promise<void> {
  const RealDate = Date;
  const BASE = RealDate.UTC(2026, 9, 6, 16, 30, 0); // later than any file the run writes, so no file looks "just written"
  let stepNo = 0;
  const instant = () => BASE + stepNo * 60_000;
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) { if (args.length === 0) super(instant()); else super(...(args as [number])); }
    static now() { return instant(); }
  }
  let seed = 20261006;
  const realRandom = Math.random;
  Math.random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  fs.rmSync(authDir, { recursive: true, force: true });
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(authDir, 0o700);
  const saved = { ...process.env };
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir, MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'), MVP_BASE_URL: 'http://127.0.0.1:1',
    MVP_OWNER_EMAIL: 'bench@example.test', MVP_OWNER_PASSWORD: 'synthetic-bench-secret-123', MVP_PORT: '1',
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback', RENOR_TELEMETRY_DISABLED: 'true', INDEX_CONCURRENCY: '1',
  });
  const records: StepRecord[] = [];
  const consoleLog = console.log;
  console.log = () => {}; // the server's tool_use telemetry lines
  const app = createMvpApp(loadMvpConfig(), Object.assign(new EvalHashEmbeddingProvider(), { dimensions: 768 }));
  try {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await app.server.connect(serverT);
    const client = new Client({ name: 'write-differential', version: '0' });
    await client.connect(clientT);
    await new Promise(resolve => setTimeout(resolve, 2300)); // past the engine's clock tick, in real time
    (globalThis as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;

    const WRITES = new Set(['save_memory', 'remember']);
    const step = async (label: string, name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      if (WRITES.has(name)) await new Promise(resolve => setTimeout(resolve, 2300));
      const text = (res.content as Array<{ text: string }>)[0].text;
      const normalised = normalise(text);
      records.push({ label, ok: res.isError !== true, digest: crypto.createHash('sha256').update(normalised).digest('hex'), bytes: normalised.length, scores: scoresOf(text) });
    };
    const question = 'what do we know about the quillmoor bakery inventory project and its budget';
    const reads = async (tag: string) => {
      await step(`${tag} get_context`, 'get_context', { query: question });
      await step(`${tag} search_memory`, 'search_memory', { query: question, top_k: 10 });
      await step(`${tag} get_context @project:alpha`, 'get_context', { query: question, scope: 'project:alpha' });
      await step(`${tag} search_memory @project:alpha`, 'search_memory', { query: question, scope: 'project:alpha', top_k: 10 });
      await step(`${tag} get_context @scope:beta`, 'get_context', { query: question, scope: 'scope:beta' });
      await step(`${tag} search_memory @beta`, 'search_memory', { query: question, scope: 'beta', top_k: 10 });
      await step(`${tag} get_context @global`, 'get_context', { query: question, scope: 'global' });
      await step(`${tag} search_text`, 'search_text', { query: 'quillmoor bakery' });
      await step(`${tag} get_context +history`, 'get_context', { query: question, include_history: true });
      await step(`${tag} retrieve_memory`, 'retrieve_memory', { subject: 'quillmoor' });
    };
    const next = () => { stepNo++; };

    await reads('0 start');
    next(); await step('1 save fact', 'save_memory', { subject: 'quillmoor', predicate: 'budget', object: '9000 euros for the bakery inventory tracker' });
    await reads('1 after fact');
    next(); await step('2 correct fact', 'save_memory', { subject: 'quillmoor', predicate: 'budget', object: '12000 euros for the bakery inventory tracker, revised' });
    await reads('2 after correction');
    next(); await step('3 note @alpha', 'remember', { statement: 'Quillmoor bakery inventory tracker kickoff notes for the alpha workstream: shelf scanning pilot', scope: 'project:alpha' });
    await reads('3 after alpha note');
    next(); await step('4 fact @beta', 'remember', { statement: 'Quillmoor bakery inventory beta budget is 500 euros', subject: 'quillmoor', predicate: 'budget', object: '500 euros', scope: 'scope:beta' });
    next(); await step('4b fact @alpha', 'remember', { statement: 'Quillmoor bakery inventory alpha owner is Ada', subject: 'quillmoor', predicate: 'owner', object: 'Ada', scope: 'project:alpha' });
    await reads('4 after scoped facts');
    next(); await step('5 correct @alpha', 'remember', { statement: 'Quillmoor bakery inventory alpha owner is now Grace', subject: 'quillmoor', predicate: 'owner', object: 'Grace', scope: 'project:alpha' });
    next(); await step('5b note @beta', 'remember', { statement: 'Quillmoor bakery inventory beta pricing sheet draft', scope: 'scope:beta' });
    await reads('5 after more writes');
    next(); await step('6 note', 'remember', { statement: 'Quillmoor bakery inventory general reminder: order flour on Fridays' });
    await reads('6 after global note');
    await client.close();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
    Math.random = realRandom;
    console.log = consoleLog;
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  fs.writeFileSync(out, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.stdout.write(`${records.length} responses written to ${out} (${records.filter(r => !r.ok).length} errors)\n`);
}

const load = (file: string): StepRecord[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as StepRecord);

if (require.main === module) {
  const [command, a, b, c] = process.argv.slice(2);
  if (command === 'run' && a && b && c) {
    run(a, b, c).then(() => process.exit(0), err => { console.error(err); process.exit(1); });
  } else if (command === 'compare' && a && b) {
    const { identical, lines } = compareRuns(load(a), load(b));
    lines.forEach(line => process.stdout.write(`${line}\n`));
    process.exit(identical ? 0 : 1);
  } else {
    console.error('usage: write-differential.ts run <memoryDir> <authDir> <out.jsonl> | compare <a.jsonl> <b.jsonl>');
    process.exit(2);
  }
}
