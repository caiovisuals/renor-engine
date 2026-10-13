import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { buildAgentContext, replyTokens, sessionMatesAbove, applyBudget, sessionStatementsFor, statementRelevance, STATEMENT_RELEVANCE_FLOOR, NEWEST_SESSION_SHARE, NEWEST_SESSION_PIECES, NEWEST_SESSION_STATEMENT_FLOOR, NEWEST_SESSION_WEAK_STATEMENTS, type AgentContextMemory } from '../../src/mvp/agentMemory';

/**
 * The newest match above the relevance bar keeps its room (budget-keeps-newest.test.ts), but a session that said something newer
 * about the question said it in more than one chunk, and the chunk that holds the answer is often not its closest. With the
 * reservation alone, a closer and bigger chunk of an OLDER session took the room and the later statement was cut: on the
 * held-out 400 the newest gold session lost 12 of the 85 questions whose every evidence turn the newest-first prefix kept at 800
 * tokens, and 34 of 115 at 1,200 (docs/evals/results/NEWEST-SESSION-SHARE-20261007.md). So the rest of the reserved match's
 * session, its other matches above the bar, takes up to NEWEST_SESSION_SHARE of the budget before the others are taken by score.
 *
 * The workspace: an old note that is the closest match and the biggest, and an update note of two chunks (its sections), both
 * above the bar, scored below the old note, and a newer note that is not relevant. Eval-hash embeddings, no model. The bar is set
 * explicitly (the eval-hash embeddings have none) and the relevance signal is off, as in budget-keeps-newest.test.ts.
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
const BAR = '0.38';
const KESTREL = 'The Kestrel billing export runs nightly on the Kestrel worker. Ravi owns the Kestrel billing export and its failures. Where does the Kestrel billing export run? It runs on the Kestrel worker.';
const NOTES: Array<[file: string, date: string, text: string]> = [
  ['kestrel-export', '2026-03-02', Array.from({ length: 3 }, () => KESTREL).join(' ')],
  ['kestrel-update', '2026-08-15', '# Update\n\n## Owner\n\nRavi still owns the Kestrel billing export and its failures.\n\n## Runtime\n\nThe Kestrel billing export runs on the new worker pool since August, not on the Kestrel worker.'],
  ['office', '2026-08-21', 'The office plants are watered on Fridays, and the kitchen rota changes on the first Monday of the month.'],
];
const BUDGETS = Array.from({ length: 76 }, (_, i) => 128 + i * 8); // 128 .. 728 tokens: from nothing fitting to everything
const WIDE = Array.from({ length: 110 }, (_, i) => 128 + i * 8); // 128 .. 1,000 tokens
/** The same notes with an update of four chunks (its sections), all above the bar. */
const MANY: typeof NOTES = [
  NOTES[0],
  ['kestrel-update', '2026-08-15', '# Update\n\n## Owner\n\nRavi still owns the Kestrel billing export and its failures.\n\n## Runtime\n\nThe Kestrel billing export runs on the new worker pool since August, not on the Kestrel worker.\n\n## Schedule\n\nThe Kestrel billing export still runs nightly, now on the new worker pool, and Ravi checks its failures each morning.\n\n## Escalation\n\nWhen the Kestrel billing export fails on the new worker pool, Ravi owns the fix and the finance team is told.'],
  NOTES[2],
];

type Context = { memories: AgentContextMemory[]; truncated: boolean };
/** A kept memory as the test names it: its note, and for the update its section. */
const label = (m: AgentContextMemory): string => {
  const section = ['Owner', 'Runtime', 'Schedule', 'Escalation'].find(name => m.headingPath?.includes(name));
  return `${path.basename(m.notePath, '.md')}${section ? `#${section.toLowerCase()}` : ''}`;
};

