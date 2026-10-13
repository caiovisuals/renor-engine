/**
 * Why an MCP tool refused a call: a CLOSED set of short, stable snake_case codes, one per refusal a caller
 * can act on.
 *
 * Every failed tool call used to reach telemetry as `error_kind: "other"`, so one user's day read as "13 of
 * 152 calls failed" with nothing to act on: no way to tell an over-long statement from an unknown memory id
 * from a path that escapes the vault. `error_kind` says how the call ended (it is a dashboard field and its
 * values never change); this says why it was refused, next to it, as `error_reason`.
 *
 * The rules this file exists to keep:
 *
 * - A code is a FIXED LITERAL from the list below. Nothing here is ever built from an argument, a statement,
 *   a file, an exception message or a path, so no code can carry what the user said or wrote.
 * - The list is closed: `isToolErrorReason` is the only way a code reaches telemetry, so a free-form string
 *   (an exception message, say) is dropped rather than logged.
 * - Refusal sites name their code where the refusal is decided, and the code travels out of band — in a
 *   WeakMap beside the thrown error, or beside a refusal result the tool builds itself — instead of being
 *   parsed back out of a message or added as a property. The error keeps the class, `name` and keys it had
 *   before; the message still goes to the agent; the code never leaves this vocabulary.
 * - Anything with no better code gets `refused`; an unexpected throw gets `internal`.
 */

export const TOOL_ERROR_REASONS = [
  /** An unexpected throw: a defect, not a refusal. */
  'internal',
  /** A refusal with no more specific code in this set. */
  'refused',
  /** A required argument was absent or empty. */
  'missing_argument',
  /** An argument was present but unusable as sent. */
  'invalid_argument',
  /** A scope was not `global`, `scope:<slug>` or `project:<slug>`. */
  'invalid_scope',
  /** A field was longer than the bound that stores it (memory/limits.ts, lifecycle FIELD_LIMITS). */
  'field_too_long',
  /** Text that cannot be stored or framed as text: control characters, an unpaired surrogate, a NUL byte. */
  'invalid_text',
  /** A path that escapes the memory directory, hides a segment, crosses a symlink, or is not a memory. */
  'unsafe_path',
  /** The memory id named nothing (it may have been retired). */
  'memory_not_found',
  /** That memory was already retired. */
  'memory_already_retired',
  /** A restore would overwrite a file that now occupies the path. */
  'restore_conflict',
  /** An import batch or preview is unknown or has expired. */
  'batch_not_found',
  /** The batch was already applied, failed or undone; it cannot be applied again. */
  'batch_already_applied',
  /** The batch was larger than the import byte bounds allow. */
  'import_too_large',
  /** A file the import would not admit (not a Markdown file). */
  'unsupported_import_format',
  /** The batch named the same relative path twice. */
  'duplicate_import_path',
  /** Too many previews are pending in this workspace; apply or wait for one to expire. */
  'too_many_previews',
  /** The deployment cannot answer this way right now (no semantic search, no keyword index, no history). */
  'capability_unavailable',
  /** The same, while the index is being rebuilt: it answers again once that finishes. */
  'capability_rebuilding',
  /** A search query the keyword index could not read as a query. */
  'invalid_query',
] as const;

export type ToolErrorReason = (typeof TOOL_ERROR_REASONS)[number];

/** The only gate a code passes to reach telemetry: membership in the closed set, nothing else. */
export function isToolErrorReason(value: unknown): value is ToolErrorReason {
  return typeof value === 'string' && (TOOL_ERROR_REASONS as readonly string[]).includes(value);
}

/**
 * The code an error carries, out of band: a WeakMap leaves no property to serialize, so the error keeps the
 * identity it had before this vocabulary existed — its class, `name`, `message` and enumerable keys — and the
 * code reaches telemetry only. Nothing about `String(err)`, a log line or an `instanceof` check changes.
 */
const errorReasons = new WeakMap<Error, ToolErrorReason>();

/**
 * Shorthand for the refusal sites: `throw refusal('invalid_scope', '…')`. The error is a PLAIN `Error`, exactly
 * what the site threw before; only the message (unchanged) and the out-of-band code are kept.
 */
export function refusal(reason: ToolErrorReason, message: string): Error {
  return markErrorReason(new Error(message), reason);
}

/** Records the code an error carries, out of band. Used by `refusal` and by an error class that names its own. */
export function markErrorReason<T extends Error>(err: T, reason: ToolErrorReason): T {
  errorReasons.set(err, reason);
  return err;
}

/**
 * The code an error carries, or undefined when it carries none.
 *
 * Read from the out-of-band WeakMap rather than a property, so an error class that already exists
 * (LifecycleInputError, say) names its code without gaining a field and without losing its own identity to the
 * callers that check `instanceof` — and no error ever grows a `reason` key a reply or a log line could show.
 */
export function refusalReason(err: unknown): ToolErrorReason | undefined {
  return err instanceof Error ? errorReasons.get(err) : undefined;
}

/**
 * A tool result built by a refusal path carries its code here, beside the result and never inside it: a
 * WeakMap leaves no property to serialize, so the code cannot ride out to the agent, into a log line or into
 * a remote sink by accident. The tool wrapper reads it and the code goes to telemetry only.
 */
const reasons = new WeakMap<object, ToolErrorReason>();

export function markToolRefusal<T extends object>(result: T, reason: ToolErrorReason): T {
  reasons.set(result, reason);
  return result;
}

/** The code a refusal result carries, if any. */
export function toolRefusalOf(result: unknown): ToolErrorReason | undefined {
  return result !== null && typeof result === 'object' ? reasons.get(result) : undefined;
}