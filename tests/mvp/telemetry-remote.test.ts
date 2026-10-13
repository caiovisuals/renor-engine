import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTelemetry, flushTelemetry } from '../../src/mvp/telemetry';

const ENV_KEYS = [
  'MVP_INSTANCE_ID',
  'RENOR_POSTHOG_KEY',
  'RENOR_POSTHOG_HOST',
  'RENOR_POSTHOG_CAPTURE_URL',
  'RENOR_SENTRY_DSN',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_HOST',
  'RENOR_TELEMETRY_HASH_SALT',
  'RENOR_TELEMETRY_DISABLED',
] as const;

// Hermetic env isolation: telemetry sinks are configured from process.env by
// design, so any key present in the ambient shell environment (e.g. real
// LANGFUSE_PUBLIC_KEY/SECRET_KEY) leaks into the first test and dispatches an
// extra remote fetch. Clear the keys BEFORE each test, not only after.
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  await flushTelemetry();
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 200 }));
}

describe('MVP remote telemetry', () => {
  it('forwards metadata-only tool outcomes to current PostHog ingestion', async () => {
    process.env.MVP_INSTANCE_ID = 'alpha-one';
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    process.env.RENOR_TELEMETRY_HASH_SALT = 'test-salt';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_use', tool: 'remember', ok: true, ms: 17 });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('renor_tool_use');
    expect(body.distinct_id).toMatch(/^[0-9a-f]{24}$/);
    expect(body.distinct_id).not.toContain('alpha-one');
    expect(body.properties).toMatchObject({
      service: 'renor-core',
      tool: 'remember',
      ok: true,
      ms: 17,
      $process_person_profile: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/query|memory content|conversation|secret/i);
  });

  it('sends Sentry events only for operational failures', async () => {
    process.env.MVP_INSTANCE_ID = 'alpha-two';
    process.env.RENOR_SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/12345';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_use', tool: 'get_context', ok: true, ms: 9 });
    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();

    emitTelemetry({
      event: 'tool_use',
      tool: 'get_context',
      ok: false,
      ms: 11,
      error_kind: 'internal',
    });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://o0.ingest.sentry.io/api/12345/envelope/');
    const body = String(init.body);
    expect(body).toContain('Renor operational failure');
    expect(body).toContain('get_context');
    expect(body).toContain('internal');
    expect(body).not.toContain('alpha-two');
  });

  it('exports privacy-safe OTLP spans to Langfuse v4', async () => {
    process.env.MVP_INSTANCE_ID = 'alpha-three';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'auth', kind: 'login_ok' });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-langfuse-ingestion-version']).toBe('4');
    expect(headers.authorization).toMatch(/^Basic /);

    const body = JSON.parse(String(init.body));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe('renor.auth.login_ok');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(span)).not.toContain('sk-lf-test');
    expect(JSON.stringify(span)).not.toContain('alpha-three');
  });

  it('forwards a schema-rejected call to PostHog as the tool, the argument and the kind, and nothing else', async () => {
    process.env.MVP_INSTANCE_ID = 'alpha-four';
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_rejected', tool: 'remember', arg: 'statement', kind: 'missing' });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.event).toBe('renor_tool_rejected');
    expect(body.properties).toEqual({
      service: 'renor-core',
      tool: 'remember',
      arg: 'statement',
      kind: 'missing',
      $process_person_profile: false,
    });
  });

  it('does not send a schema-rejected call to Sentry: it is the caller\'s mistake, not an operational failure', async () => {
    process.env.RENOR_SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/12345';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_rejected', tool: 'remember', arg: 'statement', kind: 'wrong_type' });
    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();

    // The same sink does take a failure, so the silence above is the event's, not a misconfigured test.
    emitTelemetry({ event: 'tool_use', tool: 'remember', ok: false, ms: 3, error_kind: 'other' });
    await flushTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exports a schema-rejected call as a span named for the tool, with its own attributes and no error status', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_rejected', tool: 'memory_map', arg: 'limit', kind: 'too_big' });
    emitTelemetry({ event: 'tool_rejected', tool: 'get_context', kind: 'missing' });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const spans = calls.map(([, init]) => JSON.parse(String(init.body)).resourceSpans[0].scopeSpans[0].spans[0]);
    const withArg = spans.find((s) => s.name === 'renor.tool_rejected.memory_map');
    const withoutArg = spans.find((s) => s.name === 'renor.tool_rejected.get_context');
    expect(withArg).toBeTruthy();
    expect(withoutArg).toBeTruthy();
    const attrs = (span: { attributes: Array<{ key: string; value: { stringValue?: string } }> }) =>
      Object.fromEntries(span.attributes.map((a) => [a.key, a.value.stringValue]));
    expect(attrs(withArg)).toMatchObject({ 'renor.event': 'tool_rejected', 'renor.tool': 'memory_map', 'renor.rejection_kind': 'too_big', 'renor.rejected_arg': 'limit' });
    expect(attrs(withArg)).not.toHaveProperty('renor.session_kind');
    expect(attrs(withoutArg)).not.toHaveProperty('renor.rejected_arg');
    // The caller's mistake is not a failure of the service, so the span is not marked as an error (OTLP: 1 is OK, 2 is ERROR).
    expect(withArg.status.code).toBe(1);
  });

  it('writes a schema-rejected call only when it names a tool and an argument and a kind from the closed set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_rejected', tool: 'remember', arg: 'statement', kind: 'missing' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: 'tool_rejected', tool: 'remember', arg: 'statement', kind: 'missing' });

    // None of these is a name from a schema or a kind from the set: each is dropped whole rather than logged.
    emitTelemetry({ event: 'tool_rejected', tool: '../etc/passwd', arg: 'statement', kind: 'missing' });
    emitTelemetry({ event: 'tool_rejected', tool: 'remember', arg: 'my own words about a secret', kind: 'missing' });
    emitTelemetry({ event: 'tool_rejected', tool: 'remember', arg: 'statement', kind: 'Invalid input: a user sentence' as never });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('honors the remote telemetry kill switch while retaining local telemetry', async () => {
    process.env.RENOR_TELEMETRY_DISABLED = 'true';
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    process.env.RENOR_SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/12345';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    emitTelemetry({ event: 'tool_use', tool: 'remember', ok: true, ms: 1 });
    await flushTelemetry();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('"event":"tool_use"');
  });
});

