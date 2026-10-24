import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import {
  buildAgentContext,
  replyTokens,
  MAX_FACT_OBJECT_LANE_SHARE,
  FACTS_BUDGET_SHARE,
  TRUNCATION_MARKER,
  scoreFactRelevance,
  rankCandidateFacts,
  joinedWords,
  type AgentContextFact,
} from '../../src/mvp/agentMemory';
import type { Engine } from '../../src/mvp/engine';

/** The part of the get_context reply these tests read; buildAgentContext's own return is a plain record. */
type Context = { facts: AgentContextFact[]; truncated: boolean };

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function createWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-crowding-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  runMigrations(db);
  dbs.push(db);

  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  const engine: Engine = {
    provider,
    vectorIndex,
    dims: provider.dimensions,
    modelKey: 'test:hash:256',
  };

  const put = (subject: string, predicate: string, object: string, scope?: string) =>
    remember(db, dir, DEFAULT_LEDGER_REL, {
      subject,
      predicate,
      object,
      ...(scope !== undefined ? { scope } : {}),
    });

  const getContext = (query: string, options: { scope?: string; maxTokens?: number } = {}) =>
    buildAgentContext(db, engine, dir, {
      query,
      scope: options.scope,
      maxTokens: options.maxTokens ?? 800,
    }) as Promise<Context>;

  return { dir, db, engine, put, getContext };
}

// The secret guard is on by default. These tests store fixture text that the guard refuses (a credential-shaped or an
// identifier-shaped sentence that is incidental to what each test checks), so they run with it explicitly off.
const SAVED_GUARD = process.env.RENOR_SECRET_GUARD;
beforeAll(() => { process.env.RENOR_SECRET_GUARD = '0'; });
afterAll(() => { if (SAVED_GUARD === undefined) delete process.env.RENOR_SECRET_GUARD; else process.env.RENOR_SECRET_GUARD = SAVED_GUARD; });

