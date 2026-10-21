import { describe, it, expect, afterEach, vi } from 'vitest';
import { setTimeout as pause } from 'node:timers/promises';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { poolFetch, type PooledFetch } from '../../src/net/poolFetch';
import { CallPhases, recordPhase } from '../../src/callPhases';
import { startVertexStub, type VertexStub } from '../helpers/vertexStub';

/**
 * What keeping the service's connection and its access token alive means for a call, against a local stub of Vertex (no Google
 * call, no credential): a connection is reused across calls, one the service closed meanwhile is replaced without failing the
 * call, the access token is renewed before it expires so no call waits for it, and the vectors are the ones the plain `fetch`
 * gets. The stub counts the connections it accepts and the token requests it answers, and says which token each predict carried.
 *
 * The token tests do not wait for time to pass: the provider is handed a clock they move by hand (`tokenClock`), so an hour passes
 * in no time and no global timer is faked. What they wait for is an event, never a duration.
 */

// Every test makes real HTTP requests to the stub; a loaded machine needs the room.
vi.setConfig({ testTimeout: 20_000 });

const stubs: VertexStub[] = [];
const pools: PooledFetch[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(stubs.splice(0).map(stub => stub.close()));
});

/** What `handClock` hands the provider as a timer: it only unrefs it and gives it back to be cleared. */
interface HandTimer { id: number; unref(): HandTimer }

/**
 * A clock the test moves by hand. `advance` moves it on and runs the timers that fall due on the way, earliest first, with the clock
 * at the moment each was due; `jump` moves it without running any (a process that was stopped for a while). A timer is given what
 * Node gives one: a wait it cannot give (under a millisecond, or longer than 2^31 - 1) is 1 ms. Nothing global is touched, so no
 * socket, no timer of the runner and no other test feels it.
 */
function handClock(start = Date.parse('2030-01-01T00:00:00Z')) {
  let now = start;
  let ids = 0;
  const due = new Map<number, { at: number; callback: () => void }>();
  let waiting: Array<() => void> = [];
  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number): HandTimer {
      const id = ++ids;
      due.set(id, { at: now + (ms >= 1 && ms <= 2 ** 31 - 1 ? Math.trunc(ms) : 1), callback });
      const woken = waiting;
      waiting = [];
      for (const resolve of woken) resolve();
      const timer: HandTimer = { id, unref: () => timer };
      return timer;
    },
    clearTimeout(timer: HandTimer | undefined): void {
      if (timer) due.delete(timer.id);
    },
    /** How many timers wait to fall due. */
    pending: () => due.size,
    advance(ms: number): void {
      const end = now + ms;
      for (let ran = 0; ; ran++) {
        let next: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of due) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        if (ran >= 1_000) throw new Error('timers were armed in a loop while the clock moved on');
        due.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].callback();
      }
      now = end;
    },
    jump(ms: number): void {
      now += ms;
    },
    /**
     * Resolves when the provider next arms a timer, which it does once an exchange has ended: with a token in hand (it arms the next
     * renewal) or refused (it arms the retry). It resolves one turn of the event loop later, when the provider has finished what it
     * does after arming it (its exchange is no longer the one in flight), so that the test can move the clock on at once.
     */
    armed: async () => {
      await new Promise<void>(resolve => { waiting.push(resolve); });
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}
type HandClock = ReturnType<typeof handClock>;

async function provider(options: { pooled?: boolean; tokenLifetimeS?: number; tokenClock?: HandClock; onConnect?: (ms: number) => void } = {}): Promise<{
  vertex: VertexEmbeddingProvider;
  stub: VertexStub;
  /** What the provider has issued, counted as it issues it (not as the stub sees it): a test can say how many exchanges some calls made without waiting for an answer. */
  sent: { tokens: number; predicts: number };
}> {
  const stub = await startVertexStub({ keepAliveHint: false, tokenLifetimeS: options.tokenLifetimeS });
  stubs.push(stub);
  let pool: PooledFetch | undefined;
  if (options.pooled) {
    pool = poolFetch({ retryOnReset: true, onConnect: options.onConnect });
    pools.push(pool);
  }
  const sent = { tokens: 0, predicts: 0 };
  const request: typeof fetch = (input, init) => {
    if (String(input).endsWith('/token')) sent.tokens++;
    else sent.predicts++;
    return pool ? pool(input, init) : globalThis.fetch(input, init);
  };
  return { vertex: new VertexEmbeddingProvider({ keyFile: stub.keyFile, project: 'stub-project', location: 'europe-west4', baseUrl: stub.baseUrl, request, tokenClock: options.tokenClock }), stub, sent };
}

