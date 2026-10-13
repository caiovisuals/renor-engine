import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { DEFAULT_LEDGER_REL, appendLedgerEvent, replayLedger } from '../../src/memory/lifecycle';
import { buildAgentContext, replyTokens } from '../../src/mvp/agentMemory';
import { warmFactVectors } from '../../src/mvp/contextRelevance';
import type { Engine } from '../../src/mvp/engine';
import { seedWorkspace } from '../../scripts/eval/relevance-calibration';

/**
 * get_context's whole-reply budget (live dogfood D9: max_tokens counts every field, in the engine's own tokens) meeting
 * the relevance verdict (#333: `relevant: true` reports a match the reply holds, and the closest fact is listed in the
 * room the rest leaves). Three things exist only where the two meet, and neither one's own tests could see them:
 *
 *   - the verdict is a field of the reply, so it counts in max_tokens, and it stands only when the reply holds its match;
 *   - a fact the reply lists says its ledger event once, whether the words found it or the verdict added it;
 *   - a match that is the event of a listed fact is held by that fact, not lost with the memory that said it.
 *
 * The deterministic eval-hash embeddings, no model, no network.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** The eval-hash embeddings, taught one paraphrase: "based" means a home city (the same stub as facts-lane-relevance). */
class ParaphraseProvider extends EvalHashEmbeddingProvider {
  async embedQuery(text: string): Promise<number[]> {
    return super.embedQuery(text.replace(/\bbased\b/gi, 'home city'));
  }
}

type Fact = { subject: string; predicate: string; object: string };
type Context = { facts: Fact[]; memories: Array<{ text: string }>; truncated: boolean; relevance?: { relevant: boolean } };

const factLine = (fact: Fact) => `${fact.subject} · ${fact.predicate} · ${fact.object}`;
const armed = (bar: string) => ({ RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: bar });
const OFF = { RENOR_CONTEXT_RELEVANCE: '0' };

interface Seed {
  /** `statement`: the user's own words, which the ledger keeps with the event (what `remember` writes). */
  facts: Array<Fact & { scope?: string; statement?: string }>;
  notes: Array<{ slug: string; date: string; text: string }>;
}

/** A workspace read through get_context itself; `matched` has the similarities behind the last verdict. */
async function workspace(seed: Seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-tokens-relevance-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir);
  const db = openDb(path.join(root, 'index.db'));
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const provider = new ParaphraseProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await seedWorkspace(db, memoryDir, { facts: [], notes: seed.notes });
  for (const [i, fact] of seed.facts.entries()) {
    await appendLedgerEvent(memoryDir, DEFAULT_LEDGER_REL, {
      id: `MEM_RT${String(i + 1).padStart(5, '0')}`,
      at: new Date(Date.parse('2026-09-01T09:00:00.000Z') + i * 1000).toISOString(),
      kind: 'store', closedEvent: null, source: 'claude', scope: 'global', ...fact,
    });
  }
  await replayLedger(db, memoryDir, DEFAULT_LEDGER_REL);
  // Each note on its own day, as a returning user's are, so newest first goes by day.
  const daily = path.join(memoryDir, 'Memory/Daily');
  for (const file of fs.existsSync(daily) ? fs.readdirSync(daily) : []) {
    const day = new Date(`${file.slice(0, 10)}T09:00:00Z`);
    fs.utimesSync(path.join(daily, file), day, day);
  }
  await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 2);
  const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey: 'test:hash:256' };
  await warmFactVectors(db, provider);
  const matched = { chunk: null as number | null, fact: null as number | null };
  const ask = (query: string, env: Record<string, string>, maxTokens?: number) =>
    buildAgentContext(db, engine, memoryDir, {
      query, env: env as NodeJS.ProcessEnv, relevanceComponents: matched, ...(maxTokens ? { maxTokens } : {}),
    }) as Promise<Context>;
  return { ask, matched };
}