async function workspace(notes: typeof NOTES = NOTES, armed = false) {
  process.env.RENOR_SESSION_EXPAND = '0';
  if (armed) delete process.env.RENOR_CONTEXT_RELEVANCE;
  else process.env.RENOR_CONTEXT_RELEVANCE = '0';
  process.env.RENOR_CONTEXT_RELEVANCE_MIN = BAR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-keeps-newest-session-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  for (const [name, date, text] of notes) fs.writeFileSync(path.join(memoryDir, `${name}.md`), `---\ndate: ${date}\n---\n# ${name}\n\n${text}\n`);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now());
  const engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  const ask = (maxTokens: number): Promise<Context & { relevance?: { relevant: boolean } }> => buildAgentContext(db, engine, memoryDir, { query: QUERY, maxTokens }) as Promise<Context & { relevance?: { relevant: boolean } }>;
  return { ask };
}

describe('the rest of the newest match\'s session keeps its place in get_context\'s budget', () => {
  it('keeps the newest session\'s second chunk where a closer, bigger chunk of an older note would take the room', async () => {
    const w = await workspace();
    const kept = new Map<number, string[]>();
    for (const max of BUDGETS) kept.set(max, (await w.ask(max)).memories.map(label));
    // Both chunks of the update are kept together, and the older note's closest match is the one that does not fit beside them.
    const witnesses = BUDGETS.filter(max => kept.get(max)!.join() === 'kestrel-update#owner,kestrel-update#runtime');
    expect(witnesses.length).toBeGreaterThan(0);
    // Where everything fits the reply is the whole list, as it always was.
    expect(kept.get(728)).toEqual(expect.arrayContaining(['kestrel-update#owner', 'kestrel-update#runtime', 'kestrel-export']));
    for (const max of BUDGETS) {
      const list = kept.get(max)!;
      // The newest relevant match is in as soon as two matches fit, and its session's other chunk comes right after it.
      if (list.includes('kestrel-update#runtime')) expect(list, `${max} tokens`).toContain('kestrel-update#owner');
      // Listed newest first: the update's chunks are listed with the update's date, before the older note.
      if (list.includes('kestrel-export') && list.includes('kestrel-update#owner')) expect(list.indexOf('kestrel-update#owner'), `${max} tokens`).toBeLessThan(list.indexOf('kestrel-export'));
    }
  });

  it('counts what it keeps once: the next match comes in as soon as its own cost fits beside the ones kept', async () => {
    const w = await workspace();
    const kept = new Map<number, string[]>();
    for (const max of BUDGETS) kept.set(max, (await w.ask(max)).memories.map(label));
    const first = (names: string[]) => BUDGETS.find(max => names.every(name => kept.get(max)!.includes(name)));
    const three = first(['kestrel-update#owner', 'kestrel-update#runtime', 'kestrel-export']);
    const four = first(['office', 'kestrel-update#owner', 'kestrel-update#runtime', 'kestrel-export']);
    expect(three).toBeDefined();
    expect(four).toBeDefined();
    // The office note comes after the update's chunks in the order of the scores, and what it costs is what it adds: a chunk the
    // reservation kept and the cut by score then counted a second time would put it that much further up.
    const office = (await w.ask(728)).memories.find(m => label(m) === 'office')!;
    const step = BUDGETS[1] - BUDGETS[0];
    expect(four! - three!).toBeLessThanOrEqual(replyTokens(JSON.stringify(office)) + 1 + step);
  });

  it('takes its share of the room for the rest of the newest session, however many chunks it has', async () => {
    const w = await workspace(MANY);
    const kept = new Map<number, string[]>();
    for (const max of WIDE) kept.set(max, (await w.ask(max)).memories.map(label));
    const others = (list: string[]) => list.filter(name => name.startsWith('kestrel-update#') && name !== 'kestrel-update#owner');
    // The share is a part of the room: the older note, the closest match and the biggest, is in wherever the room the share
    // leaves holds it. (The room is the budget less the reply's own fixed part; the step of the budgets is the slack.)
    const whole = (await w.ask(4000)) as Context & Record<string, unknown>;
    const older = whole.memories.find(m => label(m) === 'kestrel-export')!;
    const fixed = replyTokens(JSON.stringify({ ...whole, memories: [] }));
    const step = WIDE[1] - WIDE[0];
    const roomed = WIDE.filter(max => (max - fixed) * (1 - NEWEST_SESSION_SHARE) >= replyTokens(JSON.stringify(older)) + 1 + 2 * step);
    expect(roomed.length).toBeGreaterThan(0);
    for (const max of roomed) expect(kept.get(max)!, `${max} tokens`).toContain('kestrel-export');
    // ... and the share is real: somewhere the owner and several other chunks of the update are kept where the older note is not.
    expect(WIDE.some(max => { const list = kept.get(max)!; return list.includes('kestrel-update#owner') && !list.includes('kestrel-export') && others(list).length >= 2; })).toBe(true);
    // ... but no more than NEWEST_SESSION_PIECES of them come with the reservation: the update has four chunks and the older note is in beside all four.
    expect(NEWEST_SESSION_PIECES).toBeGreaterThanOrEqual(2);
  });

  it('allows one single-word statement in the reservation, never none (the deciding turn can share one word) and never a crowd', () => {
    expect(NEWEST_SESSION_STATEMENT_FLOOR).toBe(1);
    expect(NEWEST_SESSION_WEAK_STATEMENTS).toBeGreaterThanOrEqual(1);
    expect(NEWEST_SESSION_WEAK_STATEMENTS).toBeLessThan(NEWEST_SESSION_PIECES);
  });

  it('lets the verdict match come first only when it says more about the question than the newest match, and the verdict stands either way', async () => {
    // The relevance signal is armed, so the closest match (the old note, the biggest) is the verdict's match. It holds all of
    // the question's words and the update's chunk fewer: where the budget holds the old note alone it takes the room first, as
    // it always did; where it holds the update's chunk alone the reservation has it, the old note is not in, and the verdict
    // still stands because the reply holds a match above the same bar.
    const w = await workspace(NOTES, true);
    const lists = new Map<number, { list: string[]; relevant: boolean | undefined }>();
    for (const max of BUDGETS) {
      const reply = await w.ask(max);
      lists.set(max, { list: reply.memories.map(label), relevant: reply.relevance?.relevant });
    }
    const only = (name: string) => BUDGETS.filter(max => lists.get(max)!.list.join() === name);
    const oldAlone = only('kestrel-export');
    const updateAlone = only('kestrel-update#owner');
    expect(oldAlone.length).toBeGreaterThan(0);
    expect(updateAlone.length).toBeGreaterThan(0);
    for (const max of [...oldAlone, ...updateAlone]) expect(lists.get(max)!.relevant, `${max} tokens`).toBe(true);
    // The update's chunk fits first (it is smaller), and the old note's budget comes after it.
    expect(Math.min(...updateAlone)).toBeLessThan(Math.min(...oldAlone));
  });

  it('never spends past the budget, and brings in nothing when the budget is the whole list', async () => {
    const w = await workspace();
    for (const max of BUDGETS) expect(replyTokens(JSON.stringify(await w.ask(max))), `${max} tokens`).toBeLessThanOrEqual(max);
    const whole = await w.ask(4000);
    expect(whole.truncated).toBe(false);
    expect(whole.memories.map(label)).toEqual(expect.arrayContaining(['office', 'kestrel-update#owner', 'kestrel-update#runtime', 'kestrel-export']));
  });

  it('takes at most the share of the budget the constant names, so it is a part of the room and never all of it', () => {
    // The first value, a quarter, held one big chunk of the session at 800 tokens and none of its statements beside it; the
    // practice questions were best served at 0.6 (docs/evals/results/NEWEST-FACT-POOL-20261011.md), and the older evidence
    // keeps the rest of the room whatever the share.
    expect(NEWEST_SESSION_SHARE).toBeGreaterThan(0);
    expect(NEWEST_SESSION_SHARE).toBeLessThan(1);
  });
});

