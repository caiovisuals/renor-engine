import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EvidenceCache } from '../../src/evidence/evidenceCache';
import { EvidenceExtractor, type EvidenceChat, type EvidenceChatRequest } from '../../src/evidence/secondPass';
import {
  attachSearchEvidence,
  collectEvidence,
  productEvidenceReport,
  type CollectEvidenceArgs,
  type ProductEvidenceAttachment,
} from '../../src/evidence/attach';
import {
  EVIDENCE_BACKGROUND_CONCURRENCY,
  EVIDENCE_BACKGROUND_QUEUE,
  EVIDENCE_WAIT_MS_DEFAULT,
  EvidenceFlights,
  evidenceAsyncEnabled,
  resolveEvidenceBackground,
  resolveEvidenceWaitMs,
  sharedEvidenceFlights,
  waitAtMost,
} from '../../src/evidence/background';
import { resolveEvidenceToolOptions } from '../../src/evidence/options';
import { resolveEngineEvidence } from '../../src/mvp/engine';

/**
 * Bounded-wait evidence (RENOR_EVIDENCE_ASYNC, default off): a slow extractor never holds a search longer than the
 * configured wait; a cached table comes back at once; one extraction per prompt; a bounded queue. Without the flag a
 * search waits for the extractor, as before. The model here is a chat function the test opens and closes, so no
 * assertion depends on how fast this machine is: a search that has to answer before the model does is given a model
 * that never answers until the test lets it.
 */

const ITEMS_JSON = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });

const tmpDirs: string[] = [];
const openCaches: EvidenceCache[] = [];
afterEach(() => {
  for (const cache of openCaches.splice(0)) cache.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bounded-wait-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

/** A model that answers only once the test opens it; `calls` counts the requests it received. */
function gatedChat(content = ITEMS_JSON) {
  let isOpen = false;
  const parked: Array<() => void> = [];
  const chat = vi.fn(async (_request: EvidenceChatRequest) => {
    if (!isOpen) await new Promise<void>(resolve => parked.push(resolve));
    return { content, promptTokens: 1000, completionTokens: 50, latencyMs: 7 };
  });
  return {
    chat: chat as EvidenceChat & typeof chat,
    open() {
      isOpen = true;
      for (const resume of parked.splice(0)) resume();
    },
  };
}

/** A vault of `n` notes and the ranked hits that point at them. */
function vault(n = 3): { dir: string; hits: CollectEvidenceArgs['hits'] } {
  const dir = tmpDir('vault');
  const hits = Array.from({ length: n }, (_, i) => {
    const notePath = path.join(dir, `session-${i}.md`);
    fs.writeFileSync(notePath, `# Session ${i}\n\nWe went camping for ${i + 2} days near the lake.\n`);
    return { notePath, text: `chunk ${i}`, session_date: `2023/05/2${i}` };
  });
  return { dir, hits };
}

function extractorWith(chat: EvidenceChat): { extractor: EvidenceExtractor; cachePath: string; cache: EvidenceCache } {
  const cachePath = path.join(tmpDir('cache'), 'evidence-cache.db');
  const cache = new EvidenceCache(cachePath);
  openCaches.push(cache);
  return { extractor: new EvidenceExtractor({ chat, cache, model: 'stub-model' }), cachePath, cache };
}

function args(
  over: Partial<CollectEvidenceArgs> & Pick<CollectEvidenceArgs, 'extractor' | 'hits' | 'vaultPath'>,
  background?: { waitMs: number; flights: EvidenceFlights },
  cachePath?: string,
): CollectEvidenceArgs {
  return {
    query: 'How many days was the camping trip?',
    options: { mode: 'always', maxSessions: 20, charCap: 6000, cachePath, ...(background ? { background } : {}) },
    ...over,
  };
}

/** Whether `promise` is still unsettled after `ms` of real time. */
async function stillPending(promise: Promise<unknown>, ms = 60): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(marker), ms))]);
  return winner === marker;
}

