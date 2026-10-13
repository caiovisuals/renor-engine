import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import {
  buildAgentContext,
  permissionQuestion,
  GOVERNANCE_PREDICATES,
  PERMISSION_RULE_LIMIT,
  replyTokens,
  type AgentContextFact,
} from '../../src/mvp/agentMemory';
import type { Engine } from '../../src/mvp/engine';
import type { EmbeddingProvider } from '../../src/embeddings/types';

/**
 * A question about whether an action is allowed or needs approval names the action, never the standing rule
 * that governs it ("Can I add a section to the dashboard?" shares no subject words with "Renor UI changes /
 * rule"). On a workspace where long review facts from other work share the action's words, they fill the
 * facts lane's candidate window (ordered by shared words, then newest) before the rule is even ranked, so the
 * rule never comes back (a hosted workspace, 2026-10-09). These tests seed that workspace with the
 * eval-hash stub and pin the fix: a permission question looks the standing facts up through the term index and
 * ranks them by relevance to the question — never by recency, so newer unrelated decisions cannot shadow the
 * older governing rule (review P2, 2026-10-09).
 *
 * No model, no network: the eval-hash provider is a deterministic lexical stub.
 */

type Context = { facts: AgentContextFact[]; memories: Array<{ text: string }>; truncated: boolean; maxTokens?: number };

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The model key production runs (Vertex), the only one with a calibrated bar (contextRelevance.ts CALIBRATED_BARS). */
const VERTEX = 'vertex:gemini-embedding-001:768';

function createWorkspace(provider: EmbeddingProvider | null = new EvalHashEmbeddingProvider(), env: NodeJS.ProcessEnv = {}, modelKey = 'test:hash:256') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-permission-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  runMigrations(db);
  dbs.push(db);
  const dims = provider?.dimensions ?? 256;
  const vectorIndex = new VectorIndex(db, dims);
  vectorIndex.initTable();
  const engine: Engine = { provider, vectorIndex, dims, modelKey: provider ? modelKey : null } as Engine;
  const put = (subject: string, predicate: string, object: string, scope?: string) =>
    remember(db, dir, DEFAULT_LEDGER_REL, { subject, predicate, object, ...(scope !== undefined ? { scope } : {}) });
  const getContext = (query: string, options: { scope?: string; maxTokens?: number } = {}) =>
    buildAgentContext(db, engine, dir, { query, scope: options.scope, maxTokens: options.maxTokens ?? 800, env }) as Promise<Context>;
  return { dir, db, engine, put, getContext };
}

const RULE_UI = 'Simple and good: name what is removed or simplified or show user evidence; improve only what was asked; tell Rowan before any user-visible change';
const RULE_AUTO = 'Run safe reversible work independently; ask before production, destructive, or irreversible actions; never expand your own authority';
const RULES = ['Renor UI changes', 'Renor agent autonomy']; // by relevance to the indirect question

const line = (f: AgentContextFact) => `${f.subject} · ${f.predicate}`;
const ruleLines = (body: Context) => body.facts.filter(f => f.predicate === 'rule').map(line);

/** The long other-lane facts that share the action's words: they outrank the rules on shared words and are newer. */
async function reviews(ws: ReturnType<typeof createWorkspace>, scope = 'project:renor', count = 200): Promise<void> {
  for (let i = 0; i < count; i++) {
    const n = 400 + i;
    await ws.put(`PR ${n} review`, 'verdict', `PR ${n} review: verified the Renor dashboard change, checked the new section renders, confirmed the build and tests pass, and left notes on the add flow.`, scope);
  }
}

const INDIRECT = 'Can I add a new section to the Renor dashboard, and do I need to ask Rowan?';

