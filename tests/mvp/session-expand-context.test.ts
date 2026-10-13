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
import { engineSearchMemory, type Engine } from '../../src/mvp/engine';
import { warmFactVectors } from '../../src/mvp/contextRelevance';
import { orderHits, SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';
import { seedWorkspace } from '../../scripts/eval/relevance-calibration';

/**
 * get_context spends its token budget (default 800) on the facts, then the memories in order, and cuts every list from
 * its end. Session expansion (RENOR_SESSION_EXPAND) adds the short statements of the notes retrieval found to the
 * memories, and they were laid out with their session: so an added hit, which no word of the question matched, came
 * before the keyword matches and took their room. The first-week replay on a workspace that kept an imported vault (a
 * document of short sections) lost 5 of 134 answers at 800 tokens and 12 of 134 at 4,000
 * (docs/evals/results/SESSION-EXPAND-GET-CONTEXT-20261004.md).
 *
 * The contract pinned here: the added hits take only the room the facts and the matches leave. Whatever the same read
 * holds with the expansion off, it holds with it on, in the same relative order, at every budget. Once selected, added
 * hits render with their session under newest-first ranking, before word-only matches; `truncated` still says that a
 * match was cut, not that an extra was. The workspace is a returning user's:
 * facts, daily notes that answer the question, and an imported runbook of short sections, which is where the expansion
 * acts (a daily log's entries share one heading, so none of them is a "statement"). Eval-hash embeddings: no model.
 */

const cleanups: Array<() => void> = [];
const savedExpand = process.env.RENOR_SESSION_EXPAND;
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (savedExpand === undefined) delete process.env.RENOR_SESSION_EXPAND;
  else process.env.RENOR_SESSION_EXPAND = savedExpand;
});

const SECTIONS: Array<[string, string]> = [
  ['Deploys', 'Production deploys come from release tags after the smoke suite passes. Staging deploys from the develop branch on every merge.'],
  ['Rollbacks', 'Redeploy the previous tag from the deploy dashboard. Migrations stay backwards compatible for one release, so a rollback never needs a restore.'],
  ['On call', 'One person per week, rotating. The pager goes to the on-call phone; acknowledge within ten minutes.'],
  ['Incidents', 'Open an incident channel, post a timeline as you go, write the review within three working days.'],
  ['Contacts', 'Carrier integrations go through the vendor support portal. Billing questions go to Ravi. Customer escalations go to Sofia.'],
  ['Observability', 'Logs go to Papertrail, metrics to Datadog and errors to Sentry. The Atlas Overview board is the on-call dashboard.'],
  ['Queues', 'Celery with Redis for webhook retries and invoice exports. Retries back off thirty seconds, two minutes, ten minutes.'],
  ['Hosting', 'The API and the worker run on ECS Fargate in two availability zones behind one load balancer.'],
];

const QUERY = 'What is the Atlas deploy and rollback procedure?';
const BUDGETS = [128, 200, 300, 400, 600, 800, 1500, 4000];

type Fact = { subject: string; predicate: string; object: string; scope: string };
type Memory = { notePath: string; headingPath?: string; text: string; reason: string; score?: number; session_date?: string };
type Context = { facts: Fact[]; memories: Memory[]; truncated: boolean };

