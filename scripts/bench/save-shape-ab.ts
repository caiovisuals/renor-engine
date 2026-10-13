/**
 * What the structured fields of a save (subject, predicate, object) buy, measured: the same facts saved two ways,
 * read back through the real MCP tools. No generation model is ever called.
 *
 *   npx tsx scripts/bench/save-shape-ab.ts [--embeddings hash|vertex] [--styles natural,explicit]
 *       [--arms S,Pn,Pc,Sd25,Sd50] [--timelines days,one-day] [--seeds 1,2,3,4,5] [--catalog] [--check-determinism]
 *       [--show 12] [--out results.json]
 *
 * One synthetic world of 24 attributes that change once (a person's city, a project's database), 12 that never
 * change, 48 journal lines that talk about the same things without stating a value, and 10 facts an agent saves again
 * on later days. Each arm saves exactly that through the `remember` tool and is then asked the same questions through
 * `get_context` (default settings, what an agent does), `retrieve_memory` and `lookup_entity`:
 *
 *   S    structured  `remember {statement, subject, predicate, object}` for every fact, the same key every time.
 *                    This is the most structure can give: the agent never misspells a key.
 *   Pn   plain       `remember {statement}`; the correction is the statement as the user would say it.
 *   Pc   plain+cue   as Pn, but the correction says it is one: "Update: ... It is no longer <old value>."
 *   Sd25 / Sd50      as S, but a quarter / half of the corrections reach the ledger under another predicate spelling
 *                    ("current_database" for "database"), as when several agents write on their own. The fraction is
 *                    a constructed sensitivity, not a measurement of any agent.
 *
 * Two styles of statement are run: `natural` ("Fjord stores its data in SQLite.": the words an agent happens to use,
 * which often leave out the name of the attribute) and `explicit` ("Fjord's database is SQLite."). The statements are
 * the same words in every arm, so a difference is the save shape and nothing else. `--embeddings hash` is the lexical
 * eval-hash stub (no network); `--embeddings vertex` is the real embedding model behind a persistent cache (only
 * embeddings are called; credentials are read from the environment by the provider and never printed).
 *
 * Two timelines are run. `days` (the default) saves the first values on day 1, the journal over days 1-5, the corrections
 * on day 8 and the repeated facts on days 9-11, so a correction lands in another daily note than what it corrects; it is
 * how a memory used for weeks looks. `one-day` saves all of it within one day, so old and new statements share a daily
 * note, which the engine reads as one session (its session expansion adds the statements of a note it matched); it is
 * how a memory used for one working night looks, and what the first version of this script did without saying so.
 *
 * Seeds, and why every figure is a mean with a range. A seed fixes everything incidental to a run: the order the facts
 * are saved in, the day and second every entry lands on (a simulated clock the engine reads, the modification time of
 * every file it writes included, so the engine's own recency scoring sees days, not milliseconds), and the random part
 * of every event id. The same seed gives the same numbers: `--check-determinism` runs the first configuration twice and
 * compares the two results whole. Different seeds differ only in those incidental things, so the spread across seeds is
 * the instrument's own noise, and the tables report `mean [min-max]` over the seeds (one number: identical in every
 * seed). The first version of this script ran on the real clock with unseeded ids, and the same command gave different
 * counts on the same tree (an independent review saw 24, 23, 24 and 16 stale lines of 24 in four runs of one arm): its
 * timestamps and ids were incidental inputs it did not control, and the stub embeds every token of a chunk, the digits
 * of a timestamp and the characters of an id included, so they moved near-ties. Pinning them made two runs identical.
 * The figures it quoted were single draws, not measurements.
 *
 * What it can and cannot say. The check is on the text of the reply (is the new value in it, is a line that asserts
 * only the old value in it, which comes first): no model reads the reply, so it measures what the reader is handed,
 * not whether a reader gets the answer right. "New value first" and its mean position need care: a plain reply lists
 * the notes it matched newest-first by the time each was saved, so a correction is first only when it happens to be the
 * most recently saved of them, which depends on the order unrelated facts were saved in (that is what the seeds vary);
 * a structured reply lists the current facts first by construction. Journal lines are the same in every arm, so they
 * move no difference. The eval-hash stub is purely lexical, so on it a plain statement is found only through the words
 * it shares with the question, and the digits of a timestamp are words to it.
 *
 * The last part (`--catalog`) is not a measurement of the product: it is the exact text an agent receives for 20
 * plausible calls (constructed here, not observed from any user), so "why is it hard" can be read, not argued. It is
 * deterministic and runs on the real clock.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp } from '../../src/mvp/server';
import { replyTokens } from '../../src/mvp/agentMemory';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { CachingEmbeddingProvider } from '../../src/embeddings/caching';

// ---------------------------------------------------------------------------------------------------------------
// The world: fictional people and projects, values chosen so no value is a substring of any other statement.
// ---------------------------------------------------------------------------------------------------------------

interface Attr { subject: string; predicate: string; label: string; old: string; neu: string; say: (value: string) => string }
const attr = (subject: string, predicate: string, label: string, old: string, neu: string, say: (value: string) => string): Attr =>
  ({ subject, predicate, label, old, neu, say });

const ATTRS: Attr[] = [
  attr('Ava', 'favorite_drink', 'favorite drink', 'mango juice', 'passion fruit juice', v => `Ava's favorite drink is ${v}.`),
  attr('Ava', 'home_city', 'home city', 'Boston', 'Seattle', v => `Ava lives in ${v}.`),
  attr('Maya', 'employer', 'employer', 'Brightloom', 'Cobaltway', v => `Maya works at ${v}.`),
  attr('Maya', 'instrument', 'instrument', 'cello', 'viola', v => `Maya is learning the ${v}.`),
  attr('Noah', 'editor', 'code editor', 'Vim', 'Helix', v => `Noah writes code in ${v}.`),
  attr('Noah', 'commute', 'commute', 'bicycle', 'tram', v => `Noah commutes by ${v}.`),
  attr('Lena', 'team', 'team', 'Lighthouse squad', 'Compass squad', v => `Lena is on the ${v}.`),
  attr('Lena', 'manager', 'manager', 'Priya Raman', 'Tomas Okafor', v => `Lena's manager is ${v}.`),
  attr('Theo', 'breakfast', 'breakfast', 'oatmeal', 'shakshuka', v => `Theo eats ${v} for breakfast.`),
  attr('Theo', 'phone', 'phone', 'Pixel Seven', 'Fairphone Five', v => `Theo's phone is a ${v}.`),
  attr('Iris', 'home_city', 'home city', 'Lisbon', 'Porto', v => `Iris lives in ${v}.`),
  attr('Iris', 'pet', "pet's name", 'Biscuit', 'Pepper', v => `Iris's dog is called ${v}.`),
  attr('Fjord', 'database', 'database', 'DuckDB', 'SQLite', v => `Fjord stores its data in ${v}.`),
  attr('Fjord', 'language', 'language', 'Python', 'TypeScript', v => `Fjord is written in ${v}.`),
  attr('Fjord', 'deploy_target', 'deploy target', 'Fly.io', 'Hetzner', v => `Fjord deploys to ${v}.`),
  attr('Fjord', 'release_cadence', 'release cadence', 'monthly', 'weekly', v => `Fjord ships a release ${v}.`),
  attr('Acme', 'billing_provider', 'billing provider', 'Stripe', 'Paddle', v => `Acme bills customers through ${v}.`),
  attr('Acme', 'support_tool', 'support tool', 'Zendesk', 'Pylon', v => `Acme answers support tickets in ${v}.`),
  attr('Acme', 'sprint_length', 'sprint length', 'three weeks', 'two weeks', v => `Acme sprints last ${v}.`),
  attr('Acme', 'staging_region', 'staging region', 'eu-west', 'us-east', v => `Acme's staging environment runs in ${v}.`),
  attr('Birch', 'test_runner', 'test runner', 'Jest', 'Vitest', v => `Birch runs its tests with ${v}.`),
  attr('Birch', 'ci_provider', 'CI provider', 'CircleCI', 'GitHub Actions', v => `Birch builds on ${v}.`),
  attr('Birch', 'logger', 'logging library', 'winston', 'pino', v => `Birch logs with ${v}.`),
  attr('Birch', 'package_manager', 'package manager', 'Yarn', 'pnpm', v => `Birch installs packages with ${v}.`),
];

interface Stable { subject: string; predicate: string; value: string; say: string; question: string }
const STABLE: Stable[] = [
  { subject: 'Ava', predicate: 'allergy', value: 'peanuts', say: 'Ava is allergic to peanuts.', question: 'What is Ava allergic to?' },
  { subject: 'Maya', predicate: 'birthday_month', value: 'November', say: 'Maya was born in November.', question: 'Which month is Maya\'s birthday?' },
  { subject: 'Noah', predicate: 'keyboard_layout', value: 'Colemak', say: 'Noah types on Colemak.', question: 'What keyboard layout does Noah use?' },
  { subject: 'Lena', predicate: 'second_language', value: 'Dutch', say: 'Lena speaks Dutch.', question: 'Which language does Lena speak?' },
  { subject: 'Theo', predicate: 'sport', value: 'fencing', say: 'Theo practices fencing.', question: 'What sport does Theo practice?' },
  { subject: 'Iris', predicate: 'hometown', value: 'Faro', say: 'Iris grew up in Faro.', question: 'Where did Iris grow up?' },
  { subject: 'Fjord', predicate: 'license', value: 'MPL-2.0', say: 'Fjord is licensed under MPL-2.0.', question: 'Which license does Fjord use?' },
  { subject: 'Fjord', predicate: 'repo_host', value: 'Codeberg', say: 'Fjord\'s repository lives on Codeberg.', question: 'Where is the Fjord repository hosted?' },
  { subject: 'Acme', predicate: 'founded_year', value: '2014', say: 'Acme was founded in 2014.', question: 'When was Acme founded?' },
  { subject: 'Acme', predicate: 'headquarters', value: 'Rotterdam', say: 'Acme is headquartered in Rotterdam.', question: 'Where is Acme headquartered?' },
  { subject: 'Birch', predicate: 'mascot', value: 'otter', say: 'Birch has an otter as its mascot.', question: 'What is the Birch mascot?' },
  { subject: 'Birch', predicate: 'default_branch', value: 'trunk', say: 'Birch keeps its default branch as trunk.', question: 'What is the default branch of Birch?' },
];

/** Lines an agent journals about the same things: they name the subject and the attribute and state no value. */
function journalLines(): string[] {
  const lines: string[] = [];
  for (const a of ATTRS) {
    lines.push(`Talked about ${a.subject}'s ${a.label} in the sync; nothing to change yet.`);
    lines.push(`Left the question of ${a.subject}'s ${a.label} open until next week's review.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Determinism: a simulated clock the engine reads (file times included) and seeded randomness.
// ---------------------------------------------------------------------------------------------------------------

const RealDate = Date;
const RealRandom = Math.random;

/**
 * `now` is the simulated time (ms since the epoch) while a run is measured, null otherwise. `real` counts the calls that
 * must see the real clock: an embedding request signs its credential with it, so a hosted model refuses a past date.
 * `memoryDir` is the workspace whose files get the simulated time as their modification time.
 */
const sim: { now: number | null; real: number; memoryDir: string | null } = { now: null, real: 0, memoryDir: null };

class SimDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0 && sim.now !== null && sim.real === 0) super(sim.now);
    else super(...(args as [number]));
  }
  static now(): number {
    return sim.now !== null && sim.real === 0 ? sim.now : RealDate.now();
  }
}
(globalThis as { Date: unknown }).Date = SimDate;

/** A small seeded generator (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * While a run is measured every `Math.random` is drawn from the run's seed. The event ids the ledger writes (the random
 * part of `MEM_...`, which sits in the text of a ledger chunk and so in what the stub embeds) have a stream of their own,
 * so an embedding retry's jitter cannot shift them.
 */
let streams: { ids: () => number; rest: () => number } | null = null;
Math.random = () => {
  if (streams === null) return RealRandom();
  return (new Error().stack ?? '').includes('newEventId') ? streams.ids() : streams.rest();
};

/**
 * A file the engine writes while the clock is simulated gets the simulated time as its modification time, as it would
 * have had at that time: the index records it (`notes.modified_at`) and retrieval's recency boost reads it.
 */
type FsWrite = (file: unknown, ...rest: unknown[]) => Promise<void>;
const fsWritable = fsp as unknown as { appendFile: FsWrite; writeFile: FsWrite };
for (const name of ['appendFile', 'writeFile'] as const) {
  const real = fsWritable[name].bind(fsp);
  fsWritable[name] = async (file, ...rest) => {
    await real(file, ...rest);
    if (sim.now !== null && sim.memoryDir !== null && typeof file === 'string' && file.startsWith(sim.memoryDir)) {
      const at = new RealDate(sim.now);
      await fsp.utimes(file, at, at);
    }
  };
}

/** An embedding provider whose requests see the real clock (see `sim.real`). */
class RealClockProvider implements EmbeddingProvider {
  readonly identity: EmbeddingProvider['identity'];
  constructor(private readonly inner: EmbeddingProvider) { this.identity = inner.identity; }
  get dimensions(): number { return this.inner.dimensions; }
  private async onRealClock<T>(work: () => Promise<T>): Promise<T> {
    sim.real++;
    try { return await work(); } finally { sim.real--; }
  }
  embed(texts: string[]): Promise<number[][]> { return this.onRealClock(() => this.inner.embed(texts)); }
  embedQuery(text: string): Promise<number[]> {
    const inner = this.inner;
    return this.onRealClock(() => (inner.embedQuery ? inner.embedQuery(text) : inner.embed([text]).then(rows => rows[0])));
  }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** `--show <n>`: print what the reader is handed for attribute n (0-23), for every arm run. Written past the quiet() wrapper. */
const rawStderr = process.stderr.write.bind(process.stderr);
let showAttribute: number | null = null;

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One seed's plan: the order of every save and the second it lands on. */
interface Plan {
  old: Array<{ i: number; at: number }>;
  stable: Array<{ i: number; at: number }>;
  journal: Array<{ line: string; at: number }>;
  fixes: Array<{ i: number; at: number }>;
  resaves: Array<{ i: number; at: number }>;
  readAt: number;
}

/**
 * `days`: the first values and the stable facts on the first morning, the journal over the next five days, the corrections
 * a week in, the same ten facts again on three later days, and every question on the fourteenth day. `one-day`: the same
 * saves in the same order within one day, half an hour apart between phases. Every save is 20-90 seconds after the one
 * before it on a seeded draw, so no two entries share a second and a correction is always later than what it corrects.
 */
function planFor(seed: number, timeline: Timeline): Plan {
  const rand = prng(seed * 7919 + 17);
  const base = RealDate.UTC(2026, 8, 1);
  const seconds = (n: number) => n * 1000;
  const run = (start: number, count: number): number[] => {
    const times: number[] = [];
    let t = start;
    for (let k = 0; k < count; k++) {
      times.push(t);
      t += seconds(20 + Math.floor(rand() * 71));
    }
    return times;
  };
  const morning = (day: number, hour: number, spanHours: number) => base + day * DAY + hour * HOUR + seconds(Math.floor(rand() * spanHours * 3600));

  const oldTimes = run(morning(0, 8, 3), ATTRS.length);
  const stableTimes = run(oldTimes[oldTimes.length - 1] + seconds(60), STABLE.length);
  const lastOf = (times: number[]) => times[times.length - 1];
  const half = seconds(1800);

  const lines = shuffled(journalLines(), rand);
  let journalTimes: number[];
  if (timeline === 'one-day') {
    journalTimes = run(lastOf(stableTimes) + seconds(60), lines.length);
  } else {
    const lo = base + 15 * HOUR;
    const hi = base + 5 * DAY + 18 * HOUR;
    journalTimes = lines.map(() => lo + Math.floor(rand() * ((hi - lo) / 1000)) * 1000).sort((a, b) => a - b);
    for (let k = 1; k < journalTimes.length; k++) if (journalTimes[k] <= journalTimes[k - 1]) journalTimes[k] = journalTimes[k - 1] + 1000;
  }

  const fixTimes = run(timeline === 'one-day' ? lastOf(journalTimes) + half : morning(7, 8, 3), ATTRS.length);
  const resaves: Plan['resaves'] = [];
  let after = lastOf(fixTimes);
  for (const day of [8, 9, 10]) {
    const times = run(timeline === 'one-day' ? after + half : morning(day, 10, 2), 10);
    after = lastOf(times);
    shuffled([...Array(10).keys()], rand).forEach((i, k) => resaves.push({ i, at: times[k] }));
  }

  return {
    old: shuffled([...ATTRS.keys()], rand).map((i, k) => ({ i, at: oldTimes[k] })),
    stable: shuffled([...STABLE.keys()], rand).map((i, k) => ({ i, at: stableTimes[k] })),
    journal: lines.map((line, k) => ({ line, at: journalTimes[k] })),
    fixes: shuffled([...ATTRS.keys()], rand).map((i, k) => ({ i, at: fixTimes[k] })),
    resaves,
    readAt: timeline === 'one-day' ? after + seconds(3600) : base + 13 * DAY + 12 * HOUR,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The service: the real MCP surface in memory, on a fresh workspace, with the eval-hash provider.
// ---------------------------------------------------------------------------------------------------------------

const SCOPE = 'project:ab';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface CallResult { threw: boolean; isError: boolean; text: string; body: any }

async function openWorkspace(provider: EmbeddingProvider = new EvalHashEmbeddingProvider()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-shape-ab-'));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true, mode: 0o700 });
  for (const key of ['MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_DB_PATH',
    'RENOR_CONTEXT_RELEVANCE', 'RENOR_READ_HONESTY', 'RENOR_SECRET_GUARD']) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(root, 'auth', 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  const app = createMvpApp(loadMvpConfig(), provider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'save-shape-ab', version: '0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>)[0].text;
      let body: any = null;
      if (!res.isError) { try { body = JSON.parse(text); } catch { body = null; } }
      return { threw: false, isError: res.isError === true, text, body };
    } catch (err) {
      // A schema rejection leaves the SDK as a protocol error; the agent sees its message.
      return { threw: true, isError: true, text: err instanceof Error ? err.message : String(err), body: null };
    }
  };
  return {
    call,
    client,
    memoryDir,
    async close() {
      await client.close();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
type Workspace = Awaited<ReturnType<typeof openWorkspace>>;

/** Everything a reader is handed, in the order it is handed over: the current facts, then the memories. */
function itemsOf(body: any): string[] {
  const facts = (body?.facts ?? []).map((f: any) => `${f.subject} ${f.predicate} ${f.object}`);
  const memories = (body?.memories ?? []).map((m: any) => String(m.text));
  return [...facts, ...memories];
}
const has = (text: string, value: string) => text.toLowerCase().includes(value.toLowerCase());

// ---------------------------------------------------------------------------------------------------------------
// One arm.
// ---------------------------------------------------------------------------------------------------------------

type Arm = 'S' | 'Pn' | 'Pc' | 'Sd25' | 'Sd50';
const structuredArm = (arm: Arm) => arm === 'S' || arm === 'Sd25' || arm === 'Sd50';

/** Which corrections of an S-drift arm are written under another spelling of the predicate: every fourth, every second. */
function drifts(arm: Arm, index: number): boolean {
  return arm === 'Sd25' ? index % 4 === 3 : arm === 'Sd50' ? index % 2 === 1 : false;
}

type Style = 'natural' | 'explicit';
type Timeline = 'days' | 'one-day';

function saveArgs(arm: Arm, style: Style, kind: 'old' | 'new' | 'stable', a: Attr | Stable, index: number): Record<string, unknown> {
  if (kind === 'stable') {
    const s = a as Stable;
    return structuredArm(arm)
      ? { statement: s.say, subject: s.subject, predicate: s.predicate, object: s.value, scope: SCOPE }
      : { statement: s.say, scope: SCOPE };
  }
  const at = a as Attr;
  const value = kind === 'old' ? at.old : at.neu;
  const said = style === 'explicit' ? `${at.subject}'s ${at.label} is ${value}.` : at.say(value);
  const statement = kind === 'new' && arm === 'Pc' ? `Update: ${said} It is no longer ${at.old}.` : said;
  if (!structuredArm(arm)) return { statement, scope: SCOPE };
  const predicate = kind === 'new' && drifts(arm, index) ? `current_${at.predicate}` : at.predicate;
  return { statement, subject: at.subject, predicate, object: value, scope: SCOPE };
}

interface ArmResult {
  arm: Arm;
  style: Style;
  embeddings: string;
  timeline: Timeline;
  seed: number;
  corrections: number;
  supersedeReceipts: number;
  now: { answered: number; staleItem: number; contested: number; staleFirst: number; top1New: number; conflictsShown: number; rankNew: number; tokensMean: number };
  isolationLeaks: number;
  before: { oldAnswerable: number };
  retrieve: { currentRight: number; historyHasOld: number };
  lookup: { found: number; of: number };
  stable: { answered: number; top1: number; of: number };
  dedupe: { facts: number; nochangeReceipts: number; copiesInReply: number; replyTokens: number };
  status: Record<string, number>;
  saveCallTokens: { old: number; new: number; stable: number };
}

/** One arm of one seed, on a fresh workspace and a fresh simulated clock. */
async function runArm(arm: Arm, style: Style, seed: number, embeddings: string, timeline: Timeline, provider: EmbeddingProvider): Promise<ArmResult> {
  const plan = planFor(seed, timeline);
  streams = { ids: prng(seed * 104729 + 3), rest: prng(seed * 1299709 + 5) };
  const ws = await openWorkspace(provider);
  sim.memoryDir = ws.memoryDir;
  try {
    const argTokens = { old: [] as number[], new: [] as number[], stable: [] as number[] };
    const send = async (at: number, kind: 'old' | 'new' | 'stable', a: Attr | Stable, index: number) => {
      sim.now = at;
      const args = saveArgs(arm, style, kind, a, index);
      argTokens[kind].push(replyTokens(JSON.stringify(args)));
      const res = await ws.call('remember', args);
      if (res.isError) throw new Error(`${arm} ${kind} save failed: ${res.text}`);
      return res.body;
    };

    for (const { i, at } of plan.old) await send(at, 'old', ATTRS[i], i);
    for (const { i, at } of plan.stable) await send(at, 'stable', STABLE[i], i);
    for (const { line, at } of plan.journal) {
      sim.now = at;
      const res = await ws.call('remember', { statement: line, scope: SCOPE });
      if (res.isError) throw new Error(`${arm} journal save failed: ${res.text}`);
    }
    let supersedeReceipts = 0;
    for (const { i, at } of plan.fixes) {
      const receipt = await send(at, 'new', ATTRS[i], i);
      if (receipt?.action === 'supersede') supersedeReceipts++;
    }
    // Later days: the agent records ten facts again, word for word.
    let nochangeReceipts = 0;
    for (const { i, at } of plan.resaves) {
      const receipt = await send(at, 'stable', STABLE[i], i);
      if (receipt?.action === 'nochange') nochangeReceipts++;
    }

    sim.now = plan.readAt;
    await ws.call('index_memory', {});
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = (await ws.call('memory_status')).body;
      if (status?.semantic === true && status.chunksWithoutVectors === 0) break;
      await sleep(100);
    }
    if (embeddings === 'vertex') {
      // A read can hold back its relevance verdict until every current fact has a vector, and the first read starts that
      // fill in the background: ask until a read carries the verdict, so the answers below do not depend on its timing.
      for (let attempt = 0; attempt < 120; attempt++) {
        const probe = await ws.call('get_context', { query: 'which facts are on file?', scope: SCOPE, max_tokens: 200 });
        if (probe.body?.relevance) break;
        await sleep(500);
      }
    }

    // The current-value questions, as an agent asks them: get_context with the request, nothing else.
    const now = { answered: 0, staleItem: 0, contested: 0, staleFirst: 0, top1New: 0, conflictsShown: 0 };
    const tokens: number[] = [];
    const ranks: number[] = []; // the position of the first item that holds the new value; past the end when none does
    for (const a of ATTRS) {
      const res = await ws.call('get_context', { query: `What is ${a.subject}'s ${a.label} now?`, scope: SCOPE });
      tokens.push(replyTokens(res.text));
      const items = itemsOf(res.body);
      const answered = items.some(t => has(t, a.neu));
      const staleItem = items.some(t => has(t, a.old) && !has(t, a.neu));
      const first = items.find(t => has(t, a.old) || has(t, a.neu));
      if (answered) now.answered++;
      if (staleItem) now.staleItem++;
      if (answered && staleItem) now.contested++;
      if (first !== undefined && has(first, a.old) && !has(first, a.neu)) now.staleFirst++;
      if (items.length > 0 && has(items[0], a.neu)) now.top1New++;
      const at = items.findIndex(t => has(t, a.neu));
      ranks.push(at >= 0 ? at + 1 : items.length + 1);
      if ((res.body?.conflicts ?? []).length > 0) now.conflictsShown++;
      if (showAttribute === ATTRS.indexOf(a)) {
        rawStderr(`\n[show] ${embeddings}/${timeline}/${style}/${arm} seed ${seed}: "${a.subject}'s ${a.label}", old "${a.old}", new "${a.neu}"\n`
          + items.map((t, k) => `  ${k + 1}. ${t.replace(/\s+/g, ' ').slice(0, 150)}`).join('\n') + '\n');
      }
    }

    // Scope is not part of the structure: a read in another scope must hand over none of these values, in any arm.
    let isolationLeaks = 0;
    for (const a of ATTRS.slice(0, 6)) {
      const res = await ws.call('get_context', { query: `What is ${a.subject}'s ${a.label} now?`, scope: 'project:other' });
      if (itemsOf(res.body).some(t => has(t, a.old) || has(t, a.neu))) isolationLeaks++;
    }

    let oldAnswerable = 0;
    for (const a of ATTRS) {
      const res = await ws.call('get_context', { query: `What was ${a.subject}'s ${a.label} before it changed?`, scope: SCOPE, include_history: true });
      if (itemsOf(res.body).some(t => has(t, a.old))) oldAnswerable++;
    }

    let currentRight = 0;
    let historyHasOld = 0;
    for (const a of ATTRS) {
      const current = await ws.call('retrieve_memory', { subject: a.subject, predicate: a.predicate, scope: SCOPE });
      const facts: any[] = current.body?.facts ?? [];
      if (facts.length === 1 && facts[0].current === true && has(String(facts[0].object), a.neu)) currentRight++;
      const history = await ws.call('retrieve_memory', { subject: a.subject, predicate: a.predicate, scope: SCOPE, include_history: true });
      if ((history.body?.facts ?? []).some((f: any) => has(String(f.object), a.old))) historyHasOld++;
    }

    const subjects = [...new Set(ATTRS.map(a => a.subject))];
    let found = 0;
    for (const name of subjects) {
      const res = await ws.call('lookup_entity', { name, scope: SCOPE });
      if (res.body?.entity) found++;
    }

    const stable = { answered: 0, top1: 0, of: STABLE.length };
    for (const s of STABLE) {
      const res = await ws.call('get_context', { query: s.question, scope: SCOPE });
      const items = itemsOf(res.body);
      if (items.some(t => has(t, s.value))) stable.answered++;
      if (items.length > 0 && has(items[0], s.value)) stable.top1++;
    }

    // What an agent that records the same decision every session leaves behind.
    const probe = STABLE[0];
    const dedupeRead = await ws.call('get_context', { query: probe.question, scope: SCOPE });
    const copiesInReply = itemsOf(dedupeRead.body).filter(t => has(t, probe.value)).length;
    const status = (await ws.call('memory_status')).body ?? {};
    const mean = (xs: number[]) => Math.round((xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1)) * 10) / 10;

    return {
      arm,
      style,
      embeddings,
      timeline,
      seed,
      corrections: ATTRS.length,
      isolationLeaks,
      supersedeReceipts,
      now: { ...now, rankNew: mean(ranks), tokensMean: mean(tokens) },
      before: { oldAnswerable },
      retrieve: { currentRight, historyHasOld },
      lookup: { found, of: subjects.length },
      stable,
      dedupe: { facts: Number(status.facts ?? 0), nochangeReceipts, copiesInReply, replyTokens: replyTokens(dedupeRead.text) },
      status,
      saveCallTokens: { old: mean(argTokens.old), new: mean(argTokens.new), stable: mean(argTokens.stable) },
    };
  } finally {
    sim.now = null;
    sim.memoryDir = null;
    streams = null;
    await ws.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The calls an agent may plausibly make, and exactly what comes back.
// ---------------------------------------------------------------------------------------------------------------

interface CatalogEntry { id: string; what: string; tool: string; args: Record<string, unknown> }
const LONG_NOTE = `Status of the board: ${'item resolved, owner confirmed, evidence linked. '.repeat(60)}`;
const CATALOG: CatalogEntry[] = [
  { id: 'C01', what: 'plain save, one argument', tool: 'remember', args: { statement: 'Decided: Fjord moves to SQLite.' } },
  { id: 'C02', what: 'plain save, scope given', tool: 'remember', args: { statement: 'Decided: Fjord moves to SQLite.', scope: 'project:atlas' } },
  { id: 'C03', what: 'plain save, unused optionals sent as null (strict function-calling clients)', tool: 'remember', args: { statement: 'Decided: Fjord moves to SQLite.', subject: null, predicate: null, object: null } },
  { id: 'C04', what: 'plain save, scope and source sent as null', tool: 'remember', args: { statement: 'Decided: Fjord moves to SQLite.', scope: null, source: null } },
  { id: 'C05', what: 'plain save, unused structure sent as empty strings', tool: 'remember', args: { statement: 'Decided: Fjord moves to SQLite.', subject: '', predicate: '', object: '' } },
  { id: 'C06', what: 'only one of the three structured fields', tool: 'remember', args: { statement: 'Decided: Fjord moves to SQLite.', subject: 'Fjord' } },
  { id: 'C07', what: 'structured save, complete', tool: 'remember', args: { statement: 'Fjord stores its data in SQLite.', subject: 'Fjord', predicate: 'database', object: 'SQLite' } },
  { id: 'C08', what: 'structured save, a multi-line value in object', tool: 'remember', args: { statement: 'Fjord notes.', subject: 'Fjord', predicate: 'notes', object: 'line one\nline two' } },
  { id: 'C09', what: 'a file path as source (the board file the agent just updated)', tool: 'remember', args: { statement: 'P8 resolved.', source: '/home/example/notes/BOARD.md#P8' } },
  { id: 'C10', what: 'source left out (what the server writes itself)', tool: 'remember', args: { statement: 'P9 resolved.' } },
  { id: 'C11', what: 'the plain text sent as `text`, the argument name of remember_note', tool: 'remember', args: { text: 'Decided: Fjord moves to SQLite.' } },
  { id: 'C12', what: 'save_memory with plain text only', tool: 'save_memory', args: { text: 'Decided: Fjord moves to SQLite.' } },
  { id: 'C13', what: 'save_memory with `statement` only', tool: 'save_memory', args: { statement: 'Decided: Fjord moves to SQLite.' } },
  { id: 'C14', what: 'save_memory, complete', tool: 'save_memory', args: { subject: 'Fjord', predicate: 'database', object: 'SQLite' } },
  { id: 'C15', what: 'save_memory, scope sent as null', tool: 'save_memory', args: { subject: 'Fjord', predicate: 'database', object: 'SQLite', scope: null } },
  { id: 'C16', what: 'remember_note with `statement`, the argument name of remember', tool: 'remember_note', args: { statement: 'Decided: Fjord moves to SQLite.' } },
  { id: 'C17', what: 'remember_note, a 2,400-character journal entry', tool: 'remember_note', args: { text: LONG_NOTE.slice(0, 2400) } },
  { id: 'C18', what: 'the same 2,400 characters through remember', tool: 'remember', args: { statement: LONG_NOTE.slice(0, 2400) } },
  { id: 'C19', what: 'remember_note with a timestamp as date', tool: 'remember_note', args: { text: 'P10 resolved.', date: '2026-10-06T07:02:00Z' } },
  { id: 'C20', what: 'a time-zone abbreviation', tool: 'remember', args: { statement: 'P11 resolved.', timezone: 'BRT' } },
];

interface CatalogRow { id: string; what: string; tool: string; outcome: 'saved' | 'refused'; refusal?: 'raw validation' | 'tool message'; text: string; stored?: string }

async function runCatalog(): Promise<CatalogRow[]> {
  const ws = await openWorkspace();
  try {
    const rows: CatalogRow[] = [];
    for (const entry of CATALOG) {
      const res = await ws.call(entry.tool, entry.args);
      const saved = !res.isError && res.body?.ok !== false;
      const row: CatalogRow = {
        id: entry.id, what: entry.what, tool: entry.tool,
        outcome: saved ? 'saved' : 'refused',
        text: saved ? '' : res.text.replace(/\s+/g, ' ').slice(0, 300),
      };
      if (!saved) row.refusal = /Input validation error|Invalid arguments/.test(res.text) ? 'raw validation' : 'tool message';
      if (saved && res.body?.file) {
        // How the entry reads in the file: the header's source name.
        const file = fs.readFileSync(path.join(ws.memoryDir, String(res.body.file)), 'utf8').trimEnd().split('\n');
        row.stored = (file.reverse().find(line => /^- \[\d\d:\d\d:\d\d\] \(/.test(line)) ?? '').slice(0, 60);
      } else if (saved && res.body?.mode === 'fact') {
        row.stored = `fact ${res.body.subject} / ${res.body.predicate}`;
      } else if (saved && res.body?.subject) {
        row.stored = `fact ${res.body.subject} / ${res.body.predicate}`;
      }
      rows.push(row);
    }
    return rows;
  } finally {
    await ws.close();
  }
}

/** The save tools as an agent is shown them: description size and how many arguments it must decide on. */
async function saveToolSurface() {
  const ws = await openWorkspace();
  try {
    const { tools } = await ws.client.listTools();
    const surface = (name: string) => {
      const tool = tools.find(t => t.name === name)!;
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const required = schema.required ?? [];
      const all = Object.keys(schema.properties ?? {});
      return {
        tool: name,
        required: required.length,
        optional: all.length - required.length,
        descriptionChars: (tool.description ?? '').length,
        descriptionTokens: replyTokens(tool.description ?? ''),
        schemaTokens: replyTokens(JSON.stringify(tool.inputSchema)),
      };
    };
    return {
      tools: tools.length,
      listTokens: replyTokens(JSON.stringify(tools)),
      instructionsTokens: replyTokens(ws.client.getInstructions() ?? ''),
      saves: ['remember', 'remember_note', 'save_memory'].map(surface),
    };
  } finally {
    await ws.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation: every figure is a mean over the seeds, with its range.
// ---------------------------------------------------------------------------------------------------------------

/** What an arm reports, as numbers one seed to the next can be compared on. */
function metricsOf(r: ArmResult): Record<string, number> {
  return {
    answered: r.now.answered, stale: r.now.staleItem, staleFirst: r.now.staleFirst, first: r.now.top1New, rank: r.now.rankNew,
    conflicts: r.now.conflictsShown, replyTokens: r.now.tokensMean,
    superseded: r.supersedeReceipts, history: r.before.oldAnswerable,
    retrieveNow: r.retrieve.currentRight, retrieveHistory: r.retrieve.historyHasOld,
    lookup: r.lookup.found, leaks: r.isolationLeaks,
    stableAnswered: r.stable.answered, stableFirst: r.stable.top1,
    nochange: r.dedupe.nochangeReceipts, copies: r.dedupe.copiesInReply, dedupeReplyTokens: r.dedupe.replyTokens,
    chunks: Number(r.status.chunks ?? 0), facts: Number(r.status.facts ?? 0),
    callTokensFirst: r.saveCallTokens.old, callTokensCorrection: r.saveCallTokens.new, callTokensStable: r.saveCallTokens.stable,
  };
}

interface Spread { mean: number; min: number; max: number; values: number[] }
const spreadOf = (values: number[]): Spread => ({
  mean: values.reduce((s, x) => s + x, 0) / values.length, min: Math.min(...values), max: Math.max(...values), values,
});
const round1 = (x: number) => String(Math.round(x * 10) / 10);
/** One number when every seed agrees, else `mean [min-max]`. */
const show = (s: Spread) => (s.min === s.max ? round1(s.mean) : `${round1(s.mean)} [${round1(s.min)}-${round1(s.max)}]`);

const runKey = (r: ArmResult) => `${r.embeddings}/${r.timeline}/${r.style}/${r.arm}`;

function summarize(results: ArmResult[]): Map<string, Record<string, Spread>> {
  const groups = new Map<string, ArmResult[]>();
  for (const r of results) groups.set(runKey(r), [...(groups.get(runKey(r)) ?? []), r]);
  const summary = new Map<string, Record<string, Spread>>();
  for (const [key, rows] of groups) {
    const metrics = rows.map(metricsOf);
    summary.set(key, Object.fromEntries(Object.keys(metrics[0]).map(name => [name, spreadOf(metrics.map(m => m[name]))])));
  }
  return summary;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
  return rows.map(r => r.map((cell, c) => cell.padEnd(widths[c])).join('  ')).join('\n');
}

/**
 * The embedding model a run reads with. `hash` is the lexical eval stub. `vertex` is the real model behind the
 * persistent embedding cache every benchmark here uses (a text is sent once, ever); its requests run on the real clock.
 */
async function makeProvider(kind: string): Promise<{ provider: EmbeddingProvider; report: () => string; close: () => void }> {
  if (kind === 'hash') return { provider: new EvalHashEmbeddingProvider(), report: () => 'eval-hash stub (lexical, no network)', close: () => {} };
  if (kind !== 'vertex') throw new Error(`--embeddings must be hash or vertex, got ${kind}`);
  const cachePath = process.env.SAVE_SHAPE_AB_CACHE ?? path.join(process.cwd(), '.gate', 'save-shape-ab-embed-cache.db');
  const inner = new VertexEmbeddingProvider();
  const cached = new CachingEmbeddingProvider(inner, { cachePath });
  return {
    provider: new RealClockProvider(cached),
    report: () => `vertex ${inner.model}, ${inner.dimensions} dims: ${cached.sent.texts} texts sent in ${cached.sent.calls} calls; cache ${cached.stats.hits} hits / ${cached.stats.misses} misses`,
    close: () => (cached as unknown as { close?: () => void }).close?.(),
  };
}

const flag = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};

/** The tree the numbers describe, so a figure can be traced to the code that produced it. */
function treeInfo(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
    return `${sha}${dirty ? '+dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

async function main() {
  const out = flag('out', '');
  const embeddings = flag('embeddings', 'hash');
  const styles = flag('styles', 'natural,explicit').split(',') as Style[];
  const arms = flag('arms', 'S,Pn,Pc').split(',') as Arm[];
  const timelines = flag('timelines', 'days').split(',') as Timeline[];
  const seeds = flag('seeds', '1,2,3,4,5').split(',').map(Number);
  if (timelines.some(t => t !== 'days' && t !== 'one-day')) throw new Error('--timelines must be days, one-day or both');
  if (seeds.some(seed => !Number.isInteger(seed))) throw new Error('--seeds must be a comma-separated list of integers');
  const withCatalog = process.argv.includes('--catalog');
  if (process.argv.includes('--show')) showAttribute = Number(flag('show', '0'));
  const log = console.log;
  /** The service logs its migrations and one line per tool call; none of it belongs in the report. */
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const o = process.stdout as { write: unknown };
    const e = process.stderr as { write: unknown };
    const [write, errWrite] = [o.write, e.write];
    console.log = () => {};
    o.write = () => true;
    e.write = () => true;
    try { return await fn(); } finally { console.log = log; o.write = write; e.write = errWrite; }
  };

  const model = await makeProvider(embeddings);

  let determinism: { configuration: string; identical: boolean; differing: string[] } | null = null;
  if (process.argv.includes('--check-determinism')) {
    const [style, arm, seed, timeline] = [styles[0], arms[0], seeds[0], timelines[0]];
    const first = await quiet(() => runArm(arm, style, seed, embeddings, timeline, model.provider));
    const second = await quiet(() => runArm(arm, style, seed, embeddings, timeline, model.provider));
    const [a, b] = [metricsOf(first), metricsOf(second)];
    determinism = {
      configuration: `${embeddings}/${timeline}/${style}/${arm} seed ${seed}`,
      identical: JSON.stringify(first) === JSON.stringify(second),
      differing: Object.keys(a).filter(name => a[name] !== b[name]),
    };
    console.error(`determinism ${determinism.configuration}: ${determinism.identical ? 'identical' : `DIFFERENT in ${determinism.differing.join(', ')}`}`);
  }

  const results: ArmResult[] = [];
  const total = seeds.length * timelines.length * (styles.length * arms.filter(a => a !== 'Sd25' && a !== 'Sd50').length + arms.filter(a => a === 'Sd25' || a === 'Sd50').length);
  for (const seed of seeds) {
    for (const timeline of timelines) {
      for (const style of styles) {
        for (const arm of arms) {
          // The drift arms differ from S only in a spelling, so one style is enough for them.
          if ((arm === 'Sd25' || arm === 'Sd50') && style !== styles[0]) continue;
          results.push(await quiet(() => runArm(arm, style, seed, embeddings, timeline, model.provider)));
          console.error(`done ${results.length}/${total}: ${embeddings}/${timeline}/${style}/${arm} seed ${seed}`);
        }
      }
    }
  }
  const catalog = withCatalog ? await quiet(runCatalog) : [];
  const surface = withCatalog ? await quiet(saveToolSurface) : null;
  const world = { changing: ATTRS.length, stable: STABLE.length, journal: journalLines().length, resavedFacts: 10, resaves: 3 };
  const embeddingReport = model.report();
  model.close();

  const summary = summarize(results);
  const keys = [...summary.keys()];
  const meta = { tree: treeInfo(), node: process.version, seeds, embeddings, timelines, styles, arms, embeddingReport };
  if (out) {
    fs.writeFileSync(out, JSON.stringify({
      meta, world, determinism, results, catalog, surface,
      summary: Object.fromEntries(keys.map(key => [key, summary.get(key)])),
    }, null, 2));
  }

  const n = seeds.length;
  const cells = (key: string, names: string[]) => names.map(name => show(summary.get(key)![name]));
  log(`\nTree ${meta.tree}, Node ${meta.node}, embeddings: ${embeddingReport}`);
  log(`Every figure is the mean over ${n} seed${n === 1 ? '' : 's'} (${seeds.join(', ')}) with its range, "mean [min-max]"; a single number is the same in every seed.`);
  if (determinism) log(`Determinism (${determinism.configuration}, run twice): ${determinism.identical ? 'the two results are identical' : `DIFFERENT in ${determinism.differing.join(', ')}`}.`);
  log('\n## Current value ("What is X now?" through get_context, default settings), out of 24\n');
  log(table([
    ['run', 'new value in reply', 'a line asserting only the old value', 'old value first', 'new value first', 'new value: mean position', 'conflicts shown', 'tokens/reply'],
    ...keys.map(key => [key, ...cells(key, ['answered', 'stale', 'staleFirst', 'first', 'rank', 'conflicts', 'replyTokens'])]),
  ]));
  log('\n## What only structure can do\n');
  log(table([
    ['run', 'receipts that superseded /24', 'history asked of get_context: old value in reply /24', 'retrieve_memory right /24', 'retrieve_memory history has old /24', 'lookup_entity found /9', 'other-scope leaks'],
    ...keys.map(key => [key, ...cells(key, ['superseded', 'history', 'retrieveNow', 'retrieveHistory', 'lookup', 'leaks'])]),
  ]));
  log('\n## Facts that never change, and the same fact saved four times\n');
  log(table([
    ['run', 'stable answered /12', 'stable first /12', 'receipts "nochange" /30', 'copies of the fact in one reply', 'tokens of that reply', 'workspace chunks', 'workspace facts'],
    ...keys.map(key => [key, ...cells(key, ['stableAnswered', 'stableFirst', 'nochange', 'copies', 'dedupeReplyTokens', 'chunks', 'facts'])]),
  ]));
  log('\n## Tokens the agent writes per save call (arguments as JSON, o200k)\n');
  log(table([['run', 'first value', 'correction', 'stable fact'], ...keys.map(key => [key, ...cells(key, ['callTokensFirst', 'callTokensCorrection', 'callTokensStable'])])]));
  log('\n## Per seed (seeds in order): a line asserting only the old value /24, and new value first /24\n');
  for (const key of keys) log(`${key.padEnd(30)} stale ${summary.get(key)!.stale.values.join(' ')}   first ${summary.get(key)!.first.values.join(' ')}   answered ${summary.get(key)!.answered.values.join(' ')}`);
  if (surface) {
    log('\n## The save tools as an agent is shown them\n');
    log(table([['tool', 'required', 'optional', 'description tokens', 'schema tokens'], ...surface.saves.map(t => [t.tool, String(t.required), String(t.optional), String(t.descriptionTokens), String(t.schemaTokens)])]));
    log(`(${surface.tools} tools, ${surface.listTokens} tokens in the whole tools/list, ${surface.instructionsTokens} in the server instructions)`);
  }
  if (catalog.length > 0) {
    log('\n## Call catalog: what comes back\n');
    for (const row of catalog) {
      log(`${row.id} ${row.tool.padEnd(13)} ${row.outcome.toUpperCase().padEnd(7)} ${row.what}`);
      if (row.outcome === 'refused') log(`      ${row.refusal}: ${row.text}`);
      else if (row.stored) log(`      stored as: ${row.stored}`);
    }
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });

