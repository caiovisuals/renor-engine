import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getObjectShape, safeParseAsync, type AnyObjectSchema, type AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { emitTelemetry, isSafeArgName, type RejectionKind } from './telemetry';

/**
 * Counting the calls a tool's input schema refuses.
 *
 * The SDK checks a call's arguments against the tool's schema BEFORE it runs the handler, and answers a failed check itself
 * (an `isError` result reading "Input validation error: ..."). `tracedTool` wraps the handler, so a call refused that way never
 * reached it and left no trace: nothing could say how often agents were turned away at the door, or by which argument.
 *
 * The SDK has no hook for this, so this wraps the one method that does the check, `validateToolInput` (private in its typings,
 * an ordinary method at run time), on one server instance, the way server.ts already wraps `registerTool`. The wrapper calls
 * the SDK's own method and rethrows what it threw, so the client reads exactly the answer it always did; it only looks at the
 * failure on its way past. tests/mvp/schema-rejected-calls.test.ts pins both halves (the line is written, the answer is
 * unchanged) against the real service, so an SDK upgrade that renames the method fails there instead of silently counting nothing.
 *
 * Privacy (binding, see telemetry.ts): the line carries the tool, the NAME of the first argument that failed and a kind from a
 * closed set. The name is taken from the tool's own schema, never from the call, and the value the caller sent is looked at only
 * to tell "absent" from "wrong", never kept.
 */

/** What the SDK passes `validateToolInput`: the registered tool, whose schema is the one that refused the call. */
interface ValidatedTool {
  inputSchema?: AnySchema;
}
type ValidateToolInput = (tool: ValidatedTool, args: unknown, toolName: string) => Promise<unknown>;

/**
 * Wraps `server` so that each call its tools' schemas refuse is counted as one `tool_rejected` event. `onRefused` hears the
 * tool's name for each such call, before the event is written: a refused call is still a call (a session's first call).
 */
export function countSchemaRejections(server: McpServer, onRefused?: (tool: string) => void): void {
  const sdk = server as unknown as { validateToolInput?: ValidateToolInput };
  const validate = sdk.validateToolInput;
  if (typeof validate !== 'function') return;
  sdk.validateToolInput = async (tool, args, toolName) => {
    try {
      return await validate.call(server, tool, args, toolName);
    } catch (err) {
      // Inside this method the SDK throws InvalidParams for one thing only: the arguments failed the schema (an unknown or
      // disabled tool is refused before it is reached). Anything else is a defect of the schema itself, not a refusal.
      if ((err as { code?: unknown } | null)?.code === ErrorCode.InvalidParams) {
        onRefused?.(toolName);
        await recordRejection(tool, args, toolName);
      }
      throw err;
    }
  };
}

async function recordRejection(tool: ValidatedTool, args: unknown, toolName: string): Promise<void> {
  // The SDK has refused the call, so it is counted whatever happens next: a failure to say more leaves the kind at `other`.
  let described: { arg?: string; kind: RejectionKind } = { kind: 'other' };
  try {
    described = await describeFailure(tool, args);
  } catch {
    // Observability must never change what the caller reads.
  }
  emitTelemetry({ event: 'tool_rejected', tool: toolName, ...described });
}

interface Issue {
  code: string;
  path: ReadonlyArray<PropertyKey>;
}

/**
 * Which argument the schema refused first and how, read from the issues the SDK's own parse yields (the same function, on
 * the same schema and the same arguments, so the same verdict). Issues follow the schema's own order, so "first" is stable.
 */
async function describeFailure(tool: ValidatedTool, args: unknown): Promise<{ arg?: string; kind: RejectionKind }> {
  if (!tool.inputSchema) return { kind: 'other' };
  const parsed = await safeParseAsync(tool.inputSchema, args);
  if (parsed.success) return { kind: 'other' };
  const issue = firstIssue(parsed.error);
  if (!issue) return { kind: 'other' };

  // Only a name the tool's own schema declares can be an argument that failed: a key the caller invented is not one. A declared
  // name that is not a plain identifier is left out too, so the call is still counted instead of the whole line being dropped.
  const shape = getObjectShape(tool.inputSchema as AnyObjectSchema);
  const head = issue.path[0];
  const named = typeof head === 'string' && shape !== undefined && Object.prototype.hasOwnProperty.call(shape, head) && isSafeArgName(head);
  return { ...(named ? { arg: head } : {}), kind: kindOf(issue, args) };
}

function firstIssue(error: unknown): Issue | undefined {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return undefined;
  const first = issues[0] as { code?: unknown; path?: unknown } | undefined;
  if (!first || typeof first.code !== 'string' || !Array.isArray(first.path)) return undefined;
  return { code: first.code, path: first.path };
}

function kindOf(issue: Issue, args: unknown): RejectionKind {
  switch (issue.code) {
    // The schema says "invalid_type" both for an absent argument and for one of the wrong type; the call says which.
    case 'invalid_type': return valueAt(args, issue.path) === undefined ? 'missing' : 'wrong_type';
    case 'too_small': return 'too_small';
    case 'too_big': return 'too_big';
    case 'invalid_value': return 'invalid_value';
    case 'invalid_format': return 'invalid_format';
    default: return 'other';
  }
}

/** Whatever sits at `path` in what the caller sent. Only ever compared with `undefined`: it is never kept or written. */
function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}
