/**
 * Repeatable latency benchmark for the two read tools every agent leans on — `get_context` and
 * `search_memory` — driven through the REAL MCP surface (the registered McpServer tools: zod input
 * validation, handler, JSON serialization) over an in-memory transport, on generated workspaces of
 * 100 / 1,000 / 10,000 notes plus facts.
 *
 *   npx tsx scripts/bench/mcp-latency.ts [--sizes 100,1000,10000] [--runs 7] [--out result.json] [--label before]
 *       [--embeddings hash|vertex|cache-only|none] [--dims 768] [--evidence default|off] [--dir <fixtures>] [--profile] [--per-call]
 *       [--shape live | --pad-sections N --facts N --fact-subjects N] [--queries wide] [--tools get_context,search_memory]
 *       [--calls '<regex over tool:label>'] [--cpu-profile out.cpuprofile]
 *   npx tsx scripts/bench/mcp-latency.ts --embeddings vertex --probe-hop 20 [--embed-cache <path>]
 *   npx tsx scripts/bench/mcp-latency.ts --compare before-1.json,before-2.json after-1.json,after-2.json
 *
 * Embeddings. The vector scan and the query hop depend on the DIMENSION of the vectors, not on their
 * values, so a tier is chosen by what it can honestly claim:
 *   hash    the repo's deterministic eval-hash stub (src/eval/hashEmbedding.ts) at --dims (default 768,
 *           the Vertex default). No model, no network: the tier CI and reviewers can rerun anywhere.
 *   vertex  Vertex AI gemini-embedding-001 through the repo's persistent content-addressed cache
 *           (src/embeddings/caching.ts). Corpus and query vectors are paid for once, so reruns are free
 *           and byte-stable. Needs RENOR_EVAL_VERTEX_* (or GOOGLE_APPLICATION_CREDENTIALS) in the
 *           environment. --probe-hop N times N LIVE query embeddings: the network hop a hosted
 *           workspace pays on every call, reported beside the tool timings and never inside them.
 *   cache-only  the same Vertex vectors read from --embed-cache and nothing else (src/embeddings/caching.ts
 *           CacheOnlyVertex): the cache is opened read-only, a text it does not hold is a fatal error, and there
 *           is no upstream to fall back to, so the tier cannot spend. It measures a fixture that was built
 *           beforehand (a missing one is not generated); 768 dimensions only.
 *   none    a workspace with no embedding provider: get_context is lifecycle facts + keyword search and
 *           search_memory answers semantic-unavailable (so it is not measured). Uses the hash fixture.
 * No local embedding model is ever loaded.
 *
 * Fixtures are generated once from a fixed seed under --dir and reused. Time is frozen (Date.now) for
 * the measured passes, so retrieval's recency boost is identical on every run and the response digests
 * are comparable across commits and processes. The A/B contract: same fixture, same queries,
 * byte-identical responses, different milliseconds. To compare two commits, run this file from each
 * checkout against the same --dir, then --compare the outputs (several runs per side are pooled).
 * On a shared host wall time swings with other people's load: alternate the two checkouts run by run
 * and read the cpu columns first. "main-thread cpu" is the event loop's own work (what a call waits on);
 * "process cpu" adds GC and helper threads, whose time lands in whichever call is running and inflates tails.
 *
 * Synthetic data only; remote telemetry is disabled for the process.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { collectOllamaKeys } from '../../src/evidence/keyPool';
import { CachingEmbeddingProvider, CacheOnlyVertex, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { CpuProfile } from './cpu-profile';

/** `--shape live`: the production workspace's size and shape (measured 2026-10-06 on the hosted workspace: 85 notes, 1,946 chunks, 413 entities, 806 facts). */
export const LIVE_SHAPE = { notes: 85, padSections: 10, facts: 671, factSubjects: 220 } as const;

export const FROZEN_NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY_MS = 86_400_000;
export const SEED = 20260930;
/** Spend guard for a Vertex fixture: a 10,000-note corpus is ~4M tokens. */
const VERTEX_TOKEN_CAP = 12_000_000;

export type Embeddings = 'hash' | 'vertex' | 'cache-only' | 'none';

export interface BenchOptions {
  sizes: number[];
  runs: number;
  embeddings: Embeddings;
  dims: number;
  dir: string;
  label?: string;
  /**
   * `default`: the shipped behaviour. The evidence second pass is ON unless switched off, and with no extractor
   * configured it still loads up to 20 source notes from disk per query before skipping. `off`: retrieval alone.
   * Either way the benchmark never has an extractor, so it never makes a model call.
   */
  evidence?: 'default' | 'off';
  profile?: boolean;
  perCall?: boolean;
  /** Fixture shape beyond the note count: extra body sections per note, fact saves, distinct fact subjects. */
  padSections?: number;
  facts?: number;
  factSubjects?: number;
  /** `wide`: the default calls plus a fixed, seeded set of ~90 more (scopes, top_k, budgets, history, the other read tools). */
  queries?: 'default' | 'wide';
  /** Measure only these tools (comma list in the CLI). */
  tools?: string[];
  /** Measure only the calls whose `tool:label` matches this pattern (a regular expression in the CLI). */
  calls?: RegExp;
  /** Write a V8 CPU profile (.cpuprofile) of the measured passes only, not of the warm pass or the start-up. */
  cpuProfile?: string;
  /** Time N live Vertex query embeddings (embeddings=vertex only). */
  probeHop?: number;
  embedCache?: string;
  /** Report sink: the CLI prints, a test collects. */
  log?: (line: string) => void;
}