describe('the service\'s connection', () => {
  it('is reused by the next call, and a connection the service closed meanwhile is replaced without failing the call', async () => {
    const { vertex, stub } = await provider({ pooled: true });
    expect(await vertex.embedQuery('first')).toHaveLength(768);
    expect(await vertex.embedQuery('second')).toHaveLength(768);
    await pause(50); // both connections are back in the pool
    const opened = stub.counts.connections;
    expect(opened).toBeGreaterThan(0);
    expect(await vertex.embedQuery('third')).toHaveLength(768);
    expect(stub.counts.connections).toBe(opened); // a call after a pause made no new connection

    // The service closes the connection as the next request reaches it (the race an idle connection always has).
    stub.resetNext();
    const before = { requests: stub.counts.requests, served: stub.counts.served };
    expect(await vertex.embedQuery('fourth')).toHaveLength(768);
    expect(stub.counts.requests - before.requests).toBe(2); // the one it reset, then the one it answered
    expect(stub.counts.served - before.served).toBe(1);

    // The service closed its idle connections before the call (its idle timeout): the call opens one, and nothing is retried.
    await pause(50);
    stub.closeIdleConnections();
    await pause(50);
    const connections = stub.counts.connections;
    const requests = stub.counts.requests;
    expect(await vertex.embedQuery('fifth')).toHaveLength(768);
    expect(stub.counts.connections).toBeGreaterThan(connections);
    expect(stub.counts.requests - requests).toBe(1);
  }, 20_000);

  it('gives the same vectors as the plain fetch does', async () => {
    const plain = await provider();
    const pooled = await provider({ pooled: true });
    const texts = ['what did we decide about the vector floor?', 'why did we choose that design?', 'the mango juice stand closes at six'];
    expect(await pooled.vertex.embed(texts)).toEqual(await plain.vertex.embed(texts));
    expect(await pooled.vertex.embedQuery(texts[0])).toEqual(await plain.vertex.embedQuery(texts[0]));
    expect(pooled.vertex.usage).toEqual(plain.vertex.usage);
  });
});

