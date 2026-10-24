import fs from 'node:fs';

/**
 * A context-engineering profile for the HTTP server's agent surface: four levers, each off unless its variable is set,
 * so a benchmark arm (scripts/eval/agent-tasks/) can change one at a time and a lever that wins can ship as a default
 * later. Off, the server is exactly what it was: the same instructions, listing and replies.
 *
 *   RENOR_MCP_TOOLS              comma-separated tool names: only these are listed and run (the others are disabled in
 *                                the SDK's registry, as a directory client's hidden tools are);
 *   RENOR_MCP_DESCRIPTIONS_FILE  a JSON object {tool: description}: those tools are listed with that description;
 *   RENOR_MCP_INSTRUCTIONS_FILE  a UTF-8 file: its text replaces the server instructions an agent is given;
 *   RENOR_MCP_RESPONSE           `lines`: get_context, search_memory and search_text answer one line per fact or memory
 *                                (`date | text`) instead of JSON. structuredContent, where a reply carries it, is unchanged.
 *
 * Read when each MCP server is built. A file that cannot be read or parsed, or a tool name the server does not have,
 * fails that build: an arm must never run with a lever silently off.
 */
export interface ContextProfile {
  tools?: Set<string>;
  descriptions?: Record<string, string>;
  instructions?: string;
  response?: 'lines';
}

export function contextProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ContextProfile {
  const profile: ContextProfile = {};
  const tools = env.RENOR_MCP_TOOLS?.trim();
  if (tools) profile.tools = new Set(tools.split(',').map(t => t.trim()).filter(Boolean));
  const descriptions = env.RENOR_MCP_DESCRIPTIONS_FILE?.trim();
  if (descriptions) {
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptions, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string' || v.trim() === '')) {
      throw new Error('RENOR_MCP_DESCRIPTIONS_FILE must hold a JSON object of tool name to a non-empty description');
    }
    profile.descriptions = parsed as Record<string, string>;
  }
  const instructions = env.RENOR_MCP_INSTRUCTIONS_FILE?.trim();
  if (instructions) {
    const text = fs.readFileSync(instructions, 'utf8').trim();
    if (!text) throw new Error('RENOR_MCP_INSTRUCTIONS_FILE is empty');
    profile.instructions = text;
  }
  const response = env.RENOR_MCP_RESPONSE?.trim();
  if (response) {
    if (response !== 'lines') throw new Error(`RENOR_MCP_RESPONSE takes lines, not ${response}`);
    profile.response = 'lines';
  }
  return profile;
}

/** Fail the build on a profile that names a tool the server does not have: a typo would otherwise switch a lever off. */
export function checkProfileTools(profile: ContextProfile, registered: string[]): void {
  const known = new Set(registered);
  for (const name of [...(profile.tools ?? []), ...Object.keys(profile.descriptions ?? {})]) {
    if (!known.has(name)) throw new Error(`the context profile names ${name}, which this server does not register`);
  }
}

export const LINE_TOOLS = new Set(['get_context', 'search_memory', 'search_text']);

interface Item { text?: unknown; session_date?: unknown; headingPath?: unknown; notePath?: unknown; replaced?: unknown; matched?: unknown }

const DAY = /\d{4}-\d{2}-\d{2}/;

/** The item's date: its session_date, else the day its daily note is filed under (headingPath, then notePath). */
function dateOf(m: Item): string {
  if (typeof m.session_date === 'string') return m.session_date;
  for (const v of [m.headingPath, m.notePath]) {
    const day = typeof v === 'string' ? v.match(DAY)?.[0] : undefined;
    if (day) return day;
  }
  return 'undated';
}
interface Fact { subject?: unknown; predicate?: unknown; object?: unknown; scope?: unknown }

/**
 * A read's JSON reply as lines: current facts first (`fact | subject predicate: object`), then each memory or hit in the
 * reply's own order (`date | text`, the date being session_date or the day of its daily note, `(replaced)` on one a later save corrected, `(not matched)` on one the query did not
 * match). A reply that is not a read's JSON, or that refuses (ok: false), is returned as it is.
 */
export function renderLines(text: string): string {
  let body: { ok?: unknown; facts?: Fact[]; memories?: Item[]; hits?: Item[]; note?: unknown; error?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof body !== 'object' || body === null || body.ok === false) return text;
  const lines: string[] = [];
  for (const f of Array.isArray(body.facts) ? body.facts : []) {
    lines.push(`fact | ${String(f.subject)} ${String(f.predicate)}: ${String(f.object)}${typeof f.scope === 'string' && f.scope !== 'global' ? ` (${f.scope})` : ''}`);
  }
  const items = Array.isArray(body.memories) ? body.memories : Array.isArray(body.hits) ? body.hits : [];
  for (const m of items) {
    if (typeof m.text !== 'string') continue;
    const marks = [m.replaced ? '(replaced)' : '', m.matched === false ? '(not matched)' : ''].filter(Boolean).join(' ');
    lines.push(`${dateOf(m)} | ${marks ? `${marks} ` : ''}${m.text.replace(/\s*\n\s*/g, ' ')}`);
  }
  return lines.length === 0 ? 'nothing found' : lines.join('\n');
}
