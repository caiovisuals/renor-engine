import { createHash, randomBytes } from 'node:crypto';
import { PHASE_NAMES, type PhaseReport } from '../callPhases';
import { isToolErrorReason, type ToolErrorReason } from '../toolRefusal';

/**
 * Privacy-safe product telemetry for Renor MVP.
 *
 * Local stdout remains the canonical operational log. Optional remote sinks
 * (PostHog, Sentry and Langfuse/OTLP) receive metadata only: event names,
 * success/failure, latency and a pseudonymous instance id.
 *
 * `emitTelemetry` is where that is enforced: every line is built by `cleanEvent` from values it has checked, never from the
 * object the caller handed in, so an event or a field is not written until `cleanEvent` lists it.
 *
 * NEVER add memory content, queries, prompts, conversations, credentials,
 * tokens, paths, email addresses or arbitrary exception messages here.
 */
export type TelemetryEvent =
  | {
      event: 'tool_use';
      tool: string;
      ok: boolean;
      ms: number;
      error_kind?: (typeof TOOL_ERROR_KINDS)[number];
      /**
       * Why the call was refused, from the closed set in src/toolRefusal.ts and next to `error_kind`, which
       * says only how the call ended. A code is always a literal from that set: anything else is dropped below,
       * so a message, a statement or a path can never arrive here as a "reason".
       */
      error_reason?: ToolErrorReason;
      /**
       * Where a get_context or search_memory call spent its time (callPhases.ts): milliseconds per phase, from a closed list of
       * names, numbers and nothing else. For the local log only: it is not forwarded to PostHog, Sentry or Langfuse, which get
       * this event exactly as they did before phases existed.
       */
      phases?: PhaseReport;
    }
  | {
      event: 'auth';
      kind: (typeof AUTH_KINDS)[number];
    }
  | {
      event: 'session';
      kind: (typeof SESSION_KINDS)[number];
      /**
       * On `mcp_init` only: an opaque id for the one SSE session that opened, so its `first_call` can be joined to it. It is
       * random per connection and is never the session's bearer or its transport id. Absent before the release that adds it.
       */
      session?: string;
    }
  // The first tool call a session made, when the call reached a handler (a call the schema refused is `tool_rejected`).
  // `recall` is whether the tool reads stored memory back (RECALL_TOOLS); `session` is the id its `mcp_init` carried.
  | {
      event: 'first_call';
      tool: string;
      recall: boolean;
      session: string;
    }
  // Whether a read helped (readUsefulness.ts). Counts and opaque ids only: `read` and `ids` are keyed hashes the engine
  // made up, never anything of a memory.
  | {
      event: 'read';
      tool: (typeof READ_TOOLS)[number];
      read: string;
      relevant: boolean;
      judged: boolean;
      items: number;
      ids: string[];
    }
  | {
      event: 'read_used';
      tool: (typeof READ_TOOLS)[number];
      read: string;
      via: (typeof USE_VIAS)[number];
      after_s: number;
    }
  | {
      /**
       * A call the tool's input schema refused, so no handler ran and there is no `tool_use` for it. `arg` is the first
       * argument that failed, as the schema names it (absent when the arguments as a whole were refused); `kind` is how.
       * Neither is ever a value the caller sent.
       */
      event: 'tool_rejected';
      tool: string;
      arg?: string;
      kind: RejectionKind;
    };

/**
 * How a tool's input schema refused a call: a CLOSED set, so a kind can name the family of the failure and nothing the
 * caller wrote. `missing`: the argument (or all of them) was absent. `wrong_type`: present, but not the type the
 * schema takes (a number sent as a string, a null). `too_small` / `too_big`: under a minimum or over a maximum, of a length
 * or of a value. `invalid_value`: not one of the values the schema lists. `invalid_format`: not the format it takes
 * (a UUID, a pattern). `other`: any refusal this list has no word for.
 */
export const REJECTION_KINDS = ['missing', 'wrong_type', 'too_small', 'too_big', 'invalid_value', 'invalid_format', 'other'] as const;
export type RejectionKind = (typeof REJECTION_KINDS)[number];

type TelemetryLine = TelemetryEvent & {
  ts: string;
  instance: string;
};

const SAFE_TOOL = /^[a-z][a-z0-9_]{0,64}$/;
const SAFE_ARG = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const OPAQUE_ID = /^[0-9a-f]{8}$/;
const SESSION_ID = /^[0-9a-f]{16}$/;
/** Ids a `read` event lists, as many as readUsefulness.ts lists: `items` still counts them all. */
const MAX_EVENT_IDS = 20;

