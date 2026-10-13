import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { buildAgentContext, replyTokens } from '../../src/mvp/agentMemory';
import { fitConflicts, type FactConflict } from '../../src/context/readHonesty';
import { warmFactVectors } from '../../src/mvp/contextRelevance';
import type { Engine } from '../../src/mvp/engine';
import { seedWorkspace } from '../../scripts/eval/relevance-calibration';

/**
 * The opt-in read-honesty lane (RENOR_READ_HONESTY, default OFF) inside the contract the get_context description states
 * unconditionally: "the whole reply is bounded by max_tokens (counted with the o200k tokenizer: the echoed query,
 * conflicts and every other field count too)".
 *
 * The lane answered every reachable budget by spending past it: its items were counted in characters and its
 * contradictions in a budget of their own on top, so 59 of the 485 reachable max_tokens budgets came back over — by up
 * to 3.19x (1356 tokens against a 300 budget with a contradiction of long values). Measured over the reachable range
 * the schema allows, `z.number().int().min(128).max(4000)`.
 *
 * And what a budget too small for everything cuts is the least of what the lane says (the independent review of
 * the read-honesty lane): the extra sides of a contradiction across scopes before the fact it
 * is about, a contradiction no listed fact brings before the answer, and what only describes a reply before its verdict.
 *
 * Deterministic: the eval-hash embeddings, a synthetic workspace, no model and no network.
 */

type Workspace = Parameters<typeof seedWorkspace>[2];
type Context = {
  facts: Array<{ subject: string; predicate: string; object: string; provenance?: unknown }>;
  memories: Array<{ text: string; provenance?: unknown }>;
  conflicts?: FactConflict[];
  provenance?: { ledger: string };
  abstention?: { status: string; reason: string; statement: string; terms?: string[] } | null;
  truncated: boolean;
  maxTokens: number;
};

const ARMED = { RENOR_READ_HONESTY: '1' };
const QUERY = 'What is the Atlas status?';

const long = (what: string, n: number): string => Array.from({ length: n }, (_, i) =>
  `${what} detail ${i + 1}: the rollout checklist item was verified against the staging database and signed off by the on-call engineer.`).join(' ');

/** Two current values of `status` under related names and a third in another scope: the contradictions the lane names. */
const SEED: Workspace = {
  facts: [
    { subject: 'Atlas', predicate: 'status', object: `paused: ${long('Atlas pause', 6)}` },
    { subject: 'Atlas project', predicate: 'status', object: `active: ${long('Atlas active', 6)}` },
    { subject: 'Atlas', predicate: 'status', object: `blocked: ${long('Atlas blocked', 4)}`, scope: 'project:atlas' },
  ],
  notes: Array.from({ length: 6 }, (_, i) => ({
    slug: `atlas-${i}`,
    date: `2026-09-2${i + 1}`,
    text: `Atlas status note ${i + 1}: ${long(`Atlas note ${i + 1}`, 3)}`,
  })),
};

const cleanups: Array<() => Promise<void> | void> = [];

// A memory's score counts recency against the clock, and the clock is held, so a reply measured at one budget is the
// same reply, to the token, at any other budget that holds it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.useRealTimers();
});

/**
 * An in-process workspace behind the real builder, so a sweep over every reachable budget is one process, not 485
 * servers. `files` are written into the memory directory as they are, before it is indexed.
 */
async function honestyWorkspace(seed = SEED, files: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honesty-budget-'));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, seed);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(memoryDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, rel), text, 'utf8');
  }
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  await warmFactVectors(db, provider);
  const ask = (query: string, env: Record<string, string>, maxTokens?: number, scope?: string) =>
    buildAgentContext(db, engine, memoryDir, {
      query,
      env: env as NodeJS.ProcessEnv,
      // The seeded facts were saved as 'calibration' (scripts/eval/relevance-calibration.ts), so this reader wrote them and
      // their reply carries no source, as before: these budget assertions measure the packing they were written for.
      reader: 'calibration',
      ...(maxTokens ? { maxTokens } : {}),
      ...(scope ? { scope } : {}),
    }) as Promise<Context>;
  return { ask };
}

/** Every budget the get_context schema accepts: an integer in 128..4000, swept in steps of 8 (485 of them). */
const REACHABLE: number[] = [];
for (let maxTokens = 128; maxTokens <= 4000; maxTokens += 8) REACHABLE.push(maxTokens);

