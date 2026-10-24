import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from '../db/sqlite';
import { countO200k } from '../indexer/o200k';
import { parseNote, type ParsedNote } from '../indexer/parser';
import { chunkNote } from '../indexer/chunker';
import { noteContentHash } from '../indexer/dailyEntries';
import { createOllamaChat } from '../evidence/ollamaChat';
import { splitKeyList } from '../evidence/keyPool';
import { resolveEvidenceProvider } from '../evidence/options';
import { EVIDENCE_MODEL_DEFAULT, type EvidenceChat } from '../evidence/secondPass';
import {
  orderHits,
  resolveSessionDate,
  sessionDateMs,
  type RetrievalHit,
  type RetrievalResult,
} from '../retrieval/orchestrator';
import { RouterCache } from './routerCache';

/**
 * Session router (RENOR_SESSION_ROUTER, default OFF): one model call picks the few notes that answer a question,
 * and the engine delivers those notes' own statements instead of (or beside) the retrieved chunks.
 *
 * Measured mechanism (PageIndex scout, 2026-10-03, research-only: LongMemEval-S, 36 questions the shipped retrieval
 * fails + 12 controls): a router reading one LLM-written title + summary per session picked ~2.6 sessions; delivering
 * their user statements (~1,038 tokens) answered 20/36 where every other compact arm answered 8-11/36 and the shipped
 * evidence pass 10/36, neutral on the controls. It missed its pre-registered delivery gate by one question (29/36 vs
 * 30/36), so it is an opt-in arm for a powered trial, not a default.
 *
 *   index (write time)  one model call per batch of up to 8 notes (56,000 characters) writes a title and a summary per
 *                       note into the router cache, keyed by the note's file hash, so an unchanged note is never paid
 *                       for twice. Only `renor index` / `renor rebuild` with the flag on do this.
 *   search (read time)  the notes' titles + summaries (dated, oldest first) and the question go to the router in one
 *                       call; the routed notes' statements are delivered newest first under a token budget.
 *
 * A statement is one piece of a note as the chunker cuts it, unsplit (a heading section; a daily note's entry), whose
 * content is shorter than 800 characters (PageIndex's small-node threshold). The rule is role-agnostic: on a chat
 * import it keeps the user's turns and the rare short assistant turn and drops the long assistant answers; on a
 * daily note it keeps each entry.
 *
 * Bounds: the router is shown at most ROUTER_MAX_NODES notes (above that it steps aside rather than send an unbounded
 * prompt), each title/summary is clipped, its answer is capped at ROUTER_MAX_OUTPUT_TOKENS, at most
 * ROUTER_MAX_SESSIONS notes and ROUTER_MAX_DELIVERED_TOKENS tokens are delivered, and one search makes at most
 * ROUTE_ATTEMPTS router calls, each bounded by RENOR_ROUTER_TIMEOUT_MS per attempt and RENOR_ROUTER_RETRIES
 * transport retries (defaults: 10 s and 1 retry, so a routing call gives up after about 21 s).
 *
 * Fail-open: when the router cannot answer (no model, a note without a summary, a failed or empty answer, nothing to
 * deliver) search returns the retrieved hits unchanged, and the `router` report says which of those happened, so a
 * run that lost its router is never indistinguishable from one that kept it (the issue #222 lesson).
 */

export type SessionRouterMode = 'off' | 'replace' | 'union';

/** At most this many notes are shown to the router (~102 prompt tokens per note measured, so ~20k tokens). */
export const ROUTER_MAX_NODES = 200;
/** At most this many routed notes are delivered (the study's cap). */
export const ROUTER_MAX_SESSIONS = 15;
/** Delivered statements, in gpt-tokenizer tokens. Leaves room under a 6,000-token client cap for excerpt labels. */
export const ROUTER_MAX_DELIVERED_TOKENS = 5_500;
/** A heading section whose content is shorter than this many characters is a statement. */
export const STATEMENT_MAX_CHARS = 800;
/** Output ceiling of one routing call (the cheap router measured ~240 output tokens). */
export const ROUTER_MAX_OUTPUT_TOKENS = 4_096;
export const ROUTER_TIMEOUT_MS_DEFAULT = 10_000;
/** Transport retries of a routing call when RENOR_ROUTER_RETRIES is unset (each retry backs off 1 s, 2 s, ...). */
export const ROUTER_RETRIES_DEFAULT = 1;
/** One unparseable routing answer is asked once more; a second one is a fallback. */
export const ROUTE_ATTEMPTS = 2;
const NODE_TITLE_MAX_CHARS = 200;
const NODE_SUMMARY_MAX_CHARS = 1_500;