// The values a field that is not free text may take. The type of each field is made from its list, so the two cannot part.
const TOOL_ERROR_KINDS = ['validation', 'unavailable', 'internal', 'auth', 'other'] as const;
const AUTH_KINDS = ['login_ok', 'login_fail', 'token_ok', 'token_fail'] as const;
const SESSION_KINDS = ['mcp_init', 'mcp_close'] as const;
const READ_TOOLS = ['get_context', 'search_memory', 'retrieve_memory'] as const;
const USE_VIAS = ['read', 'cite', 'update'] as const;

/**
 * The tools that read stored memory back to the agent: the usage report's "memory read" tools (docs/USAGE-METRICS.md) and
 * read_memory. A first call to one of them is a recall. Decided here, from the tool's name, so no caller can set the flag.
 */
export const RECALL_TOOLS = [
  'get_context', 'search_memory', 'search_text', 'search_history', 'retrieve_memory', 'lookup_entity', 'export_memory', 'read_memory',
] as const;
export function isRecallTool(tool: string): boolean {
  return (RECALL_TOOLS as readonly string[]).includes(tool);
}

/**
 * The `clientInfo.name` the platform's own MCP calls present: the gateway's dashboard import (engine/apps/gateway/src/dashboard-import.ts)
 * and the dashboard's memory inventory (supabase/functions/memory-inventory/renor-tenant.ts). A session that presents one is the
 * platform acting for a person, not an agent reaching for memory, so the recall share leaves it out. The name is what the client
 * declares about itself: a client that declares one only drops its own session from the share, and nothing else follows from it.
 */
const PLATFORM_CLIENT_NAMES: ReadonlySet<string> = new Set(['renor-dashboard', 'renor-dashboard-import']);

/** True when an `initialize` request names a platform client (see PLATFORM_CLIENT_NAMES). Reads the body; keeps nothing from it. */
export function isPlatformInitialize(body: unknown): boolean {
  const params = typeof body === 'object' && body !== null ? (body as { params?: unknown }).params : undefined;
  const clientInfo = typeof params === 'object' && params !== null ? (params as { clientInfo?: unknown }).clientInfo : undefined;
  const name = typeof clientInfo === 'object' && clientInfo !== null ? (clientInfo as { name?: unknown }).name : undefined;
  return typeof name === 'string' && PLATFORM_CLIENT_NAMES.has(name);
}

const READ_FIELDS = ['event', 'tool', 'read', 'relevant', 'judged', 'items', 'ids'];
const READ_USED_FIELDS = ['event', 'tool', 'read', 'via', 'after_s'];
const FIRST_CALL_FIELDS = ['event', 'tool', 'recall', 'session'];

/** Exactly these keys and no other: a field nobody listed is a field nobody reviewed, so the event is dropped whole. */
function hasOnlyFields(payload: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(payload);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

const isOpaqueId = (value: unknown): value is string => typeof value === 'string' && OPAQUE_ID.test(value);
const isSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSafeTool = (value: unknown): value is string => typeof value === 'string' && SAFE_TOOL.test(value);

/** An argument name as the tools declare them: an identifier. Anything else is left unnamed, and the call is still counted. */
export function isSafeArgName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_ARG.test(name);
}

/** The longest a phase may have taken, a day: anything above it is not a duration anyone measured. */
const MAX_PHASE_MS = 86_400_000;

/**
 * `value` as a NEW object of phase timings, or undefined. Each name of the closed list is read once and kept only as a finite
 * number in range, rounded to a tenth of a millisecond; a name nobody listed is not read at all. One value that fails its
 * check drops the whole report (the call itself is still counted), never part of it.
 */
function cleanPhases(value: unknown): PhaseReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const given = value as Record<string, unknown>;
  const phases: PhaseReport = {};
  for (const name of PHASE_NAMES) {
    const ms: unknown = given[name];
    if (ms === undefined) continue;
    if (!isFiniteNumber(ms) || ms < 0 || ms > MAX_PHASE_MS) return undefined;
    phases[name] = Math.round(ms * 10) / 10;
  }
  return Object.keys(phases).length > 0 ? phases : undefined;
}