// ---- deterministic generation --------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  'billing', 'onboarding', 'gateway', 'retrieval', 'embeddings', 'dashboard', 'pricing', 'hiring',
  'roadmap', 'incident', 'deploy', 'privacy', 'latency', 'research', 'support', 'security',
  'analytics', 'mobile', 'sync', 'export', 'agents', 'memory', 'invoices', 'contracts',
];
const WORDS = (
  'alpha bravo cargo delta engine falcon garden harbor island jungle kernel lantern meadow nebula orbit '
  + 'pillar quartz ridge signal tunnel union valley window yonder zenith anchor beacon canyon dune ember '
  + 'forge glacier hollow ivory jasper keystone lumen mosaic nectar oasis prism quill raven summit thistle '
  + 'umbra vertex willow xenon yarrow zephyr decision meeting customer shipped reviewed planned blocked '
  + 'estimate budget owner status update release rollback metric target quarter customer feedback'
).split(' ');

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

// Zipf-weighted vocabulary: the listed words are the head, a synthetic tail follows. Real text has a
// few very common words and a long tail of rare ones, and FTS cost depends on exactly that shape (a
// uniform vocabulary would make every query term match a third of the corpus).
const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'to', 'vi', 'xe', 'zo', 'an', 'el', 'or', 'um'];
const VOCAB: string[] = [...WORDS];
for (let i = 0; VOCAB.length < 2500; i++) {
  VOCAB.push(`${SYLLABLES[i % 14]}${SYLLABLES[Math.floor(i / 14) % 14]}${SYLLABLES[Math.floor(i / 196) % 14]}${i % 7 === 0 ? 'n' : ''}`);
}
const ZIPF_CDF: number[] = (() => {
  let total = 0;
  const cdf = VOCAB.map((_, i) => (total += 1 / (i + 1)));
  return cdf.map(x => x / total);
})();
function zipfWord(rnd: () => number): string {
  const r = rnd();
  let lo = 0, hi = ZIPF_CDF.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ZIPF_CDF[mid] < r) lo = mid + 1; else hi = mid; }
  return VOCAB[lo];
}

function sentence(rnd: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(zipfWord(rnd));
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

export interface Fixture { notes: number; facts: number; seed: number; dims: number; vectors: 'hash' | 'vertex' | 'cache-only'; padSections?: number; factSubjects?: number }

export function writeNotes(memoryDir: string, p: Fixture): void {
  const rnd = mulberry32(p.seed);
  for (let i = 0; i < p.notes; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const ageDays = Math.floor(rnd() * 120);
    const when = new Date(FROZEN_NOW_MS - ageDays * DAY_MS);
    const scoped = i % 25 === 0;
    const dir = scoped
      ? path.join(memoryDir, 'Memory', 'Scopes', 'alpha', 'Daily')
      : path.join(memoryDir, 'Notes', topic);
    fs.mkdirSync(dir, { recursive: true });
    const id = String(i).padStart(5, '0');
    const links = [Math.floor(rnd() * p.notes), Math.floor(rnd() * p.notes)]
      .map(n => `[[${TOPICS[n % TOPICS.length]} note ${String(n).padStart(5, '0')}]]`).join(' and ');
    const body = [
      `---`,
      `date: ${when.toISOString().slice(0, 10)}`,
      `tags: [${topic}, q${1 + (i % 4)}]`,
      `status: ${i % 7 === 0 ? 'archived' : 'active'}`,
      `owner: person-${i % 37}`,
      i % 11 === 0 ? `kind: ${i % 22 === 0 ? 'historical' : 'note'}` : '',
      `---`,
      `# ${topic} note ${id}`,
      '',
      `${sentence(rnd, 28)} We discussed ${topic} for project-${i % 150} with person-${i % 37}. ${sentence(rnd, 20)}`,
      '',
      `## Decisions`,
      `${sentence(rnd, 24)} See ${links}. ${sentence(rnd, 18)}`,
      '',
      `## Follow-ups`,
      `${sentence(rnd, 22)} Budget for ${topic} is ${100 + (i % 900)} units. ${sentence(rnd, 16)}`,
      '',
      ...Array.from({ length: p.padSections ?? 0 }, (_, k) => [`## Section ${k + 1}`, `${sentence(rnd, 30)} ${sentence(rnd, 14)}`, '']).flat(),
    ].filter((l, idx) => l !== '' || idx > 0).join('\n');
    const file = path.join(dir, `${topic}-note-${id}.md`);
    fs.writeFileSync(file, body);
    fs.utimesSync(file, when, when);
  }
}

const factSubjectNames = (n: number): string[] => ['Rowan', 'Renor', ...Array.from({ length: n - 2 }, (_, i) => `project-${i}`)];
const FACT_PREDICATES = [
  'current_project', 'preferred_name', 'location', 'primary_goal', 'status', 'owner', 'priority',
  'stack', 'deadline', 'budget', 'cofounder', 'reviewer',
];

export async function writeFacts(client: Client, p: Fixture): Promise<void> {
  const rnd = mulberry32(p.seed + 1);
  const subjects = factSubjectNames(p.factSubjects ?? 62);
  for (let i = 0; i < p.facts; i++) {
    const subject = subjects[i % subjects.length];
    const predicate = FACT_PREDICATES[Math.floor(i / subjects.length) % FACT_PREDICATES.length]
      + (i >= subjects.length * FACT_PREDICATES.length ? `_${Math.floor(i / (subjects.length * FACT_PREDICATES.length))}` : '');
    const scope = i % 9 === 0 ? 'project:alpha' : undefined;
    await client.callTool({
      name: 'save_memory',
      arguments: { subject, predicate, object: `${zipfWord(rnd)} ${pick(rnd, TOPICS)} ${i}`, ...(scope ? { scope } : {}) },
    });
    if (i % 10 === 0) { // a correction: exercises history rows without changing the live count
      await client.callTool({
        name: 'save_memory',
        arguments: { subject, predicate, object: `${zipfWord(rnd)} ${pick(rnd, TOPICS)} revised ${i}`, ...(scope ? { scope } : {}) },
      });
    }
  }
}

// ---- environment, providers, workspace ----------------------------------------------

/** Variables the Vertex tier needs (and nothing else): the embedding provider and its cache. */
const VERTEX_ENV = /^(RENOR_EVAL_VERTEX_[A-Z_]+|RENOR_EVAL_MODEL|RENOR_EVAL_EMBEDDING_DIMS|RENOR_EVAL_EMBED_CACHE|RENOR_EVAL_MAX_EMBED_TOKENS|GOOGLE_APPLICATION_CREDENTIALS)$/;
const CREDENTIAL_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DSN|AUTH)/i;