describe('the access token', () => {
  // A token lives an hour; the renewal is due 50 minutes after it was issued and a call stops using it at 55. A test moves its clock
  // and then waits for the event it needs: the provider arming its next timer (which it does once an exchange has ended), or the stub
  // having received an exchange. The requests to the stub are real.
  const minutes = (n: number) => n * 60_000;
  const days = (n: number) => n * 24 * minutes(60);

  it('is renewed before it expires, so the call after the renewal waits for no exchange', async () => {
    const clock = handClock();
    const { vertex, stub, sent } = await provider({ tokenClock: clock });
    await vertex.embedQuery('first');
    expect(stub.tokens.requests).toBe(1);
    expect(clock.pending()).toBe(1); // the renewal is armed
    clock.advance(minutes(49));
    expect(sent.tokens).toBe(1); // and not yet due
    clock.advance(minutes(1)); // nothing asks for an embedding: the exchange that follows is the provider's own
    expect(sent.tokens).toBe(2);
    await clock.armed(); // the exchange ended with the new token in hand
    expect(stub.counts.requests).toBe(1);
    await vertex.embedQuery('second');
    expect(stub.tokens.used.at(-1)).toBe('stub-token-2');
    expect(sent.tokens).toBe(2); // no call made an exchange, and the calls since carry the renewed token
  });

  it('goes on being renewed: one exchange for each life of the token, with no call to ask for any', async () => {
    const clock = handClock();
    const { vertex, stub } = await provider({ tokenClock: clock });
    await vertex.embedQuery('first');
    for (const issued of [2, 3, 4]) {
      clock.advance(minutes(50));
      await clock.armed();
      expect(stub.tokens.requests).toBe(issued);
    }
    expect(stub.counts.requests).toBe(1); // nothing but the first call asked for an embedding
    await vertex.embedQuery('last');
    expect(stub.tokens.used.at(-1)).toBe('stub-token-4');
    expect(stub.tokens.requests).toBe(4);
  });

  it('is not a reason for a call to fail when a renewal is refused: the token in hand is used, and the renewal is tried again', async () => {
    const clock = handClock();
    const { vertex, stub } = await provider({ tokenClock: clock });
    await vertex.embedQuery('first');
    stub.tokens.failing = 1; // the renewal is refused
    clock.advance(minutes(50));
    await clock.armed(); // the refusal reached the provider, which armed the retry (an unhandled rejection would fail this file)
    expect(stub.tokens.requests).toBe(2);
    expect(await vertex.embedQuery('second')).toHaveLength(768); // 5 minutes of the first token are left
    expect(stub.tokens.used.at(-1)).toBe('stub-token-1');
    expect(stub.tokens.requests).toBe(2);
    clock.advance(minutes(1)); // a minute after the refusal the provider asks again
    await clock.armed();
    expect(stub.tokens.requests).toBe(3);
    await vertex.embedQuery('third');
    expect(stub.tokens.used.at(-1)).toBe('stub-token-3');
    expect(stub.tokens.requests).toBe(3);
  });

  it('is exchanged for by the call that finds it unusable, when nothing renewed it', async () => {
    const clock = handClock();
    const { vertex, stub } = await provider({ tokenClock: clock });
    await vertex.embedQuery('first');
    clock.jump(minutes(56)); // the timer has not run (a process that was stopped), and the token is past its margin
    expect(await vertex.embedQuery('second')).toHaveLength(768);
    expect(stub.tokens.requests).toBe(2);
    expect(stub.tokens.used.at(-1)).toBe('stub-token-2');
    expect(clock.pending()).toBe(1); // the renewal the stopped process missed was replaced by the next one, not left beside it
  });

  it('is not renewed in the background when it lives only a moment, which would be an exchange in a loop', async () => {
    const clock = handClock();
    const { vertex, stub, sent } = await provider({ tokenClock: clock, tokenLifetimeS: 1 });
    await vertex.embedQuery('first');
    expect(clock.pending()).toBe(0); // nothing is armed
    clock.advance(minutes(60));
    expect(sent.tokens).toBe(1);
    await vertex.embedQuery('second'); // a token that short is exchanged for by the call, as it always was
    expect(stub.tokens.requests).toBe(2);
  });

  it('is renewed in the background from a life of a minute, and not under it', async () => {
    for (const [lifetimeS, timers] of [[59, 0], [60, 1]] as const) {
      const clock = handClock();
      const { vertex } = await provider({ tokenClock: clock, tokenLifetimeS: lifetimeS });
      await vertex.embedQuery('first');
      expect(clock.pending()).toBe(timers);
    }
  });

  it('is renewed when it is due, not at once, when it lives longer than a timer can wait', async () => {
    const clock = handClock();
    const { vertex, stub, sent } = await provider({ tokenClock: clock, tokenLifetimeS: days(115) / 1000 }); // renewal due in 96 days; a timer waits 24.8 at most
    await vertex.embedQuery('first');
    clock.advance(days(30)); // the timer woke once, found it early, and waited again
    expect(sent.tokens).toBe(1);
    clock.advance(days(66)); // 96 days in
    expect(sent.tokens).toBe(2);
    await clock.armed();
    await vertex.embedQuery('second');
    expect(stub.tokens.used.at(-1)).toBe('stub-token-2');
    expect(stub.tokens.requests).toBe(2);
  });

  it('is renewed by the process\'s own timer when it is given no clock, a timer that never keeps the process alive', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const { vertex } = await provider();
      await vertex.embedQuery('first');
      const renewal = timers.mock.calls.findIndex(([, ms]) => typeof ms === 'number' && ms > minutes(49) && ms <= minutes(50));
      expect(renewal).toBeGreaterThanOrEqual(0);
      const timer = timers.mock.results[renewal].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      clearTimeout(timer); // not left for 50 minutes
    } finally {
      timers.mockRestore();
    }
  });

  it('is exchanged for once when calls need it together', async () => {
    const { vertex, stub, sent } = await provider();
    stub.tokens.hold = true;
    const calls = ['a', 'b', 'c', 'd', 'e'].map(text => vertex.embedQuery(text));
    expect(sent.tokens).toBe(1); // the five asked at once and one exchange was made
    stub.tokens.hold = false;
    stub.releaseTokens();
    const vectors = await Promise.all(calls);
    expect(vectors.every(vector => vector.length === 768)).toBe(true);
    expect(stub.tokens.requests).toBe(1);
    expect(sent.tokens).toBe(1);
    expect(new Set(stub.tokens.used)).toEqual(new Set(['stub-token-1']));
  });

  it('is still fetched for the next call when the call that asked for it gave up', async () => {
    const { vertex, stub, sent } = await provider();
    stub.tokens.hold = true; // the exchange is under way and not answered
    const gaveUp = new AbortController();
    const settled = vertex.embedQuery('impatient', { signal: gaveUp.signal }).then(() => 'answered', (err: Error) => `stopped: ${err.message}`);
    await stub.tokenRequest(1); // it has reached the stub: a signal that cancelled it would be seen, as the next call would make another
    gaveUp.abort(new Error('budget'));
    expect(await settled).toBe('stopped: budget'); // it stopped waiting at its signal, with the exchange still unanswered
    expect(stub.counts.requests).toBe(0); // and asked for no embedding
    stub.tokens.hold = false;
    stub.releaseTokens(); // the exchange it left running ends now
    expect(await vertex.embedQuery('patient')).toHaveLength(768);
    expect(stub.tokens.requests).toBe(1); // the next call used the token that exchange brought
    expect(sent.tokens).toBe(1);
  });
});