/** The member of `allowed` that `value` is, or undefined. Only a string can be one, and what comes back is the list's own string. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' ? allowed.find(member => member === value) : undefined;
}

/**
 * `ids` as a NEW array of opaque ids, or null. It walks the indexes itself and never asks the array anything: an array can carry
 * its own `every` or `toJSON`, and `every` skips a hole that JSON.stringify writes as `null`. Each element is read once and what
 * is kept is the element as it was checked.
 */
function opaqueIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const length: unknown = value.length;
  if (typeof length !== 'number' || !(length <= MAX_EVENT_IDS)) return null;
  const ids: string[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return null;
    const id: unknown = value[index];
    if (!isOpaqueId(id)) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * The one door out: what is written is what comes out of here. The payload belongs to the caller, so it is only read: each field
 * once, into a local, and checked by its TYPE (a regex or an `includes` on an object coerces it through its own toString and
 * passes, while JSON.stringify then writes the object out as it is). The event that leaves is a NEW object made of those checked
 * values, so nothing the caller still owns can reach a sink: not a field nobody listed, not an accessor that answers differently
 * the second time, not an array's own `every` or `toJSON`. A value that fails its check drops the whole event; a read event
 * is dropped for a field nobody listed too, where the older events just leave that field out.
 */
function cleanEvent(payload: TelemetryEvent): TelemetryEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const fields = payload as unknown as Record<string, unknown>;
  switch (fields.event) {
    case 'tool_use': {
      const { tool, ok, ms, error_kind, error_reason, phases: rawPhases } = fields;
      if (!isSafeTool(tool) || typeof ok !== 'boolean' || !isFiniteNumber(ms)) return null;
      const errorKind = error_kind === undefined ? undefined : oneOf(error_kind, TOOL_ERROR_KINDS);
      if (error_kind !== undefined && !errorKind) return null;
      // The closed set is the whole gate for a reason: anything that is not one of its literals is dropped
      // rather than logged, so no code can be a message, a statement or a path however it was produced. A
      // dropped reason leaves the call counted, exactly as it was before reasons existed.
      const errorReason = isToolErrorReason(error_reason) ? error_reason : undefined;
      // Likewise a report that does not check is dropped and the call is still counted, as it was before phases existed.
      const phases = rawPhases === undefined ? undefined : cleanPhases(rawPhases);
      return {
        event: 'tool_use',
        tool,
        ok,
        ms,
        ...(errorKind ? { error_kind: errorKind } : {}),
        ...(errorReason ? { error_reason: errorReason } : {}),
        ...(phases ? { phases } : {}),
      };
    }
    case 'auth': {
      const kind = oneOf(fields.kind, AUTH_KINDS);
      return kind ? { event: 'auth', kind } : null;
    }
    case 'session': {
      const { kind: rawKind, session } = fields;
      const kind = oneOf(rawKind, SESSION_KINDS);
      if (!kind) return null;
      if (session === undefined) return { event: 'session', kind };
      return isSessionId(session) ? { event: 'session', kind, session } : null;
    }
    // A session's first tool call: the tool, whether it is a recall and the opaque id of the session. Nothing else: not the
    // call's arguments, its result or its timing. `recall` must be the tool's own answer from RECALL_TOOLS, or the event is dropped.
    case 'first_call': {
      if (!hasOnlyFields(fields, FIRST_CALL_FIELDS)) return null;
      const { tool, recall, session } = fields;
      if (!isSafeTool(tool) || typeof recall !== 'boolean' || recall !== isRecallTool(tool) || !isSessionId(session)) return null;
      return { event: 'first_call', tool, recall, session };
    }
    // A rejection line may name a tool and an argument and say how it failed, from the closed set: nothing else gets out.
    case 'tool_rejected': {
      const { tool, arg, kind } = fields;
      const rejection = oneOf(kind, REJECTION_KINDS);
      if (!isSafeTool(tool) || !rejection) return null;
      if (arg === undefined) return { event: 'tool_rejected', tool, kind: rejection };
      return isSafeArgName(arg) ? { event: 'tool_rejected', tool, arg, kind: rejection } : null;
    }
    // The read-usefulness events carry nothing but counts and opaque ids.
    case 'read': {
      if (!hasOnlyFields(fields, READ_FIELDS)) return null;
      const { tool, read, relevant, judged, items, ids } = fields;
      const readTool = oneOf(tool, READ_TOOLS);
      const opaque = opaqueIds(ids);
      if (!readTool || !isOpaqueId(read) || typeof relevant !== 'boolean' || typeof judged !== 'boolean' || !isCount(items) || !opaque) return null;
      return { event: 'read', tool: readTool, read, relevant, judged, items, ids: opaque };
    }
    case 'read_used': {
      if (!hasOnlyFields(fields, READ_USED_FIELDS)) return null;
      const { tool, read, via, after_s } = fields;
      const readTool = oneOf(tool, READ_TOOLS);
      const usedVia = oneOf(via, USE_VIAS);
      if (!readTool || !isOpaqueId(read) || !usedVia || !isCount(after_s)) return null;
      return { event: 'read_used', tool: readTool, read, via: usedVia, after_s };
    }
    default:
      return null;
  }
}