describe('sessionMatesAbove', () => {
  const memory = (name: string, date: string | undefined, notePath = `${name}.md`, reason = 'semantic'): AgentContextMemory => ({
    notePath, text: `text of ${name}`, reason, ...(date ? { session_date: date } : {}),
  });
  const cosine = (name: string, similarity: number, notePath = `${name}.md`) => ({ notePath, text: `text of ${name}`, similarity });

  it('lists the other matches of the session above the bar, in the order of the list', () => {
    const memories = [
      memory('c1', '2026-09-15', 'c.md'), memory('b', '2026-09-10'), memory('c2', '2026-09-15', 'c.md'), memory('c3', '2026-09-15', 'c.md'), memory('c4', '2026-09-15', 'c.md', 'session-expand'),
    ];
    const found = [cosine('c1', 0.9, 'c.md'), cosine('b', 0.9), cosine('c2', 0.8, 'c.md'), cosine('c3', 0.5, 'c.md'), cosine('c4', 0.9, 'c.md')];
    expect(sessionMatesAbove(memories, found, 0.6, 0)).toEqual([2]); // c3 is below the bar, c4 is a statement the expansion added, b is another session
    expect(sessionMatesAbove(memories, found, 0.6, -1)).toEqual([]);
    expect(sessionMatesAbove(memories, found, 0.95, 0)).toEqual([]);
  });

  it('tells sessions of one note apart by their date: the events of a ledger are one session each', () => {
    const memories = [memory('e3', '2026-09-03T10:00:00.000Z', 'ledger.md'), memory('e2', '2026-09-02T10:00:00.000Z', 'ledger.md'), memory('e1b', '2026-09-03T10:00:00.000Z', 'ledger.md')];
    const found = [cosine('e3', 0.9, 'ledger.md'), cosine('e2', 0.9, 'ledger.md'), cosine('e1b', 0.9, 'ledger.md')];
    expect(sessionMatesAbove(memories, found, 0.6, 0)).toEqual([2]); // the same event, split in two chunks; e2 is another event of the same note
  });
});