/** A contradiction's sides, newest first, each with its scope. */
const sides = (c: FactConflict) => [c.newer, c.older, ...(c.alsoCurrent ?? [])].map(s => `${s.value} [${s.scope}]`);

/** The least max_tokens, to the token, whose reply `holding(maxTokens)` would be inside it. */
async function leastHolding(holding: (maxTokens: number) => Promise<Context>): Promise<number> {
  const fits = async (maxTokens: number) => replyTokens(JSON.stringify(await holding(maxTokens))) <= maxTokens;
  let least = 128;
  while (!(await fits(least))) least += 8;
  while (least > 128 && (await fits(least - 1))) least--;
  return least;
}

describe('the armed read-honesty lane stays inside max_tokens', () => {
  it('bounds the whole reply at every reachable budget, contradictions and provenance counted', async () => {
    const { ask } = await honestyWorkspace();
    const over: string[] = [];
    let worst = 0;
    for (const maxTokens of REACHABLE) {
      const body = await ask(QUERY, ARMED, maxTokens);
      const said = replyTokens(JSON.stringify(body));
      if (said > maxTokens) {
        over.push(`max_tokens ${maxTokens}: ${said} tokens (${(said / maxTokens).toFixed(2)}x)`);
        worst = Math.max(worst, said / maxTokens);
      }
    }
    expect(
      over,
      `${over.length} of ${REACHABLE.length} reachable budgets came back over max_tokens, by up to ${worst.toFixed(2)}x`,
    ).toEqual([]);
  }, 120_000);

  it('bounds a read with nothing on file at every reachable budget, and keeps its verdict while the budget holds it', async () => {
    // Nothing on file leaves no item to cut: the reply is its fixed part alone, which the lane makes larger by the
    // provenance legend and an abstention that lists the terms it looked for. It came back at 175 tokens against 128 for
    // an eight-word question (the lane off: 77), and at 139 for a five-word one read in a scope with nothing in it.
    const empty = await honestyWorkspace({ facts: [], notes: [] });
    const store = await honestyWorkspace({ facts: [{ subject: 'Atlas', predicate: 'status', object: 'paused' }], notes: [] });
    const question = 'please remind me which grafana dashboards kubernetes clusters?';
    const reads: Array<[string, (maxTokens: number) => Promise<Context>]> = [
      ['an eight-word question with nothing on file', maxTokens => empty.ask(question, ARMED, maxTokens)],
      ['a five-word question in a scope with nothing in it', maxTokens => store.ask(QUERY, ARMED, maxTokens, 'project:nothing-here')],
    ];
    const wrong: string[] = [];
    for (const [what, ask] of reads) {
      for (const maxTokens of REACHABLE) {
        const body = await ask(maxTokens);
        const said = replyTokens(JSON.stringify(body));
        if (said > maxTokens) wrong.push(`${what}, max_tokens ${maxTokens}: ${said} tokens`);
        if (body.abstention?.status !== 'no-answer') wrong.push(`${what}, max_tokens ${maxTokens}: no verdict`);
      }
    }
    expect(wrong).toEqual([]);
    // What goes first is what only describes: the provenance legend (it explains the items, and there are none), then the
    // terms the abstention looked for. A budget that holds them keeps them.
    const tight = await empty.ask(question, ARMED, 128);
    expect(tight.provenance).toBeUndefined();
    expect(tight.abstention).toMatchObject({ status: 'no-answer', reason: 'no-evidence', statement: 'no good answer on file for this' });
    expect(tight.abstention?.terms).toBeUndefined();
    const roomy = await empty.ask(question, ARMED, 4000);
    expect(roomy.provenance?.ledger).toBeTruthy();
    expect(roomy.abstention?.terms).toEqual(['please', 'remind', 'grafana', 'dashboards', 'kubernetes', 'clusters']);
  }, 120_000);

  it('is over max_tokens only where the lane off is: a question too long for its verdict says the reply was cut', async () => {
    // At the least budget a long question leaves no room for the verdict as well: it is the last thing the lane cuts,
    // as it does not name a contradiction a budget cannot hold, and the reply says it was cut.
    const { ask } = await honestyWorkspace({ facts: [], notes: [] });
    const question = 'please remind me which grafana dashboards we built for the kubernetes clusters in the staging region last quarter '
      + 'and who reviewed the alert thresholds for the database replicas before the migration window opened on friday evening?';
    const off = await ask(question, {}, 128);
    expect(replyTokens(JSON.stringify(off))).toBeLessThanOrEqual(128);
    let verdicts = 0;
    for (const maxTokens of REACHABLE.filter(m => m <= 400)) {
      const body = await ask(question, ARMED, maxTokens);
      expect(replyTokens(JSON.stringify(body)), `max_tokens ${maxTokens}`).toBeLessThanOrEqual(maxTokens);
      if (body.abstention) verdicts++;
      else expect(body.truncated, `max_tokens ${maxTokens}`).toBe(true);
    }
    expect((await ask(question, ARMED, 128)).abstention).toBeUndefined();
    expect(verdicts).toBeGreaterThan(0);
  });

  it('is the whole reply, cut nowhere, at every budget that holds it', async () => {
    // Counted to the token, a budget cut each list in turn: at 2864..3096, where the whole reply (2857 tokens) fit, it
    // kept the ledger events of two facts and so had no room left for the facts themselves.
    const { ask } = await honestyWorkspace();
    const whole = await ask(QUERY, ARMED, 4000);
    expect(whole.truncated).toBe(false);
    const wholeTokens = replyTokens(JSON.stringify(whole));
    const cut: number[] = [];
    for (const maxTokens of REACHABLE.filter(m => m >= wholeTokens)) {
      if (JSON.stringify({ ...(await ask(QUERY, ARMED, maxTokens)), maxTokens: 0 }) !== JSON.stringify({ ...whole, maxTokens: 0 })) cut.push(maxTokens);
    }
    expect(cut, `the whole reply is ${wholeTokens} tokens`).toEqual([]);
  }, 120_000);

  it('still judges what it judged: provenance on every item, the contradiction named, abstention when nothing covers it', async () => {
    const { ask } = await honestyWorkspace();
    const roomy = await ask(QUERY, ARMED, 4000);
    expect(roomy.provenance?.ledger).toBeTruthy();
    expect(roomy.facts.length).toBeGreaterThan(0);
    expect(roomy.memories.length).toBeGreaterThan(0);
    for (const item of [...roomy.facts, ...roomy.memories]) expect(item.provenance).toBeDefined();
    expect(roomy.conflicts?.length).toBeGreaterThan(0);
    expect(roomy.conflicts?.[0].statement).toMatch(/newer/i);
    expect(roomy.abstention).toBeNull(); // the question is covered, and a contradiction stands abstention down

    const offTopic = await ask('what is my favourite colour and pet name', ARMED, 4000);
    expect(offTopic.abstention).toMatchObject({ status: 'no-answer', statement: 'no good answer on file for this' });

    // Off, the shipped contract is untouched: no field of this lane is in the reply (its `conflicts` are the default
    // lane's own, a different and older shape, which is why they are not asserted here).
    const off = await ask(QUERY, {}, 4000);
    expect(off.provenance).toBeUndefined();
    expect(off.abstention).toBeUndefined();
    for (const item of [...off.facts, ...off.memories]) expect(item.provenance).toBeUndefined();
  });

  it('never tells an agent "no good answer on file" for a read its own budget emptied', async () => {
    // The abstention is a claim about the store, so at a budget too small for this fixture's facts and notes the reply
    // says the findings were cut — it does not claim the store is empty of an answer.
    const { ask } = await honestyWorkspace();
    const tight = await ask(QUERY, ARMED, 128);
    expect(tight.facts).toEqual([]);
    expect(tight.memories).toEqual([]);
    expect(tight.abstention).toBeNull();
    expect(tight.truncated).toBe(true);
    // And when nothing at all on file covers the question, it still says so.
    const bare = await honestyWorkspace({ facts: [{ subject: 'user', predicate: 'home_city', object: 'Lisbon' }], notes: [] });
    const nothing = await bare.ask(QUERY, ARMED, 4000);
    expect(nothing.abstention).toMatchObject({ status: 'no-answer', statement: 'no good answer on file for this' });
  });
});