const pendingRemote = new Set<Promise<void>>();

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function remoteDisabled(): boolean {
  return env('RENOR_TELEMETRY_DISABLED').toLowerCase() === 'true';
}

function pseudonymousInstance(instance: string): string {
  const salt = env('RENOR_TELEMETRY_HASH_SALT');
  return createHash('sha256')
    .update(`renor-telemetry:\0${salt}\0${instance}`)
    .digest('hex')
    .slice(0, 24);
}

function isFailure(line: TelemetryLine): boolean {
  if (line.event === 'tool_use') return !line.ok;
  if (line.event === 'auth') return line.kind.endsWith('_fail');
  return false;
}

function safeTimeoutMs(): number {
  const parsed = Number(env('RENOR_TELEMETRY_TIMEOUT_MS') || '1500');
  if (!Number.isFinite(parsed)) return 1500;
  return Math.min(5000, Math.max(250, Math.trunc(parsed)));
}

async function postJson(
  url: string,
  init: RequestInit & { body: string },
): Promise<void> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(safeTimeoutMs()),
    });
    await response.body?.cancel();
  } catch {
    // Remote observability must never affect Renor availability.
  }
}

function posthogEndpoint(): string {
  const explicit = env('RENOR_POSTHOG_CAPTURE_URL');
  if (explicit) return explicit;
  const host = env('RENOR_POSTHOG_HOST') || 'https://us.i.posthog.com';
  return `${host.replace(/\/$/, '')}/i/v0/e/`;
}

async function sendPostHog(line: TelemetryLine): Promise<void> {
  const apiKey = env('RENOR_POSTHOG_KEY');
  if (!apiKey) return;

  const { event, instance: _instance, ts, ...properties } = line;
  await postJson(posthogEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      distinct_id: pseudonymousInstance(line.instance),
      event: `renor_${event}`,
      timestamp: ts,
      properties: {
        service: 'renor-core',
        $process_person_profile: false,
        ...properties,
      },
    }),
  });
}

function sentryEnvelopeEndpoint(dsn: string): string | null {
  try {
    const parsed = new URL(dsn);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const projectId = parts.pop();
    if (!projectId || !/^\d+$/.test(projectId)) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return `${parsed.origin}${prefix}/api/${projectId}/envelope/`;
  } catch {
    return null;
  }
}

async function sendSentry(line: TelemetryLine): Promise<void> {
  if (!isFailure(line)) return;

  const dsn = env('RENOR_SENTRY_DSN');
  if (!dsn) return;
  const endpoint = sentryEnvelopeEndpoint(dsn);
  if (!endpoint) return;

  const eventId = randomBytes(16).toString('hex');
  const tags: Record<string, string> = {
    service: 'renor-core',
    event: line.event,
    instance_id: pseudonymousInstance(line.instance),
  };
  const extra: Record<string, boolean | number | string> = {};

  if (line.event === 'tool_use') {
    tags.tool = line.tool;
    tags.error_kind = line.error_kind ?? 'other';
    extra.ok = line.ok;
    extra.ms = line.ms;
    if (line.error_reason) tags.error_reason = line.error_reason;
  } else if (line.event === 'auth') {
    tags.kind = line.kind;
  }

  const payload = {
    event_id: eventId,
    timestamp: line.ts,
    level: 'error',
    platform: 'node',
    message: 'Renor operational failure',
    tags,
    extra,
  };
  const envelope =
    JSON.stringify({ event_id: eventId, sent_at: line.ts, dsn }) +
    '\n' +
    JSON.stringify({ type: 'event' }) +
    '\n' +
    JSON.stringify(payload);

  await postJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body: envelope,
  });
}

type OtlpAttribute = {
  key: string;
  value: {
    stringValue?: string;
    boolValue?: boolean;
    intValue?: string;
  };
};