async function workspace(extra: (memoryDir: string) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-expand-context-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, {
    facts: [
      { subject: 'Atlas', predicate: 'deploy_target', object: 'AWS ECS Fargate', scope: 'project:atlas' },
      { subject: 'Atlas', predicate: 'rollback_window', object: 'one release', scope: 'project:atlas' },
      { subject: 'Atlas', predicate: 'on_call', object: 'Ravi', scope: 'project:atlas' },
      { subject: 'Atlas', predicate: 'release_cadence', object: 'every Tuesday', scope: 'project:atlas' },
      { subject: 'Atlas', predicate: 'deploy_dashboard', object: 'the internal deploy dashboard', scope: 'project:atlas' },
      { subject: 'Atlas', predicate: 'rollback_owner', object: 'the person on call', scope: 'project:atlas' },
    ],
    notes: [
      { slug: 'a', date: '2026-09-02', text: 'Atlas deploy and rollback: the rollback of a bad deploy took eleven minutes and needed no restore.' },
      { slug: 'b', date: '2026-09-09', text: 'Atlas deploy notes: staging deploys from develop; production deploys from release tags.' },
      { slug: 'c', date: '2026-09-16', text: 'Atlas rollback drill went fine; the previous tag redeployed from the dashboard in four minutes.' },
      { slug: 'd', date: '2026-09-23', text: 'Atlas deploy freeze starts Friday; rollback owner is whoever is on call.' },
    ],
  });
  // The imported vault note: newer than every daily note, so newest first lays its sections out ahead of them.
  const imported = path.join(memoryDir, 'Imported');
  fs.mkdirSync(imported, { recursive: true });
  fs.writeFileSync(path.join(imported, 'atlas-runbook.md'),
    `---\ndate: 2026-10-02\n---\n# Atlas runbook\n\n${SECTIONS.map(([heading, text]) => `## ${heading}\n\n${text}`).join('\n\n')}\n`);
  extra(memoryDir);
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  const setExpand = (expand: string | undefined) => {
    if (expand === undefined) delete process.env.RENOR_SESSION_EXPAND;
    else process.env.RENOR_SESSION_EXPAND = expand;
  };
  /** get_context's body; `expand` undefined leaves RENOR_SESSION_EXPAND unset, the shipped default. */
  const ask = (expand: string | undefined, maxTokens: number, query = QUERY, scope?: string): Promise<Context> => {
    setExpand(expand);
    return buildAgentContext(db, engine, memoryDir, { query, maxTokens, ...(scope ? { scope } : {}) }) as Promise<Context>;
  };
  /** search_memory's hits: the same retrieval with no token budget of its own. */
  const search = async (expand: string | undefined, topK = 3, scope?: string): Promise<Memory[]> => {
    setExpand(expand);
    return (await engineSearchMemory(db, engine, memoryDir, QUERY, topK, scope)).hits as Memory[];
  };
  return { ask, search };
}

const factKey = (f: Fact) => `${f.subject}|${f.predicate}|${f.object}|${f.scope}`;
const memoryKey = (m: Memory) => `${m.notePath}|${m.headingPath ?? ''}|${m.text}`;
const added = (m: Memory) => m.reason === SESSION_EXPAND_REASON;
const wordOnly = (m: Memory) => m.reason.split('+').every(r => ['fts', 'note-identity'].includes(r));
const newestLayout = (memories: Memory[]) => [
  ...orderHits(memories.filter(m => !wordOnly(m)).map(item => ({ item, score: item.score ?? 0, session_date: item.session_date })), 'session_date').map(h => h.item),
  ...memories.filter(wordOnly),
];

describe('get_context with the session expansion on spends only the room the facts and the matches leave', () => {
  it('holds every fact and memory the read holds with the expansion off, in the same order, at every budget', async () => {
    const w = await workspace();
    for (const maxTokens of BUDGETS) {
      const off = await w.ask('0', maxTokens);
      const on = await w.ask('5', maxTokens);
      expect(on.facts.map(factKey), `facts at ${maxTokens} tokens`).toEqual(off.facts.map(factKey));
      const matches = on.memories.filter(m => !added(m));
      expect(matches.map(memoryKey), `memories at ${maxTokens} tokens`).toEqual(off.memories.map(memoryKey));
    }
  });

  it('renders selected statements with their session before word-only matches, and still fits the budget', async () => {
    const w = await workspace();
    let addedShown = 0;
    for (const maxTokens of BUDGETS) {
      const on = await w.ask('5', maxTokens);
      expect(on.memories.map(memoryKey), `at ${maxTokens} tokens`).toEqual(newestLayout(on.memories).map(memoryKey));
      addedShown += on.memories.filter(added).length;
      expect(replyTokens(JSON.stringify(on)), `at ${maxTokens} tokens`).toBeLessThanOrEqual(maxTokens); // the whole reply, as get_context counts it
    }
    // The lane is not dead in get_context: where there is room, the runbook's other sections are in the reply.
    const roomy = await w.ask('5', 4000);
    expect(roomy.memories.filter(added).length).toBeGreaterThan(0);
    expect(roomy.memories.filter(added).every(m => m.notePath.endsWith('atlas-runbook.md'))).toBe(true);
    expect(addedShown).toBeGreaterThan(0);
  });

  it('says truncated only when a fact or a match was cut, as it does with the expansion off', async () => {
    const w = await workspace();
    for (const maxTokens of BUDGETS) {
      const off = await w.ask('0', maxTokens);
      const on = await w.ask('5', maxTokens);
      expect(on.truncated, `truncated at ${maxTokens} tokens`).toBe(off.truncated);
    }
  });
});