describe('get_context: the whole-reply budget with the relevance verdict armed', () => {
  it('bounds the reply with the verdict in it, and the verdict stands exactly when the reply holds its match', async () => {
    // The scout's Fly.io case: newer worklogs that say "Atlas" come first (newest first), and the decision record is the
    // match. At every budget the reply, measured whole, is within max_tokens; `relevant: true` is about a record the
    // reply holds, and a budget too tight for the record gets no verdict rather than one about something it lacks.
    const worklog = (date: string) => `${date} Atlas worklog: reviewed the deploy dashboards, paired on the billing export, `
      + 'rotated the staging credentials, closed three tickets about webhook retries, updated the runbook for the nightly job, '
      + 'answered support questions about invoices, wrote notes for the planning meeting about capacity and the release train, '
      + 'chased the flaky integration suite, bumped two dependencies and drafted the incident summary for the queue backlog.';
    const w = await workspace({
      facts: [{ subject: 'Atlas', predicate: 'deploy_target', object: 'AWS ECS Fargate', scope: 'project:atlas' }],
      notes: [
        { slug: 'decision', date: '2026-09-24', text: 'Decision record: we considered moving Atlas to Fly.io to cut hosting cost (Heroku about $410/month vs Fly about $150/month).' },
        ...['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'].map(date => ({ slug: date, date, text: worklog(date) })),
      ],
    });
    let stood = 0;
    let withheld = 0;
    for (let maxTokens = 128; maxTokens <= 704; maxTokens += 8) {
      const body = await w.ask('Why did we consider moving Atlas to Fly.io?', armed('0.45'), maxTokens);
      expect(replyTokens(JSON.stringify(body)), `max_tokens ${maxTokens}`).toBeLessThanOrEqual(maxTokens);
      const holdsRecord = body.memories.some(memory => memory.text.includes('$410/month'));
      expect(body.relevance?.relevant === true, `max_tokens ${maxTokens}`).toBe(holdsRecord);
      if (holdsRecord) stood++;
      else withheld++;
    }
    expect(stood).toBeGreaterThan(0);
    expect(withheld).toBeGreaterThan(0);
  });

  it('lists the closest fact once: the memory that is its ledger event is not listed again', async () => {
    const w = await workspace({
      facts: [
        { subject: 'user', predicate: 'home_city', object: 'Lisbon' },
        { subject: 'user', predicate: 'dog_name', object: 'Biscuit' },
        { subject: 'Atlas', predicate: 'cloud_region', object: 'eu-west-1', scope: 'project:atlas' },
      ],
      notes: [],
    });
    // The words find the dog; the home city is the closest fact, which the verdict adds after it.
    const query = 'Where am I based, and what is the dog called?';
    const on = await w.ask(query, armed('0.3'));
    expect(on.facts.map(factLine)).toEqual(['user · dog_name · Biscuit', 'user · home_city · Lisbon']);
    // Without the signal the home city is a memory only (the event that recorded it). Listed as a fact, it is not again.
    const off = await w.ask(query, OFF);
    expect(off.memories.map(memory => memory.text)).toContainEqual(expect.stringContaining('home_city: Lisbon'));
    expect(on.memories.map(memory => memory.text)).not.toContainEqual(expect.stringContaining('home_city: Lisbon'));
  });

  it('keeps the verdict when its match is the event of a fact the reply lists, though that memory is not listed', async () => {
    // What `remember` writes: the user's words, with the fact. For "What is my dog called?" the closest thing on file is
    // that statement (a note chunk of the ledger), not the fact's own rendering; the fact is listed, so the memory is
    // left out as a repeat, and the fact is the reply's copy of the match.
    const w = await workspace({
      facts: [
        { subject: 'user', predicate: 'dog_name', object: 'Biscuit', statement: 'My dog is called Biscuit.' },
        { subject: 'user', predicate: 'home_city', object: 'Lisbon', statement: 'I live in Lisbon, where I am based.' },
        { subject: 'Atlas', predicate: 'cloud_region', object: 'eu-west-1', statement: 'Atlas runs in eu-west-1.' },
      ],
      notes: [],
    });
    for (const maxTokens of [800, 200]) {
      const body = await w.ask('What is my dog called?', armed('0.3'), maxTokens);
      expect(w.matched.chunk!, `max_tokens ${maxTokens}`).toBeGreaterThan(w.matched.fact!); // the match is the user's statement
      expect(body.relevance?.relevant, `max_tokens ${maxTokens}`).toBe(true);
      expect(body.facts.map(factLine), `max_tokens ${maxTokens}`).toEqual(['user · dog_name · Biscuit']);
      expect(body.memories.map(memory => memory.text), `max_tokens ${maxTokens}`).not.toContain('My dog is called Biscuit.');
      expect(replyTokens(JSON.stringify(body)), `max_tokens ${maxTokens}`).toBeLessThanOrEqual(maxTokens);
    }
  });
});