/**
 * Runs `fn` with product defaults, no outbound telemetry and no extractor key, whatever the caller's shell
 * holds. A shell that has sourced a secrets file carries PostHog / Sentry / Langfuse keys and, worse, the Ollama
 * key pool the default-on evidence pass would use for a real model call on every query: so everything
 * credential-shaped and every RENOR_* / MVP_* / OLLAMA_* setting is dropped, and only the Vertex variables the
 * `vertex` tier needs are kept. The bench then refuses to run if an extractor key somehow survives.
 */
export async function withBenchEnv<T>(keepVertex: boolean, evidence: 'default' | 'off', fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (keepVertex && VERTEX_ENV.test(key)) continue;
    if (/^(RENOR_|MVP_|LANGFUSE_|EMBEDDING_|OLLAMA_)/.test(key) || CREDENTIAL_LIKE.test(key) || key === 'VAULT_PATH') delete process.env[key];
  }
  process.env.RENOR_TELEMETRY_DISABLED = 'true';
  if (evidence === 'off') process.env.RENOR_SEARCH_EVIDENCE = '0';
  if (collectOllamaKeys(process.env).keys.length > 0 || process.env.RENOR_EVIDENCE_API_KEY || process.env.RENOR_EVIDENCE_API_KEYS) {
    throw new Error('refusing to run: an evidence extractor key is present in the environment');
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

interface Vectors { provider: EmbeddingProvider | null; close(): void }

function openVectors(kind: Embeddings, o: Pick<BenchOptions, 'dims' | 'embedCache'>): Vectors {
  if (kind === 'none') return { provider: null, close() {} };
  if (kind === 'hash') {
    return { provider: Object.assign(new EvalHashEmbeddingProvider(), { dimensions: o.dims }), close() {} };
  }
  if (kind === 'cache-only') {
    if (!o.embedCache) throw new Error('--embeddings cache-only needs --embed-cache <the cache file to read>');
    const cache = new CacheOnlyVertex(o.embedCache);
    return { provider: cache, close: () => cache.close() };
  }
  const vertex = new VertexEmbeddingProvider({ dimensions: o.dims, maxInputTokens: VERTEX_TOKEN_CAP });
  const cachePath = o.embedCache ?? resolveEmbeddingCachePath();
  if (!cachePath) throw new Error('--embeddings vertex needs a persistent cache: pass --embed-cache or unset RENOR_EVAL_EMBED_CACHE=off');
  const cached = new CachingEmbeddingProvider(vertex, { cachePath });
  return { provider: cached, close: () => cached.close() };
}

function benchConfig(memoryDir: string, authDir: string): MvpConfig {
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:1',
    MVP_OWNER_EMAIL: 'bench@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-bench-secret-123',
    MVP_PORT: '1',
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
  });
  return loadMvpConfig();
}

export async function openWorkspace(memoryDir: string, provider: EmbeddingProvider | null, authDir: string) {
  const app = createMvpApp(benchConfig(memoryDir, authDir), provider);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverT);
  const client = new Client({ name: 'mcp-latency-bench', version: '0' });
  await client.connect(clientT);
  return { app, client, close: async () => { await client.close(); await app.close(); } };
}

/** The fixture an option set asks for, and the directory it lives in: `<dir>/n<notes>[-p<pad>-f<facts>-s<subjects>]-<vectors><dims>`. */
export function fixtureFor(o: BenchOptions, notes: number): { memoryDir: string; fixture: Fixture } {
  const fixture: Fixture = {
    notes, facts: o.facts ?? Math.max(20, Math.floor(notes / 5)), seed: SEED, dims: o.dims,
    vectors: o.embeddings === 'vertex' || o.embeddings === 'cache-only' ? o.embeddings : 'hash', // `none` measures the hash fixture with the provider detached
    ...(o.padSections ? { padSections: o.padSections } : {}),
    ...(o.factSubjects ? { factSubjects: o.factSubjects } : {}),
  };
  const shape = o.padSections || o.facts || o.factSubjects ? `-p${o.padSections ?? 0}-f${fixture.facts}-s${o.factSubjects ?? 62}` : '';
  return { memoryDir: path.join(o.dir, `n${notes}${shape}-${fixture.vectors}${o.dims}`), fixture };
}