describe('facts lane crowding resolution (P2)', () => {
  it('joins word sequences with trailing single letters/digits (Lane J -> lanej)', () => {
    const joined = joinedWords('What is the schedule for Lane J and model v2?');
    expect(joined).toContain('lanej');
    expect(joined).toContain('modelv2');
  });

  it('does not join a possessive s into a lookup key (John\'s is not johns)', () => {
    expect(joinedWords("What is John's plan?")).not.toContain('johns');
    expect(joinedWords("Atlas's budget")).not.toContain('atlass');
    expect(joinedWords("user's key")).not.toContain('users');
    // A real single-letter key still joins.
    expect(joinedWords('Lane J schedule')).toContain('lanej');
  });

  it('ranks concise answering facts ahead of long background facts with incidental term overlap', async () => {
    const { put, getContext } = createWorkspace();

    // Long background fact from another lane with ~2,000 characters mentioning "model", "decision", "scout" incidentally
    const longEngineeringDoc = ('Evaluation run report 2026-10-06: Evaluated multiple model options and decision trees across lanes. ' +
      'The scout benchmark tested several alternatives including fast decision models, fallback heuristics, and token limits. ' +
      'Scout performance was measured across 100 trials with varying model parameters. Options evaluated: ' +
      'Option A: Decision latency 420ms, accuracy 84.2%, token consumption per model invocation was high. ' +
      'Option B: Decision latency 310ms, accuracy 89.1%, model weights cached in memory across invocations. ' +
      'Option C: Model ensemble with fallback decision logic on low confidence scores. ' +
      'Conclusions: The scout decision models must balance throughput and accuracy. Further investigation needed for memory lane integration. ' +
      'Full metrics: precision=0.88, recall=0.85, f1=0.865. The scout pipeline logs confirm that decision models performed as expected under heavy load. ')
      .repeat(4);

    await put('scout_eval_report', 'benchmark_summary', longEngineeringDoc, 'project:atlas');

    // Fresh, concise answering fact from current agent in project:renor
    await put('decision_model', 'scout_model', 'Vertex claude-3-5-sonnet', 'project:renor');

    // Unscoped query: "What is the decision model for the scout?"
    const result = await getContext('What is the decision model for the scout?');

    expect(result.facts.length).toBeGreaterThan(0);
    // Answering fact MUST rank first (#1)
    expect(result.facts[0].predicate).toBe('scout_model');
    expect(result.facts[0].object).toBe('Vertex claude-3-5-sonnet');
    expect(result.facts[0].subject).toBe('decision_model');
  });

  it('caps a long non-top fact object under crowding, never the top-ranked fact, and flags the cut', async () => {
    const { put, getContext } = createWorkspace();

    // The answering fact: concise, top-ranked by the query's subject and predicate.
    await put('architecture_matrix', 'primary_db', 'PostgreSQL 16', 'global');

    // A long background fact from another lane that only matches the query's words inside its (damped) object,
    // so it ranks below the answering fact. Uncapped it would take the whole lane.
    const hugeFactObject = 'Detailed test matrix results for architecture decision: ' + 'result-entry-code-9912 '.repeat(150);
    await put('atlas_benchmark', 'raw_report', hugeFactObject, 'project:atlas');

    const maxTokens = 600;
    const result = await getContext('architecture matrix test results and db', { maxTokens });

    // The answering fact is delivered whole, never cut.
    const dbFact = result.facts.find(f => f.predicate === 'primary_db');
    expect(dbFact).toBeDefined();
    expect(dbFact!.object).toBe('PostgreSQL 16');

    // The long background fact is capped to its share of the lane and marked, so the agent knows to read the rest.
    const hugeFact = result.facts.find(f => f.predicate === 'raw_report');
    expect(hugeFact).toBeDefined();
    expect(hugeFact!.object.includes(TRUNCATION_MARKER)).toBe(true);
    const factBudget = maxTokens; // no memories, so allowance is maxTokens
    const maxTokensCap = Math.max(32, Math.floor(factBudget * MAX_FACT_OBJECT_LANE_SHARE));
    expect(replyTokens(hugeFact!.object)).toBeLessThanOrEqual(maxTokensCap + replyTokens(TRUNCATION_MARKER));

    // The reply says it was cut.
    expect(result.truncated).toBe(true);

    // Total reply shape and budget must be respected.
    expect(replyTokens(JSON.stringify(result))).toBeLessThanOrEqual(maxTokens);
  });

  it('delivers a long answering fact whole when the lane has room for it (reviewer case C)', async () => {
    const { put, getContext } = createWorkspace();

    // A 150-word fact that IS the answer; the answer token sits at the end.
    const body = Array.from({ length: 150 }, (_, i) => `step${i}`).join(' ') + ' FINAL-ANSWER-TOKEN';
    await put('release_runbook', 'procedure', body, 'project:renor');
    await put('release_runbook', 'owner', 'Carol', 'project:renor');

    // Default budget: the fact (~305 tokens) fits the lane, so it is delivered whole.
    const result = await getContext('release runbook procedure');
    const fact = result.facts.find(f => f.predicate === 'procedure');
    expect(fact).toBeDefined();
    expect(fact!.object).toBe(body);
    expect(fact!.object.includes('FINAL-ANSWER-TOKEN')).toBe(true);
    expect(result.truncated).toBe(false);

    // A budget that holds the fact whole still delivers it whole.
    const roomy = await getContext('release runbook procedure', { maxTokens: 1500 });
    const roomyFact = roomy.facts.find(f => f.predicate === 'procedure');
    expect(roomyFact).toBeDefined();
    expect(roomyFact!.object).toBe(body);
    expect(roomy.truncated).toBe(false);
  });

  it('delivers a long top-ranked fact as a marked truncated prefix when it alone is over the budget', async () => {
    const { put, getContext } = createWorkspace();

    // A fact that IS the answer, long enough that at max_tokens=400 it cannot be delivered whole
    // (~400 tokens of object plus JSON overhead against a ~360-token allowance).
    const body = Array.from({ length: 380 }, (_, i) => `step${i}`).join(' ') + ' FINAL-ANSWER-TOKEN';
    await put('release_runbook', 'procedure', body, 'project:renor');

    const maxTokens = 400;
    const result = await getContext('release runbook procedure', { maxTokens });

    // The top fact is delivered as a prefix, not dropped: the budget must not lose the one fact that answers.
    expect(result.facts.length).toBeGreaterThan(0);
    const fact = result.facts[0];
    expect(fact.predicate).toBe('procedure');
    expect(fact.object).not.toBe(body);
    expect(fact.object.includes(TRUNCATION_MARKER)).toBe(true);
    expect(body.startsWith(fact.object.split('…')[0])).toBe(true);
    expect(result.truncated).toBe(true);

    // The reply stays within max_tokens.
    expect(replyTokens(JSON.stringify(result))).toBeLessThanOrEqual(maxTokens);

    // A budget that holds the fact whole still delivers it whole (the fix must not over-truncate).
    const roomy = await getContext('release runbook procedure', { maxTokens: 1500 });
    const roomyFact = roomy.facts.find(f => f.predicate === 'procedure');
    expect(roomyFact).toBeDefined();
    expect(roomyFact!.object).toBe(body);
    expect(roomy.truncated).toBe(false);
  });

  it('prefers request scope when provided, breaking ties across projects', async () => {
    const { put, getContext } = createWorkspace();

    await put('Lane J', 'rerun_date', '2026-10-08', 'project:renor');
    await put('Lane J', 'rerun_date', '2026-10-15', 'project:atlas');
    await put('Lane J', 'rerun_date', '2026-10-22', 'project:kestrel');

    // Scoped request to project:renor
    const renorResult = await getContext('When is Lane J rerun?', { scope: 'project:renor' });
    expect(renorResult.facts[0].object).toBe('2026-10-08');
    expect(renorResult.facts[0].scope).toBe('project:renor');

    // Scoped request to project:atlas
    const atlasResult = await getContext('When is Lane J rerun?', { scope: 'project:atlas' });
    expect(atlasResult.facts[0].object).toBe('2026-10-15');
    expect(atlasResult.facts[0].scope).toBe('project:atlas');
  });

  it('delivers the answering fact first when a longer other-lane fact matches an extra query term', async () => {
    const { put, getContext } = createWorkspace();

    // The answering fact: concise, in the requesting agent's project.
    await put('decision_model', 'scout_model', 'Vertex claude-3-5-sonnet', 'project:renor');

    // A long benchmark dump from another lane that incidentally contains every word of the query,
    // including "benchmark" which the answering fact's key does not. On the old shared-count order
    // it has one more matched word and, being long, then takes the lane's whole allowance.
    const bench = ('Benchmark report: the decision model scout benchmark ran across arms. ' +
      'Each decision model scout benchmark arm produced decision model scout benchmark metrics. ').repeat(30);
    await put('atlas_benchmark', 'raw_report', bench, 'project:atlas');

    const result = await getContext('What is the decision model for the scout benchmark?');
    expect(result.facts[0].subject).toBe('decision_model');
    expect(result.facts[0].object).toBe('Vertex claude-3-5-sonnet');
  });

  it('keeps the answering fact when newer other-lane facts overflow the candidate window', async () => {
    const { put, getContext } = createWorkspace();

    // Saved first, so every other-lane fact below is newer and, on the old order, ranked above it.
    await put('decision_model', 'scout_model', 'Vertex claude-3-5-sonnet', 'project:renor');

    const bench = 'Benchmark report: decision model scout benchmark. '.repeat(20);
    for (let i = 0; i < 15; i++) {
      await put(`lane${i}_report`, 'raw_report', `${bench} lane ${i}`, `project:lane${i}`);
    }

    const result = await getContext('What is the decision model for the scout?');
    const hit = result.facts.find(f => f.subject === 'decision_model');
    expect(hit).toBeDefined();
    expect(hit!.object).toBe('Vertex claude-3-5-sonnet');
  });

  it('keeps the answering fact when other-lane long facts would exhaust the facts lane', async () => {
    const { put, getContext } = createWorkspace();

    await put('decision_model', 'scout_model', 'Vertex claude-3-5-sonnet', 'project:renor');

    const bench = 'Benchmark report: decision model scout benchmark. '.repeat(20);
    await put('atlas_gate', 'report', bench, 'project:atlas');
    await put('kestrel_gate', 'report', bench, 'project:kestrel');

    const result = await getContext('What is the decision model for the scout?');
    expect(result.facts[0].subject).toBe('decision_model');
    expect(result.facts[0].object).toBe('Vertex claude-3-5-sonnet');
  });

  it('delivers each scoped answering fact first across a multi-lane workspace', async () => {
    const { put, getContext } = createWorkspace();

    // 1. Long background facts from various lanes and projects
    await put('atlas_release_gate', 'report', 'Long gate run status: all 400 suites passed with 0 failures under node 22. '.repeat(20), 'project:atlas');
    await put('kestrel_crawler', 'config_dump', 'Crawler options and parameters: depth=5, concurrency=10, timeout=30s, user_agent=RenorBot. '.repeat(20), 'project:kestrel');
    await put('decision_models_scout', 'raw_benchmark', 'Extensive decision model scout benchmark data: arm A score 0.91, arm B score 0.88, arm C score 0.94. '.repeat(25), 'global');
    await put('selfserve_options', 'full_matrix', 'Semantic options matrix: fast_mode=true, semantic_cutoff=0.45, max_candidates=50. '.repeat(25), 'global');

    // 2. Fresh answering facts for specific agent queries
    await put('decision_model', 'scout_model', 'Vertex claude-3-5-sonnet', 'project:renor');
    await put('selfserve_semantic', 'primary_option', 'cosine_rerank_v2', 'project:renor');
    await put('extractor_attribution', 'author_email', 'agent@renor.internal', 'project:renor');
    await put('Lane J', 'rerun_scheduled', 'tomorrow 10:00', 'project:renor');
    await put('Atlas', 'deploy_target', 'AWS ECS Fargate', 'project:atlas');
    await put('Kestrel', 'primary_storage', 'Cloudflare R2', 'project:kestrel');
    await put('user', 'timezone', 'America/Sao_Paulo', 'global');
    await put('user', 'editor', 'VS Code', 'global');

    const testCases = [
      { query: 'What is the decision model for the scout?', expected: 'Vertex claude-3-5-sonnet' },
      { query: 'What is the primary option for selfserve semantic?', expected: 'cosine_rerank_v2' },
      { query: 'What is the author email for extractor attribution?', expected: 'agent@renor.internal' },
      { query: 'When is Lane J rerun scheduled?', expected: 'tomorrow 10:00' },
      { query: 'Where does Atlas deploy?', expected: 'AWS ECS Fargate' },
      { query: 'Where does Kestrel store data?', expected: 'Cloudflare R2' },
      { query: 'What is the user timezone?', expected: 'America/Sao_Paulo' },
      { query: 'Which editor does the user use?', expected: 'VS Code' },
    ];

    for (const { query, expected } of testCases) {
      const result = await getContext(query);
      expect(result.facts.length).toBeGreaterThan(0);
      const firstFact = result.facts[0];
      expect(firstFact.object, `Query "${query}" failed to deliver answering fact at rank 1`).toBe(expected);
    }
  });
});
