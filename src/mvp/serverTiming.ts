import { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';
import { PHASE_NAMES, isPhasedTool, type PhaseReport } from '../callPhases';

/**
 * The Server-Timing header of an authenticated read that reports its phases (`get_context`, `search_memory`).
 *
 * It names durations and phases and nothing else: no query, no text, no result. The header is written when the reply is
 * sent, and the reply's headers come before its body, so a reply that carries the header is held until its tool has
 * finished. Only those authenticated reads are held; every other reply is written as it always was.
 */

/** What one request's timing collects: the bearer check, then the tool call that runs inside the request. */
export interface RequestTiming {
  authMs: number;
  tool?: { totalMs: number; phases: PhaseReport; cache?: 'hit' | 'miss' };
}

/** The timing of the request whose tool call is running now (set by the handler, filled in by the tool wrapper). */
export const requestTiming = new AsyncLocalStorage<RequestTiming>();

/** Whether a JSON-RPC body calls one of the phased reads. */
export function phasedToolCalled(body: unknown): boolean {
  const call = body as { method?: unknown; params?: { name?: unknown } } | null;
  return Boolean(
    call && typeof call === 'object' && call.method === 'tools/call'
      && typeof call.params?.name === 'string' && isPhasedTool(call.params.name),
  );
}

/** The header's value: the bearer check, then the engine's whole call and each phase it measured. Numbers and names only. */
export function serverTimingValue(timing: RequestTiming): string {
  const parts = [`auth;dur=${timing.authMs.toFixed(1)}`];
  if (timing.tool) {
    parts.push(`engine;dur=${timing.tool.totalMs.toFixed(1)}`);
    for (const name of PHASE_NAMES) {
      const ms = timing.tool.phases[name];
      if (ms !== undefined) parts.push(`${name};dur=${ms.toFixed(1)}`);
    }
    if (timing.tool.cache) parts.push(`query_cache;desc="${timing.tool.cache}"`);
  }
  return parts.join(', ');
}

/**
 * For an authenticated phased read: the timing the tool fills in, and the reply held until the tool has finished, so its
 * headers can carry the phases. Null for every other request, whose reply is left alone.
 */
export function serverTimingFor(req: express.Request, res: express.Response, authInfo: unknown): RequestTiming | null {
  if (!authInfo || !phasedToolCalled(req.body)) return null;
  const timing: RequestTiming = { authMs: (req as express.Request & { authMs?: number }).authMs ?? 0 };
  holdUntilDone(res, () => ({ 'server-timing': serverTimingValue(timing) }));
  return timing;
}

/**
 * A reply's headers as an object, whichever form the transport wrote them in: Node takes an object or a flat list of name and
 * value pairs. The pairs are merged here, so the extra header is added to all of them. A name that repeats keeps every value,
 * as Node's own writeHead does.
 */
function objectHeaders(headers: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(headers)) return headers as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  for (let i = 0; i + 1 < headers.length; i += 2) {
    const name = String(headers[i]).toLowerCase();
    const previous = out[name];
    out[name] = previous === undefined ? headers[i + 1] : [...[previous].flat(), headers[i + 1]];
  }
  return out;
}

/**
 * Holds a reply's headers and body until it ends, then writes them with the extra headers that are known by then. The
 * transport's own writes are kept in order and replayed unchanged.
 */
function holdUntilDone(res: express.Response, extraHeaders: () => Record<string, string>): void {
  const realWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => express.Response;
  const realWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const realEnd = res.end.bind(res) as (...args: unknown[]) => express.Response;
  const realFlushHeaders = res.flushHeaders.bind(res);
  let held: { status?: number; reason?: string; headers?: unknown; writes: unknown[][] } | null = { writes: [] };

  res.writeHead = ((status: number, ...rest: unknown[]) => {
    if (!held) return realWriteHead(status, ...rest);
    held.status = status;
    if (typeof rest[0] === 'string') {
      held.reason = rest[0];
      held.headers = objectHeaders(rest[1]);
    } else {
      held.headers = objectHeaders(rest[0]);
    }
    return res;
  }) as unknown as typeof res.writeHead;

  res.write = ((...args: unknown[]) => {
    if (!held) return (realWrite as (...a: unknown[]) => boolean)(...args);
    held.writes.push(args);
    return true;
  }) as unknown as typeof res.write;

  res.flushHeaders = (() => {
    if (!held) realFlushHeaders();
  }) as typeof res.flushHeaders;

  res.end = ((...args: unknown[]) => {
    if (!held) return realEnd(...args);
    const chunk = args[0];
    const callback = args.find((arg) => typeof arg === 'function');
    if (chunk !== undefined && typeof chunk !== 'function') held.writes.push(args.filter((arg) => typeof arg !== 'function'));
    const done = held;
    held = null;
    const headers = {
      ...res.getHeaders(),
      ...(typeof done.headers === 'object' && done.headers !== null ? (done.headers as Record<string, string>) : {}),
      ...extraHeaders(),
    };
    if (done.reason !== undefined) realWriteHead(done.status ?? res.statusCode, done.reason, headers);
    else realWriteHead(done.status ?? res.statusCode, headers);
    for (const write of done.writes) realWrite(...write);
    return realEnd(callback);
  }) as unknown as typeof res.end;
}
