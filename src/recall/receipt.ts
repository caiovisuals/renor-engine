/**
 * Memory receipts: when automatic recall (autoRecall.ts) put memories into the agent's context, one line in the chat
 * tells the user that it did, for example
 *
 *   Renor recalled 3: 2 notes (Oct 18, Oct 19), 1 fact
 *
 * Opt-in and off by default (RENOR_RECALL_RECEIPT=1), and only ever shown by a recall hook that is itself on and
 * injected something. The line carries counts and dates only, never text from a memory or a fact: a memory's own
 * words can be anything the user saved (a PIN, a diagnosis), and a terminal line is seen by whoever is looking at the
 * screen and kept in stream-json logs. The user reads what was recalled with the agent, which has it in context.
 *
 * Claude Code shows a hook's `systemMessage` to the user and gives `hookSpecificOutput.additionalContext` to the model
 * only (code.claude.com/docs/en/hooks, "JSON output"), so runHook puts the line in `systemMessage`.
 *
 * Only Node built-ins, like autoRecall.ts: the plugin ships the compiled dist/recall/ directory.
 */

/** One injected line, as the receipt counts it: what kind, and the day it was saved when the reply gave one. */
export interface Recalled {
  kind: 'fact' | 'memory';
  /** ISO date or timestamp (get_context's session_date). */
  date?: string;
}

export const MAX_DATES = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whether the receipt is on: only RENOR_RECALL_RECEIPT=1 (or on/true/yes). Unset, it is off. */
export function receiptOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.RENOR_RECALL_RECEIPT?.trim() ?? '');
}

/** "Oct 18", or "Oct 18 2025" outside `now`'s year (UTC); null for a missing or invalid date. */
export function receiptDate(value: string | undefined, now: Date = new Date()): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The receipt line for what was injected, or null when nothing was. Notes first with up to MAX_DATES distinct dates
 * (then "+N more"), then facts. Built from counts and dates only.
 */
export function formatReceipt(recalled: readonly Recalled[], now: Date = new Date()): string | null {
  if (!Array.isArray(recalled) || recalled.length === 0) return null;
  const notes = recalled.filter(r => r.kind === 'memory');
  const facts = recalled.length - notes.length;
  const dates = [...new Set(notes.map(n => receiptDate(n.date, now)).filter((d): d is string => d !== null))];
  const shown = dates.slice(0, MAX_DATES).join(', ') + (dates.length > MAX_DATES ? `, +${dates.length - MAX_DATES} more` : '');
  const parts = [
    ...(notes.length ? [`${count(notes.length, 'note', 'notes')}${shown ? ` (${shown})` : ''}`] : []),
    ...(facts ? [count(facts, 'fact', 'facts')] : []),
  ];
  return `Renor recalled ${recalled.length}: ${parts.join(', ')}`;
}