describe('a permission question returns the rule that governs the action (P2, 2026-10-09)', () => {
  it('returns the standing rules first for the indirect question', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    await ws.put('Renor agent autonomy', 'rule', RULE_AUTO, 'project:renor');
    await reviews(ws);
    const body = await ws.getContext(INDIRECT);
    expect(ruleLines(body)).toEqual(RULES.map(s => `${s} · rule`));
    // The rules lead; the facts the words found follow.
    expect(body.facts.slice(0, RULES.length).every(f => f.predicate === 'rule')).toBe(true);
    expect(body.facts.some(f => f.predicate === 'verdict')).toBe(true);
  });

  it('does not let newer unrelated decisions shadow the older governing rule (review P2, reproduction A)', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    // Four decisions saved after the rule, all in the same scope, none about adding a dashboard section.
    await ws.put('Fjord', 'decision', 'The database moved to SQLite because it needs no server', 'project:renor');
    await ws.put('Hetzner region', 'decision', 'Use the Falkenstein region for the new VM', 'project:renor');
    await ws.put('MCP transport', 'decision', 'Use SSE for the hosted MCP transport', 'project:renor');
    await ws.put('Alpha host', 'decision', 'Run each tenant as its own systemd unit', 'project:renor');
    await reviews(ws);
    const body = await ws.getContext('Can I add a new section to the Renor dashboard?', { scope: 'project:renor', maxTokens: 800 });
    // The rule that governs the action is the one that comes back, not the three newest decisions.
    expect(ruleLines(body)).toEqual(['Renor UI changes · rule']);
    expect(body.facts[0]).toMatchObject({ subject: 'Renor UI changes', predicate: 'rule' });
  });

  it('finds the Renor rule in an unscoped read across projects (review P2, reproduction B)', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    // Newer rules in other scopes, which the unscoped permission question must not prefer.
    await ws.put('Atlas schema rules', 'rule', 'Atlas schema changes need a migration review', 'project:atlas');
    await ws.put('Atlas release rules', 'rule', 'Atlas releases wait for the load test', 'project:atlas');
    await ws.put('Kestrel config rules', 'rule', 'Kestrel config changes are reviewed by the platform team', 'project:kestrel');
    await reviews(ws);
    const body = await ws.getContext('Can I add a new section to the Renor dashboard?');
    expect(ruleLines(body)[0]).toBe('Renor UI changes · rule');
  });

  it('keeps a long rule from displacing the fact the words found (review P3)', async () => {
    const ws = createWorkspace();
    const longRule = 'Rule detail: ' + Array.from({ length: 780 }, () => 'clause').join(' ');
    await ws.put('Renor UI changes', 'rule', longRule, 'project:renor');
    await ws.put('deploy_target', 'region', 'us-east-1');
    const body = await ws.getContext('Can I change the deploy target region?', { maxTokens: 800 });
    // The rule leads (capped) and the word-found fact is still returned.
    expect(body.facts[0]).toMatchObject({ subject: 'Renor UI changes', predicate: 'rule' });
    expect(body.facts.some(f => f.predicate === 'region')).toBe(true);
    expect(replyTokens(JSON.stringify(body))).toBeLessThanOrEqual(800);
  });

  it('leaves the word-found path unchanged for the direct question', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    await ws.put('Renor agent autonomy', 'rule', RULE_AUTO, 'project:renor');
    await reviews(ws);
    const body = await ws.getContext("What are Rowan's rules for UI changes in Renor?");
    // The words name the UI rule; it leads, and the permission lookup adds nothing on top of it.
    expect(body.facts[0]).toMatchObject({ subject: 'Renor UI changes', predicate: 'rule' });
    expect(body.facts.filter(f => f.predicate === 'rule').length).toBe(1);
  });

  it('adds no rule to a question that is not about permission or approval', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    await reviews(ws);
    const body = await ws.getContext('Where does Atlas deploy, and which database does it use?');
    expect(ruleLines(body)).toEqual([]);
  });

  it('looks the rules up only in the scope the read names', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    await ws.put('Kestrel deploys', 'rule', 'Kestrel rules only apply inside project:kestrel', 'project:kestrel');
    await reviews(ws);
    const scoped = await ws.getContext(INDIRECT, { scope: 'project:kestrel' });
    expect(ruleLines(scoped)).toEqual(['Kestrel deploys · rule']);
  });

  it('never adds more than the cap of standing facts ahead of the words', async () => {
    const ws = createWorkspace();
    for (let i = 0; i < 10; i++) await ws.put(`Policy ${i}`, 'rule', `Policy ${i} governs a distinct action`, 'project:renor');
    const body = await ws.getContext(INDIRECT);
    expect(body.facts.filter(f => f.predicate === 'rule').length).toBe(PERMISSION_RULE_LIMIT);
  });

  it('recognises the phrases that ask for permission, and not a plain question', () => {
    expect(permissionQuestion(INDIRECT)).toBe(true);
    expect(permissionQuestion('Am I allowed to change the schema?')).toBe(true);
    expect(permissionQuestion('Do I need approval for this?')).toBe(true);
    expect(permissionQuestion('Should I ship this now?')).toBe(true);
    // The reviewer's misses (P3): the intent is permission even without a modal.
    expect(permissionQuestion('Is a new section allowed?')).toBe(true);
    expect(permissionQuestion('Is adding a section allowed?')).toBe(true);
    expect(permissionQuestion('Do I need to check with Rowan before adding that?')).toBe(true);
    expect(permissionQuestion('Would it be okay to rename the table?')).toBe(true);
    expect(permissionQuestion('Is it acceptable to delete the old index?')).toBe(true);
    // Plain questions stay out.
    expect(permissionQuestion('What are the deployment steps?')).toBe(false);
    expect(permissionQuestion('Who owns the billing export?')).toBe(false);
    expect(permissionQuestion('What do I need to do today?')).toBe(false);
    expect(GOVERNANCE_PREDICATES).toContain('rule');
    expect(GOVERNANCE_PREDICATES).toContain('decision');
  });
});