// ---- the line is written from what was checked, never from the object the caller handed in ---------------------------

const CANARY = 'HOSTILE-CANARY-EGRESS';
// Reads as `name` when a regex or an `includes` coerces it through its own toString, and writes the canary out when serialised.
const readsAs = (name: string) => ({ toString: () => name, secret: CANARY });
const serialisesAsText = () => ({ toJSON: () => CANARY });

const SESSION = '0123456789abcdef';
const READ = { event: 'read', tool: 'get_context', read: 'abcdef01', relevant: true, judged: true, items: 2, ids: ['01234567', '89abcdef'] };
const idsOf = (count: number) => Array.from({ length: count }, (_, i) => i.toString(16).padStart(8, '0'));

/** One of each event the engine writes, built the way its callers build it. */
const LEGIT: Array<[string, Record<string, unknown>]> = [
  ['a tool call', { event: 'tool_use', tool: 'remember', ok: true, ms: 17 }],
  ['a failed tool call', { event: 'tool_use', tool: 'remember', ok: false, ms: 3, error_kind: 'internal' }],
  ['a login', { event: 'auth', kind: 'login_ok' }],
  ['a session', { event: 'session', kind: 'mcp_init' }],
  ['a session, with the opaque id it opened under', { event: 'session', kind: 'mcp_init', session: SESSION }],
  ['a session close', { event: 'session', kind: 'mcp_close' }],
  ['a session\'s first call, a recall', { event: 'first_call', tool: 'get_context', recall: true, session: SESSION }],
  ['a session\'s first call, not a recall', { event: 'first_call', tool: 'remember', recall: false, session: SESSION }],
  ['a rejected call', { event: 'tool_rejected', tool: 'remember', arg: 'statement', kind: 'missing' }],
  ['a rejected call that names no argument', { event: 'tool_rejected', tool: 'get_context', kind: 'other' }],
  ['a read', READ],
  ['a read that lists the most ids it may', { ...READ, items: 20, ids: idsOf(20) }],
  ['a read that was used', { event: 'read_used', tool: 'search_memory', read: 'abcdef01', via: 'cite', after_s: 5 }],
];