export async function ensureFixture(o: BenchOptions, notes: number, authDir: string, log: (l: string) => void): Promise<{ memoryDir: string; fixture: Fixture }> {
  const { memoryDir, fixture } = fixtureFor(o, notes);
  const marker = path.join(memoryDir, '.bench-fixture.json');
  const want = JSON.stringify(fixture);
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === want) return { memoryDir, fixture };
  if (o.embeddings === 'cache-only') throw new Error(`--embeddings cache-only measures a fixture built beforehand: ${memoryDir} is missing or was built for other options`);
  fs.rmSync(memoryDir, { recursive: true, force: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const t0 = performance.now();
  writeNotes(memoryDir, fixture);
  const vectors = openVectors(fixture.vectors, o);
  const ws = await openWorkspace(memoryDir, vectors.provider, authDir);
  try {
    await writeFacts(ws.client, fixture);
    await ws.client.callTool({ name: 'index_memory', arguments: {} }, undefined, { timeout: 3 * 60 * 60_000 });
  } finally { await ws.close(); vectors.close(); }
  fs.writeFileSync(marker, want);
  log(`  generated ${notes} notes + ${fixture.facts} facts (${fixture.vectors} ${o.dims}-d) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return { memoryDir, fixture };
}

// ---- queries -----------------------------------------------------------------------

type ReadTool = 'get_context' | 'search_memory' | 'search_text' | 'lookup_entity' | 'retrieve_memory';
interface Call { tool: ReadTool; label: string; args: Record<string, unknown> }

export function buildCalls(set: 'default' | 'wide' = 'default'): Call[] {
  const ctx: Array<[string, Record<string, unknown>]> = [
    ['nl-topic', { query: 'what did we decide about billing for project-12' }],
    ['nl-two-topics', { query: 'status of the gateway rollout and the incident follow-ups' }],
    ['identity', { query: 'who is Rowan and what is my current project' }],
    ['first-person', { query: 'what is my preferred name and location' }],
    ['fact-match', { query: 'project-7 status owner deadline' }],
    ['hyphenated', { query: 'project-33 retrieval budget' }],
    ['past-intent', { query: 'what was the pricing decision previously' }],
    ['dated', { query: 'roadmap decisions in March 2026' }],
    ['no-match', { query: 'zxqv unrelated nonsense xylophone' }],
    ['scoped', { query: 'follow-ups for the alpha workstream', scope: 'project:alpha' }],
    ['long', { query: 'summarise everything we know about security privacy and export decisions, owners and budgets for the quarter' }],
    ['profile', {}],
    ['big-budget', { query: 'customer feedback release metric target', max_tokens: 4000 }],
  ];
  const search: Array<[string, Record<string, unknown>]> = [
    ['nl-topic', { query: 'what did we decide about billing for project-12' }],
    ['topic-word', { query: 'embeddings' }],
    ['person', { query: 'person-12 owner updates' }],
    ['identity', { query: 'who is Rowan' }],
    ['no-match', { query: 'zxqv unrelated nonsense xylophone' }],
    ['scoped', { query: 'follow-ups for the alpha workstream', scope: 'project:alpha' }],
    ['top50', { query: 'shipped reviewed planned blocked estimate', top_k: 50 }],
    ['past-intent', { query: 'what was the pricing decision previously' }],
  ];
  const base: Call[] = [
    ...ctx.map(([label, args]) => ({ tool: 'get_context' as const, label, args })),
    ...search.map(([label, args]) => ({ tool: 'search_memory' as const, label, args })),
  ];
  return set === 'wide' ? [...base, ...wideCalls()] : base;
}

/**
 * The calls the byte-identity check adds to the default ones: a fixed set drawn from a seeded PRNG over the
 * fixture's own vocabulary (topics, subjects, predicates, Zipf words), so it is the same on every run and every
 * commit. It reaches the paths the default set does not: every scope spelling, every top_k band, every token
 * budget, history, questions about the past and about dates, a long query, non-Latin and punctuation-heavy text,
 * and the other read tools. Digests are of the whole response text, so any reordering, rounding or dropped
 * field is a DIFF. Nothing here asserts a result, only that two commits agree on it.
 */
function wideCalls(): Call[] {
  const rnd = mulberry32(SEED + 7);
  const topic = () => pick(rnd, TOPICS);
  const word = () => zipfWord(rnd);
  const subject = () => `project-${Math.floor(rnd() * 60)}`;
  const predicate = () => pick(rnd, FACT_PREDICATES);
  const out: Call[] = [];
  let n = 0;
  const add = (tool: ReadTool, label: string, args: Record<string, unknown>) => out.push({ tool, label: `w${String(++n).padStart(2, '0')}-${label}`, args });

  const questions = [
    () => `what did we decide about ${topic()} for ${subject()}`,
    () => `status of the ${topic()} work and the ${topic()} follow-ups`,
    () => `${word()} ${word()} ${topic()}`,
    () => `who owns ${subject()} and what is its ${predicate()}`,
    () => `${subject()} ${predicate()} ${predicate()}`,
    () => `remind me what ${word()} meant in the ${topic()} notes`,
    () => `any blockers on ${topic()} this quarter`,
    () => `${topic()} budget and deadline`,
    () => `what is Rowan working on`,
    () => `which decisions touched ${topic()} and ${topic()}`,
    () => `${word()}`,
    () => `notes mentioning person-${Math.floor(rnd() * 37)}`,
    () => `how did ${subject()} change over time`,
    () => `anything about ${topic()} shipped recently`,
  ];
  for (const q of questions) add('get_context', 'question', { query: q() });
  for (const scope of ['project:alpha', 'alpha', 'scope:alpha', 'global', 'project:no-such-scope']) {
    add('get_context', `scope-${scope}`, { query: `follow-ups and decisions about ${topic()}`, scope });
  }
  add('get_context', 'scope-profile', { scope: 'project:alpha' });
  for (const max_tokens of [128, 300, 1500, 4000]) add('get_context', `budget-${max_tokens}`, { query: `${topic()} ${word()} decisions owners budgets`, max_tokens });
  add('get_context', 'history', { query: `what was the ${predicate()} of ${subject()} before`, include_history: true });
  add('get_context', 'history-profile', { include_history: true });
  add('get_context', 'history-scoped', { query: `${subject()} ${predicate()}`, include_history: true, scope: 'project:alpha' });
  for (const q of ['what was the budget before the last change', 'decisions in March 2026', 'what happened last week', 'status on 2026-03-14', 'what did we plan for next quarter']) add('get_context', 'temporal', { query: q });
  for (const q of ['zxqv unrelated nonsense xylophone', 'café résumé naïve façade', '日本語のクエリ メモリ', 'what about "quoted phrase" and (parens) and *star*', "it's O'Brien's project-12 - isn't it?"]) add('get_context', 'odd-text', { query: q });
  add('get_context', 'long', { query: Array.from({ length: 60 }, () => word()).join(' '), max_tokens: 2000 });
  add('get_context', 'long-questions', { query: `summarise ${topic()}, ${topic()}, ${topic()} and ${topic()} decisions, owners, budgets and deadlines for ${subject()} and ${subject()}` });

  for (const top_k of [1, 3, 5, 10, 20, 50]) add('search_memory', `top${top_k}`, { query: `${topic()} ${word()} ${word()}`, top_k });
  for (let i = 0; i < 6; i++) add('search_memory', 'question', { query: questions[i]() });
  for (const scope of ['project:alpha', 'alpha', 'global']) add('search_memory', `scope-${scope}`, { query: `follow-ups for ${topic()}`, scope, top_k: 10 });
  add('search_memory', 'history', { query: `${subject()} ${predicate()} before`, include_history: true, top_k: 10 });
  add('search_memory', 'temporal', { query: 'what was decided in March 2026', top_k: 10 });
  add('search_memory', 'odd-text', { query: '日本語のクエリ メモリ café', top_k: 5 });
  add('search_memory', 'long', { query: Array.from({ length: 40 }, () => word()).join(' '), top_k: 15 });

  for (const q of [`${topic()}`, `${word()} ${word()}`, `${subject()}`, `person-${Math.floor(rnd() * 37)}`, 'billing', `${topic()} ${topic()}`]) add('search_text', 'keywords', { query: q });
  add('search_text', 'top5', { query: `${topic()} ${word()}`, top_k: 5 });
  add('search_text', 'scoped', { query: `${topic()}`, scope: 'project:alpha' });
  add('search_text', 'identity', { query: 'project-12' });

  for (const name of ['Rowan', 'Renor', subject(), topic(), `${topic()} note 00012`, 'project', 'no such entity here']) add('lookup_entity', 'name', { name });
  add('lookup_entity', 'scoped', { name: 'alpha', scope: 'project:alpha' });

  for (const subjectName of ['Rowan', 'Renor', subject(), 'project-7']) add('retrieve_memory', 'subject', { subject: subjectName });
  add('retrieve_memory', 'predicate', { subject: 'Rowan', predicate: 'status' });
  add('retrieve_memory', 'history', { subject: 'Renor', include_history: true });
  add('retrieve_memory', 'as-of', { subject: 'Rowan', as_of: '2026-09-30T00:00:00Z', include_history: true });
  add('retrieve_memory', 'scoped', { subject: 'project-9', scope: 'project:alpha' });
  add('retrieve_memory', 'unknown', { subject: 'project-1x' });
  return out;
}

// ---- statistics ------------------------------------------------------------------------

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export interface Stat { n: number; medianMs: number; p95Ms: number; maxMs: number }
export function stat(samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, medianMs: pct(s, 0.5), p95Ms: pct(s, 0.95), maxMs: s[s.length - 1] };
}
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * CPU time of the thread running the event loop (ms). process.cpuUsage() adds every thread, including V8's
 * GC helpers and libuv's pool, whose work lands in whichever call happens to be running: it inflates tail
 * percentiles with time that never blocked a request. The main thread is the work a call actually waits on.
 */
const HAS_THREAD_CPU = typeof (process as { threadCpuUsage?: unknown }).threadCpuUsage === 'function';
const threadCpu = (): number => {
  if (!HAS_THREAD_CPU) return 0;
  const t = (process as unknown as { threadCpuUsage(): { user: number; system: number } }).threadCpuUsage();
  return (t.user + t.system) / 1000;
};

// ---- SQL-level profile ---------------------------------------------------------------------

interface ToolProfile {
  calls: number; wallMs: number; embedMs: number; sqlMs: number;
  statements: Array<{ sql: string; calls: number; ms: number }>;
}

/**
 * Times every Statement.get/all/run and Database.prepare while installed, attributed to the tool call
 * in flight, plus the provider's query-embedding hop. Whatever is left of the wall time is JS
 * (ranking, shaping, serialization). better-sqlite3 is synchronous, so a statement's time is its cost.
 */
class Profiler {
  private tool: string | null = null;
  private readonly sql = new Map<string, Map<string, { calls: number; ms: number }>>();
  private readonly embed = new Map<string, number>();
  private readonly wall = new Map<string, { calls: number; ms: number }>();
  private undo: Array<() => void> = [];

  install(provider: EmbeddingProvider | null): void {
    const probe = new Database(':memory:');
    const statementProto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
    probe.close();
    const wrap = (target: any, name: string, label: (self: any, args: unknown[]) => string) => {
      const original = target[name];
      const sink = (key: string, ms: number) => {
        if (!this.tool) return;
        const perTool = this.sql.get(this.tool) ?? new Map();
        this.sql.set(this.tool, perTool);
        const row = perTool.get(key) ?? { calls: 0, ms: 0 };
        row.calls += 1; row.ms += ms;
        perTool.set(key, row);
      };
      target[name] = function (this: unknown, ...args: unknown[]) {
        const t0 = performance.now();
        try { return original.apply(this, args); } finally { sink(label(this, args), performance.now() - t0); }
      };
      this.undo.push(() => { target[name] = original; });
    };
    for (const method of ['get', 'all', 'run']) wrap(statementProto, method, self => String(self.source));
    wrap(Database.prototype, 'prepare', (_self, args) => `[prepare] ${String(args[0])}`);
    if (provider?.embedQuery) {
      const original = provider.embedQuery.bind(provider);
      provider.embedQuery = async (text: string) => {
        const t0 = performance.now();
        try { return await original(text); } finally {
          if (this.tool) this.embed.set(this.tool, (this.embed.get(this.tool) ?? 0) + performance.now() - t0);
        }
      };
    }
  }

  uninstall(): void { this.undo.forEach(fn => fn()); this.undo = []; }
  begin(tool: string): void { this.tool = tool; }
  end(tool: string, wallMs: number): void {
    const w = this.wall.get(tool) ?? { calls: 0, ms: 0 };
    w.calls += 1; w.ms += wallMs;
    this.wall.set(tool, w);
    this.tool = null;
  }

  summary(): Record<string, ToolProfile> {
    const out: Record<string, ToolProfile> = {};
    for (const [tool, w] of this.wall) {
      const statements = [...(this.sql.get(tool) ?? [])]
        .map(([sql, r]) => ({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 110), calls: r.calls, ms: r.ms }))
        .sort((a, b) => b.ms - a.ms);
      out[tool] = {
        calls: w.calls, wallMs: w.ms, embedMs: this.embed.get(tool) ?? 0,
        sqlMs: statements.reduce((sum, s) => sum + s.ms, 0), statements,
      };
    }
    return out;
  }
}

// ---- measurement ----------------------------------------------------------------------------

export interface SizeResult {
  notes: number; facts: number;
  stats: Record<string, Stat>;                // per tool, wall clock
  cpuStats: Record<string, Stat>;             // per tool, process CPU (user+system, all threads): steadier than wall on a loaded host
  threadStats?: Record<string, Stat>;         // per tool, CPU of the event-loop thread alone (Node >= 22.19)
  perCall: Record<string, Stat>;              // per tool:label, wall clock
  samples: { wall: Record<string, number[]>; cpu: Record<string, number[]>; thread?: Record<string, number[]> };
  digests: Record<string, string>;            // per tool:label -> sha256 of the response text
  responseBytes: Record<string, number>;
  profile?: Record<string, ToolProfile>;
}

async function measure(memoryDir: string, fixture: Fixture, o: BenchOptions, authDir: string): Promise<SizeResult> {
  const vectors = openVectors(o.embeddings, o);
  const profiler = o.profile ? new Profiler() : null;
  const ws = await openWorkspace(memoryDir, vectors.provider, authDir);
  try {
    const calls = buildCalls(o.queries ?? 'default')
      .filter(c => o.embeddings !== 'none' || (c.tool !== 'search_memory'))
      .filter(c => !o.tools || o.tools.includes(c.tool))
      .filter(c => !o.calls || o.calls.test(`${c.tool}:${c.label}`));
    if (calls.length === 0) throw new Error('no calls to measure: --tools and --calls match none of the calls the set holds');
    const run = async (c: Call) => {
      profiler?.begin(c.tool);
      const cpu0 = process.cpuUsage();
      const thread0 = threadCpu();
      const t0 = performance.now();
      const res = await ws.client.callTool({ name: c.tool, arguments: c.args });
      const ms = performance.now() - t0;
      const cpu = process.cpuUsage(cpu0);
      const threadMs = threadCpu() - thread0;
      profiler?.end(c.tool, ms);
      const text = (res.content as Array<{ text: string }>)[0].text;
      return { ms, cpuMs: (cpu.user + cpu.system) / 1000, threadMs, text, isError: res.isError === true };
    };
    // Warm pass, real clock: statement and page caches, lazy init, and (vertex) the first, paid
    // embedding of every query. After it every provider call is a cache hit.
    for (const c of calls) await run(c);
    // A read that cannot embed its query answers without the semantic lane instead of failing, so a cache-only
    // run that missed would time a different, cheaper read: refuse it.
    const assertNoMisses = (): void => {
      if (vectors.provider instanceof CacheOnlyVertex && vectors.provider.stats.misses > 0) {
        throw new Error(`cache-only: ${vectors.provider.stats.misses} embedding(s) were not in ${o.embedCache}, so the reads were not the dense reads this tier measures`);
      }
    };
    assertNoMisses();

    const wall: Record<string, number[]> = {}, cpu: Record<string, number[]> = {}, thread: Record<string, number[]> = {}, byCall: Record<string, number[]> = {};
    const digests: Record<string, string> = {}, bytes: Record<string, number> = {}, texts: Record<string, string> = {};
    const realNow = Date.now;
    Date.now = () => FROZEN_NOW_MS; // recency scoring must be the same on every run
    profiler?.install(vectors.provider);
    const cpuProfile = o.cpuProfile ? await CpuProfile.start() : null;
    try {
      for (let r = 0; r < o.runs; r++) {
        for (const c of calls) {
          const { ms, cpuMs, threadMs, text, isError } = await run(c);
          const key = `${c.tool}:${c.label}`;
          if (isError) throw new Error(`${key} returned an error: ${text.slice(0, 200)}`);
          (wall[c.tool] ??= []).push(round3(ms));
          (cpu[c.tool] ??= []).push(round3(cpuMs));
          if (HAS_THREAD_CPU) (thread[c.tool] ??= []).push(round3(threadMs));
          (byCall[key] ??= []).push(round3(ms));
          const d = crypto.createHash('sha256').update(text).digest('hex');
          if (digests[key] && digests[key] !== d) throw new Error(`${key} is not deterministic across runs: ${firstDifference(texts[key], text)}`);
          texts[key] ??= text;
          digests[key] = d;
          bytes[key] = text.length;
        }
      }
    } finally {
      profiler?.uninstall();
      Date.now = realNow;
      if (cpuProfile && o.cpuProfile) fs.writeFileSync(o.cpuProfile, JSON.stringify(await cpuProfile.stop()));
    }
    assertNoMisses();
    const statsOf = (m: Record<string, number[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stat(v)]));
    return {
      notes: fixture.notes, facts: fixture.facts,
      stats: statsOf(wall), cpuStats: statsOf(cpu), ...(HAS_THREAD_CPU ? { threadStats: statsOf(thread) } : {}), perCall: statsOf(byCall),
      samples: { wall, cpu, ...(HAS_THREAD_CPU ? { thread } : {}) }, digests, responseBytes: bytes,
      ...(profiler ? { profile: profiler.summary() } : {}),
    };
  } finally { await ws.close(); vectors.close(); }
}

/** N live (uncached) query embeddings: the provider hop every hosted call to a Vertex workspace pays. */
async function probeHop(o: BenchOptions, n: number): Promise<Stat> {
  const live = new VertexEmbeddingProvider({ dimensions: o.dims, maxInputTokens: VERTEX_TOKEN_CAP });
  const queries = buildCalls().filter(c => c.tool === 'get_context' && typeof c.args.query === 'string').map(c => String(c.args.query));
  await live.embedQuery('warm the access token and the connection'); // the first call mints the token and opens TLS
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await live.embedQuery(`${queries[i % queries.length]} #${i}`);
    samples.push(performance.now() - t0);
  }
  return stat(samples);
}

// ---- run + compare ---------------------------------------------------------------------------

export interface BenchResult {
  meta: { label: string; node: string; commit: string; embeddings: Embeddings; dims: number; runs: number; evidence: 'default' | 'off'; sqlite: string; cpu: string };
  hop?: Stat;
  sizes: Record<string, SizeResult>;
}

function commitId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return 'n/a'; }
}