/** Summary batching, the study's: up to 8 notes or 56,000 characters per call. */
export const SUMMARY_BATCH_MAX_NOTES = 8;
export const SUMMARY_BATCH_MAX_CHARS = 56_000;
/** A note longer than this is summarised from its first 14,000 and last 6,000 characters. */
export const SUMMARY_NOTE_MAX_CHARS = 20_000;
export const SUMMARY_MAX_OUTPUT_TOKENS = 6_000;
export const SUMMARY_TIMEOUT_MS = 180_000;
/** Transport retries of a summary call when RENOR_ROUTER_RETRIES is unset: index time is not latency-bound. */
export const SUMMARY_RETRIES_DEFAULT = 3;
/** A batch whose answer misses some notes is asked once more. */
const SUMMARY_ATTEMPTS = 2;

/**
 * The session-summary prompt, verbatim from the study (adapted there from PageIndex's generate_node_summary). Its
 * hash is part of every summary's cache key, so editing it re-summarises every note.
 */
export const SUMMARY_PROMPT_TEMPLATE = `You are building the table of contents for a person's long-term conversation memory. Below are {n} past conversations between the person ("User") and an AI assistant. Each starts with an id and a date.

For EACH conversation write a node for the table of contents:
- "title": a specific title of 4-10 words naming what the conversation is about.
- "summary": 2-4 sentences describing the main points covered. Also state every concrete personal fact, event, plan, preference, purchase, number or date that the User says about their own life (things they did, own, bought, plan, like, or need to do). Do not include generic advice given by the assistant.

Reply with ONLY this JSON, one entry per conversation, using the ids given:
{"nodes": [{"id": "<id>", "title": "...", "summary": "..."}]}

{conversations}
`;

/**
 * RENOR_SESSION_ROUTER.
 *   unset / 0 / off / false / no   off: index and search are exactly what they were (no summaries, no cache file,
 *                                  no `router` field in `search --json`)
 *   1 / on / true / yes / replace  the routed statements replace the retrieved chunks (the study's Tu arm)
 *   union                          the retrieved chunks, then the routed statements they do not already hold (BTu)
 * Anything else is refused, like RENOR_EVIDENCE_MODE: a typo must not quietly measure the control arm twice.
 */
