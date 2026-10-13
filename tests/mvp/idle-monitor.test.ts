import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { IdleMonitor, DRAINING_HEADER } from '../../src/mvp/idle';

/**
 * The on-demand idle clock (RENOR_ON_DEMAND) on fake timers: what holds an engine awake,
 * what restarts its idle period, and that a draining engine refuses a request before any
 * handler runs. idle-exit.test.ts drives the same rules through a running engine.
 */

describe('IdleMonitor', () => {
  afterEach(() => vi.useRealTimers());

  function fakeRequest(method: string, reqPath: string) {
    return { method, path: reqPath } as any;
  }
  function fakeResponse() {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      setHeader(name: string, value: string) { res.headers[name.toLowerCase()] = value; },
      status(code: number) { res.statusCode = code; return res; },
      json(body: unknown) { res.body = body; res.emit('finish'); res.emit('close'); return res; },
    });
    return res;
  }
  function serve(monitor: IdleMonitor, method: string, reqPath: string) {
    const res = fakeResponse();
    const next = vi.fn();
    monitor.middleware(fakeRequest(method, reqPath), res as any, next);
    return { res, next, end(status: number) { res.statusCode = status; res.emit('finish'); res.emit('close'); } };
  }

  it('drains only after a full idle period with nothing in flight, then refuses requests before they run', async () => {
    vi.useFakeTimers();
    const monitor = new IdleMonitor(1_000);
    let drained = false;
    void monitor.start().then(() => { drained = true; });

    let finishWork!: () => void;
    const work = monitor.track(() => new Promise<void>(resolve => { finishWork = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drained).toBe(false);
    finishWork();
    await work;
    await vi.advanceTimersByTimeAsync(999);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(true);

    const late = serve(monitor, 'POST', '/mcp');
    expect(late.next).not.toHaveBeenCalled();
    expect(late.res.statusCode).toBe(503);
    expect(late.res.headers[DRAINING_HEADER]).toBe('1');
    expect(late.res.headers.connection).toBe('close');
  });

  it('counts a request until it closes; only a successful non-probe request restarts the clock', async () => {
    vi.useFakeTimers();
    const monitor = new IdleMonitor(1_000);
    let drainedAt = -1;
    const t0 = Date.now();
    void monitor.start().then(() => { drainedAt = Date.now() - t0; });

    await vi.advanceTimersByTimeAsync(500);
    const probe = serve(monitor, 'GET', '/version');
    const denied = serve(monitor, 'POST', '/mcp');
    expect(probe.next).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); // both still open: no drain however long
    expect(drainedAt).toBe(-1);
    probe.end(200);
    denied.end(401);
    await vi.advanceTimersByTimeAsync(0);
    // Neither reset the clock (last activity was t=0), so it drains at once.
    expect(drainedAt).toBe(2_500);

    const second = new IdleMonitor(1_000);
    let secondDrainedAt = -1;
    const t1 = Date.now();
    void second.start().then(() => { secondDrainedAt = Date.now() - t1; });
    await vi.advanceTimersByTimeAsync(500);
    serve(second, 'POST', '/mcp').end(200);
    await vi.advanceTimersByTimeAsync(999);
    expect(secondDrainedAt).toBe(-1);
    await vi.advanceTimersByTimeAsync(1);
    expect(secondDrainedAt).toBe(1_500);
  });
});