const ms2 = (x: number): string => x.toFixed(2);

/** The first line two response bodies disagree on, so a determinism failure says what moved. */
function firstDifference(a: string, b: string): string {
  const x = a.split('\n'), y = b.split('\n');
  const i = x.findIndex((line, n) => line !== y[n]);
  return i < 0 ? 'bodies differ in length only' : `line ${i + 1}: ${JSON.stringify(x[i]?.trim().slice(0, 100))} vs ${JSON.stringify(y[i]?.trim().slice(0, 100))}`;
}

function describeSize(log: (l: string) => void, notes: number, r: SizeResult, o: BenchOptions): void {
  for (const [tool, s] of Object.entries(r.stats)) {
    const c = r.cpuStats[tool], th = r.threadStats?.[tool];
    log(`n=${String(notes).padStart(5)} ${tool.padEnd(13)} median ${ms2(s.medianMs).padStart(8)} ms  p95 ${ms2(s.p95Ms).padStart(8)} ms  max ${ms2(s.maxMs).padStart(8)} ms  (${s.n} calls)`
      + (th ? `  main-thread cpu median ${ms2(th.medianMs)} ms  p95 ${ms2(th.p95Ms)} ms` : '') + `  process cpu median ${ms2(c.medianMs)} ms  p95 ${ms2(c.p95Ms)} ms`);
  }
  if (o.perCall) {
    for (const [key, s] of Object.entries(r.perCall)) log(`    ${key.padEnd(28)} median ${ms2(s.medianMs).padStart(8)} ms  p95 ${ms2(s.p95Ms).padStart(8)} ms  ${r.responseBytes[key]} bytes`);
  }
  for (const [tool, tp] of Object.entries(r.profile ?? {})) {
    const mean = (x: number) => ms2(x / tp.calls).padStart(7);
    log(`  profile ${tool} @${notes}: mean per call over ${tp.calls} calls: wall ${mean(tp.wallMs)} ms = sql ${mean(tp.sqlMs)} + query embedding ${mean(tp.embedMs)} + other JS ${mean(tp.wallMs - tp.sqlMs - tp.embedMs)}`);
    for (const s of tp.statements.slice(0, 10)) log(`    ${mean(s.ms)} ms ${(s.calls / tp.calls).toFixed(1).padStart(6)}x  ${s.sql}`);
  }
}