describe('the phases of a call', () => {
  it('say where the time went: the whole embedding, the token, the connection and the request', async () => {
    const { vertex, stub, sent } = await provider({ pooled: true, onConnect: ms => recordPhase('connect', ms) });
    stub.delayMs = 40;

    const first = new CallPhases();
    await first.run(() => vertex.embedQuery('a question that opens the connection'));
    const opening = first.report();
    expect(opening.connect).toBeDefined(); // a connection was opened for it (the token's and the predict's)
    expect(opening.token).toBeGreaterThan(0); // and a token was exchanged for on its way
    expect(opening.call).toBeGreaterThanOrEqual(35); // the stub's own time (40 ms) is in the request
    expect(opening.embed).toBeGreaterThanOrEqual(opening.call! + opening.token! - 0.2); // the whole holds its parts

    await pause(50); // the connection is back in the pool
    const second = new CallPhases();
    await second.run(() => vertex.embedQuery('a question asked over it'));
    const reusing = second.report();
    expect(reusing.connect).toBeUndefined();
    expect(sent.tokens).toBe(1); // the token was in hand: this call made no exchange
    expect(reusing.token).toBeLessThan(opening.token!); // and its token phase is the lookup of the one in hand, not an exchange
    expect(reusing.call).toBeGreaterThanOrEqual(35);
  });

  it('are recorded only for a call that is being recorded, and a call outside one is unchanged', async () => {
    const { vertex } = await provider();
    const outside = await vertex.embedQuery('nobody is recording');
    const recorded = new CallPhases();
    const inside = await recorded.run(() => vertex.embedQuery('nobody is recording'));
    expect(inside).toEqual(outside);
    expect(recorded.report().embed).toBeDefined();
  });
});
