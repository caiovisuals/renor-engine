import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrument } from '@posthog/mcp';
import { PostHog } from 'posthog-node';
import { createHash } from 'node:crypto';
import { telemetryInstanceId } from './telemetry';

/** Shape of the payload passed to @posthog/mcp beforeSend (not re-exported by the package). */
export type McpAnalyticsCaptureEvent = {
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  type: 'capture';
};

/**
 * PostHog MCP Analytics (@posthog/mcp) for the production MVP server.
 *
 * Privacy defaults match Renor's contract: never capture tool args, results,
 * memory content, queries, or model/conversation text. Instrumentation is a
 * no-op when RENOR_POSTHOG_KEY is missing or RENOR_TELEMETRY_DISABLED=true.
 */

const DEFAULT_HOST = 'https://us.i.posthog.com';

/** Property keys that may carry args/results/content — always stripped. */
const STRIP_EXACT = new Set([
  '$mcp_parameters',
  '$mcp_response',
  '$mcp_intent',
  '$mcp_error_message',
  '$mcp_feedback_details',
  '$mcp_feedback_summary',
  '$mcp_feedback_suggested_improvement',
  '$mcp_feedback_friction_points',
  '$mcp_tool_description',
  'args',
  'arguments',
  'params',
  'parameters',
  'result',
  'response',
  'content',
  'query',
  'statement',
  'text',
  'body',
  'message',
]);

const STRIP_SUBSTRING = [
  'parameter',
  'argument',
  'response',
  'content',
  'query',
  'statement',
  'memory',
  'prompt',
  'exception_message',
  'exception_stack',
];

let client: PostHog | null | undefined;
let shutdownHookInstalled = false;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function remoteDisabled(): boolean {
  return env('RENOR_TELEMETRY_DISABLED').toLowerCase() === 'true';
}

function pseudonymousDistinctId(instance: string): string {
  const salt = env('RENOR_TELEMETRY_HASH_SALT');
  return createHash('sha256')
    .update(`renor-telemetry:\0${salt}\0${instance}`)
    .digest('hex')
    .slice(0, 24);
}

/** Testable privacy filter — strips args/results/content; keeps tool/ok/duration. */
export function redactMcpAnalyticsEvent(
  event: McpAnalyticsCaptureEvent,
): McpAnalyticsCaptureEvent | null {
  if (!event || typeof event !== 'object') return null;
  // Exception siblings can embed stack/message text — drop entirely.
  if (event.event === '$exception') return null;

  const properties = { ...(event.properties ?? {}) };
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (STRIP_EXACT.has(key) || STRIP_EXACT.has(lower)) {
      delete properties[key];
      continue;
    }
    if (STRIP_SUBSTRING.some((needle) => lower.includes(needle))) {
      // Keep known-safe metadata keys even if they contain a substring match.
      if (
        key === '$mcp_is_error' ||
        key === '$mcp_duration_ms' ||
        key === '$mcp_tool_name' ||
        key === '$mcp_client_name' ||
        key === '$mcp_client_version' ||
        key === '$mcp_server_name' ||
        key === '$mcp_server_version' ||
        key === '$mcp_protocol_version' ||
        key === '$mcp_listed_tool_names' ||
        key === '$mcp_source' ||
        key === '$groups' ||
        key === '$process_person_profile' ||
        key === 'service'
      ) {
        continue;
      }
      delete properties[key];
    }
  }

  return {
    distinct_id: event.distinct_id,
    event: event.event,
    timestamp: event.timestamp,
    type: 'capture',
    properties,
  };
}

function getOrCreateClient(): PostHog | null {
  if (client !== undefined) return client;
  if (remoteDisabled()) {
    client = null;
    return null;
  }
  const apiKey = env('RENOR_POSTHOG_KEY');
  if (!apiKey) {
    client = null;
    return null;
  }
  const host = env('RENOR_POSTHOG_HOST') || DEFAULT_HOST;
  try {
    client = new PostHog(apiKey, {
      host,
      // Privacy: do not capture IP / personal profiles by default.
      disableGeoip: true,
    });
  } catch {
    client = null;
  }
  return client;
}

function installShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  // Best-effort: cli.ts also awaits shutdownPosthogMcp on SIGINT/SIGTERM.
  // This covers process paths that skip the CLI handler.
  const onSignal = () => {
    void shutdownPosthogMcp();
  };
  process.once('beforeExit', onSignal);
}

/**
 * Instrument one McpServer instance (call inside buildMcpServer — SSE builds
 * a fresh server per session). No-ops when PostHog is disabled/unconfigured.
 */
export function instrumentMcpServer(server: McpServer): void {
  try {
    const posthog = getOrCreateClient();
    if (!posthog) return;

    const tenant = telemetryInstanceId();
    const distinctId = pseudonymousDistinctId(tenant);

    instrument(server, posthog, {
      context: false,
      enableConversationId: false,
      captureModel: false,
      enableExceptionAutocapture: false,
      identify: async () => ({
        distinctId,
        // The workspace as PostHog's `tenant` group, filed under the same salted hash as the distinct id and
        // never under the slug: a slug made before opaque workspace names is the owner's email local part.
        groups: tenant && tenant !== 'unknown' ? { tenant: distinctId } : undefined,
        properties: {
          service: 'renor-core',
          $process_person_profile: false,
        },
      }),
      eventProperties: async () => ({
        service: 'renor-core',
        $process_person_profile: false,
      }),
      beforeSend: redactMcpAnalyticsEvent,
      logger: () => {
        // STDIO-safe: discard SDK warnings (HTTP MVP uses stderr only if needed).
      },
    });
    installShutdownHook();
  } catch {
    // Observability must never break the product.
  }
}

/** Flush + stop the shared posthog-node client (SIGINT/SIGTERM). */
export async function shutdownPosthogMcp(): Promise<void> {
  const current = client;
  client = null;
  if (!current) return;
  try {
    await current.shutdown();
  } catch {
    // ignore
  }
}

/** Test helper: reset singleton between hermetic tests. */
export function resetPosthogMcpForTests(): void {
  client = undefined;
  shutdownHookInstalled = false;
}