export function resolveSessionRouterMode(env: NodeJS.ProcessEnv = process.env): SessionRouterMode {
  const raw = (env.RENOR_SESSION_ROUTER ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 'off';
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes' || raw === 'replace') return 'replace';
  if (raw === 'union') return 'union';
  throw new Error(`Invalid RENOR_SESSION_ROUTER "${raw}": must be off | replace | union`);
}

export interface SessionRouterOptions {
  mode: 'replace' | 'union';
  /** RENOR_ROUTER_MODEL, else RENOR_EVIDENCE_MODEL, else the evidence default. */
  routerModel: string;
  /** RENOR_ROUTER_SUMMARY_MODEL, else the router model. */
  summaryModel: string;
  /** RENOR_ROUTER_CACHE, else router-cache.db beside the index. */
  cachePath: string;
  /** RENOR_ROUTER_TIMEOUT_MS: one routing attempt (1 s..120 s). */
  timeoutMs: number;
  /** RENOR_ROUTER_RETRIES (0..8) for routing calls; default ROUTER_RETRIES_DEFAULT. */
  retries: number;
  /** RENOR_ROUTER_RETRIES when set, else SUMMARY_RETRIES_DEFAULT: index-time summary calls. */
  summaryRetries: number;
  /** Routing transport: absent when no key is configured. */
  routeChat?: EvidenceChat;
  /** Summary transport (index time): absent when no key is configured. */
  summaryChat?: EvidenceChat;
}

/**
 * The router's OpenAI-compatible provider. A dedicated slot first: RENOR_ROUTER_API_KEY(S) with RENOR_ROUTER_BASE_URL
 * (else the evidence base URL), so the router's model can live on another endpoint than the evidence extractor (say
 * the shipped evidence pass on Ollama and the router on Gemini). Otherwise the evidence pass's provider, as a unit:
 * RENOR_ROUTER_BASE_URL is never combined with the evidence keys, so a key is only ever sent to the endpoint it was
 * configured for. Values are never logged.
 */
export function resolveRouterProvider(env: NodeJS.ProcessEnv = process.env): { baseUrl?: string; keys: string[]; slot: 'router' | 'evidence' } {
  const keys = [...splitKeyList(env.RENOR_ROUTER_API_KEYS), ...splitKeyList(env.RENOR_ROUTER_API_KEY)];
  if (keys.length > 0) {
    return { baseUrl: env.RENOR_ROUTER_BASE_URL?.trim() || env.RENOR_EVIDENCE_BASE_URL, keys, slot: 'router' };
  }
  return { ...resolveEvidenceProvider(env), slot: 'evidence' };
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number((raw ?? '').trim());
  if ((raw ?? '').trim() === '' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Env -> options, or null when the flag is off. The provider is the evidence pass's OpenAI-compatible one
 * (RENOR_EVIDENCE_BASE_URL + RENOR_EVIDENCE_API_KEY(S) or the Ollama pool, read by the same function), so the router
 * model is one more model name on the endpoint the deployment already configured; RENOR_ROUTER_API_KEY(S) +
 * RENOR_ROUTER_BASE_URL give it an endpoint of its own (resolveRouterProvider).
 */
export function resolveSessionRouterOptions(
  config: { dbPath: string },
  env: NodeJS.ProcessEnv = process.env,
): SessionRouterOptions | null {
  const mode = resolveSessionRouterMode(env);
  if (mode === 'off') return null;
  const routerModel = env.RENOR_ROUTER_MODEL?.trim() || env.RENOR_EVIDENCE_MODEL?.trim() || EVIDENCE_MODEL_DEFAULT;
  const summaryModel = env.RENOR_ROUTER_SUMMARY_MODEL?.trim() || routerModel;
  const cachePath = env.RENOR_ROUTER_CACHE?.trim() || path.join(path.dirname(config.dbPath), 'router-cache.db');
  const timeoutMs = boundedInt(env.RENOR_ROUTER_TIMEOUT_MS, ROUTER_TIMEOUT_MS_DEFAULT, 1_000, 120_000);
  const retries = boundedInt(env.RENOR_ROUTER_RETRIES, ROUTER_RETRIES_DEFAULT, 0, 8);
  const summaryRetries = boundedInt(env.RENOR_ROUTER_RETRIES, SUMMARY_RETRIES_DEFAULT, 0, 8);
  const { baseUrl, keys } = resolveRouterProvider(env);
  return {
    mode,
    routerModel,
    summaryModel,
    cachePath,
    timeoutMs,
    retries,
    summaryRetries,
    ...(keys.length > 0
      ? {
          routeChat: createOllamaChat({ baseUrl, keys, timeoutMs, maxRetries: retries }),
          summaryChat: createOllamaChat({ baseUrl, keys, timeoutMs: SUMMARY_TIMEOUT_MS, maxRetries: summaryRetries }),
        }
      : {}),
  };
}

// ─── The notes the router may route to ───

export interface RouterNote {
  /** The note's path as the index stores it (what hits carry). */
  path: string;
  /** Absolute path inside the vault. */
  file: string;
  noteHash: string;
  date?: string;
}

/**
 * Every indexed note inside the vault except the memory ledger, oldest first (then by path). A note whose index
 * entry is unfinished (`note_hash` '') is left out: it is not searchable either.
 */
export function listRouterNotes(db: Database.Database, vaultPath: string, ledgerRelPath?: string): RouterNote[] {
  const root = path.resolve(vaultPath);
  const ledger = ledgerRelPath ? path.resolve(root, ledgerRelPath) : null;
  const rows = db.prepare("SELECT path, note_hash, frontmatter_json, modified_at FROM notes WHERE note_hash != ''")
    .all() as Array<{ path: string; note_hash: string; frontmatter_json: string; modified_at: string }>;
  const notes: Array<RouterNote & { dateMs: number }> = [];
  for (const row of rows) {
    const file = path.isAbsolute(row.path) ? path.resolve(row.path) : path.resolve(root, row.path);
    const rel = path.relative(root, file);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    if (ledger !== null && file === ledger) continue;
    const date = resolveSessionDate(row.frontmatter_json, row.modified_at);
    notes.push({ path: row.path, file, noteHash: row.note_hash, ...(date ? { date } : {}), dateMs: sessionDateMs(date) });
  }
  notes.sort((a, b) => {
    const delta = a.dateMs - b.dateMs;
    if (delta !== 0 && !Number.isNaN(delta)) return delta;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return notes.map(({ dateMs: _dateMs, ...note }) => note);
}

// ─── Index time: one title + summary per note ───

export interface SummaryBuildStats {
  model: string;
  /** Notes the router will be shown. */
  notes: number;
  /** Already in the cache: no call. */
  cached: number;
  /** Written by this run (an empty note gets its title and no call). */
  summarized: number;
  /** Left without a summary: search steps aside (`summaries-incomplete`) until a later index fills them. */
  failed: number;
  /** Summary requests this run made (a batch asked again counts twice; the transport's own retries do not count). */
  calls: number;
  promptTokens: number;
  /** Output tokens as billed (hidden thinking included when the provider reports a total). */
  completionTokens: number;
  ms: number;
  /** First failure, for the operator. Never a key. */
  error?: string;
}

/** The text a note is summarised from: its body, or its head and tail when it is very long. */
export function summaryInputOf(body: string): string {
  if (body.length <= SUMMARY_NOTE_MAX_CHARS) return body;
  return `${body.slice(0, 14_000)}\n\n[... middle of conversation omitted ...]\n\n${body.slice(-6_000)}`;
}

export function renderSummaryPrompt(batch: Array<{ id: string; date: string; text: string }>): string {
  const conversations = batch.map(item => `=== CONVERSATION id=${item.id} date=${item.date} ===\n${item.text}`).join('\n\n');
  return SUMMARY_PROMPT_TEMPLATE.replace('{n}', () => String(batch.length)).replace('{conversations}', () => conversations);
}

/** A batch id as the model may write it back: case and leading zeros do not matter (`C1` is `c01`). */
const batchId = (id: string) => id.trim().toLowerCase().replace(/^c0*(\d+)$/, 'c$1');

/**
 * `{"nodes": [{id, title, summary}]}` -> id (normalised by batchId) -> node. Entries without an id or without any
 * text are dropped.
 */
export function parseSummaryNodes(text: string): Map<string, { title: string; summary: string }> {
  const out = new Map<string, { title: string; summary: string }>();
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return out;
    try {
      payload = JSON.parse(match[0]);
    } catch {
      return out;
    }
  }
  const nodes = payload && typeof payload === 'object' ? (payload as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    const id = batchId(String(record.id ?? ''));
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!id || (!title && !summary)) continue;
    out.set(id, { title: title || 'Untitled conversation', summary });
  }
  return out;
}

function batchesOf<T extends { text: string }>(items: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length > 0 && (chars + item.text.length > SUMMARY_BATCH_MAX_CHARS || current.length >= SUMMARY_BATCH_MAX_NOTES)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Give every note the router will be shown a title + summary, calling the summary model only for notes the cache
 * does not already hold. Batches run one after another (no burst against a per-minute provider limit).
 */
export async function buildSessionSummaries(args: {
  db: Database.Database;
  vaultPath: string;
  ledgerRelPath?: string;
  options: SessionRouterOptions;
  cache: RouterCache;
}): Promise<SummaryBuildStats> {
  const started = Date.now();
  const { options, cache } = args;
  const model = options.summaryModel;
  const notes = listRouterNotes(args.db, args.vaultPath, args.ledgerRelPath);
  const stats: SummaryBuildStats = {
    model, notes: notes.length, cached: 0, summarized: 0, failed: 0, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0,
  };
  const pending: Array<{ key: string; noteHash: string; date: string; text: string }> = [];
  for (const note of notes) {
    const key = RouterCache.summaryKey(model, SUMMARY_PROMPT_TEMPLATE, note.noteHash);
    if (cache.getSummary(key)) {
      stats.cached++;
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(note.file, 'utf8');
    } catch (err) {
      stats.failed++;
      stats.error ??= `unreadable note: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      continue;
    }
    if (noteContentHash(note.file, raw) !== note.noteHash) {
      // Edited after it was indexed: its summary must describe what search will find, so it waits for the next index.
      stats.failed++;
      stats.error ??= 'a note changed after it was indexed; index again';
      continue;
    }
    const parsed = parseNote(note.file, raw);
    if (!parsed.body) {
      cache.putSummary(key, note.noteHash, { title: parsed.title, summary: '', model });
      stats.summarized++;
      continue;
    }
    pending.push({ key, noteHash: note.noteHash, date: note.date ?? '', text: summaryInputOf(parsed.body) });
  }
  if (pending.length > 0 && !options.summaryChat) {
    stats.failed += pending.length;
    stats.error ??= 'no summary model configured';
    stats.ms = Date.now() - started;
    return stats;
  }
  const batches = batchesOf(pending);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const items = batches[batchIndex].map((entry, index) => ({ ...entry, id: `c${String(index + 1).padStart(2, '0')}` }));
    let prompt = renderSummaryPrompt(items);
    const left = new Map(items.map(item => [batchId(item.id), item]));
    let transportFailed = false;
    for (let attempt = 0; attempt < SUMMARY_ATTEMPTS && left.size > 0; attempt++) {
      let content: string;
      try {
        const res = await options.summaryChat!({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
        });
        stats.calls++;
        stats.promptTokens += res.promptTokens ?? 0;
        stats.completionTokens += billedOutputTokens(res);
        content = res.content;
      } catch (err) {
        stats.calls++;
        stats.error ??= `summary call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        transportFailed = true;
        break;
      }
      const nodes = parseSummaryNodes(content);
      for (const [id, item] of [...left]) {
        const node = nodes.get(id);
        if (!node) continue;
        cache.putSummary(item.key, item.noteHash, { title: node.title, summary: node.summary, model });
        stats.summarized++;
        left.delete(id);
      }
      // A different request, so a provider-side cache cannot replay the incomplete answer.
      prompt += '\n';
    }
    if (left.size > 0) {
      stats.failed += left.size;
      stats.error ??= 'the summary model left some notes without a node';
    }
    if (transportFailed) {
      // The transport already retried: a provider that is down or out of quota fails the next batch the same way, so
      // the rest waits for the next index instead of spending requests against the same wall.
      for (const rest of batches.slice(batchIndex + 1)) stats.failed += rest.length;
      break;
    }
  }
  stats.ms = Date.now() - started;
  return stats;
}

// ─── Read time: route, then deliver statements ───

export type SessionRouterSkipReason =
  | 'no-model'
  | 'no-notes'
  | 'too-many-notes'
  | 'summaries-incomplete'
  | 'router-error'
  | 'router-parse-error'
  | 'empty-route'
  /** Nothing to add: the routed notes have no short section, or (with `truncated`) no room was left for one. */
  | 'no-statements';

export interface SessionRouterReport {
  status: 'ok' | 'skipped';
  reason?: SessionRouterSkipReason;
  mode: 'replace' | 'union';
  model: string;
  summaryModel: string;
  /** Notes shown to (or, when skipped before the call, counted for) the router. */
  nodes?: number;
  missingSummaries?: number;
  /**
   * Every note the router named (valid ids, at most ROUTER_MAX_SESSIONS), in routing order, with what was delivered
   * from it; in union mode also how many of its statements the retrieved window already held.
   */
  routed?: Array<{ notePath: string; session_date?: string; statements: number; tokens: number; alreadyRetrieved?: number }>;
  deliveredTokens?: number;
  /** The delivery budget (ROUTER_MAX_DELIVERED_TOKENS; in union mode, what the retrieved window left of it) cut it. */
  truncated?: boolean;
  fromCache?: boolean;
  /** Tokens of the routing answer; completionTokens is output as billed (see billedOutputTokens). */
  usage?: { promptTokens: number; completionTokens: number };
  /** Model time of the routing answer (for a cached answer: of the call that produced it). */
  latencyMs?: number;
  error?: string;
}

/**
 * `Question date: <d>\n<question>` -> its parts; any other query is the question and today is its date. The
 * benchmark client and agents that stamp the date they ask on use the first form; the router needs the date to
 * read "last week" or "four weeks ago".
 */
export function splitQuestionDate(query: string, nowMs: number): { questionDate: string; question: string } {
  const match = /^Question date:[ \t]*([^\n]+)\n([\s\S]+)$/.exec(query.trim());
  if (match && match[2].trim()) return { questionDate: match[1].trim(), question: match[2].trim() };
  return { questionDate: new Date(nowMs).toISOString().slice(0, 10), question: query.trim() };
}

interface RouterNode {
  id: string;
  date: string;
  title: string;
  summary: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Output tokens as billed: the provider's total minus the prompt when it reports a total (Gemini's completion count
 * leaves out hidden thinking, which is billed as output), else the completion count.
 */
export function billedOutputTokens(res: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): number {
  const completion = res.completionTokens ?? 0;
  if (typeof res.totalTokens === 'number' && typeof res.promptTokens === 'number') {
    return Math.max(completion, res.totalTokens - res.promptTokens);
  }
  return completion;
}

/** One node as a JSON line, keys in the study's order and spacing. */
function nodeLine(node: RouterNode): string {
  return `{"node_id": ${JSON.stringify(node.id)}, "date": ${JSON.stringify(node.date)}, "title": ${JSON.stringify(node.title)}, "summary": ${JSON.stringify(node.summary)}}`;
}

/** The routing prompt: the study's stage-1 prompt (PageIndex's tree-search prompt, "document" -> "memory"). */
export function renderRouterPrompt(questionDate: string, question: string, nodes: RouterNode[]): string {
  return `You are given a question and the tree structure of a person's long-term conversation memory.
Each node is one past conversation with a node id, its date, a title and a summary.
Your task is to find all tree nodes that are likely to contain the answer to the question.

Question date: ${questionDate}
Question: ${question}

Memory tree structure:
${nodes.map(nodeLine).join('\n')}

Please reply in the following JSON format:
{
    "thinking": "<Your thinking process on which nodes are relevant to the question>",
    "node_list": ["node_id_1", "node_id_2", ..., "node_id_n"]
}
Directly return the final JSON structure. Do not output anything else.`;
}

class RouterParseError extends Error {}

/** The last JSON object in the text that has a `node_list` (tolerates prose, code fences and leaked thoughts). */
function lastObjectWithNodeList(text: string): Record<string, unknown> {
  const at = text.lastIndexOf('"node_list"');
  if (at < 0) throw new RouterParseError('router answer has no node_list');
  let start = text.lastIndexOf('{', at);
  while (start >= 0) {
    let depth = 0;
    for (let end = start; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const candidate = JSON.parse(text.slice(start, end + 1)) as unknown;
            if (candidate && typeof candidate === 'object' && 'node_list' in candidate) return candidate as Record<string, unknown>;
          } catch {
            // not this brace; try an earlier one
          }
          break;
        }
      }
    }
    start = start > 0 ? text.lastIndexOf('{', start - 1) : -1;
  }
  throw new RouterParseError('router answer has an unparseable node_list object');
}