describe('the expansion is on by default at the hosted read surfaces, and 0 turns it off', () => {
  it('get_context answers the same with no variable set as with 5, and with 0 holds exactly the matches', async () => {
    const w = await workspace();
    // What the reply holds, not the float noise of two calls' recency scores.
    const held = (c: Context) => ({ facts: c.facts.map(factKey), memories: c.memories.map(m => `${m.reason}|${memoryKey(m)}`), truncated: c.truncated });
    for (const maxTokens of [800, 4000]) {
      const unset = await w.ask(undefined, maxTokens);
      expect(held(unset), `${maxTokens} tokens`).toEqual(held(await w.ask('5', maxTokens)));
      const off = await w.ask('0', maxTokens);
      expect(off.memories.some(added), `0 at ${maxTokens} tokens`).toBe(false);
    }
    expect((await w.ask(undefined, 4000)).memories.some(added)).toBe(true); // on, with no variable
  });

  it('search_memory adds the short statements of the best notes by default, and nothing with 0', async () => {
    const w = await workspace();
    const off = await w.search('0');
    expect(off.some(added)).toBe(false);
    const byDefault = await w.search(undefined);
    expect(byDefault.filter(added).length).toBeGreaterThan(0);
    expect(byDefault.filter(added).every(m => m.notePath.endsWith('atlas-runbook.md'))).toBe(true);
    // A union: every hit the search holds with the expansion off, it holds on.
    expect(byDefault.map(memoryKey)).toEqual(expect.arrayContaining(off.map(memoryKey)));
    expect(JSON.stringify(byDefault.map(memoryKey))).toBe(JSON.stringify((await w.search('5')).map(memoryKey)));
  });
});

describe('a scoped read adds no statement from another scope', () => {
  const project = (slug: string, topic: string) => (memoryDir: string) => {
    const dir = path.join(memoryDir, 'Memory', 'Scopes', slug);
    fs.mkdirSync(dir, { recursive: true });
    // More sections than the window holds, so some statements are left for the expansion to add.
    const headings = ['Deploys', 'Rollbacks', 'Contacts', 'Hosting', 'Queues', 'Alerts', 'Backups', 'Secrets', 'Releases', 'Incidents', 'Capacity', 'Costs'];
    const sections = headings.map(h => `## ${h}\n\n${topic} ${h.toLowerCase()}: the ${slug} procedure for this lives with the ${slug} team.`);
    fs.writeFileSync(path.join(dir, 'runbook.md'), `---\ndate: 2026-10-02\n---\n# ${topic} runbook\n\n${sections.join('\n\n')}\n`);
  };

  it('with no variable set, the statements added to a project\'s read are that project\'s notes, and global holds neither', async () => {
    const w = await workspace(memoryDir => { project('atlas', 'Atlas deploy and rollback')(memoryDir); project('kestrel', 'Kestrel deploy and rollback')(memoryDir); });
    const from = (m: Memory) => /\/Scopes\/(atlas|kestrel)\//.exec(m.notePath.replace(/\\/g, '/'))?.[1];
    for (const [scope, other] of [['project:atlas', 'kestrel'], ['project:kestrel', 'atlas']] as const) {
      const context = (await w.ask(undefined, 4000, QUERY, scope)).memories;
      const search = await w.search(undefined, 3, scope);
      for (const [surface, memories] of [['get_context', context], ['search_memory', search]] as const) {
        const expansion = memories.filter(added);
        expect(expansion.length, `${surface} ${scope}`).toBeGreaterThan(0);
        expect(expansion.every(m => from(m) === scope.slice('project:'.length)), `${surface} ${scope}`).toBe(true);
        expect(memories.some(m => from(m) === other || m.text.toLowerCase().includes(other)), `${surface} ${scope} shows nothing of ${other}`).toBe(false);
      }
    }
    const inGlobal = [...(await w.ask(undefined, 4000, QUERY, 'global')).memories, ...(await w.search(undefined, 3, 'global'))];
    expect(inGlobal.some(m => from(m) !== undefined)).toBe(false);
  });
});