/** The reviewer's seed (delta review, 2026-10-09): the rule, four newer decisions in the same scope, 200 reviews. */
async function reproductionA(ws: ReturnType<typeof createWorkspace>): Promise<void> {
  await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
  await ws.put('Fjord', 'decision', 'The database moved to SQLite because it needs no server', 'project:renor');
  await ws.put('Hetzner region', 'decision', 'Use the Falkenstein region for the new VM', 'project:renor');
  await ws.put('MCP transport', 'decision', 'Use SSE for the hosted MCP transport', 'project:renor');
  await ws.put('Alpha host', 'decision', 'Run each tenant as its own systemd unit', 'project:renor');
  await reviews(ws);
}

describe('the rule comes back however the question is worded (delta review P2, 2026-10-09)', () => {
  // One word away from the PR's own wording: an agent already scoped to project:renor does not name the project.
  for (const query of [
    'Can I add a new section to the dashboard?',
    'Is a new section allowed on the dashboard?',
    'Would it be okay to add a new section to the dashboard?',
    'Can I add a new section to the dashboard, and do I need to ask Rowan?',
  ]) {
    it(`returns the scope's rule first for "${query}"`, async () => {
      const ws = createWorkspace();
      await reproductionA(ws);
      const body = await ws.getContext(query, { scope: 'project:renor' });
      expect(line(body.facts[0])).toBe('Renor UI changes · rule');
    });
  }
});