export async function runBench(o: BenchOptions): Promise<BenchResult> {
  const log = o.log ?? (() => {});
  fs.mkdirSync(o.dir, { recursive: true });
  return withBenchEnv(o.embeddings === 'vertex', o.evidence ?? 'default', async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-auth-'));
    const consoleLog = console.log;
    console.log = () => {}; // the server's tool_use telemetry lines
    try {
      const result: BenchResult = {
        meta: {
          label: o.label ?? 'run', node: process.version, commit: commitId(), embeddings: o.embeddings, dims: o.dims, runs: o.runs, evidence: o.evidence ?? 'default',
          sqlite: (() => { const db = new Database(':memory:'); try { return String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v); } finally { db.close(); } })(),
          cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
        },
        sizes: {},
      };
      if (o.probeHop) {
        if (o.embeddings !== 'vertex') throw new Error('--probe-hop times live Vertex embeddings: use --embeddings vertex');
        result.hop = await probeHop(o, o.probeHop);
        log(`query-embedding hop (live Vertex ${o.dims}-d, ${result.hop.n} calls): median ${ms2(result.hop.medianMs)} ms  p95 ${ms2(result.hop.p95Ms)} ms  max ${ms2(result.hop.maxMs)} ms (not included in the tool timings below)`);
      }
      for (const notes of o.sizes) {
        log(`n=${notes}`);
        const { memoryDir, fixture } = await ensureFixture(o, notes, authDir, log);
        const r = await measure(memoryDir, fixture, o, authDir);
        result.sizes[String(notes)] = r;
        describeSize(log, notes, r, o);
      }
      return result;
    } finally {
      console.log = consoleLog;
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });
}