export function parseRouterAnswer(text: string): { nodeIds: string[]; thinking: string } {
  let body = text.replace(/<thought>[\s\S]*?<\/thought>/g, '');
  if (body.trimStart().startsWith('<thought>')) {
    const at = body.lastIndexOf('{"');
    if (at >= 0) body = body.slice(at);
  }
  body = body.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as unknown;
    payload = parsed && typeof parsed === 'object' && 'node_list' in parsed
      ? parsed as Record<string, unknown>
      : lastObjectWithNodeList(body);
  } catch (err) {
    if (err instanceof RouterParseError) throw err;
    payload = lastObjectWithNodeList(body);
  }
  const list = payload.node_list;
  if (!Array.isArray(list)) throw new RouterParseError('router node_list is not a list');
  return {
    nodeIds: list.map(id => String(id).trim()).filter(Boolean),
    thinking: typeof payload.thinking === 'string' ? payload.thinking : '',
  };
}

async function askRouter(
  prompt: string,
  options: SessionRouterOptions,
  cache: RouterCache,
): Promise<{ nodeIds: string[]; usage: { promptTokens: number; completionTokens: number }; latencyMs: number; fromCache: boolean }> {
  const key = RouterCache.routeKey(options.routerModel, prompt);
  const cached = cache.getRoute(key);
  if (cached) {
    return {
      nodeIds: cached.nodeIds,
      usage: { promptTokens: cached.promptTokens, completionTokens: cached.completionTokens },
      latencyMs: cached.latencyMs,
      fromCache: true,
    };
  }
  let promptTokens = 0;
  let completionTokens = 0;
  let latencyMs = 0;
  let lastError: Error = new RouterParseError('router answered nothing');
  for (let attempt = 0; attempt < ROUTE_ATTEMPTS; attempt++) {
    const res = await options.routeChat!({
      model: options.routerModel,
      // A different request on the retry, so a provider-side cache cannot replay the unparseable answer.
      messages: [{ role: 'user', content: prompt + '\n'.repeat(attempt) }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: ROUTER_MAX_OUTPUT_TOKENS,
    });
    promptTokens += res.promptTokens ?? 0;
    completionTokens += billedOutputTokens(res);
    latencyMs += res.latencyMs;
    try {
      const parsed = parseRouterAnswer(res.content);
      cache.putRoute(key, {
        nodeIds: parsed.nodeIds,
        thinking: parsed.thinking.slice(0, 4_000),
        model: options.routerModel,
        promptTokens,
        completionTokens,
        latencyMs,
      });
      return { nodeIds: parsed.nodeIds, usage: { promptTokens, completionTokens }, latencyMs, fromCache: false };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

/**
 * A note's statements: the pieces the chunker cuts it into, never split for size (a heading section, with its heading
 * line; a daily note's entry, with its time and source), whose content, a leading heading line aside, is non-empty
 * and shorter than STATEMENT_MAX_CHARS. On a chat import a piece's heading names the speaker (`### Turn 3 — User`).
 * Cutting with the chunker itself keeps the two in step: a statement is byte-identical to the chunk the index holds
 * for it (a piece this short is never split there either), which is what lets union mode skip what retrieval already
 * returned. Document order.
 */
export function noteStatements(note: ParsedNote): string[] {
  const statements: string[] = [];
  for (const piece of chunkNote(note, { maxTokens: Number.POSITIVE_INFINITY, overlapTokens: 0 })) {
    const lines = piece.text.split('\n');
    const headed = /^#{1,3}\s+/.test(lines[0] ?? '');
    const content = (headed ? lines.slice(1) : lines).join('\n').trim();
    if (content.length === 0 || content.length >= STATEMENT_MAX_CHARS) continue;
    statements.push(piece.text);
  }
  return statements;
}

const tokensOf = (text: string) => countO200k(text);

interface Delivered {
  note: RouterNote;
  /** Delivered statements (may be none: no short section, all already retrieved, or the budget ran out). */
  statements: string[];
  tokens: number;
  /** Statements of this note the retrieved window already held (union mode). */
  alreadyRetrieved: number;
}

/**
 * One entry per routed note, in routing order: its statements in document order, while the budget lasts (a note
 * after the budget ran out is not read and delivers nothing). `truncated`: the budget stopped the delivery.
 */
async function deliverStatements(notes: RouterNote[], exclude: Set<string>, budget: number): Promise<{ delivered: Delivered[]; truncated: boolean }> {
  const delivered: Delivered[] = notes.map(note => ({ note, statements: [], tokens: 0, alreadyRetrieved: 0 }));
  let used = 0;
  let truncated = false;
  for (const entry of delivered) {
    let raw: string;
    try {
      raw = await fs.readFile(entry.note.file, 'utf8');
    } catch {
      continue;
    }
    let full = false;
    for (const statement of noteStatements(parseNote(entry.note.file, raw))) {
      if (exclude.has(statement)) {
        entry.alreadyRetrieved++;
        continue;
      }
      const cost = tokensOf(statement) + (entry.statements.length > 0 ? 1 : 0);
      if (used + cost > budget) {
        full = true;
        truncated = true;
        break;
      }
      entry.statements.push(statement);
      used += cost;
    }
    entry.tokens = entry.statements.length > 0 ? tokensOf(entry.statements.join('\n\n')) : 0;
    if (full) break;
  }
  // The running sum counts each statement plus one token per separator, which can differ from the joined text's
  // count by a token at a boundary; trim from the end until the delivered texts themselves fit, so the bound is exact.
  let total = delivered.reduce((sum, entry) => sum + entry.tokens, 0);
  for (let index = delivered.length - 1; index >= 0 && total > budget; ) {
    const entry = delivered[index];
    if (entry.statements.length === 0) {
      index--;
      continue;
    }
    total -= entry.tokens;
    entry.statements.pop();
    truncated = true;
    entry.tokens = entry.statements.length > 0 ? tokensOf(entry.statements.join('\n\n')) : 0;
    total += entry.tokens;
  }
  return { delivered, truncated };
}

/**
 * Route one search. Never throws and never fails the search: every path that cannot route returns the retrieved
 * hits unchanged with a report that says why.
 */
export async function applySessionRouter(args: {
  db: Database.Database;
  vaultPath: string;
  ledgerRelPath?: string;
  query: string;
  retrieved: RetrievalResult;
  options: SessionRouterOptions;
  cache: RouterCache;
  nowMs?: number;
}): Promise<{ hits: RetrievalHit[]; report: SessionRouterReport }> {
  const { options, cache, retrieved } = args;
  const base = { mode: options.mode, model: options.routerModel, summaryModel: options.summaryModel };
  const skip = (reason: SessionRouterSkipReason, extra: Partial<SessionRouterReport> = {}) => ({
    hits: retrieved.hits,
    report: { status: 'skipped' as const, reason, ...base, ...extra },
  });
  try {
    if (!options.routeChat) return skip('no-model');
    const notes = listRouterNotes(args.db, args.vaultPath, args.ledgerRelPath);
    if (notes.length === 0) return skip('no-notes', { nodes: 0 });
    if (notes.length > ROUTER_MAX_NODES) return skip('too-many-notes', { nodes: notes.length });
    const summaries = notes.map(note => cache.getSummary(RouterCache.summaryKey(options.summaryModel, SUMMARY_PROMPT_TEMPLATE, note.noteHash)));
    const missingSummaries = summaries.filter(summary => !summary).length;
    if (missingSummaries > 0) return skip('summaries-incomplete', { nodes: notes.length, missingSummaries });

    const width = Math.max(4, String(notes.length).length);
    const nodes = notes.map((note, index) => ({
      id: String(index + 1).padStart(width, '0'),
      date: note.date ?? '',
      title: clip(summaries[index]!.title, NODE_TITLE_MAX_CHARS),
      summary: clip(summaries[index]!.summary, NODE_SUMMARY_MAX_CHARS),
      note,
    }));
    const { questionDate, question } = splitQuestionDate(args.query, args.nowMs ?? Date.now());
    const prompt = renderRouterPrompt(questionDate, question, nodes);

    let answer: Awaited<ReturnType<typeof askRouter>>;
    try {
      answer = await askRouter(prompt, options, cache);
    } catch (err) {
      const reason = err instanceof RouterParseError ? 'router-parse-error' : 'router-error';
      return skip(reason, { nodes: nodes.length, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
    const spent = { nodes: nodes.length, fromCache: answer.fromCache, usage: answer.usage, latencyMs: answer.latencyMs };
    const byId = new Map(nodes.map(node => [node.id, node]));
    const routed = [...new Set(answer.nodeIds.map(id => (/^\d+$/.test(id) ? id.padStart(width, '0') : id)))]
      .filter(id => byId.has(id))
      .slice(0, ROUTER_MAX_SESSIONS)
      .map(id => byId.get(id)!.note);
    if (routed.length === 0) return skip('empty-route', spent);

    // union: the retrieved window stays as it is; the routed statements fill what is left of the budget and never
    // repeat a chunk the window already holds (a short section is one chunk of the same text).
    const union = options.mode === 'union';
    const exclude = union ? new Set(retrieved.hits.map(hit => hit.text)) : new Set<string>();
    const budget = union
      ? ROUTER_MAX_DELIVERED_TOKENS - retrieved.hits.reduce((sum, hit) => sum + tokensOf(hit.text), 0)
      : ROUTER_MAX_DELIVERED_TOKENS;
    const { delivered, truncated } = await deliverStatements(routed, exclude, Math.max(0, budget));
    const withText = delivered.filter(entry => entry.statements.length > 0);
    // Nothing to deliver is a fallback, except in union mode when the window already held what the router pointed
    // at and nothing was cut for room: then the union IS the window, and the router agreed with retrieval.
    const agreed = union && !truncated && delivered.some(entry => entry.alreadyRetrieved > 0);
    if (withText.length === 0 && !agreed) return skip('no-statements', { ...spent, ...(truncated ? { truncated } : {}) });

    const routerHits: RetrievalHit[] = withText.map((entry, rank) => ({
      notePath: entry.note.path,
      chunkId: -1,
      headingPath: '',
      text: entry.statements.join('\n\n'),
      // Routing order as a score (first routed = 1), so a score-ordered result keeps the router's order.
      score: (withText.length - rank) / withText.length,
      reason: 'router',
      ...(entry.note.date ? { session_date: entry.note.date } : {}),
    }));
    // Same presentation rule as retrieval: newest first unless the retrieval result is in score order (an explicit
    // past-intent or as-of query); in score order a union keeps the retrieved window first.
    const hits = options.mode === 'replace'
      ? orderHits(routerHits, retrieved.rankedBy)
      : retrieved.rankedBy === 'session_date'
        ? orderHits([...retrieved.hits, ...routerHits], 'session_date')
        : [...retrieved.hits, ...routerHits];
    return {
      hits,
      report: {
        status: 'ok',
        ...base,
        ...spent,
        routed: delivered.map(entry => ({
          notePath: entry.note.path,
          ...(entry.note.date ? { session_date: entry.note.date } : {}),
          statements: entry.statements.length,
          tokens: entry.tokens,
          ...(union ? { alreadyRetrieved: entry.alreadyRetrieved } : {}),
        })),
        deliveredTokens: delivered.reduce((sum, entry) => sum + entry.tokens, 0),
        ...(truncated ? { truncated } : {}),
      },
    };
  } catch (err) {
    return skip('router-error', { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
  }
}

// ─── CLI entry points ───

/**
 * `renor search`: the routed hits and the report, or null when the flag is off (then nothing here runs and no
 * cache file is created).
 */
export async function routeSearch(args: {
  db: Database.Database;
  config: { dbPath: string; vaultPath: string; memoryLedger?: string };
  query: string;
  retrieved: RetrievalResult;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<{ hits: RetrievalHit[]; report: SessionRouterReport } | null> {
  const options = resolveSessionRouterOptions(args.config, args.env);
  if (!options) return null;
  let cache: RouterCache;
  try {
    cache = new RouterCache(options.cachePath);
  } catch (err) {
    return {
      hits: args.retrieved.hits,
      report: {
        status: 'skipped', reason: 'router-error', mode: options.mode, model: options.routerModel,
        summaryModel: options.summaryModel,
        error: `router cache unavailable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      },
    };
  }
  try {
    return await applySessionRouter({
      db: args.db,
      vaultPath: args.config.vaultPath,
      ledgerRelPath: args.config.memoryLedger,
      query: args.query,
      retrieved: args.retrieved,
      options,
      cache,
      nowMs: args.nowMs,
    });
  } finally {
    cache.close();
  }
}

/** `renor index` / `renor rebuild`: build the summaries the router reads. The caller has refused a missing model. */
export async function summarizeForRouter(args: {
  db: Database.Database;
  config: { vaultPath: string; memoryLedger?: string };
  options: SessionRouterOptions;
}): Promise<SummaryBuildStats> {
  const cache = new RouterCache(args.options.cachePath);
  try {
    return await buildSessionSummaries({
      db: args.db,
      vaultPath: args.config.vaultPath,
      ledgerRelPath: args.config.memoryLedger,
      options: args.options,
      cache,
    });
  } finally {
    cache.close();
  }
}