describe('the bounded-wait flag', () => {
  it('is on only for 1, true, yes or on; unset, empty and anything else is off', () => {
    for (const on of ['1', 'true', 'yes', 'on', ' ON ', 'True']) {
      expect(evidenceAsyncEnabled({ RENOR_EVIDENCE_ASYNC: on }), on).toBe(true);
    }
    for (const off of [undefined, '', '0', 'false', 'no', 'off', 'enabled', '2']) {
      expect(evidenceAsyncEnabled(off === undefined ? {} : { RENOR_EVIDENCE_ASYNC: off }), String(off)).toBe(false);
      expect(resolveEvidenceBackground(off === undefined ? {} : { RENOR_EVIDENCE_ASYNC: off }), String(off)).toBeUndefined();
    }
  });

  it('reads RENOR_EVIDENCE_WAIT_MS as whole milliseconds from 0 to 60,000, and anything unreadable as the default', () => {
    expect(EVIDENCE_WAIT_MS_DEFAULT).toBe(2000);
    expect(resolveEvidenceWaitMs({})).toBe(2000);
    expect(resolveEvidenceWaitMs({ RENOR_EVIDENCE_WAIT_MS: '' })).toBe(2000);
    expect(resolveEvidenceWaitMs({ RENOR_EVIDENCE_WAIT_MS: '0' })).toBe(0);
    expect(resolveEvidenceWaitMs({ RENOR_EVIDENCE_WAIT_MS: '750.9' })).toBe(750);
    expect(resolveEvidenceWaitMs({ RENOR_EVIDENCE_WAIT_MS: '999999' })).toBe(60000);
    for (const bad of ['-1', 'soon', '2s', 'NaN', 'Infinity']) {
      expect(resolveEvidenceWaitMs({ RENOR_EVIDENCE_WAIT_MS: bad }), bad).toBe(2000);
    }
  });

  it('gives every search of the process the same flights, with the documented bounds', () => {
    const a = resolveEvidenceBackground({ RENOR_EVIDENCE_ASYNC: '1', RENOR_EVIDENCE_WAIT_MS: '300' });
    const b = resolveEvidenceBackground({ RENOR_EVIDENCE_ASYNC: 'on' });
    expect(a?.waitMs).toBe(300);
    expect(b?.waitMs).toBe(2000);
    expect(a?.flights).toBe(sharedEvidenceFlights());
    expect(b?.flights).toBe(a?.flights);
    expect(sharedEvidenceFlights().concurrency).toBe(EVIDENCE_BACKGROUND_CONCURRENCY);
    expect(sharedEvidenceFlights().queue).toBe(EVIDENCE_BACKGROUND_QUEUE);
  });

  it('is read by the MVP read tools only: the resolver the CLI, API and stdio server use never sets it', () => {
    const dbPath = path.join(tmpDir('db'), 'index.db');
    const on = { RENOR_EVIDENCE_ASYNC: '1' };
    expect(resolveEvidenceToolOptions({ dbPath }, on)).not.toHaveProperty('background');
    expect(resolveEngineEvidence({ dbPath }, on)?.options.background?.flights).toBe(sharedEvidenceFlights());
    // Off, the MVP gets exactly what it got before: the same options, with no background key at all.
    for (const off of [{}, { RENOR_EVIDENCE_ASYNC: '0' }, { RENOR_EVIDENCE_ASYNC: 'maybe' }]) {
      const engine = resolveEngineEvidence({ dbPath }, off);
      expect(engine?.options).not.toHaveProperty('background');
      expect(engine?.options).toEqual(resolveEvidenceToolOptions({ dbPath }, off));
    }
  });
});