function otlpAttributes(line: TelemetryLine): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [
    { key: 'renor.event', value: { stringValue: line.event } },
    {
      key: 'renor.instance_id',
      value: { stringValue: pseudonymousInstance(line.instance) },
    },
  ];

  if (line.event === 'tool_use') {
    attrs.push(
      { key: 'renor.tool', value: { stringValue: line.tool } },
      { key: 'renor.ok', value: { boolValue: line.ok } },
      { key: 'renor.duration_ms', value: { intValue: String(Math.max(0, Math.trunc(line.ms))) } },
    );
    if (line.error_kind) {
      attrs.push({ key: 'renor.error_kind', value: { stringValue: line.error_kind } });
    }
    if (line.error_reason) {
      attrs.push({ key: 'renor.error_reason', value: { stringValue: line.error_reason } });
    }
  } else if (line.event === 'auth') {
    attrs.push({ key: 'renor.auth_kind', value: { stringValue: line.kind } });
  } else if (line.event === 'tool_rejected') {
    attrs.push(
      { key: 'renor.tool', value: { stringValue: line.tool } },
      { key: 'renor.rejection_kind', value: { stringValue: line.kind } },
    );
    if (line.arg) attrs.push({ key: 'renor.rejected_arg', value: { stringValue: line.arg } });
  } else if (line.event === 'session') {
    attrs.push({ key: 'renor.session_kind', value: { stringValue: line.kind } });
  }

  return attrs;
}

async function sendLangfuse(line: TelemetryLine): Promise<void> {
  // A trace span per call; a read-usefulness event is a count, and PostHog takes it. A first call is already a tool_use span.
  if (line.event === 'read' || line.event === 'read_used' || line.event === 'first_call') return;
  const publicKey = env('LANGFUSE_PUBLIC_KEY');
  const secretKey = env('LANGFUSE_SECRET_KEY');
  if (!publicKey || !secretKey) return;

  const host = (env('LANGFUSE_HOST') || 'https://cloud.langfuse.com').replace(/\/$/, '');
  const endMs = Date.parse(line.ts);
  if (!Number.isFinite(endMs)) return;
  const durationMs = line.event === 'tool_use' ? Math.max(0, line.ms) : 0;
  const startMs = Math.max(0, endMs - durationMs);
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const suffix =
    line.event === 'tool_use' || line.event === 'tool_rejected' ? line.tool :
    line.event === 'auth' || line.event === 'session' ? line.kind :
    'read';

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'renor-core' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'renor.telemetry', version: '1' },
            spans: [
              {
                traceId,
                spanId,
                name: `renor.${line.event}.${suffix}`,
                startTimeUnixNano: String(BigInt(Math.trunc(startMs)) * 1_000_000n),
                endTimeUnixNano: String(BigInt(Math.trunc(endMs)) * 1_000_000n),
                attributes: otlpAttributes(line),
                status: { code: isFailure(line) ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };

  await postJson(`${host}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      'content-type': 'application/json',
      'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(body),
  });
}

async function forwardRemote(line: TelemetryLine): Promise<void> {
  if (remoteDisabled()) return;
  await Promise.allSettled([
    sendPostHog(line),
    sendSentry(line),
    sendLangfuse(line),
  ]);
}

function dispatchRemote(line: TelemetryLine): void {
  const task = forwardRemote(line).finally(() => pendingRemote.delete(task));
  pendingRemote.add(task);
}

export function telemetryInstanceId(): string {
  const raw = (process.env.MVP_INSTANCE_ID ?? 'unknown').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(raw) ? raw : 'unknown';
}

/** The line as the remote sinks get it: phase timings are for the local log, so the event leaves exactly as it always did. */
function forRemote(line: TelemetryLine): TelemetryLine {
  if (line.event !== 'tool_use' || line.phases === undefined) return line;
  const { phases: _local, ...rest } = line;
  return rest;
}

export function emitTelemetry(payload: TelemetryEvent): void {
  try {
    const event = cleanEvent(payload);
    if (!event) return;
    const line: TelemetryLine = {
      ts: new Date().toISOString(),
      instance: telemetryInstanceId(),
      ...event,
    };
    console.log(JSON.stringify(line));
    dispatchRemote(forRemote(line));
  } catch {
    // Telemetry must never break the product.
  }
}

/** Primarily for orderly shutdowns and deterministic tests. */
export async function flushTelemetry(): Promise<void> {
  await Promise.allSettled([...pendingRemote]);
}