describe('what a budget too small for everything cuts is the least of what the lane says', () => {
  it('cuts a contradiction across many scopes to the two values that disagree before it drops the fact it is about', async () => {
    // Two hundred scopes, one value each. Whole, the contradiction names the eight newest values (#331's cap), about 830
    // tokens; at its least, the two values that disagree and how many there are, about 255. The fact it is about was
    // charged the whole of it, so from max_tokens 440 to 1040 the reply listed six ledger events with six different
    // values and named no contradiction, where the reply holds the fact and the two values from 440 (the lane off names
    // it from 480).
    const shards = (team: number) => `${team} shards on the team-${team} build hosts`;
    const { ask } = await honestyWorkspace({
      facts: Array.from({ length: 200 }, (_, i) => ({ subject: 'build cache', predicate: 'shard_count', object: shards(i + 1), scope: `scope:team-${i + 1}` })),
      notes: [],
    });
    const query = 'how many shards does the build cache use?';
    const newest = (n: number) => Array.from({ length: n }, (_, i) => `${shards(200 - i)} [scope:team-${200 - i}]`);
    const roomy = await ask(query, ARMED, 4000);
    expect(roomy.conflicts).toHaveLength(1);
    expect(sides(roomy.conflicts![0])).toEqual(newest(8));
    expect(roomy.conflicts![0].total).toBe(200);
    const least = fitConflicts(roomy.conflicts!, 0);
    expect(sides(least[0])).toEqual(newest(2));
    const wrong: string[] = [];
    let named = 0;
    for (const maxTokens of REACHABLE) {
      const body = await ask(query, ARMED, maxTokens);
      const said = replyTokens(JSON.stringify(body));
      if (said > maxTokens) wrong.push(`${maxTokens}: ${said} tokens`);
      const [conflict] = body.conflicts ?? [];
      // A fact it is about is never listed without it, and it is never named without one.
      if (body.facts.some(f => f.subject === 'build cache') !== (conflict !== undefined)) {
        wrong.push(`${maxTokens}: ${body.facts.length} facts, ${(body.conflicts ?? []).length} contradictions`);
      }
      // Wherever the reply holds the best fact and the two values that disagree, it names them.
      const holds = replyTokens(JSON.stringify({ ...body, facts: [roomy.facts[0]], memories: [], truncated: true, conflicts: least })) <= maxTokens;
      if (holds && conflict === undefined) wrong.push(`${maxTokens}: holds the fact and the two values that disagree, names neither`);
      // Named, it is the newest values first, as many as the reply holds, and it counts them all.
      if (conflict !== undefined) {
        named++;
        const n = sides(conflict).length;
        if (sides(conflict).join() !== newest(n).join() || conflict.total !== 200) wrong.push(`${maxTokens}: ${sides(conflict).join(', ')}, total ${conflict.total}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(named).toBeGreaterThan(400);
    // To the token: at the least max_tokens that holds the best fact and the two values that disagree, they are listed.
    const first = await leastHolding(async maxTokens =>
      ({ ...(await ask(query, ARMED, maxTokens)), facts: [roomy.facts[0]], memories: [], truncated: true, conflicts: least }));
    const atFirst = await ask(query, ARMED, first);
    expect(atFirst.facts.map(f => f.subject), `max_tokens ${first}`).toEqual(['build cache']);
    expect(atFirst.conflicts?.map(sides), `max_tokens ${first}`).toEqual([newest(2)]);
  }, 120_000);

  it('lets a contradiction about a subject the query names take only the room the answer leaves, and counts it once', async () => {
    // Atlas's owner is saved through the ledger and a note's front matter says another: a contradiction inside one scope,
    // about a subject the query names. It was fixed cost, in the reply before any item, and charged again to the owner
    // fact. "What is the Atlas rollout status?" then came back with no fact from 176 to 336 and with only that contradiction
    // from 344 to 416, though the status fact fit; "Who owns Atlas?" was cut at 1192..1264 though its whole reply fit.
    const { ask } = await honestyWorkspace({
      facts: [
        { subject: 'Atlas', predicate: 'owner', object: 'the renor platform team, reporting to the infrastructure group lead since the reorganisation' },
        { subject: 'Atlas', predicate: 'status', object: 'rollout paused while the staging database is migrated' },
      ],
      notes: Array.from({ length: 3 }, (_, i) => ({
        slug: `atlas-rollout-${i}`,
        date: `2026-09-1${i + 1}`,
        text: `Atlas rollout status update ${i + 1}: the rollout is paused while the staging database is migrated; ${long('Atlas rollout', 2)}`,
      })),
    }, {
      'Projects/Atlas.md': '---\nowner: the data platform guild, reporting to the analytics director since the spring planning cycle\n---\n# Atlas\n\nAtlas is the deploy orchestrator.\n',
    });
    const status = 'What is the Atlas rollout status?';
    const roomy = await ask(status, ARMED, 4000);
    const answer = roomy.facts.find(f => f.predicate === 'status')!;
    expect(answer).toBeDefined();
    expect(roomy.conflicts?.map(c => `${c.subject} / ${c.predicate}`)).toEqual(['Atlas / owner']); // named when it fits
    const wrong: string[] = [];
    for (const maxTokens of REACHABLE) {
      const body = await ask(status, ARMED, maxTokens);
      if (replyTokens(JSON.stringify(body)) > maxTokens) wrong.push(`${status} at ${maxTokens}: over`);
      const { conflicts: _conflicts, ...rest } = body;
      const fits = replyTokens(JSON.stringify({ ...rest, facts: [answer], memories: [], truncated: true })) <= maxTokens;
      if (fits && !body.facts.some(f => f.predicate === 'status')) {
        wrong.push(`${status} at ${maxTokens}: ${body.facts.length} facts, ${(body.conflicts ?? []).length} contradictions`);
      }
      // A contradiction the reply could not hold is not named, and the reply says it was cut.
      if ((body.conflicts ?? []).length === 0 && !body.truncated) wrong.push(`${status} at ${maxTokens}: cut, not truncated`);
    }
    const owner = 'Who owns Atlas?';
    const whole = await ask(owner, ARMED, 4000);
    const wholeTokens = replyTokens(JSON.stringify(whole));
    expect(whole.truncated).toBe(false);
    expect(whole.conflicts?.map(c => `${c.subject} / ${c.predicate}`)).toEqual(['Atlas / owner']);
    for (const maxTokens of REACHABLE.filter(m => m >= wholeTokens)) {
      const body = await ask(owner, ARMED, maxTokens);
      if (body.truncated || body.facts.length < whole.facts.length || body.memories.length < whole.memories.length) {
        wrong.push(`${owner} at ${maxTokens}: cut, though the whole reply (${wholeTokens} tokens) fits`);
      }
    }
    expect(wrong).toEqual([]);
    // A fact is charged its contradiction as the reply shows it, the note named by its path in the workspace (never the
    // host's): at the least max_tokens that holds the owner fact and the contradiction, to the token, both are listed.
    const asked = 'Who is the owner?';
    const ownerOnly = await ask(asked, ARMED, 4000);
    expect(ownerOnly.facts.map(f => f.predicate)).toEqual(['owner']);
    expect(ownerOnly.conflicts?.map(c => c.predicate)).toEqual(['owner']);
    const first = await leastHolding(async maxTokens =>
      ({ ...(await ask(asked, ARMED, maxTokens)), facts: ownerOnly.facts, memories: [], truncated: true, conflicts: ownerOnly.conflicts }));
    const atFirst = await ask(asked, ARMED, first);
    expect(atFirst.facts.map(f => f.predicate), `max_tokens ${first}`).toEqual(['owner']);
    expect(atFirst.conflicts?.map(c => c.predicate), `max_tokens ${first}`).toEqual(['owner']);
  }, 120_000);

  it('never says "no good answer on file" while the store answers the question and the budget cut the answer', async () => {
    // One fact that does not answer the question and one note that does. The abstention was judged over what the budget
    // kept, so from max_tokens 240 to 496 the reply listed the fact alone and said "no good answer on file for this".
    const { ask } = await honestyWorkspace({
      facts: [{ subject: 'Kestrel', predicate: 'status', object: 'on hold until the vendor contract is signed' }],
      notes: [{
        slug: 'kestrel-db',
        date: '2026-09-20',
        text: 'Kestrel migration decision: we decided to cut the Postgres replicas from four to two after the load test. '
          + Array.from({ length: 6 }, (_, i) => `Supporting measurement ${i + 1}: the read latency stayed under forty milliseconds at peak with two nodes, and failover took under nine seconds in the drill.`).join(' '),
      }],
    });
    const question = 'What did the Kestrel migration decide about Postgres replicas?';
    expect((await ask(question, ARMED, 4000)).abstention).toBeNull(); // the store answers it
    const claimed: string[] = [];
    for (const maxTokens of REACHABLE) {
      const body = await ask(question, ARMED, maxTokens);
      if (body.abstention) claimed.push(`${maxTokens}: ${body.facts.length} facts, ${body.memories.length} memories`);
      if (replyTokens(JSON.stringify(body)) > maxTokens) claimed.push(`${maxTokens}: over`);
    }
    expect(claimed).toEqual([]);
    // A question nothing on file covers is told so at every budget, however much of the read the budget holds.
    for (const maxTokens of [128, 400, 800, 4000]) {
      const body = await ask('what is my favourite colour and pet name', ARMED, maxTokens);
      expect(body.abstention, `${maxTokens}`).toMatchObject({ status: 'no-answer', statement: 'no good answer on file for this' });
    }
  }, 120_000);
});