describe('only standing facts are put first (delta review P3, candidate class)', () => {
  it('does not put a note that says "decision" ahead of the rule', async () => {
    const ws = createWorkspace();
    await ws.put('Renor UI changes', 'rule', RULE_UI, 'project:renor');
    await ws.put('Dashboard rollout', 'note', 'The decision: we add a new dashboard section for Renor users', 'project:renor');
    await reviews(ws);
    const body = await ws.getContext('Can I add a new section to the Renor dashboard?', { scope: 'project:renor' });
    expect(line(body.facts[0])).toBe('Renor UI changes · rule');
    expect(body.facts.findIndex(f => f.subject === 'Dashboard rollout')).not.toBe(0);
  });

  it('does not let a long note that says "decision" take the whole lane', async () => {
    const ws = createWorkspace();
    const longNote = 'The decision: add a new dashboard section for Renor. ' + Array.from({ length: 780 }, () => 'clause').join(' ');
    await ws.put('Dashboard rollout', 'note', longNote, 'project:renor');
    await reviews(ws);
    const body = await ws.getContext('Can I add a new section to the Renor dashboard?', { scope: 'project:renor', maxTokens: 800 });
    expect(body.facts.map(line)).not.toEqual(['Dashboard rollout · note']);
    expect(body.facts.some(f => f.predicate === 'verdict')).toBe(true);
    expect(replyTokens(JSON.stringify(body))).toBeLessThanOrEqual(800);
  });
});

describe('a governing fact saved under another standing word is found (delta review P3, predicate list)', () => {
  for (const predicate of ['constraint', 'requirement', 'must', 'approval_policy', 'ui_rule']) {
    it(`finds the governing fact saved as "${predicate}"`, async () => {
      const ws = createWorkspace();
      await ws.put('Renor dashboard sections', predicate, 'New dashboard sections need Rowan to see user evidence first', 'project:renor');
      await ws.put('Hetzner region', 'decision', 'Use the Falkenstein region for the new VM', 'project:renor');
      await ws.put('Alpha host', 'decision', 'Run each tenant as its own systemd unit', 'project:renor');
      await ws.put('MCP transport', 'decision', 'Use SSE for the hosted MCP transport', 'project:renor');
      await reviews(ws);
      const body = await ws.getContext('Can I add a new section to the Renor dashboard?', { scope: 'project:renor' });
      expect(body.facts.map(line)).toContain(`Renor dashboard sections · ${predicate}`);
    });
  }
});

describe('permission phrasing (delta review P3, phrases)', () => {
  it('reads a contraction as the question it is', () => {
    expect(permissionQuestion("Can't I add a new section to the dashboard?")).toBe(true);
    expect(permissionQuestion("Couldn't I rename the table?")).toBe(true);
    expect(permissionQuestion('Can’t we ship this today?')).toBe(true);
  });

  it('does not read a recollection or a statement as a permission question', () => {
    expect(permissionQuestion('Where did we check with the vendor?')).toBe(false);
    expect(permissionQuestion('The migration is allowed to run after review.')).toBe(false);
    expect(permissionQuestion('We confirmed with the vendor last week.')).toBe(false);
  });

  it('still reads the questions about what is allowed', () => {
    expect(permissionQuestion('Which regions are allowed for the VM?')).toBe(true);
    expect(permissionQuestion('Who is allowed to deploy?')).toBe(true);
    expect(permissionQuestion('Is a new section allowed on the dashboard')).toBe(true);
    expect(permissionQuestion('Do I need to check with Rowan before adding that?')).toBe(true);
  });
});

/**
 * A stand-in for a semantic embedding model, deterministic and offline: each word counts toward the concept it names
 * and words outside the table count for nothing, so "deploy" and "ship" are the same thing and "billing" is nothing.
 * It exists to pin the meaning path; it is not a model and makes no quality claim.
 */
class ConceptEmbeddings implements EmbeddingProvider {
  static CONCEPTS: Record<string, string[]> = {
    release: ['deploy', 'deploying', 'ship', 'shipping', 'release', 'launch', 'publish', 'production'],
    approval: ['approve', 'approval', 'signs', 'sign', 'signoff', 'permission', 'allowed', 'okay'],
    storage: ['database', 'postgres', 'sqlite', 'storage'],
  };
  dimensions = 3;
  readonly identity = { kind: 'eval-hash', model: 'concept-stub' } as EmbeddingProvider['identity'];
  embedCalls = 0;
  failing = false;
  private vector(text: string): number[] {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return Object.values(ConceptEmbeddings.CONCEPTS).map(list => words.filter(w => list.includes(w)).length);
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls += 1;
    if (this.failing) throw new Error('embedding backend down');
    return texts.map(t => this.vector(t));
  }
  async embedQuery(text: string): Promise<number[]> {
    if (this.failing) throw new Error('embedding backend down');
    return this.vector(text);
  }
}