/**
 * The reservation was the session's MATCHES: the newest match above the bar and its other matches above the bar. The
 * statement that decides the answer is not one of them on a real workspace: it is a turn that shares few words with the
 * question, so the semantic window never scored it high, and what the session expansion added is a statement, which is
 * not scored at all. It used to take only the room the facts and the matches left, in document order, after the header
 * and the turns before it, and the loop stopped at the first that did not fit: the deciding turn was cut while the room
 * went to a closer chunk of an older session. So the rest of the reserved session is its statements too, taken with its
 * reservation in the room the quarter allows, most relevant to the question first.
 *
 * The workspace: an old note that is the closest match, and an update note of sections whose answer section the window
 * drops (the cap and the score leave it out), so only the expansion can bring it. Two of the update's sections are above
 * the bar and the newest of them is the reserved match. Eval-hash embeddings, no model; the bar is set explicitly.
 */

const STATEMENT_QUERY = 'Where does the Kestrel billing export run now?';
const STATEMENT_BAR = '0.5';
const KESTREL_TEXT = 'The Kestrel billing export runs nightly on the Kestrel worker. Ravi owns the Kestrel billing export and its failures. Where does the Kestrel billing export run? It runs on the Kestrel worker.';
const SECTIONS: Array<[heading: string, text: string]> = [
  ['Status', 'The Kestrel billing export is healthy. Ravi owns the Kestrel billing export and its failures, and answers for the Kestrel billing export run each morning.'],
  ['Errata', 'The Kestrel billing export FAQ has typos. Ravi owns the Kestrel billing export corrections and reviews the Kestrel billing export run log.'],
  ['Owner', 'Ravi still owns the Kestrel billing export and its failures.'],
  ['Schedule', 'The Kestrel billing export runs nightly, and the Kestrel billing export run is checked by Ravi.'],
  ['Incidents', 'When the Kestrel billing export fails, Ravi is paged and opens an incident for the run.'],
  ['Playlist', 'The cardio playlist is the Beast Mode mix, refreshed weekly.'],
  ['Weather', 'The office plants are watered on Fridays and the kitchen rota changes monthly.'],
  ['Pets', 'Luna the cat eats twice a day and sleeps on the warm laptop bag.'],
  // The answer: the window drops it (its score is below the eight the read takes), so it is a statement or nothing.
  ['Runtime', 'It moved to the new worker pool in August, so it no longer runs on the Kestrel worker.'],
];
const STATEMENT_NOTES: Array<[file: string, date: string, text: string]> = [
  ['kestrel-export', '2026-03-02', Array.from({ length: 5 }, () => KESTREL_TEXT).join(' ')],
  ['kestrel-update', '2026-08-15', `# Update\n\nQuarterly export notes.\n\n${SECTIONS.map(([h, t]) => `## ${h}\n\n${t}`).join('\n\n')}\n`],
  ['office', '2026-08-21', 'The office plants are watered on Fridays, and the kitchen rota changes on the first Monday of the month.'],
];
const STATEMENT_BUDGETS = [200, 256, 320, 384, 448, 512, 640, 768, 896, 1024, 1500, 4000];
const statementLabel = (m: AgentContextMemory): string => {
  const section = SECTIONS.map(([h]) => h).find(name => m.headingPath?.includes(name));
  return `${path.basename(m.notePath, '.md')}${section ? `#${section.toLowerCase()}` : ''}`;
};

async function statementWorkspace() {
  process.env.RENOR_SESSION_EXPAND = '5';
  process.env.RENOR_CONTEXT_RELEVANCE = '0';
  process.env.RENOR_CONTEXT_RELEVANCE_MIN = STATEMENT_BAR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-keeps-newest-statement-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  for (const [name, date, text] of STATEMENT_NOTES) fs.writeFileSync(path.join(memoryDir, `${name}.md`), `---\ndate: ${date}\n---\n# ${name}\n\n${text}\n`);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  const ask = (maxTokens: number): Promise<{ memories: AgentContextMemory[]; truncated: boolean }> =>
    buildAgentContext(db, engine, memoryDir, { query: STATEMENT_QUERY, maxTokens }) as Promise<{ memories: AgentContextMemory[]; truncated: boolean }>;
  return { ask };
}

describe('the newest session\'s statements keep their place with its reservation in get_context\'s budget', () => {
  it('keeps the section that says where the export runs, where the leftover room spent it on the turns before it', async () => {
    const w = await statementWorkspace();
    const kept = new Map<number, string[]>();
    for (const max of STATEMENT_BUDGETS) kept.set(max, (await w.ask(max)).memories.map(statementLabel));
    // The answer section is out of the semantic window, so the reservation is the only thing that can take it before the
    // matches are taken by score. Without it the reply held the header and the two turns before it instead (384 tokens),
    // and at 768 a closer chunk of the same session took its room. The reservation takes its pieces by the question's words
    // they hold squared per token, so at 384 tokens it holds the two statements that share four of the question's five
    // words (the answer section shares two), and the answer section is in from 512, with the statement that names the
    // owner; before it was in at 384 and the owner statement was too (docs/evals/results/NEWEST-FACT-POOL-20261011.md).
    expect(kept.get(384), 'the statements that share most of the question\'s words come first').toEqual(
      expect.arrayContaining(['kestrel-update#errata', 'kestrel-update#schedule']),
    );
    expect(kept.get(512), 'the answer section is in, not the turn the document order put before it').toEqual(
      expect.arrayContaining(['kestrel-update#runtime']),
    );
    expect(kept.get(768), 'the answer section displaces the incident chunk that scored above it').toEqual(
      expect.arrayContaining(['kestrel-update#runtime']),
    );
    expect(kept.get(768)).not.toContain('kestrel-update#incidents');
    for (const max of STATEMENT_BUDGETS) {
      const list = kept.get(max)!;
      // The reserved match is in whenever one of its session's statements is: the statements follow it.
      if (list.includes('kestrel-update#runtime')) expect(list, `${max} tokens`).toContain('kestrel-update#errata');
      // Every reply is inside its budget, whatever it holds.
      expect(replyTokens(JSON.stringify(await w.ask(max))), `${max} tokens`).toBeLessThanOrEqual(max);
    }
    // Where everything fits the reply is the whole list, as it always was.
    const whole = await w.ask(4000);
    expect(whole.truncated).toBe(false);
    expect(whole.memories.map(statementLabel)).toEqual(expect.arrayContaining(['kestrel-update#runtime', 'kestrel-export', 'office']));
  });

  it('spends the quarter on the reservation and the score run on the rest: neither list is cut by the other', async () => {
    const w = await statementWorkspace();
    const kept = new Map<number, string[]>();
    for (const max of STATEMENT_BUDGETS) kept.set(max, (await w.ask(max)).memories.map(statementLabel));
    // The quarter is real and it is a part of the room: somewhere the older note, the closest match, is still in beside
    // the reservation's answer section, and somewhere the answer section is in while the older note is not.
    expect(STATEMENT_BUDGETS.some(max => {
      const list = kept.get(max)!;
      return list.includes('kestrel-update#runtime') && list.includes('kestrel-export');
    })).toBe(true);
    expect(STATEMENT_BUDGETS.some(max => {
      const list = kept.get(max)!;
      return list.includes('kestrel-update#runtime') && !list.includes('kestrel-export');
    })).toBe(true);
  });
});

describe('the reservation takes at most NEWEST_SESSION_WEAK_STATEMENTS statements that share a single word of the question', () => {
  // Synthetic items, so that every cost and relevance is set: the newest match (150 tokens), an older match (250), one statement
  // that shares three words (40) and three that share one (40 each). 500 tokens hold the reservation of the match, the deciding
  // statement and one single-word statement, and then the older match; a second single-word statement in the reservation would
  // leave the older match no room.
  const memory = (text: string, reason: string, session_date: string): AgentContextMemory => ({ notePath: `${text}.md`, text, reason, session_date, ...(reason === 'session-expand' ? { matched: false } : { score: 0.5 }) });
  const costs: Record<string, number> = { newest: 150, older: 250, decisive: 40, weak1: 40, weak2: 40, weak3: 40 };
  const said: Record<string, number> = { newest: 6, older: 0, decisive: 3, weak1: 1, weak2: 1, weak3: 1 };
  const newest = memory('newest', 'semantic', '2026-08-15');
  const older = memory('older', 'semantic', '2026-03-02');
  const statements = ['decisive', 'weak1', 'weak2', 'weak3'].map(text => memory(text, SESSION_EXPAND_REASON, '2026-08-15'));
  const reply = () => applyBudget([], [], [newest, older, ...statements], [[], [], [], [], [], []], 500, item => costs[(item as AgentContextMemory).text], {
    recent: newest,
    sessionStatements: statements,
    relevance: item => said[(item as AgentContextMemory).text] ?? 0,
  });

  it('keeps one single-word statement in the reservation and leaves the room of the older match to it', () => {
    expect(SESSION_EXPAND_REASON).toBe('session-expand');
    const kept = reply().memories.map(m => m.text);
    expect(kept).toEqual(expect.arrayContaining(['newest', 'decisive', 'weak1', 'older']));
    expect(kept.filter(text => text.startsWith('weak'))).toEqual(['weak1']);
    expect(reply().tokens).toBeLessThanOrEqual(500);
  });
});

describe('the newest session keeps its room while a top match too big for the whole budget is passed over (PR #554 with this reservation)', () => {
  // Synthetic items, so that every cost and score is set, at 500 tokens: an old top-scored match of 900 tokens that can never fit,
  // the newest match (150), the deciding statement of its session (40), and two older matches (120 and 180). The oversize top
  // match is passed over and the matches that fit are taken in score order; the reservation of the newest session is taken
  // first, so the older matches share what it leaves, and a match that does not fit still ends the run once nothing is passed over.
  const memory = (text: string, reason: string, session_date: string, score?: number): AgentContextMemory => ({ notePath: `${text}.md`, text, reason, session_date, ...(score === undefined ? { matched: false } : { score }) });
  const costs: Record<string, number> = { huge: 900, newest: 150, decisive: 40, midA: 120, midB: 180, newestBig: 700 };
  const said: Record<string, number> = { huge: 0, newest: 6, decisive: 3, midA: 0, midB: 0, newestBig: 6 };
  const huge = memory('huge', 'semantic', '2026-03-02', 0.9);
  const newest = memory('newest', 'semantic', '2026-08-15', 0.5);
  const decisive = memory('decisive', SESSION_EXPAND_REASON, '2026-08-15');
  const midA = memory('midA', 'semantic', '2026-05-01', 0.6);
  const midB = memory('midB', 'semantic', '2026-04-01', 0.55);
  const place = (list: AgentContextMemory[], recent: AgentContextMemory | undefined, statements: AgentContextMemory[], allowance = 500) =>
    applyBudget([], [], list, list.map(() => []), allowance, item => costs[(item as AgentContextMemory).text], {
      recent,
      sessionStatements: statements,
      relevance: item => said[(item as AgentContextMemory).text] ?? 0,
    });

  it('keeps the newest match and its deciding statement, passes the oversize top match over and fills with the matches that fit', () => {
    const reply = place([newest, huge, midA, midB, decisive], newest, [decisive]);
    const kept = reply.memories.map(m => m.text);
    expect(kept).not.toContain('huge');
    expect(kept).toEqual(expect.arrayContaining(['newest', 'decisive', 'midA', 'midB']));
    expect(reply.tokens).toBeLessThanOrEqual(500);
    expect(reply.truncated).toBe(true);
    // The fill is in score order, so a smaller allowance drops the lower-scored match and keeps the better one.
    const tight = place([newest, huge, midA, midB, decisive], newest, [decisive], 330).memories.map(m => m.text);
    expect(tight).toEqual(expect.arrayContaining(['newest', 'decisive', 'midA']));
    expect(tight).not.toContain('midB');
    expect(tight).not.toContain('huge');
  });

  it('keeps the deciding statement of the newest session when its own match is too big as well', () => {
    const big = memory('newestBig', 'semantic', '2026-08-15', 0.5);
    const reply = place([big, huge, midA, midB, decisive], big, [decisive]);
    const kept = reply.memories.map(m => m.text);
    expect(kept).not.toContain('huge');
    expect(kept).not.toContain('newestBig');
    expect(kept).toEqual(expect.arrayContaining(['decisive', 'midA', 'midB']));
    expect(reply.tokens).toBeLessThanOrEqual(500);
  });

  it('still ends the run at a top match that fits the budget (nothing is passed over)', () => {
    // The top match (midA, 120) fits; the next best (midB, 180) does not fit what the reservation left, so the smaller ones behind it are not taken in its place.
    const fillA = memory('fillA', 'semantic', '2026-02-01', 0.3);
    costs.fillA = 15;
    const reply = place([newest, midA, midB, fillA, decisive], newest, [decisive], 330);
    const kept = reply.memories.map(m => m.text);
    expect(kept).toEqual(expect.arrayContaining(['newest', 'decisive', 'midA']));
    expect(kept).not.toContain('midB');
    expect(kept).not.toContain('fillA');
    delete costs.fillA;
  });
});

describe('sessionStatementsFor', () => {
  const memory = (notePath: string, date: string | undefined, reason: string, text: string): AgentContextMemory => ({
    notePath, text, reason, ...(date ? { session_date: date } : {}),
  });
  const memories = [
    memory('c.md', '2026-09-15', 'semantic', 'closest match of the session'),
    memory('c.md', '2026-09-15', 'session-expand', 'the playlist is the Beast Mode mix, refreshed weekly'),
    memory('c.md', '2026-09-15', 'session-expand', 'Ravi owns the Kestrel billing export and its failures'),
    memory('c.md', '2026-09-15', 'session-expand', 'the export run moved to the new worker pool'),
    memory('c.md', '2026-09-15', 'session-expand', 'the export moved to the new worker pool'),
    memory('b.md', '2026-09-10', 'session-expand', 'Ravi owns the Kestrel billing export and its failures'),
    memory('c.md', '2026-09-20', 'session-expand', 'Ravi owns the Kestrel billing export and its failures'),
  ];
  const found = sessionStatementsFor(memories, 0, 'Who owns the Kestrel billing export and where does it run?');

  it('lists the statements of the same session most relevant to the question first', () => {
    // "Ravi owns the Kestrel billing export" holds four of the question's words, "the export run moved" two, and
    // "the export moved" one, which is below the floor and stays with the expansion's own room.
    expect(found).toEqual([2, 3]);
    expect(statementRelevance(memories[2].text, 'Who owns the Kestrel billing export and where does it run?')).toBe(4);
    expect(statementRelevance(memories[3].text, 'Who owns the Kestrel billing export and where does it run?')).toBe(2);
    expect(statementRelevance(memories[4].text, 'Who owns the Kestrel billing export and where does it run?')).toBe(1);
  });

  it('takes the statements that share one word when the caller ranks by relevance per token, and never one that shares none', () => {
    // The reservation ranks its pieces by the words they share squared per token, so one shared word is a candidate that
    // takes room only when nothing better fits; a statement with none is unmatched text and is never one.
    const question = 'Who owns the Kestrel billing export and where does it run?';
    expect(NEWEST_SESSION_STATEMENT_FLOOR).toBe(1);
    expect(sessionStatementsFor(memories, 0, question, NEWEST_SESSION_STATEMENT_FLOOR)).toEqual([2, 3, 4]); // the one-word statement follows the others
    expect(sessionStatementsFor(memories, 0, question, NEWEST_SESSION_STATEMENT_FLOOR)).not.toContain(1); // the playlist shares none
    expect(sessionStatementsFor(memories, 0, question)).toEqual([2, 3]); // the default floor is unchanged
  });

  it('is no statement of another session, and nothing for no session or no question', () => {
    expect(found).not.toContain(5); // another note
    expect(found).not.toContain(6); // the same note on another date is another session
    expect(sessionStatementsFor(memories, -1, 'Who owns the Kestrel billing export and where does it run?')).toEqual([]);
    expect(sessionStatementsFor(memories, 0, '  ')).toEqual([]);
  });
});

describe('statementRelevance', () => {
  it('counts the question\'s content words the text holds, as stems', () => {
    // weight, lost, since, started, going, gym, consistently: the turn holds lost, since, started, going, gym, consistently.
    expect(statementRelevance('That is a lot of options. I just realized I have lost 10 pounds since I started going consistently to the gym.', 'How much weight have I lost since I started going to the gym consistently?')).toBe(6);
  });

  it('does not count a word of one letter or one made of digits alone', () => {
    // "I" is in every statement of a chat, and a number is not what a later question about the same thing shares.
    expect(statementRelevance('I run 5 km every morning before work', 'I run every morning')).toBe(2);
    expect(statementRelevance('I run 5 km every morning before work', 'I 5')).toBe(0);
  });

  it('says nothing for a question whose words are all stop words', () => {
    expect(statementRelevance('the export runs on the new worker pool', 'who where when')).toBe(0);
  });

  it('is floored at two words: one shared word is a coincidence, not an answer', () => {
    expect(STATEMENT_RELEVANCE_FLOOR).toBe(2);
    expect(STATEMENT_RELEVANCE_FLOOR).toBeGreaterThan(1);
    expect(NEWEST_SESSION_SHARE).toBeGreaterThan(0);
  });
});
