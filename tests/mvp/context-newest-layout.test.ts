import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { buildAgentContext, replyTokens, type AgentContextMemory } from '../../src/mvp/agentMemory';
import { engineSearchMemory, engineSearchText, type Engine } from '../../src/mvp/engine';

vi.mock('../../src/mvp/engine', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/mvp/engine')>(),
  engineSearchMemory: vi.fn(),
  engineSearchText: vi.fn(),
}));

const memories: AgentContextMemory[] = [
  { notePath: 'new.md', text: 'Training update.', reason: 'semantic', score: 0.5, session_date: '2026-09-02' },
  { notePath: 'old.md', text: 'My goal was to lose 20 pounds.', reason: 'semantic+fts', score: 0.9, session_date: '2026-08-02' },
  { notePath: 'new.md', headingPath: 'Goal', text: 'My goal is now to lose 10 pounds.', reason: 'session-expand', score: 0, session_date: '2026-09-02' },
];
const keywords: AgentContextMemory[] = [
  { notePath: 'words.md', text: 'Training glossary.', reason: 'fts', score: 1, session_date: '2026-10-02' },
  { notePath: 'name.md', text: 'Training index.', reason: 'note-identity', score: 1, session_date: '2026-10-03' },
];
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
beforeEach(() => { vi.mocked(engineSearchText).mockReturnValue({ ok: true, results: keywords } as any); });

async function ask(rankedBy?: 'session_date' | 'score', honesty = false, hits = memories) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-newest-layout-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => db.close());
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const engine: Engine = { provider, vectorIndex: null, dims: provider.dimensions, modelKey: 'test:hash:256' };
  vi.mocked(engineSearchMemory).mockResolvedValue({ ok: true, hits, ...(rankedBy ? { rankedBy } : {}) } as any);
  return buildAgentContext(db, engine, root, {
    query: 'What is my training goal?', maxTokens: 4000,
    env: { RENOR_CONTEXT_RELEVANCE: '0', RENOR_READ_HONESTY: honesty ? '1' : '0' },
  });
}

const list = (body: Record<string, unknown>) => body.memories as AgentContextMemory[];
const text = (body: Record<string, unknown>) => list(body).map(m => m.text);
const original = [memories[0], memories[1], ...keywords, memories[2]].map(m => m.text);

describe('get_context renders the selected newest session before older values', () => {
  it('puts the updated expanded statement before an older contradicting match', async () => {
    const body = await ask('session_date');
    expect(text(body)).toEqual([memories[0].text, memories[2].text, memories[1].text, ...keywords.map(m => m.text)]);
    expect(body.rankedBy).toBe('session_date');
  });

  it.each(['score', undefined] as const)('preserves the existing layout when rankedBy is %s', async rankedBy => {
    expect(text(await ask(rankedBy))).toEqual(original);
  });

  it('keeps summary tables first and keyword matches last in their original order', async () => {
    const summaries = ['evidence', 'digest'].map(reason => ({
      notePath: `${reason}.md`, text: `${reason} summary table`, reason, score: 0, session_date: '2020-01-01',
    }));
    const body = await ask('session_date', false, [...summaries, ...memories]);
    expect(text(body).slice(0, 2)).toEqual(summaries.map(m => m.text));
    expect(text(body).slice(-2)).toEqual(keywords.map(m => m.text));
    expect(text(body).indexOf(memories[2].text)).toBeLessThan(text(body).indexOf(memories[1].text));
  });

  it('orders the expansion after the read-honesty lane attaches provenance', async () => {
    const body = await ask('session_date', true);
    expect(text(body).indexOf(memories[2].text)).toBeLessThan(text(body).indexOf(memories[1].text));
    expect(list(body).every(m => 'provenance' in m)).toBe(true);
    expect(replyTokens(JSON.stringify(body))).toBeLessThanOrEqual(4000);
  });

  it.each([false, true])('changes only the permutation, with identical tokens (honesty=%s)', async honesty => {
    const before = { ...await ask('score', honesty), rankedBy: 'session_date' };
    const after = await ask('session_date', honesty);
    const canonical = (body: Record<string, unknown>) => ({ ...body, memories: list(body).map(m => JSON.stringify(m)).sort() });
    expect(canonical(after)).toEqual(canonical(before));
    expect(replyTokens(JSON.stringify(after))).toBe(replyTokens(JSON.stringify(before)));
  });
});
