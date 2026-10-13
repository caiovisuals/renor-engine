import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  redactMcpAnalyticsEvent,
  resetPosthogMcpForTests,
  instrumentMcpServer,
  shutdownPosthogMcp,
  type McpAnalyticsCaptureEvent,
} from '../../src/mvp/posthogMcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const ENV_KEYS = [
  'MVP_INSTANCE_ID',
  'RENOR_POSTHOG_KEY',
  'RENOR_POSTHOG_HOST',
  'RENOR_TELEMETRY_HASH_SALT',
  'RENOR_TELEMETRY_DISABLED',
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetPosthogMcpForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
  resetPosthogMcpForTests();
});

function sampleEvent(
  overrides: Partial<McpAnalyticsCaptureEvent> = {},
): McpAnalyticsCaptureEvent {
  return {
    distinct_id: 'abc123',
    event: '$mcp_tool_call',
    timestamp: new Date().toISOString(),
    type: 'capture',
    properties: {
      $mcp_tool_name: 'remember',
      $mcp_is_error: false,
      $mcp_duration_ms: 12,
      $mcp_parameters: { statement: 'SECRET_MEMORY', query: 'leak' },
      $mcp_response: { content: [{ type: 'text', text: 'SECRET' }] },
      $mcp_intent: 'user asked about private stuff',
      $mcp_error_message: 'path /home/user/Memory leaked',
      service: 'renor-core',
    },
    ...overrides,
  };
}

describe('PostHog MCP privacy beforeSend', () => {
  it('strips parameters, response, and content-bearing fields', () => {
    const out = redactMcpAnalyticsEvent(sampleEvent());
    expect(out).not.toBeNull();
    expect(out!.properties.$mcp_tool_name).toBe('remember');
    expect(out!.properties.$mcp_is_error).toBe(false);
    expect(out!.properties.$mcp_duration_ms).toBe(12);
    expect(out!.distinct_id).toBe('abc123');
    expect(out!.properties).not.toHaveProperty('$mcp_parameters');
    expect(out!.properties).not.toHaveProperty('$mcp_response');
    expect(out!.properties).not.toHaveProperty('$mcp_intent');
    expect(out!.properties).not.toHaveProperty('$mcp_error_message');
    expect(JSON.stringify(out)).not.toMatch(/SECRET|Memory leaked|private stuff/i);
  });

  it('drops $exception siblings', () => {
    expect(
      redactMcpAnalyticsEvent(
        sampleEvent({ event: '$exception', properties: { $exception_message: 'boom' } }),
      ),
    ).toBeNull();
  });

  it('skips instrument when key missing or telemetry disabled', () => {
    const server = new McpServer({ name: 'renor-test', version: '0.0.0' });
    // Must not throw.
    instrumentMcpServer(server);

    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    process.env.RENOR_TELEMETRY_DISABLED = 'true';
    resetPosthogMcpForTests();
    instrumentMcpServer(server);
  });
});

/**
 * The workspace name is the account's own label for a workspace, and for every workspace made before opaque names it
 * is the part of the owner's email before the "@". The group PostHog files an event under is part of what leaves the
 * process, so it must be the same hashed id the distinct id already is, never the name.
 *
 * Read from the bytes the PostHog client really posts (its fetch is a stub that keeps them), not from the options the
 * wrapper passes to the library: a later change to the library's own payload would otherwise slip past a check of the
 * options alone.
 */
describe('PostHog MCP analytics: the workspace leaves only as its hashed id', () => {
  type PostedEvent = { event: string; distinct_id: string; properties: Record<string, unknown> };

  /** What a request body says as text, whether the client sent it as a string or gzipped it (posthog-node does). */
  async function bodyText(body: unknown): Promise<string> {
    if (typeof body === 'string') return body;
    const bytes = Buffer.from(await new Response(body as BodyInit).arrayBuffer());
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  }

  /** One tool call through an instrumented server, with every request the PostHog client makes kept. */
  async function callOneToolAndCollect(): Promise<{ raw: string[]; events: PostedEvent[] }> {
    const raw: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      raw.push(await bodyText(init?.body));
      return new Response('{"status":1}', { status: 200 });
    }));
    resetPosthogMcpForTests();

    const server = new McpServer({ name: 'renor-test', version: '0.0.0' });
    instrumentMcpServer(server);
    server.registerTool('probe', { description: 'probe' }, async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'renor-test-client', version: '0.0.0' });
    await client.connect(clientSide);
    await client.callTool({ name: 'probe', arguments: {} });
    await client.close();
    await shutdownPosthogMcp();

    const events: PostedEvent[] = [];
    for (const text of raw) {
      const body = JSON.parse(text) as { batch?: PostedEvent[] } & Partial<PostedEvent>;
      if (Array.isArray(body.batch)) events.push(...body.batch);
      else if (typeof body.event === 'string') events.push(body as PostedEvent);
    }
    return { raw, events };
  }

  function configure(instance: string | undefined): void {
    if (instance !== undefined) process.env.MVP_INSTANCE_ID = instance;
    process.env.RENOR_POSTHOG_KEY = 'phc_test';
    process.env.RENOR_POSTHOG_HOST = 'http://127.0.0.1:9';
    process.env.RENOR_TELEMETRY_HASH_SALT = 'test-salt';
  }

  it('files every event under the hashed id and posts the workspace name nowhere', async () => {
    configure('jane-doe');
    const { raw, events } = await callOneToolAndCollect();

    // Not vacuous: the tool call was really captured, and it carries a group.
    const grouped = events.filter((e) => e.properties.$groups !== undefined);
    expect(grouped.length).toBeGreaterThan(0);

    for (const e of grouped) {
      const groups = e.properties.$groups as Record<string, string>;
      expect(Object.keys(groups)).toEqual(['tenant']);
      // The same 24 hex characters the distinct id is, so one workspace is one pseudonym in every stream.
      expect(groups.tenant).toMatch(/^[0-9a-f]{24}$/);
      expect(groups.tenant).toBe(e.distinct_id);
    }
    // Nothing the client posts, in any field, spells the name or a piece of it.
    expect(raw.join('\n')).not.toMatch(/jane/i);
  });

  it('files no group at all when the process does not know which workspace it serves', async () => {
    configure(undefined);
    const { events } = await callOneToolAndCollect();

    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.properties.$groups !== undefined)).toEqual([]);
  });
});
