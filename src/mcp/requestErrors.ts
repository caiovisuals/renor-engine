import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

export function isZodError(error: unknown): error is Error & { issues: Array<{ path: PropertyKey[]; message: string }> } {
  // The SDK's schema parse throws zod v4's `$ZodError`; the transport's parse throws classic `ZodError`.
  return error instanceof Error && /ZodError$/.test(error.name) && Array.isArray((error as { issues?: unknown }).issues);
}

/**
 * A request whose params the SDK's schema refuses is answered with the error its parser threw: a ZodError has
 * no code, so the SDK sends -32603 with the issue list as its message. The client asked wrongly, so the answer is
 * -32602 with one line that names the field. The error carries the code the SDK reads (Protocol sends
 * `error.code` when it is a safe integer).
 */
export function oneLineInvalidParams(error: unknown): unknown {
  if (!isZodError(error)) return error;
  const detail = error.issues
    .map(issue => `${issue.path.map(String).join('.') || 'params'}: ${issue.message}`)
    .join('; ');
  const message = `Invalid params: ${detail}`;
  return Object.assign(new Error(message.length > 300 ? `${message.slice(0, 297)}...` : message), {
    code: ErrorCode.InvalidParams,
  });
}

/**
 * Wraps every request handler the server has registered, the SDK's own `initialize` included, so a schema refusal
 * reaches the client as -32602. The SDK keeps its handlers in a private map and parses each request inside the
 * handler it stores, so the only place a refusal can be turned into the right code is this wrapper. Call it after
 * every handler is registered and before the transport connects. An SDK that renames the map throws here at startup,
 * and the standing tests catch it before a release.
 */
export function mapInvalidParams(server: Server): void {
  const handlers = (server as unknown as { _requestHandlers: Map<string, RequestHandler> })._requestHandlers;
  for (const [method, handler] of handlers) {
    handlers.set(method, async (request, extra) => {
      try {
        return await handler(request, extra);
      } catch (error) {
        throw oneLineInvalidParams(error);
      }
    });
  }
}
