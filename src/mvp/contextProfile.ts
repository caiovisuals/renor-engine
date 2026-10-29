import fs from 'node:fs';

/**
 * A context-engineering profile for the HTTP server's agent surface: four levers, each off unless its variable is set,
 * so a benchmark arm (scripts/eval/agent-tasks/) can change one at a time and a lever that wins can ship as a default
 * later. Off, the server is exactly what it was: the same instructions, listing and replies.
 *
 *   RENOR_MCP_TOOLS              comma-separated tool names: only these are listed and run (the others are disabled in
 *                                the SDK's registry, as a directory client's hidden tools are). `lean` names the
 *                                LEAN_TOOLS preset instead;
 *   RENOR_MCP_DESCRIPTIONS_FILE  a JSON object {tool: description}: those tools are listed with that description;
 *   RENOR_MCP_INSTRUCTIONS_FILE  a UTF-8 file: its text replaces the server instructions an agent is given;
 *   RENOR_MCP_RESPONSE           `lines`: get_context, search_memory and search_text answer one line per fact or memory
 *                                (`date | text`) instead of JSON. structuredContent, where a reply carries it, is unchanged.
 *                                `toon`: successful search_memory replies use fixed TOON; all other tools stay JSON.
 *
 * Read when each MCP server is built. A file that cannot be read or parsed, or a tool name the server does not have,
 * fails that build: an arm must never run with a lever silently off.
 */
export interface ContextProfile {
  tools?: Set<string>;
  descriptions?: Record<string, string>;
  instructions?: string;
  response?: 'lines' | 'toon';
}

/**
 * The `lean` preset of RENOR_MCP_TOOLS: the eight tools the stored agent-tasks sessions called (receipts of the main-944 run:
 * 8 of the 24 renor tools in use). Narrowing the list drops the schemas of the other sixteen from every model call.
 */
export const LEAN_TOOLS = ['whats_new', 'get_context', 'search_text', 'read_memory', 'memory_map', 'search_memory', 'retrieve_memory', 'remember'];

export function contextProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ContextProfile {
  const profile: ContextProfile = {};
  const tools = env.RENOR_MCP_TOOLS?.trim();
  if (tools === 'lean') profile.tools = new Set(LEAN_TOOLS);
  else if (tools) profile.tools = new Set(tools.split(',').map(t => t.trim()).filter(Boolean));
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
    if (response !== 'lines' && response !== 'toon') throw new Error(`RENOR_MCP_RESPONSE takes lines or toon, not ${response}`);
    profile.response = response;
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

interface Item { text?: unknown; session_date?: unknown; headingPath?: unknown; notePath?: unknown; replaced?: unknown; matched?: unknown; untrusted?: unknown; origin?: unknown }

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
interface Fact { subject?: unknown; predicate?: unknown; object?: unknown; scope?: unknown; untrusted?: unknown; origin?: unknown; writerConflict?: unknown; current?: unknown }

/** The trust marks a line must keep: `untrusted` and `import` are what tell a reader the text is a claim, not the owner's word. */
const trustMarks = (x: { untrusted?: unknown; origin?: unknown }): string[] => [x.untrusted === true ? '(untrusted)' : '', x.origin === 'import' ? '(import)' : ''].filter(Boolean);

function factLine(prefix: string, f: Fact): string {
  const marks = [...trustMarks(f), typeof f.writerConflict === 'string' && f.writerConflict ? `(writerConflict: ${f.writerConflict.replace(/\s*\n\s*/g, ' ')})` : ''].filter(Boolean);
  return `${prefix} | ${marks.length ? `${marks.join(' ')} ` : ''}${String(f.subject)} ${String(f.predicate)}: ${String(f.object)}${typeof f.scope === 'string' && f.scope !== 'global' ? ` (${f.scope})` : ''}`;
}

/**
 * A read's JSON reply as lines: current facts first (`fact | subject predicate: object`), then each memory or hit in the
 * reply's own order (`date | text`, `(untrusted)` and `(import)` kept on every line that carries them, `conflict |` lines and `(writerConflict: …)` on a fact, the date being session_date or the day of its daily note, `(replaced)` on one a later save corrected, `(not matched)` on one the query did not
 * match). A reply that is not a read's JSON, or that refuses (ok: false), is returned as it is.
 */
export function renderLines(text: string): string {
  let body: { ok?: unknown; facts?: Fact[]; conflicts?: Fact[]; memories?: Item[]; hits?: Item[]; results?: Item[]; note?: unknown; error?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof body !== 'object' || body === null || body.ok === false) return text;
  const lines: string[] = [];
  for (const f of Array.isArray(body.facts) ? body.facts : []) {
    lines.push(factLine('fact', f));
  }
  // Current values that disagree with a returned fact: an open disagreement the reader must see.
  for (const c of Array.isArray(body.conflicts) ? body.conflicts : []) {
    lines.push(typeof c.subject === 'string' ? factLine('conflict', c) : `conflict | ${JSON.stringify(c)}`);
  }
  const items = Array.isArray(body.memories) ? body.memories : Array.isArray(body.hits) ? body.hits : Array.isArray(body.results) ? body.results : [];
  for (const m of items) {
    if (typeof m.text !== 'string') continue;
    const marks = [...trustMarks(m), m.replaced ? '(replaced)' : '', m.matched === false ? '(not matched)' : ''].filter(Boolean).join(' ');
    lines.push(`${dateOf(m)} | ${marks ? `${marks} ` : ''}${m.text.replace(/\s*\n\s*/g, ' ')}`);
  }
  return lines.length === 0 ? 'nothing found' : lines.join('\n');
}