describe('EvidenceFlights', () => {
  const ok = (tag: string): ProductEvidenceAttachment => ({ status: 'ok', reason: 'mode-always', model: tag, items: [] });

  it('runs one extraction per key and lets a later search join it', async () => {
    const flights = new EvidenceFlights();
    let release!: () => void;
    const run = vi.fn(() => new Promise<ProductEvidenceAttachment>(resolve => { release = () => resolve(ok('k')); }));
    const first = flights.join('k', run);
    const second = flights.join('k', run);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual(ok('k'));
    expect(flights.counts).toMatchObject({ started: 1, joined: 1, refused: 0, failed: 0 });
  });

  it('runs at most `concurrency` at once and starts the waiting ones in order as slots free', async () => {
    const flights = new EvidenceFlights({ concurrency: 2, queue: 5 });
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const runFor = (key: string) => () => new Promise<ProductEvidenceAttachment>(resolve => {
      started.push(key);
      releases.set(key, () => resolve(ok(key)));
    });
    const all = ['a', 'b', 'c', 'd'].map(key => flights.join(key, runFor(key))!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual(['a', 'b']);
    releases.get('b')!();
    await all[1];
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual(['a', 'b', 'c']);
    releases.get('a')!();
    await all[0];
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    releases.get('c')!();
    releases.get('d')!();
    await flights.idle();
    expect(flights.counts).toMatchObject({ started: 4, refused: 0 });
  });

  it('turns a new key away when every slot and the whole queue are taken, and starts nothing for it', async () => {
    const flights = new EvidenceFlights({ concurrency: 1, queue: 1 });
    const releases: Array<() => void> = [];
    const run = vi.fn(() => new Promise<ProductEvidenceAttachment>(resolve => releases.push(() => resolve(ok('x')))));
    expect(flights.join('one', run)).not.toBeNull();
    expect(flights.join('two', run)).not.toBeNull();
    expect(flights.join('three', run)).toBeNull();
    // A key already in the air is joined, never refused, even with the queue full.
    expect(flights.join('two', run)).not.toBeNull();
    expect(flights.counts).toMatchObject({ started: 2, joined: 1, refused: 1 });
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
    releases.shift()!();
    await flights.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('forgets a key when its flight ends, so a later search starts a new one', async () => {
    const flights = new EvidenceFlights();
    const run = vi.fn(async () => ok('k'));
    await flights.join('k', run);
    await flights.join('k', run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(flights.counts.started).toBe(2);
  });

  it('never leaves an unhandled rejection when a flight fails after every search stopped waiting', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const flights = new EvidenceFlights();
      const flight = flights.join('k', () => new Promise<ProductEvidenceAttachment>((_, reject) => {
        setTimeout(() => reject(new Error('provider returned 500 for: the user said something private')), 20);
      }))!;
      expect(await waitAtMost(flight, 1)).toBeUndefined();
      await flights.idle();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(flights.counts.failed).toBe(1);
      // The operator learns it failed, and only the reason code: never the query or the provider's words.
      const logged = stderr.mock.calls.map(call => String(call[0])).join('');
      expect(logged).toContain('[evidence] a background extraction ended without a table (extractor-error)');
      expect(logged).not.toContain('private');
    } finally {
      process.off('unhandledRejection', unhandled);
      stderr.mockRestore();
    }
  });
});

describe('collectEvidence with a bounded wait', () => {
  it('looks a table up under the very key extract() stores it under', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    model.open();
    const { extractor, cache } = extractorWith(model.chat);
    const sessions = [{ stem: hits[0].notePath, date: hits[0].session_date, text: fs.readFileSync(hits[0].notePath, 'utf8') }];
    expect(extractor.replay(extractor.cacheKey('How many days?', sessions))).toBeNull();
    const fresh = await extractor.extract('How many days?', sessions);
    expect(cache.stats().entries).toBe(1);
    expect(extractor.replay(extractor.cacheKey('How many days?', sessions))).toEqual({ ...fresh, fromCache: true, latencyMs: 0 });
    expect(extractor.replay(extractor.cacheKey('How many days in total?', sessions))).toBeNull();
  });

  it('returns a cached table at once, without calling the model', async () => {
    const { dir, hits } = vault();
    const warm = gatedChat();
    warm.open();
    const { extractor, cachePath } = extractorWith(warm.chat);
    const first = await collectEvidence(args({ extractor, hits, vaultPath: dir }));
    expect(first).toMatchObject({ status: 'ok', fromCache: false });

    const flights = new EvidenceFlights();
    const result = await collectEvidence(args({ extractor, hits, vaultPath: dir }, { waitMs: 60_000, flights }, cachePath));
    expect(result).toEqual({ ...first, fromCache: true, latencyMs: 0 });
    expect(warm.chat).toHaveBeenCalledTimes(1);
    expect(flights.counts.started).toBe(0);
  });

  it('answers "pending" once the wait is over, and the extraction it started fills the cache for the next search', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    const { extractor, cachePath } = extractorWith(model.chat);
    const flights = new EvidenceFlights();
    const bounded = args({ extractor, hits, vaultPath: dir }, { waitMs: 30, flights }, cachePath);

    const started = Date.now();
    const first = await collectEvidence(bounded);
    expect(first).toEqual({ status: 'skipped', reason: 'pending' });
    expect(Date.now() - started).toBeLessThan(10_000); // it returned at all, with the model still silent
    expect(model.chat).toHaveBeenCalledTimes(1);

    model.open();
    await flights.idle();
    const again = await collectEvidence(bounded);
    expect(again).toMatchObject({ status: 'ok', reason: 'mode-always', fromCache: true, model: 'stub-model' });
    expect(again.items?.[0]?.item).toBe('camping trip');
    expect(model.chat).toHaveBeenCalledTimes(1);
  });

  it('returns the table, just as without the flag, when the model answers within the wait', async () => {
    const { dir, hits } = vault();
    const fast = gatedChat();
    fast.open();
    const plain = extractorWith(fast.chat);
    const bounded = extractorWith(fast.chat);
    const without = await collectEvidence(args({ extractor: plain.extractor, hits, vaultPath: dir }));
    const within = await collectEvidence(args({ extractor: bounded.extractor, hits, vaultPath: dir }, { waitMs: 60_000, flights: new EvidenceFlights() }, bounded.cachePath));
    expect(within).toEqual(without);
    expect(within).toMatchObject({ status: 'ok', fromCache: false, latencyMs: 7 });
  });

  it('asks again after a reply the parser rejects, three attempts in all, with the flag and without', async () => {
    const { dir, hits } = vault();
    const garbageTwice = () => {
      let calls = 0;
      return vi.fn(async (_request: EvidenceChatRequest) => ({ content: ++calls <= 2 ? 'not json' : ITEMS_JSON, latencyMs: 3 }));
    };
    const a = garbageTwice();
    const b = garbageTwice();
    const plain = extractorWith(a);
    const bounded = extractorWith(b);
    const without = await collectEvidence(args({ extractor: plain.extractor, hits, vaultPath: dir }));
    const within = await collectEvidence(args({ extractor: bounded.extractor, hits, vaultPath: dir }, { waitMs: 60_000, flights: new EvidenceFlights() }, bounded.cachePath));
    expect(without).toMatchObject({ status: 'ok', fromCache: false, latencyMs: 3 });
    expect(within).toEqual(without);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);
  });

  it('never lets two cache files share an extraction, so each is filled for its own next search', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    const first = extractorWith(model.chat);
    const second = extractorWith(model.chat);
    const flights = new EvidenceFlights();
    const search = (e: ReturnType<typeof extractorWith>) =>
      collectEvidence(args({ extractor: e.extractor, hits, vaultPath: dir }, { waitMs: 60_000, flights }, e.cachePath));
    const both = Promise.all([search(first), search(second)]);
    // Same prompt, both in the air at once: the moment they could wrongly share one extraction.
    for (let i = 0; i < 1000 && flights.counts.started + flights.counts.joined < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(flights.counts).toMatchObject({ started: 2, joined: 0 });
    model.open();
    await both;
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(await search(first)).toMatchObject({ status: 'ok', fromCache: true });
    expect(await search(second)).toMatchObject({ status: 'ok', fromCache: true });
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it('makes one model call for any number of identical searches in flight at once', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    const { extractor, cachePath } = extractorWith(model.chat);
    const flights = new EvidenceFlights();
    const bounded = args({ extractor, hits, vaultPath: dir }, { waitMs: 30, flights }, cachePath);
    const results = await Promise.all(Array.from({ length: 6 }, () => collectEvidence(bounded)));
    expect(results.every(r => r.reason === 'pending')).toBe(true);
    expect(model.chat).toHaveBeenCalledTimes(1);
    expect(flights.counts).toMatchObject({ started: 1, joined: 5 });
    model.open();
    await flights.idle();
    expect(model.chat).toHaveBeenCalledTimes(1);
  });

  it('reports, for a search that joined another one\'s extraction, its own reason for running', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    const { extractor, cachePath } = extractorWith(model.chat);
    const flights = new EvidenceFlights();
    const auto = { mode: 'auto' as const, maxSessions: 20, charCap: 6000, cachePath, background: { waitMs: 60_000, flights } };
    const query = 'How many days was the camping trip?';
    const byIntent = collectEvidence({ query, hits, vaultPath: dir, extractor, options: auto });
    const forced = collectEvidence({ query, hits, vaultPath: dir, extractor, options: auto, force: true });
    // Both must reach the flight before the model answers, however slow this machine reads the notes.
    for (let i = 0; i < 1000 && flights.counts.started + flights.counts.joined < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    model.open();
    expect((await byIntent).reason).toBe('intent');
    expect((await forced).reason).toBe('forced');
    expect(model.chat).toHaveBeenCalledTimes(1);
    expect(flights.counts).toMatchObject({ started: 1, joined: 1 });
  });

  it('answers "queue-full" and calls nothing for a search past the queue bound', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    const { extractor, cachePath } = extractorWith(model.chat);
    const flights = new EvidenceFlights({ concurrency: 1, queue: 1 });
    const ask = (query: string) => collectEvidence({ ...args({ extractor, hits, vaultPath: dir }, { waitMs: 20, flights }, cachePath), query });
    expect(await ask('How many days camping?')).toEqual({ status: 'skipped', reason: 'pending' });
    expect(await ask('Where did we camp?')).toEqual({ status: 'skipped', reason: 'pending' });
    expect(await ask('Who came camping?')).toEqual({ status: 'skipped', reason: 'queue-full' });
    expect(model.chat).toHaveBeenCalledTimes(1); // the second waits for the slot; the third was never started
    model.open();
    await flights.idle();
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it('reports a model that fails within the wait exactly as it did without the flag', async () => {
    const { dir, hits } = vault();
    const garbled = gatedChat('not json at all');
    garbled.open();
    const plain = extractorWith(garbled.chat);
    const bounded = extractorWith(garbled.chat);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const without = await collectEvidence(args({ extractor: plain.extractor, hits, vaultPath: dir }));
      const within = await collectEvidence(args({ extractor: bounded.extractor, hits, vaultPath: dir }, { waitMs: 60_000, flights: new EvidenceFlights() }, bounded.cachePath));
      expect(without.reason).toBe('extractor-parse-error');
      expect(within).toEqual(without);
      expect(garbled.chat).toHaveBeenCalledTimes(6); // three attempts on each path

      const failing = (async () => { throw new Error('extractor provider returned 401: bad key'); }) as EvidenceChat;
      const a = extractorWith(failing);
      const b = extractorWith(failing);
      const searchWith = (extractor: EvidenceExtractor, background?: { waitMs: number; flights: EvidenceFlights }, cachePath?: string) =>
        attachSearchEvidence({
          query: 'How many days was the camping trip?',
          hits: hits.map(h => ({ ...h, chunkId: 1, headingPath: '', score: 1, reason: 'semantic' })),
          vaultPath: dir,
          options: { mode: 'always', model: 'stub-model', maxSessions: 20, charCap: 6000, cachePath, ...(background ? { background } : {}) },
          extractor,
          enabled: true,
        });
      const failedWithout = await searchWith(a.extractor);
      const failedWithin = await searchWith(b.extractor, { waitMs: 60_000, flights: new EvidenceFlights() }, b.cachePath);
      // A failure names the extractor that failed (#308), on both paths alike.
      expect(failedWithout.evidence).toEqual({ status: 'skipped', reason: 'extractor-error', model: 'stub-model', error: 'extractor provider returned 401: bad key' });
      expect(failedWithin).toEqual(failedWithout);
    } finally {
      stderr.mockRestore();
    }
  });

  it('without the flag, waits for the model however long it takes (the behaviour this mode bounds)', async () => {
    const { dir, hits } = vault();
    const model = gatedChat();
    const { extractor } = extractorWith(model.chat);
    const search = collectEvidence(args({ extractor, hits, vaultPath: dir }));
    expect(await stillPending(search)).toBe(true);
    model.open();
    expect(await search).toMatchObject({ status: 'ok', fromCache: false });
  });
});

describe('what a search says when the table is missing for want of time', () => {
  it('names "pending" and "busy" apart from the states that mean nothing is coming', () => {
    const pending = productEvidenceReport({ status: 'skipped', reason: 'pending' });
    expect(pending.state).toBe('pending');
    expect(pending.note).toMatch(/did not finish within the time this deployment waits/);
    expect(pending.note).toMatch(/same request over the same notes returns it/);
    const busy = productEvidenceReport({ status: 'skipped', reason: 'queue-full' });
    expect(busy.state).toBe('busy');
    expect(busy.note).toMatch(/none was started/);
    // Neither borrows the wording of the states that mean nothing is missing.
    expect(pending.note).not.toMatch(/Nothing is missing/);
    expect(busy.note).not.toMatch(/Nothing is missing/);
  });
});