/** A policy that shares no word with the question, and newer decisions that do. */
async function releaseWorkspace(ws: ReturnType<typeof createWorkspace>): Promise<void> {
  await ws.put('Release policy', 'policy', 'Ship nothing to customers until Rowan signs off', 'project:renor');
  await ws.put('Billing service', 'decision', 'The billing service keeps its own Postgres database', 'project:renor');
  await ws.put('Billing service owner', 'decision', 'Ravi owns the billing service today', 'project:renor');
  await ws.put('Billing service region', 'decision', 'The billing service runs in the Falkenstein region today', 'project:renor');
}

describe('a permission question also finds the standing facts by meaning (B2)', () => {
  const QUESTION = 'Can I deploy the billing service today?';

  it('finds the policy the words cannot, through the embedding path notes use (Vertex, its calibrated bar)', async () => {
    const ws = createWorkspace(new ConceptEmbeddings(), {}, VERTEX);
    await releaseWorkspace(ws);
    const body = await ws.getContext(QUESTION, { scope: 'project:renor' });
    expect(line(body.facts[0])).toBe('Release policy · policy');
  });

  it('falls back to the words, without an error, when there is no embedding provider', async () => {
    const ws = createWorkspace(null);
    await releaseWorkspace(ws);
    const body = await ws.getContext(QUESTION, { scope: 'project:renor' }) as Context & { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(body.facts.map(line)).not.toContain('Release policy · policy');
    expect(body.facts.some(f => f.subject.startsWith('Billing service'))).toBe(true);
  });

  it('falls back to the words, without an error, when the embedding backend fails', async () => {
    const provider = new ConceptEmbeddings();
    const ws = createWorkspace(provider, {}, VERTEX);
    await releaseWorkspace(ws);
    provider.failing = true;
    const body = await ws.getContext(QUESTION, { scope: 'project:renor' }) as Context & { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(body.facts.some(f => f.subject.startsWith('Billing service'))).toBe(true);
  });

  it('leaves a question that is not about permission to the words', async () => {
    const provider = new ConceptEmbeddings();
    const ws = createWorkspace(provider, {}, VERTEX);
    await releaseWorkspace(ws);
    const body = await ws.getContext('Which database does the billing service deploy with?', { scope: 'project:renor' });
    expect(body.facts.map(line)).not.toContain('Release policy · policy');
  });
});

describe('the meaning step runs only with the Vertex calibration (Batch 7 follow-up c)', () => {
  const QUESTION = 'Can I deploy the billing service today?';

  it('another embedder skips the meaning step and answers by words, even with an explicit bar in the environment', async () => {
    // An explicit RENOR_CONTEXT_RELEVANCE_MIN tunes the relevance signal; it does not calibrate a different model for
    // the permission lookup. Only the Vertex model's measured bar does.
    const provider = new ConceptEmbeddings();
    const ws = createWorkspace(provider, { RENOR_CONTEXT_RELEVANCE_MIN: '0.5' }, 'openai:text-embedding-3-small:1536');
    await releaseWorkspace(ws);
    const body = await ws.getContext(QUESTION, { scope: 'project:renor' }) as Context & { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(line(body.facts[0])).not.toBe('Release policy · policy');
    expect(body.facts.some(f => f.subject.startsWith('Billing service'))).toBe(true);
  });

  it('the same question with the Vertex model key finds the policy first', async () => {
    const ws = createWorkspace(new ConceptEmbeddings(), {}, VERTEX);
    await releaseWorkspace(ws);
    const body = await ws.getContext(QUESTION, { scope: 'project:renor' });
    expect(line(body.facts[0])).toBe('Release policy · policy');
  });
});