/** Every value here passes a check that coerces it, or is a shape `every` and JSON.stringify read differently. */
const DROPPED: Array<[string, () => unknown]> = [
  ['a rejected call whose tool reads as a tool name', () => ({ event: 'tool_rejected', tool: readsAs('search_memory'), kind: 'missing' })],
  ['a rejected call whose argument reads as an argument name', () => ({ event: 'tool_rejected', tool: 'search_memory', arg: readsAs('query'), kind: 'missing' })],
  ['a tool call whose tool reads as a tool name', () => ({ event: 'tool_use', tool: readsAs('get_context'), ok: true, ms: 1 })],
  ['a tool call whose ok serialises as text', () => ({ event: 'tool_use', tool: 'get_context', ok: serialisesAsText(), ms: 1 })],
  ['a tool call whose ms is text', () => ({ event: 'tool_use', tool: 'get_context', ok: true, ms: CANARY })],
  ['a tool call whose ms is not a finite number', () => ({ event: 'tool_use', tool: 'get_context', ok: true, ms: Number.NaN })],
  ['a tool call whose error_kind is text outside the closed set', () => ({ event: 'tool_use', tool: 'get_context', ok: false, ms: 1, error_kind: CANARY })],
  ['an auth event whose kind is text', () => ({ event: 'auth', kind: CANARY })],
  ['an auth event whose kind serialises as text', () => ({ event: 'auth', kind: serialisesAsText() })],
  ['a session event whose kind is text', () => ({ event: 'session', kind: CANARY })],
  // A session's id is the one thing that could be matched to a connection, so it is an id of exactly the engine's form or nothing.
  ['a session event whose id is text', () => ({ event: 'session', kind: 'mcp_init', session: CANARY })],
  ['a session event whose id is the right length but not hex', () => ({ event: 'session', kind: 'mcp_init', session: 'ZZZZZZZZZZZZZZZZ' })],
  ['a session event whose id reads as an id through toString', () => ({ event: 'session', kind: 'mcp_init', session: readsAs(SESSION) })],
  ['a session event whose id serialises as text', () => ({ event: 'session', kind: 'mcp_init', session: serialisesAsText() })],
  ['a first call whose tool reads as a tool name', () => ({ event: 'first_call', tool: readsAs('get_context'), recall: true, session: SESSION })],
  ['a first call whose recall flag is not the tool\'s own answer', () => ({ event: 'first_call', tool: 'remember', recall: true, session: SESSION })],
  ['a first call whose recall flag is text', () => ({ event: 'first_call', tool: 'get_context', recall: CANARY, session: SESSION })],
  ['a first call whose id is text', () => ({ event: 'first_call', tool: 'get_context', recall: true, session: CANARY })],
  ['a first call that carries the query it answered', () => ({ event: 'first_call', tool: 'get_context', recall: true, session: SESSION, query: CANARY })],
  ['a read whose ids array carries its own every', () => ({ ...READ, ids: Object.assign([{ secret: CANARY }], { every: () => true }) })],
  ['a read whose ids array has a hole', () => ({ ...READ, ids: Object.assign(new Array<string>(3), { 0: '01234567', 2: '89abcdef' }) })],
  ['a read whose ids array is all holes', () => ({ ...READ, ids: new Array<string>(2) })],
  // An element the array only answers with, though it does not hold it, is not one the caller put there.
  ['a read whose ids array answers a hole with an id', () => ({ ...READ, ids: new Proxy(Object.assign(new Array<string>(3), { 0: '01234567', 2: '89abcdef' }), { get: (target, key) => (key === '1' ? '45670123' : Reflect.get(target, key)) }) })],
  ['a read that lists more ids than it may', () => ({ ...READ, items: 21, ids: idsOf(21) })],
  // The walk is bounded by a length read once as a number: an object here would be coerced again on every turn of the loop.
  ['a read whose ids array answers its length with an object', () => ({ ...READ, ids: new Proxy(['01234567'], { get: (target, key) => (key === 'length' ? { valueOf: () => 1 } : Reflect.get(target, key)) }) })],
  ['an event nobody listed', () => ({ event: 'memory_text', text: CANARY })],
];