/**
 * Pools every run on each side and compares: identical response digests (every file on both sides must
 * agree on every call) and the change in median / p95, wall and CPU.
 */
export function compare(before: BenchResult[], after: BenchResult[]): { identical: boolean; lines: string[] } {
  const lines: string[] = [];
  const all = [...before, ...after];
  const first = before[0];
  for (const r of all) {
    if (r.meta.embeddings !== first.meta.embeddings || r.meta.dims !== first.meta.dims || r.meta.evidence !== first.meta.evidence) {
      lines.push(`WARNING: ${r.meta.label} ran with ${r.meta.embeddings}/${r.meta.dims}/evidence ${r.meta.evidence}, not ${first.meta.embeddings}/${first.meta.dims}/evidence ${first.meta.evidence}: not comparable`);
    }
  }
  let compared = 0, differing = 0;
  const change = (a: number, b: number): string => `${((b - a) / a * 100).toFixed(0).replace(/^(\d)/, '+$1')}%`;
  const pool = (rs: BenchResult[], size: string, kind: 'wall' | 'cpu' | 'thread', tool: string): Stat =>
    stat(rs.flatMap(r => r.sizes[size]?.samples[kind]?.[tool] ?? []));
  for (const size of Object.keys(first.sizes)) {
    const reference = first.sizes[size].digests;
    for (const r of all) {
      const digests = r.sizes[size]?.digests;
      if (!digests) { lines.push(`size ${size}: missing in ${r.meta.label}`); differing++; continue; }
      for (const key of Object.keys(reference)) {
        compared++;
        if (digests[key] !== reference[key]) { lines.push(`DIFF n=${size} ${key} (${r.meta.label} ${r.meta.commit})`); differing++; }
      }
    }
    for (const tool of Object.keys(first.sizes[size].samples.wall)) {
      const w0 = pool(before, size, 'wall', tool), w1 = pool(after, size, 'wall', tool);
      const c0 = pool(before, size, 'cpu', tool), c1 = pool(after, size, 'cpu', tool);
      const t0 = pool(before, size, 'thread', tool), t1 = pool(after, size, 'thread', tool);
      const threadPart = t0.n > 0 && t1.n > 0
        ? `main-thread cpu median ${ms2(t0.medianMs)} -> ${ms2(t1.medianMs)} ms (${change(t0.medianMs, t1.medianMs)}), p95 ${ms2(t0.p95Ms)} -> ${ms2(t1.p95Ms)} ms (${change(t0.p95Ms, t1.p95Ms)}); ` : '';
      lines.push(`n=${size.padStart(5)} ${tool.padEnd(13)} wall median ${ms2(w0.medianMs)} -> ${ms2(w1.medianMs)} ms (${change(w0.medianMs, w1.medianMs)}), p95 ${ms2(w0.p95Ms)} -> ${ms2(w1.p95Ms)} ms (${change(w0.p95Ms, w1.p95Ms)}); `
        + threadPart
        + `process cpu median ${ms2(c0.medianMs)} -> ${ms2(c1.medianMs)} ms (${change(c0.medianMs, c1.medianMs)}), p95 ${ms2(c0.p95Ms)} -> ${ms2(c1.p95Ms)} ms (${change(c0.p95Ms, c1.p95Ms)})  [${w0.n} vs ${w1.n} calls]`);
    }
  }
  lines.push(differing === 0
    ? `RESULT SETS IDENTICAL: ${compared} response digests compared across ${all.length} runs (byte-for-byte)`
    : `${differing} response digest(s) differ or are missing`);
  return { identical: differing === 0, lines };
}