describe('with the read-honesty lane armed, the expansion takes only the room the whole reply leaves', () => {
  // The opt-in lane (RENOR_READ_HONESTY, the read-honesty lane) lists the whole reply first
  // whenever it fits, and its contradictions that no listed fact brings take the room the items leave. Budgeted as items,
  // the expansion's statements made the whole reply too big where it fit without them, and the cut that follows kept two
  // facts' ledger events in place of the facts (the status question: one fact of three from 3144 to 3240 tokens); and
  // they took the room of a contradiction about the subject the query names (the rollout question: none from 1736 to
  // 1832). The contract: at every budget the schema accepts, the reply with the expansion on is the reply with it off,
  // plus the statements the expansion added, after every match, in the room that reply leaves. (An abstention, which these
  // reads do not carry, counts the statements among what it considered: the lane judges everything the read could list.)
  const ARMED = { RENOR_READ_HONESTY: '1' } as NodeJS.ProcessEnv;
  const REACHABLE: number[] = [];
  for (let maxTokens = 128; maxTokens <= 4000; maxTokens += 8) REACHABLE.push(maxTokens);
  const detail = (what: string, n: number) => Array.from({ length: n }, (_, i) =>
    `${what} detail ${i + 1}: the rollout checklist item was verified against the staging database and signed off by the on-call engineer.`).join(' ');
  // A document of short sections, the shape the expansion adds statements from.
  const runbook = (title: string) => `---\ndate: 2026-10-02\n---\n# ${title}\n\n${[
    ['Status', 'Atlas status is reported every Monday in the platform channel.'],
    ['Deploys', 'Production deploys come from release tags after the smoke suite passes.'],
    ['Rollbacks', 'Redeploy the previous tag from the deploy dashboard.'],
    ['On call', 'One person per week, rotating; acknowledge within ten minutes.'],
    ['Incidents', 'Open an incident channel and post a timeline as you go.'],
    ['Contacts', 'Billing questions go to Ravi. Customer escalations go to Sofia.'],
  ].map(([heading, text]) => `## ${heading}\n\n${text}`).join('\n\n')}\n`;
  type Seed = Parameters<typeof seedWorkspace>[2];
  type Armed = Context & { conflicts?: unknown[] };
  const READS: Array<[string, Seed, Record<string, string>, string[]]> = [
    [
      'keeps every fact of a whole reply the statements would make too big',
      {
        facts: [
          { subject: 'Atlas', predicate: 'status', object: `paused: ${detail('Atlas pause', 6)}` },
          { subject: 'Atlas project', predicate: 'status', object: `active: ${detail('Atlas active', 6)}` },
          { subject: 'Atlas', predicate: 'status', object: `blocked: ${detail('Atlas blocked', 4)}`, scope: 'project:atlas' },
        ],
        notes: Array.from({ length: 6 }, (_, i) => ({ slug: `atlas-${i}`, date: `2026-09-2${i + 1}`, text: `Atlas status note ${i + 1}: ${detail(`Atlas note ${i + 1}`, 3)}` })),
      },
      { 'Projects/atlas-runbook.md': runbook('Atlas status runbook') },
      ['What is the Atlas status?'],
    ],
    [
      'keeps a contradiction about the subject the query names',
      {
        facts: [
          { subject: 'Atlas', predicate: 'owner', object: 'the renor platform team, reporting to the infrastructure group lead since the reorganisation' },
          { subject: 'Atlas', predicate: 'status', object: 'rollout paused while the staging database is migrated' },
        ],
        notes: Array.from({ length: 3 }, (_, i) => ({
          slug: `atlas-rollout-${i}`,
          date: `2026-09-1${i + 1}`,
          text: `Atlas rollout status update ${i + 1}: the rollout is paused while the staging database is migrated; ${detail('Atlas rollout', 2)}`,
        })),
      },
      {
        'Projects/Atlas.md': '---\nowner: the data platform guild, reporting to the analytics director since the spring planning cycle\n---\n# Atlas\n\nAtlas is the deploy orchestrator.\n',
        'Projects/atlas-runbook.md': runbook('Atlas rollout status runbook'),
      },
      ['What is the Atlas rollout status?'],
    ],
    [
      // The first statement is long and the next ones short, so a budget can hold a later one and not the first. No word of
      // the question is in the title (a heading path every section carries), so the keyword search finds only the overview.
      'lists the statements in the order laid out, and stops at the first the reply cannot hold',
      {
        facts: [],
        notes: Array.from({ length: 8 }, (_, i) => ({
          slug: `kestrel-${i}`,
          date: `2026-09-1${i}`,
          text: `Kestrel handbook overview, part ${i + 1}: the team reads the handbook overview before every release.`,
        })),
      },
      {
        'Projects/kestrel-handbook.md': `---\ndate: 2026-10-02\n---\n# Team notes\n\n## Overview\n\nThe Kestrel handbook overview: how the team ships.\n\n`
          + `## History\n\n${Array.from({ length: 5 }, (_, i) => `In year ${i + 1} the team grew by two engineers, moved the build to a new region and wrote down what broke.`).join(' ')}\n\n`
          + '## Pager\n\nThe pager rotates weekly.\n\n## Channels\n\nUse the platform channel.\n',
      },
      ['What does the Kestrel handbook overview say?'],
    ],
  ];

  // A memory's score counts recency against the clock: held, the two replies of a pair differ by the expansion alone.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  async function armedWorkspace(seed: Seed, files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-expand-honesty-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const memoryDir = path.join(root, 'memory');
    fs.mkdirSync(memoryDir);
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
    await warmFactVectors(db, provider);
    const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
    return (expand: string, maxTokens: number, query: string): Promise<Armed> => {
      process.env.RENOR_SESSION_EXPAND = expand;
      return buildAgentContext(db, engine, memoryDir, { query, maxTokens, env: ARMED }) as Promise<Armed>;
    };
  }

  for (const [what, seed, files, queries] of READS) {
    it(what, async () => {
      const ask = await armedWorkspace(seed, files);
      const said = (c: Armed) => `${c.facts.length} facts, ${c.memories.filter(m => !added(m)).length} matches, ${(c.conflicts ?? []).length} contradictions, truncated ${c.truncated}`;
      for (const query of queries) {
        // Every statement the read can add: the largest budget holds them all, with room for one more.
        const roomy = await ask('5', 4000, query);
        expect(replyTokens(JSON.stringify(roomy)), query).toBeLessThanOrEqual(4000 - 400);
        const laidOut = roomy.memories.filter(added).map(m => JSON.stringify(m));
        expect(laidOut.length, `${query}: the expansion adds statements to this read`).toBeGreaterThan(0);
        const wrong: string[] = [];
        for (const maxTokens of REACHABLE) {
          const off = await ask('0', maxTokens, query);
          const on = await ask('5', maxTokens, query);
          if (JSON.stringify({ ...on, memories: on.memories.filter(m => !added(m)) }) !== JSON.stringify(off)) {
            wrong.push(`${maxTokens}: off ${said(off)}; on ${said(on)}`);
          }
          if (JSON.stringify(on.memories) !== JSON.stringify(newestLayout(on.memories))) wrong.push(`${maxTokens}: statements outside newest-first order`);
          // Like every list of the reply, cut from its end; and like every item the lane lists, it says where it came from.
          const shown = on.memories.filter(added).map(m => JSON.stringify(m));
          if (JSON.stringify(shown) !== JSON.stringify(laidOut.slice(0, shown.length))) wrong.push(`${maxTokens}: statements not in the order laid out`);
          if (on.memories.some(m => !('provenance' in m))) wrong.push(`${maxTokens}: an item without provenance`);
          if (replyTokens(JSON.stringify(on)) > maxTokens) wrong.push(`${maxTokens}: ${replyTokens(JSON.stringify(on))} tokens`);
        }
        expect(wrong, query).toEqual([]);
      }
    }, 120_000);
  }
});