/** A payload whose every field gives its real value the first time it is read and a hostile object every time after. */
function answersOnce(fields: Record<string, unknown>): object {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    let reads = 0;
    Object.defineProperty(payload, key, { enumerable: true, get: () => (reads++ === 0 ? value : { secret: CANARY }) });
  }
  return payload;
}

/** Arms every sink, emits the payloads, and returns all that left the process: the stdout lines and the bodies sent on. */
async function leaving(...payloads: unknown[]) {
  process.env.RENOR_POSTHOG_KEY = 'phc_test';
  process.env.RENOR_SENTRY_DSN = 'https://publickey@o0.ingest.sentry.io/12345';
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
  process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
  const fetchMock = okFetch();
  vi.stubGlobal('fetch', fetchMock);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const payload of payloads) emitTelemetry(payload as never);
  await flushTelemetry();
  const lines = log.mock.calls.map((args) => String(args[0]));
  const bodies = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(([, init]) => String(init.body));
  return { lines, bodies, wire: [...lines, ...bodies].join('\n') };
}

describe('MVP telemetry writes what it checked, never the object it was handed', () => {
  it.each(LEGIT)('writes %s exactly as it was given, to stdout and to the remote sinks', async (_what, event) => {
    const out = await leaving(event);
    expect(out.lines).toHaveLength(1);
    const { ts: _ts, instance: _instance, ...written } = JSON.parse(out.lines[0]);
    expect(written).toEqual(event);
    expect(out.bodies.length).toBeGreaterThan(0);
  });

  it.each(DROPPED)('drops %s whole and sends nothing to any sink', async (_what, build) => {
    const out = await leaving(build());
    expect(out.wire).not.toContain(CANARY);
    expect(out.lines).toEqual([]);
    expect(out.bodies).toEqual([]);
  });

  it('writes the ids by the elements the array holds, not by a toJSON the array carries', async () => {
    const ids = Object.assign(['01234567', '89abcdef'], { toJSON: () => ({ secret: CANARY }) });
    const out = await leaving({ ...READ, ids });
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0]).ids).toEqual(['01234567', '89abcdef']);
    expect(out.wire).not.toContain(CANARY);
  });

  it.each(LEGIT)('reads each field of %s once: what it sends is the value it checked', async (_what, event) => {
    const out = await leaving(answersOnce(event));
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0])).toMatchObject(event);
    expect(out.wire).not.toContain(CANARY);
  });

  // `ts` and `instance` are the engine's own: a payload that names them must not replace them. A read event and a first call
  // are dropped whole when a field is unlisted (hasOnlyFields), so they are pinned by the DROPPED table instead.
  const LEAVES_FIELD_OUT = ['read', 'read_used', 'first_call'];
  it.each(LEGIT.filter(([, event]) => !LEAVES_FIELD_OUT.includes(String(event.event))))('leaves a field nobody listed out of %s', async (_what, event) => {
    const out = await leaving({ ...event, query: CANARY, nested: { secret: CANARY }, ts: CANARY, instance: CANARY });
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0])).not.toHaveProperty('query');
    expect(out.wire).not.toContain(CANARY);
  });
});
