import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { buildAgentContext, newestMatchAbove, replyTokens, type AgentContextMemory } from '../../src/mvp/agentMemory';
import { engineSearchMemory, type Engine } from '../../src/mvp/engine';
import type { RetrievalProbe } from '../../src/retrieval/semantic';

/**
 * A cut by score keeps the closest matches, and where two statements are about one thing it cannot tell which is current:
 * measured on the held-out 400, it kept the NEWEST gold session of a question 178 times of 238 where the newest-first prefix
 * kept it 201 (docs/evals/results/CUT-BY-SCORE-20261007.md). The newest value must win, so the newest match that is itself
 * relevant (its raw cosine is at least the relevance bar) takes its room first and the rest are taken by score; what is kept is
 * still listed newest first. Only where the layout is by date (a read about the past is laid out by score, and asks for the
 * older statement) and the model has a bar to judge by.
 *
 * The workspace is the one of budget-cut-by-score.test.ts plus an UPDATE: a newer note about the same thing, relevant but
 * scored below the two strong notes, with two newer notes after it that are not relevant. The bar is set explicitly (the
 * eval-hash embeddings have none): between the weak notes' cosines and the update's. Eval-hash embeddings, no model.
 */

const cleanups: Array<() => void> = [];
const saved = ['RENOR_SESSION_EXPAND', 'RENOR_NEWEST_FIRST', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN'].map(name => [name, process.env[name]] as const);
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()!();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const QUERY = 'Who owns the Kestrel billing export and where does it run?';
const BAR = '0.4';
const BILLING = 'Billing notes: invoices are exported every night and the finance team reads the export in the morning.';
const NOTES: Array<[file: string, date: string, text: string]> = [
  ['kestrel-export', '2026-03-02', 'The Kestrel billing export runs nightly on the Kestrel worker. Ravi owns the Kestrel billing export and its failures.'],
  ['billing-notes', '2026-05-18', Array.from({ length: 8 }, () => BILLING).join(' ')],
  ['worker-pool', '2026-07-09', 'The worker pool was resized last week to eight workers. Nothing else changed about the pool or the queues.'],
  ['kestrel-update', '2026-08-15', 'Ravi still owns it, and it runs on the new worker pool since August.'],
  ['office', '2026-08-21', 'The office plants are watered on Fridays, and the kitchen rota changes on the first Monday of the month.'],
  ['offsite', '2026-09-30', 'The team offsite is in October. Flights are booked and the venue sent the final agenda for the export of travel receipts.'],
];
const BUDGETS = Array.from({ length: 76 }, (_, i) => 128 + i * 8); // 128 .. 728 tokens: from nothing fitting to everything
const WHOLE = ['offsite', 'office', 'kestrel-update', 'worker-pool', 'billing-notes', 'kestrel-export']; // newest first

type Context = { memories: AgentContextMemory[]; truncated: boolean };
type Settings = Record<string, string | undefined>;
const file = (m: { notePath: string }) => path.basename(m.notePath, '.md');

async function workspace() {
  process.env.RENOR_SESSION_EXPAND = '0'; // the cut is what is under test
  // An explicit bar arms the relevance signal too, and its verdict is part of the reply (it costs tokens): off here, so that the
  // two arms of a comparison, with a bar and without, differ in the reservation alone. The reservation reads the bar, not the signal.
  process.env.RENOR_CONTEXT_RELEVANCE = '0';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-keeps-newest-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  for (const [name, date, text] of NOTES) fs.writeFileSync(path.join(memoryDir, `${name}.md`), `---\ndate: ${date}\n---\n# ${name}\n\n${text}\n`);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  // A score carries a recency boost from the clock, whose digits are part of the reply and so of the tokens it costs: with the clock
  // frozen two calls of one workspace score alike, and two arms of one comparison differ only in what the test sets between them.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now());

  const set = (settings: Settings) => {
    for (const [name, value] of Object.entries(settings)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const ask = (maxTokens: number): Promise<Context> => buildAgentContext(db, engine, memoryDir, { query: QUERY, maxTokens }) as Promise<Context>;
  /** What every budget keeps under `settings` (a variable set to undefined is unset): the notes, in the order the reply lists them. */
  const arm = async (settings: Settings): Promise<Map<number, string[]>> => {
    set(settings);
    const kept = new Map<number, string[]>();
    for (const max of BUDGETS) kept.set(max, (await ask(max)).memories.map(file));
    return kept;
  };
  const search = async () => {
    const probe: RetrievalProbe = {};
    const result = await engineSearchMemory(db, engine, memoryDir, QUERY, 8, undefined, undefined, false, undefined, probe);
    return { hits: result.hits as Array<AgentContextMemory & { score: number }>, probe };
  };
  return { ask, arm, set, search };
}

const WITH_BAR: Settings = { RENOR_CONTEXT_RELEVANCE_MIN: BAR };
const NO_BAR: Settings = { RENOR_CONTEXT_RELEVANCE_MIN: undefined };

describe('the newest match above the relevance bar keeps its place in get_context\'s budget', () => {
  it('is built on a fixture that means what it says', async () => {
    const w = await workspace();
    const { hits, probe } = await w.search();
    const cosine = (name: string) => probe.similarities!.find(s => s.notePath.endsWith(`${name}.md`))!.similarity;
    const bar = Number(BAR);
    // The update is relevant and the two newer notes are not; the two strong notes are relevant and older.
    expect(cosine('kestrel-update')).toBeGreaterThanOrEqual(bar);
    expect(cosine('office')).toBeLessThan(bar);
    expect(cosine('offsite')).toBeLessThan(bar);
    expect(cosine('billing-notes')).toBeGreaterThanOrEqual(bar);
    expect(cosine('kestrel-export')).toBeGreaterThanOrEqual(bar);
    // By score the update comes third, behind the two strong notes, so a cut by score alone drops it first among them.
    const byScore = [...hits].sort((a, b) => b.score - a.score).map(file);
    expect(byScore.slice(0, 3)).toEqual(['kestrel-export', 'billing-notes', 'kestrel-update']);
    expect(hits.map(file)).toEqual(WHOLE);
  });

  it('keeps it where a cut by score alone drops it, and still lists what it kept newest first', async () => {
    const w = await workspace();
    const withBar = await w.arm(WITH_BAR);
    const noBar = await w.arm(NO_BAR);
    expect(withBar.get(728)).toEqual(WHOLE);
    let saved = 0;
    for (const max of BUDGETS) {
      const kept = withBar.get(max)!;
      // Two matches fit, so the update (about 100 tokens) fit: it is in.
      if (kept.length >= 2) expect(kept, `${max} tokens`).toContain('kestrel-update');
      // The newest relevant match is the one reserved: the newer notes that are not relevant are never brought in by it.
      if (kept.includes('offsite')) expect(noBar.get(max)!, `${max} tokens`).toContain('offsite');
      expect(kept, `listed newest first at ${max} tokens`).toEqual(WHOLE.filter(name => kept.includes(name)));
      if (kept.includes('kestrel-update') && !noBar.get(max)!.includes('kestrel-update')) saved++;
    }
    // Not vacuous: somewhere the cut by score alone dropped the update and the reservation kept it.
    expect(saved).toBeGreaterThan(0);
  });

  it('keeps the update together with the closest match where a cut by score keeps the closest alone', async () => {
    const w = await workspace();
    const withBar = await w.arm(WITH_BAR);
    const noBar = await w.arm(NO_BAR);
    // Without a bar the long second-best note blocks the run after the closest one; with it the update is in the room that is left.
    const witnesses = BUDGETS.filter(max => noBar.get(max)!.join() === 'kestrel-export' && withBar.get(max)!.join() === 'kestrel-update,kestrel-export');
    expect(witnesses.length).toBeGreaterThan(0);
  });

  it('never spends past the budget', async () => {
    const w = await workspace();
    w.set(WITH_BAR);
    for (const max of BUDGETS) expect(replyTokens(JSON.stringify(await w.ask(max))), `${max} tokens`).toBeLessThanOrEqual(max);
  });

  it('passes over a reserved match that does not fit, and the closest match still fills the room', async () => {
    // A bar between the update (0.426) and the long billing note (0.451): the newest relevant match is now the long one.
    const high = '0.44';
    const w = await workspace();
    const { probe } = await w.search();
    const cosine = (name: string) => probe.similarities!.find(s => s.notePath.endsWith(`${name}.md`))!.similarity;
    expect(cosine('billing-notes')).toBeGreaterThanOrEqual(Number(high));
    expect(cosine('kestrel-update')).toBeLessThan(Number(high));
    const withBar = await w.arm({ RENOR_CONTEXT_RELEVANCE_MIN: high });
    const noBar = await w.arm(NO_BAR);
    // Where the long note does not fit and the closest match does, the reply is that match, as a cut by score makes it: the
    // reserved match being too big does not end the run and leave the reply empty.
    const passedOver = BUDGETS.filter(max => withBar.get(max)!.join() === 'kestrel-export');
    expect(passedOver.length).toBeGreaterThan(0);
    for (const max of passedOver) expect(noBar.get(max), `${max} tokens`).toEqual(['kestrel-export']);
    // Where it does fit it is the one that is kept first.
    expect(BUDGETS.some(max => withBar.get(max)!.includes('billing-notes') && !noBar.get(max)!.includes('billing-notes'))).toBe(true);
  });

  it('is off where the layout is by score: a read about the past asks for the older statement', async () => {
    const w = await workspace();
    const withBar = await w.arm({ ...WITH_BAR, RENOR_NEWEST_FIRST: '0' });
    const noBar = await w.arm({ ...NO_BAR, RENOR_NEWEST_FIRST: '0' });
    for (const max of BUDGETS) expect(withBar.get(max), `${max} tokens`).toEqual(noBar.get(max));
  });

  it('is off where the model has no bar to judge by', async () => {
    // No explicit bar and an uncalibrated model key: the budget is the plain cut by score (budget-cut-by-score.test.ts).
    const w = await workspace();
    const kept = await w.arm(NO_BAR);
    const smallest = BUDGETS.find(max => kept.get(max)!.length === 1)!;
    // Its closest match is too big for that budget, so the next match that fits is kept, and no reserved newest one is.
    expect(kept.get(smallest)).toEqual(['office']);
    expect(kept.get(smallest)).not.toContain('kestrel-update');
  });

  it('is recorded by the search that serves it: every semantic hit with its raw cosine', async () => {
    const w = await workspace();
    const { hits, probe } = await w.search();
    expect(probe.similarities).toHaveLength(hits.length);
    for (const hit of hits) {
      const found = probe.similarities!.find(s => s.text.trim() === hit.text.trim());
      expect(found?.notePath, file(hit)).toBe(hit.notePath);
      expect(Number.isFinite(found?.similarity)).toBe(true);
    }
    // The best of them is the one the relevance signal reports.
    expect(Math.max(...probe.similarities!.map(s => s.similarity))).toBe(probe.topSimilarity);
  });
});

describe('newestMatchAbove', () => {
  const memory = (name: string, date: string | undefined, reason = 'semantic'): AgentContextMemory => ({
    notePath: `${name}.md`, text: `text of ${name}`, reason, ...(date ? { session_date: date } : {}),
  });
  const cosine = (name: string, similarity: number) => ({ notePath: `${name}.md`, text: `text of ${name}`, similarity });

  it('is the newest match whose cosine is at least the bar', () => {
    const memories = [memory('c', '2026-09-15'), memory('b', '2026-09-01'), memory('a', '2026-08-01')];
    const found = [cosine('a', 0.7), cosine('b', 0.5), cosine('c', 0.9)];
    expect(newestMatchAbove(memories, found, 0.6)).toBe(0); // c
    expect(newestMatchAbove(memories, [cosine('a', 0.7), cosine('b', 0.65), cosine('c', 0.5)], 0.6)).toBe(1); // c is below the bar: b
    expect(newestMatchAbove(memories, found, 0.95)).toBe(-1);
  });

  it('counts a cosine equal to the bar, and says nothing for a match with no cosine or no date', () => {
    const memories = [memory('keyword', '2026-09-30', 'fts'), memory('undated', undefined), memory('edge', '2026-09-01')];
    expect(newestMatchAbove(memories, [cosine('undated', 0.9), cosine('edge', 0.6)], 0.6)).toBe(2); // keyword has none, undated has no date
    expect(newestMatchAbove(memories, [cosine('undated', 0.9), cosine('edge', 0.5999)], 0.6)).toBe(-1);
  });

  it('is never what the expansion added, and of equal dates the earlier in the list', () => {
    const memories = [memory('added', '2026-09-30', 'session-expand'), memory('first', '2026-09-01'), memory('second', '2026-09-01')];
    const found = [cosine('added', 0.9), cosine('first', 0.8), cosine('second', 0.9)];
    expect(newestMatchAbove(memories, found, 0.6)).toBe(1);
  });

  describe('with the question', () => {
    const talk = (name: string, date: string, text: string): AgentContextMemory => ({ notePath: `${name}.md`, text, reason: 'semantic', session_date: date });
    const heard = (memory: AgentContextMemory, similarity: number) => ({ notePath: memory.notePath, text: memory.text, similarity });
    const fashion = talk('fashion', '2026-05-14', 'I am looking for fashion advice, neutral shoes and a gift for my mother.');
    const grocery = talk('grocery', '2026-04-30', 'My mom is using the same grocery list method as me, a shared app.');
    const memories = [fashion, grocery];
    const found = [heard(fashion, 0.8), heard(grocery, 0.7)];
    const QUESTION = 'Is my mom using the same grocery list method as me?';

    it('skips a newer match that shares none of the question\'s content words: its meaning is near, its subject is not', () => {
      expect(newestMatchAbove(memories, found, 0.6)).toBe(0); // by the bar alone the fashion chat is the newest
      expect(newestMatchAbove(memories, found, 0.6, QUESTION)).toBe(1); // the grocery chat answers it
    });

    it('counts a match that shares NEWEST_ANCHOR_RELEVANCE_FLOOR words, and nothing is the newest when none does', () => {
      expect(newestMatchAbove(memories, found, 0.6, 'Which gift did I pick?')).toBe(0); // "gift" is in the fashion chat only
      expect(newestMatchAbove(memories, found, 0.6, 'What is the weather in Lisbon?')).toBe(-1);
    });

    it('leaves the bar alone to decide for a question with no word to share: only numbers and single letters', () => {
      expect(newestMatchAbove(memories, found, 0.6, '5 a')).toBe(0);
    });
  });
});