// ---- CLI -----------------------------------------------------------------------------------------

/** What a command line (`--sizes`, `--runs`, ... as in the header) asks runBench for, and where to write the result. */
export function benchOptionsFromArgs(argv: string[]): { options: BenchOptions; out?: string } {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const embeddings = (arg('embeddings') ?? 'hash') as Embeddings;
  if (!['hash', 'vertex', 'cache-only', 'none'].includes(embeddings)) throw new Error('--embeddings must be hash, vertex, cache-only or none');
  // `--shape live` (LIVE_SHAPE). Individual flags override the preset.
  const live = arg('shape') === 'live';
  const num = (name: string, fallback?: number) => (arg(name) !== undefined ? Number(arg(name)) : fallback);
  const shape = { padSections: num('pad-sections', live ? LIVE_SHAPE.padSections : undefined), facts: num('facts', live ? LIVE_SHAPE.facts : undefined), factSubjects: num('fact-subjects', live ? LIVE_SHAPE.factSubjects : undefined) };
  if (flag('profile') && arg('cpu-profile')) throw new Error('--profile and --cpu-profile both slow every call: run them separately');
  return {
    out: arg('out'),
    options: {
      sizes: (arg('sizes') ?? (live ? String(LIVE_SHAPE.notes) : '100,1000,10000')).split(',').map(Number),
      runs: Number(arg('runs') ?? 7),
      embeddings,
      dims: Number(arg('dims') ?? 768),
      dir: arg('dir') ?? path.join(os.tmpdir(), 'renor-mcp-latency-fixtures'),
      label: arg('label'),
      evidence: arg('evidence') === 'off' ? 'off' : 'default',
      profile: flag('profile'),
      perCall: flag('per-call'),
      padSections: shape.padSections, facts: shape.facts, factSubjects: shape.factSubjects,
      queries: arg('queries') === 'wide' ? 'wide' : 'default',
      tools: arg('tools')?.split(','),
      calls: arg('calls') ? new RegExp(arg('calls')!) : undefined,
      cpuProfile: arg('cpu-profile'),
      probeHop: arg('probe-hop') ? Number(arg('probe-hop')) : undefined,
      embedCache: arg('embed-cache'),
    },
  };
}

const say = (line: string): void => { process.stdout.write(line + '\n'); };

async function main(): Promise<void> {
  if (process.argv.includes('--compare')) {
    const i = process.argv.indexOf('--compare');
    const load = (list: string) => list.split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8')) as BenchResult);
    const { identical, lines } = compare(load(process.argv[i + 1]), load(process.argv[i + 2]));
    lines.forEach(say);
    process.exit(identical ? 0 : 1);
  }
  const { options, out } = benchOptionsFromArgs(process.argv);
  const result = await runBench({ ...options, log: say });
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
