import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { encode } from 'gpt-tokenizer';
import { parseNote } from '../indexer/parser';
import { noteContentHash } from '../indexer/dailyEntries';
import { createOllamaChat } from '../evidence/ollamaChat';
import { splitKeyList } from '../evidence/keyPool';
import {
  EVIDENCE_MODEL_DEFAULT,
  EVIDENCE_REASONING_EFFORTS,
  type EvidenceChat,
  type EvidenceItem,
  type EvidenceReasoningEffort,
} from '../evidence/secondPass';
import { renderEvidenceTable } from '../evidence/attach';
import { embeddingSpace } from '../embeddings/space';
import type { EmbeddingProvider } from '../embeddings/types';
import { listRouterNotes, billedOutputTokens } from '../router/sessionRouter';
import { resolveSessionDate, sessionDateMs, type RetrievalHit } from '../retrieval/orchestrator';
import { DigestCache, type DigestItem } from './digestCache';

/**
 * Write-time digests (RENOR_DIGESTS, default OFF): one model call when a note is indexed writes a query-independent
 * list of what the user states in it, with its date and where it was said; search reads that list with no model call.
 *
 *   index (write time)  `renor index` / `renor rebuild` with the flag on: one model call per batch of up to
 *                       DIGEST_BATCH_MAX_NOTES notes writes the digest of each note into the digest cache, keyed by
 *                       the note's file hash, so an unchanged note is never paid for twice. Each item is then embedded
 *                       once with the tenant's embedding provider and the vectors are stored beside it.
 *   search (read time)  no model call. The digests of the notes the retrieval window already holds are scored by
 *                       cosine to the query embedding, the best fit DIGEST_DEFAULT_TOKENS tokens, ordered by date,
 *                       and prepended as one hit rendered like the evidence table.
 *
 * Retrieval, ranking and stored chunk text are never changed. Flag off: nothing here runs, no cache file is created,
 * and `search --json` carries no `digest` field.
 *
 * Provenance: every item keeps the turn or section it was said in (`source`), and the search report lists, per
 * rendered item, the note and that source. The statement itself stays in the note.
 *
 * The digest reads the user's own turns in full and clips the assistant's turns, since the list is of what the user
 * states; a note with no turn structure is read whole (capped). Notes with nothing to say get an empty digest.
 */

export const DIGEST_PROMPT_TEMPLATE = `You write a digest of a person's past conversations for their long-term memory. Below are {n} conversations between the person ("User") and an AI assistant. Each starts with an id and a date; turns are labelled [Turn N User] or [Turn N Assistant] (assistant turns may be shortened).

TASK: For EACH conversation list EVERY distinct item, event, amount, preference or change of state that the User states about their own life or situation. Rules:
- One entry per distinct item (e.g., each product, each trip, each device, each course, each amount, each plan, each preference).
- "item" = what it is, specific enough to be understood without the conversation.
- "action" = what happened or holds (bought / visited / completed / raised / inherited / prefers / plans / changed to / ...).
- "amount" = numeric value + unit when stated (e.g., "3 days", "$120", "100 points"); else "".
- "date" = the date the item happened or applies when the User gives one (resolve "yesterday", "last week" against the conversation's date); else the conversation's date.
- "turn" = the label of the turn where the User stated it, e.g. "Turn 3".
- Do NOT compute any totals. Do NOT merge different items. Include every candidate even if uncertain.
- Skip general knowledge and advice given by the assistant. If the User states nothing about their own life or situation, return an empty list for that conversation.

{conversations}

Respond with ONLY minified JSON, no markdown, one entry per conversation using the ids given:
{{"notes":[{{"id":"<id>","items":[{{"item":"...","action":"...","amount":"...","date":"...","turn":"..."}}]}}]}}`;

/** Part of every digest's cache key: change how a note is shown to the model and every note is digested again. */
export const DIGEST_INPUT_VERSION = 'user-turns-v1';
/** A digest call carries at most this many notes or characters of them. */
export const DIGEST_BATCH_MAX_NOTES = 6;
export const DIGEST_BATCH_MAX_CHARS = 40_000;
/** The user's turn is shown up to this many characters, the assistant's turn up to the second number. */
export const DIGEST_USER_TURN_MAX_CHARS = 4_000;
export const DIGEST_ASSISTANT_TURN_MAX_CHARS = 300;
/** A note is shown at most this long (its head, then its tail, when longer). */
export const DIGEST_NOTE_MAX_CHARS = 20_000;
export const DIGEST_MAX_OUTPUT_TOKENS = 8_000;
export const DIGEST_TIMEOUT_MS = 180_000;
export const DIGEST_RETRIES_DEFAULT = 3;
const DIGEST_ATTEMPTS = 2;
const DIGEST_MAX_ITEMS_PER_NOTE = 40;
/** What the rendered table may weigh at search time, in gpt-tokenizer tokens (table header and footer included). */
export const DIGEST_DEFAULT_TOKENS = 600;
/** At most this many of the retrieval window's notes are read, like the evidence pass's 20 sessions. */
export const DIGEST_MAX_WINDOW_NOTES = 20;
export const DIGEST_HIT_PATH = '_renor/digest';

export function digestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_DIGESTS ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return true;
  // A typo must not quietly measure the control arm twice.
  throw new Error(`Invalid RENOR_DIGESTS "${raw}": must be on | off`);
}

export interface DigestOptions {
  model: string;
  effort: EvidenceReasoningEffort;
  cachePath: string;
  /** RENOR_DIGEST_CACHE_ONLY: never call the model; a note without a cached digest has none. */
  cacheOnly: boolean;
  tokens: number;
  retries: number;
  /**
   * The background worker's per-workspace cost guard (src/digests/worker.ts): the most it may spend on one UTC day, and the
   * list prices (USD per 1M tokens) it counts a call at. Defaults are Fireworks' US-only GLM-5.3-Flash router. Only that
   * worker is held to it: `renor index` / `renor rebuild` (digestIndexedNotes) are commands someone runs, are not capped,
   * and print what they spent (README, "Cost guard").
   */
  maxUsdPerDay: number;
  priceInPerM: number;
  priceOutPerM: number;
  chat?: EvidenceChat;
}

export const DIGEST_MAX_USD_PER_DAY_DEFAULT = 0.5;
export const DIGEST_PRICE_IN_DEFAULT = 0.225;
export const DIGEST_PRICE_OUT_DEFAULT = 0.75;

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  // A typo must not quietly lift or remove a cost guard.
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name} "${text}": must be a positive number`);
  return value;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number((raw ?? '').trim());
  if ((raw ?? '').trim() === '' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * The digest model's provider: the digest slot (RENOR_DIGEST_BASE_URL + RENOR_DIGEST_API_KEY(S)) and nothing else.
 *
 * A digest call sends the text of notes (clipped, see DIGEST_NOTE_MAX_CHARS), and the Privacy Policy, the LGPD page and
 * the register of processing (ROPA P13) name one processor for it. So this never borrows the evidence provider's key or
 * URL, the session router's, or an Ollama Cloud key, and the transport's default URL (Ollama Cloud) is never reached:
 * with the slot unset no client is built and nothing is sent. Pointing the slot at a provider those pages do not name
 * means updating them first.
 */
export function resolveDigestProvider(env: NodeJS.ProcessEnv = process.env): { baseUrl?: string; keys: string[] } {
  const keys = [...splitKeyList(env.RENOR_DIGEST_API_KEYS), ...splitKeyList(env.RENOR_DIGEST_API_KEY)];
  return { baseUrl: env.RENOR_DIGEST_BASE_URL?.trim() || undefined, keys };
}

/** Env -> options, or null when the flag is off. */
export function resolveDigestOptions(config: { dbPath: string }, env: NodeJS.ProcessEnv = process.env): DigestOptions | null {
  if (!digestsEnabled(env)) return null;
  const effortRaw = (env.RENOR_DIGEST_REASONING_EFFORT ?? 'low').trim().toLowerCase();
  if (!(EVIDENCE_REASONING_EFFORTS as readonly string[]).includes(effortRaw)) {
    throw new Error(`Invalid RENOR_DIGEST_REASONING_EFFORT "${effortRaw}": must be ${EVIDENCE_REASONING_EFFORTS.join(' | ')}`);
  }
  const cacheOnlyRaw = (env.RENOR_DIGEST_CACHE_ONLY ?? '').trim().toLowerCase();
  const cacheOnly = cacheOnlyRaw === '1' || cacheOnlyRaw === 'on' || cacheOnlyRaw === 'true' || cacheOnlyRaw === 'yes';
  const retries = boundedInt(env.RENOR_DIGEST_RETRIES, DIGEST_RETRIES_DEFAULT, 0, 8);
  const { baseUrl, keys } = resolveDigestProvider(env);
  return {
    model: env.RENOR_DIGEST_MODEL?.trim() || env.RENOR_EVIDENCE_MODEL?.trim() || EVIDENCE_MODEL_DEFAULT,
    effort: effortRaw as EvidenceReasoningEffort,
    cachePath: env.RENOR_DIGEST_CACHE?.trim() || path.join(path.dirname(config.dbPath), 'digest-cache.db'),
    cacheOnly,
    tokens: boundedInt(env.RENOR_DIGEST_TOKENS, DIGEST_DEFAULT_TOKENS, 100, 4_000),
    retries,
    maxUsdPerDay: positiveNumber(env.RENOR_DIGEST_MAX_USD_PER_DAY, DIGEST_MAX_USD_PER_DAY_DEFAULT, 'RENOR_DIGEST_MAX_USD_PER_DAY'),
    priceInPerM: positiveNumber(env.RENOR_DIGEST_PRICE_IN_PER_M, DIGEST_PRICE_IN_DEFAULT, 'RENOR_DIGEST_PRICE_IN_PER_M'),
    priceOutPerM: positiveNumber(env.RENOR_DIGEST_PRICE_OUT_PER_M, DIGEST_PRICE_OUT_DEFAULT, 'RENOR_DIGEST_PRICE_OUT_PER_M'),
    // A client needs the slot's key AND its URL: a key alone would send notes to the transport's default endpoint.
    ...(keys.length > 0 && baseUrl && !cacheOnly ? { chat: createOllamaChat({ baseUrl, keys, timeoutMs: DIGEST_TIMEOUT_MS, maxRetries: retries }) } : {}),
  };
}

// ─── What the model is shown ───

const TURN_HEADING = /^### Turn (\d+) — ([^\n]*?)[ \t]*$/gm;

/**
 * The text a note is digested from. A note made of `### Turn N — Role` sections shows the user's turns whole (up to a
 * cap) and the assistant's turns clipped; any other note is shown whole, or its head and tail when long.
 */
export function digestInputOf(body: string): string {
  const matches = [...body.matchAll(TURN_HEADING)];
  if (matches.length === 0) return clipLong(body);
  const parts: string[] = [];
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? body.length) : body.length;
    const text = body.slice(start, end).trim();
    const role = match[2].trim();
    const assistant = /^assistant$/i.test(role);
    const cap = assistant ? DIGEST_ASSISTANT_TURN_MAX_CHARS : DIGEST_USER_TURN_MAX_CHARS;
    const shown = text.length > cap ? `${text.slice(0, cap)} …` : text;
    parts.push(`[Turn ${match[1]} ${role}]\n${shown}`);
  });
  return clipLong(parts.join('\n\n'));
}

function clipLong(text: string): string {
  if (text.length <= DIGEST_NOTE_MAX_CHARS) return text;
  return `${text.slice(0, 14_000)}\n\n[... middle omitted ...]\n\n${text.slice(-6_000)}`;
}

export function renderDigestPrompt(batch: Array<{ id: string; date: string; text: string }>): string {
  const conversations = batch.map(item => `=== CONVERSATION id=${item.id} date=${item.date} ===\n${item.text}`).join('\n\n');
  return DIGEST_PROMPT_TEMPLATE.replace('{n}', () => String(batch.length)).replace('{conversations}', () => conversations);
}

const batchId = (id: string) => id.trim().toLowerCase().replace(/^c0*(\d+)$/, 'c$1');

const clean = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * `{"notes":[{id, items:[{item, action, amount, date, turn}]}]}` -> id (normalised) -> items. An entry whose items
 * list is missing is dropped (the note is asked again); an empty list is a real answer. An item without text is dropped.
 */
export function parseDigestReply(text: string): Map<string, DigestItem[]> {
  const out = new Map<string, DigestItem[]>();
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
  const notes = payload && typeof payload === 'object' ? (payload as { notes?: unknown }).notes : undefined;
  if (!Array.isArray(notes)) return out;
  for (const note of notes) {
    if (!note || typeof note !== 'object' || Array.isArray(note)) continue;
    const record = note as Record<string, unknown>;
    const id = batchId(String(record.id ?? ''));
    if (!id || !Array.isArray(record.items)) continue;
    const items: DigestItem[] = [];
    for (const raw of record.items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const item = clean(r.item, 200);
      if (!item) continue;
      items.push({
        item,
        action: clean(r.action, 60),
        amount: clean(r.amount, 60),
        date: clean(r.date, 40),
        source: clean(r.turn ?? r.source, 30),
      });
      if (items.length >= DIGEST_MAX_ITEMS_PER_NOTE) break;
    }
    out.set(id, items);
  }
  return out;
}

function batchesOf<T extends { text: string }>(items: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length > 0 && (chars + item.text.length > DIGEST_BATCH_MAX_CHARS || current.length >= DIGEST_BATCH_MAX_NOTES)) {
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

/** The text one item is embedded as: the row a reader would see, without the date. */
export function digestItemText(item: DigestItem): string {
  return [item.item, item.action, item.amount].filter(Boolean).join(' | ');
}

// ─── Index time ───

export interface DigestBuildStats {
  model: string;
  /** Notes considered (every indexed note, or the `onlyPaths` subset). */
  notes: number;
  /** Already digested: no call. */
  cached: number;
  /** Digested by this run (a note with no body gets an empty digest and no call). */
  digested: number;
  /** Cache-only mode: notes with no cached digest, left alone on purpose. Not a failure. */
  skippedUncached: number;
  /** Left without a digest: a later index fills them. */
  failed: number;
  /** Indexed notes whose file no longer exists (retired or moved away): nothing to digest, not a failure. */
  gone: number;
  /** Model requests this run made (a batch asked again counts twice; the transport's own retries do not count). */
  calls: number;
  promptTokens: number;
  /** Output tokens as billed (hidden thinking included when the provider reports a total). */
  completionTokens: number;
  items: number;
  /** Item texts sent to the embedding provider by this run. */
  embeddedTexts: number;
  ms: number;
  error?: string;
}

/**
 * Give every note a digest, calling the model only for notes the cache does not hold, then give every digest the
 * vectors of its items in the provider's embedding space. Batches run one after another.
 */
export async function buildNoteDigests(args: {
  db: Database.Database;
  vaultPath: string;
  ledgerRelPath?: string;
  options: DigestOptions;
  cache: DigestCache;
  provider: EmbeddingProvider;
  /** Only these note paths (as the index stores them). Unset: every indexed note. */
  onlyPaths?: ReadonlySet<string>;
}): Promise<DigestBuildStats> {
  const started = Date.now();
  const { options, cache } = args;
  const model = options.model;
  const space = embeddingSpace(args.provider);
  const all = listRouterNotes(args.db, args.vaultPath, args.ledgerRelPath);
  const notes = args.onlyPaths ? all.filter(note => args.onlyPaths!.has(note.path)) : all;
  const stats: DigestBuildStats = {
    model, notes: notes.length, cached: 0, digested: 0, skippedUncached: 0, failed: 0, gone: 0, calls: 0,
    promptTokens: 0, completionTokens: 0, items: 0, embeddedTexts: 0, ms: 0,
  };
  const keyOf = (noteHash: string) => DigestCache.digestKey(model, options.effort, DIGEST_PROMPT_TEMPLATE, DIGEST_INPUT_VERSION, noteHash);
  const pending: Array<{ key: string; noteHash: string; date: string; text: string }> = [];
  for (const note of notes) {
    const key = keyOf(note.noteHash);
    if (cache.getDigest(key)) {
      stats.cached++;
      continue;
    }
    if (options.cacheOnly) {
      stats.skippedUncached++;
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(note.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        stats.gone++;
        continue;
      }
      stats.failed++;
      stats.error ??= `unreadable note: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      continue;
    }
    if (noteContentHash(note.file, raw) !== note.noteHash) {
      // Edited after it was indexed: its digest must describe what search will find, so it waits for the next index.
      stats.failed++;
      stats.error ??= 'a note changed after it was indexed; index again';
      continue;
    }
    const parsed = parseNote(note.file, raw);
    if (!parsed.body.trim()) {
      cache.putDigest(key, note.noteHash, { items: [], model });
      stats.digested++;
      continue;
    }
    pending.push({ key, noteHash: note.noteHash, date: note.date ?? '', text: digestInputOf(parsed.body) });
  }
  if (pending.length > 0 && !options.chat) {
    stats.failed += pending.length;
    stats.error ??= 'no digest model configured';
  } else {
    await digestPending(pending, options, cache, stats);
  }
  await embedDigests(notes, keyOf, cache, args.provider, space, stats);
  stats.ms = Date.now() - started;
  return stats;
}

async function digestPending(
  pending: Array<{ key: string; noteHash: string; date: string; text: string }>,
  options: DigestOptions,
  cache: DigestCache,
  stats: DigestBuildStats,
): Promise<void> {
  const batches = batchesOf(pending);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const items = batches[batchIndex].map((entry, index) => ({ ...entry, id: `c${String(index + 1).padStart(2, '0')}` }));
    let prompt = renderDigestPrompt(items);
    const left = new Map(items.map(item => [batchId(item.id), item]));
    let transportFailed = false;
    for (let attempt = 0; attempt < DIGEST_ATTEMPTS && left.size > 0; attempt++) {
      let content: string;
      try {
        const res = await options.chat!({
          model: options.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: DIGEST_MAX_OUTPUT_TOKENS,
          reasoning_effort: options.effort,
        });
        stats.calls++;
        stats.promptTokens += res.promptTokens ?? 0;
        stats.completionTokens += billedOutputTokens(res);
        content = res.content;
      } catch (err) {
        stats.calls++;
        stats.error ??= `digest call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        transportFailed = true;
        break;
      }
      const parsed = parseDigestReply(content);
      for (const [id, item] of [...left]) {
        const found = parsed.get(id);
        if (!found) continue;
        const dated = found.map(it => (it.date ? it : { ...it, date: item.date }));
        cache.putDigest(item.key, item.noteHash, { items: dated, model: options.model });
        stats.digested++;
        left.delete(id);
      }
      // A different request, so a provider-side cache cannot replay the incomplete answer.
      prompt += '\n';
    }
    if (left.size > 0) {
      stats.failed += left.size;
      stats.error ??= 'the digest model left some notes without a digest';
    }
    if (transportFailed) {
      // The transport already retried: a provider that is down or out of quota fails the next batch the same way.
      for (const rest of batches.slice(batchIndex + 1)) stats.failed += rest.length;
      break;
    }
  }
}

const EMBED_BATCH = 64;

async function embedDigests(
  notes: Array<{ noteHash: string }>,
  keyOf: (noteHash: string) => string,
  cache: DigestCache,
  provider: EmbeddingProvider,
  space: string | null,
  stats: DigestBuildStats,
): Promise<void> {
  if (space === null) return;
  const waiting: Array<{ key: string; texts: string[] }> = [];
  for (const note of notes) {
    const key = keyOf(note.noteHash);
    const digest = cache.getDigest(key);
    if (!digest || digest.items.length === 0) continue;
    stats.items += digest.items.length;
    if (cache.getVectors(key, space, digest.items.length)) continue;
    waiting.push({ key, texts: digest.items.map(digestItemText) });
  }
  for (let i = 0; i < waiting.length; i += EMBED_BATCH) {
    const group = waiting.slice(i, i + EMBED_BATCH);
    const texts = group.flatMap(entry => entry.texts);
    let vectors: number[][];
    try {
      vectors = await provider.embed(texts);
    } catch (err) {
      stats.failed += group.length;
      stats.error ??= `digest embedding failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      return;
    }
    stats.embeddedTexts += texts.length;
    let at = 0;
    for (const entry of group) {
      cache.putVectors(entry.key, space, vectors.slice(at, at + entry.texts.length));
      at += entry.texts.length;
    }
  }
}

/**
 * `renor index` / `renor rebuild`: build the digests. The caller opens and closes nothing. Not under the daily cost guard
 * (the background worker's, worker.ts): this is a command an operator runs, and the `[digests]` line it prints says what
 * it spent. It must not be run from an unattended job with RENOR_DIGESTS on.
 */
export async function digestIndexedNotes(args: {
  db: Database.Database;
  config: { vaultPath: string; memoryLedger?: string };
  options: DigestOptions;
  provider: EmbeddingProvider;
  onlyPaths?: ReadonlySet<string>;
}): Promise<DigestBuildStats> {
  const cache = new DigestCache(args.options.cachePath);
  try {
    return await buildNoteDigests({
      db: args.db,
      vaultPath: args.config.vaultPath,
      ledgerRelPath: args.config.memoryLedger,
      options: args.options,
      cache,
      provider: args.provider,
      onlyPaths: args.onlyPaths,
    });
  } finally {
    cache.close();
  }
}

// ─── Read time: no model call ───

export interface DigestReport {
  status: 'ok' | 'skipped';
  reason?: 'no-notes' | 'no-digests' | 'no-embedding-space' | 'no-vectors' | 'digest-error';
  /** Notes of the retrieval window whose digest was read, out of the window's notes. */
  windowNotes: number;
  notesWithDigest: number;
  itemsConsidered: number;
  itemsRendered: number;
  tokens: number;
  /** The table as the reader sees it ('' when nothing was rendered). */
  text: string;
  /** Provenance of each rendered item, in rendered order: the note and the turn or section it was said in. */
  items: Array<{ notePath: string; source: string; item: string }>;
  error?: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function rowTokens(item: EvidenceItem): number {
  const action = item.action?.trim() ? ` | ${item.action.trim()}` : '';
  const amount = item.amount?.trim() ? ` | ${item.amount.trim()}` : '';
  const date = item.date?.trim() ? ` | ${item.date.trim()}` : '';
  return encode(`- ${item.item}${action}${amount}${date}\n`).length;
}

/**
 * The table of digest items for one search, and nothing else: the digests of the window's notes (first
 * DIGEST_MAX_WINDOW_NOTES distinct notes of `hits`, never the ledger or a synthetic hit), the best-fitting items by
 * cosine to the query, as many as fit `options.tokens`, ordered oldest first. Reads the cache and the query
 * embedding only.
 */
export async function digestTable(args: {
  db: Database.Database;
  query: string;
  hits: ReadonlyArray<Pick<RetrievalHit, 'notePath'>>;
  options: DigestOptions;
  provider: EmbeddingProvider;
  isLedgerNote?: (notePath: string) => boolean;
  /** The query's embedding when the caller already has it (the search just made it): it is not embedded a second time. */
  queryVector?: number[];
}): Promise<{ items: EvidenceItem[]; report: DigestReport }> {
  const report: DigestReport = {
    status: 'skipped', windowNotes: 0, notesWithDigest: 0, itemsConsidered: 0, itemsRendered: 0, tokens: 0, text: '', items: [],
  };
  const paths: string[] = [];
  for (const hit of args.hits) {
    if (!hit.notePath || hit.notePath.startsWith('_renor/') || paths.includes(hit.notePath)) continue;
    if (args.isLedgerNote?.(hit.notePath)) continue;
    paths.push(hit.notePath);
    if (paths.length >= DIGEST_MAX_WINDOW_NOTES) break;
  }
  report.windowNotes = paths.length;
  if (paths.length === 0) return { items: [], report: { ...report, reason: 'no-notes' } };
  const space = embeddingSpace(args.provider);
  if (space === null) return { items: [], report: { ...report, reason: 'no-embedding-space' } };

  let cache: DigestCache;
  try {
    cache = new DigestCache(args.options.cachePath, { readonly: true });
  } catch (err) {
    // No cache file: nothing was ever digested here, which is the same as no digests.
    return { items: [], report: { ...report, reason: 'no-digests', error: `digest cache unavailable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) } };
  }
  try {
    const noteRow = args.db.prepare('SELECT note_hash, frontmatter_json, modified_at FROM notes WHERE path = ?');
    const candidates: Array<{ notePath: string; order: number; index: number; item: DigestItem; vector: number[]; dateMs: number }> = [];
    let missingVectors = 0;
    paths.forEach((notePath, order) => {
      const row = noteRow.get(notePath) as { note_hash: string; frontmatter_json: string; modified_at: string } | undefined;
      if (!row || !row.note_hash) return;
      const key = DigestCache.digestKey(args.options.model, args.options.effort, DIGEST_PROMPT_TEMPLATE, DIGEST_INPUT_VERSION, row.note_hash);
      const digest = cache.getDigest(key);
      if (!digest) return;
      report.notesWithDigest++;
      if (digest.items.length === 0) return;
      const vectors = cache.getVectors(key, space, digest.items.length);
      if (!vectors) {
        missingVectors++;
        return;
      }
      const noteDate = resolveSessionDate(row.frontmatter_json, row.modified_at);
      digest.items.forEach((item, index) => {
        // A date the model wrote in words ("last Tuesday") does not order; the note's own date does.
        const own = sessionDateMs(item.date);
        const dateMs = own === Number.NEGATIVE_INFINITY ? sessionDateMs(noteDate) : own;
        candidates.push({ notePath, order, index, item, vector: vectors[index], dateMs });
      });
    });
    report.itemsConsidered = candidates.length;
    if (candidates.length === 0) {
      return { items: [], report: { ...report, reason: report.notesWithDigest === 0 ? 'no-digests' : missingVectors > 0 ? 'no-vectors' : 'no-digests' } };
    }
    const queryVector = args.queryVector
      ?? (args.provider.embedQuery
        ? await args.provider.embedQuery(args.query)
        : (await args.provider.embed([args.query]))[0]);
    const ranked = candidates
      .map(candidate => ({ candidate, score: cosine(queryVector, candidate.vector) }))
      .sort((a, b) => b.score - a.score || a.candidate.order - b.candidate.order || a.candidate.index - b.candidate.index);
    const frame = encode(renderEvidenceTable([])).length;
    let used = frame;
    const chosen: typeof candidates = [];
    for (const { candidate } of ranked) {
      const cost = rowTokens(candidate.item);
      if (used + cost > args.options.tokens) break;
      used += cost;
      chosen.push(candidate);
    }
    chosen.sort((a, b) => (a.dateMs === b.dateMs ? 0 : a.dateMs < b.dateMs ? -1 : 1) || a.order - b.order || a.index - b.index);
    const items: EvidenceItem[] = chosen.map(c => ({ item: c.item.item, action: c.item.action, amount: c.item.amount, date: c.item.date }));
    report.status = items.length > 0 ? 'ok' : 'skipped';
    report.itemsRendered = items.length;
    report.text = items.length > 0 ? renderEvidenceTable(items) : '';
    report.tokens = items.length > 0 ? encode(report.text).length : 0;
    report.items = chosen.map(c => ({ notePath: c.notePath, source: c.item.source, item: c.item.item }));
    return { items, report };
  } finally {
    cache.close();
  }
}

/** The digest as one hit, rendered like the evidence table (the same rows the reader sees from the evidence pass). */
export function digestItemsToHit(items: EvidenceItem[]): RetrievalHit {
  return {
    notePath: DIGEST_HIT_PATH,
    chunkId: -1,
    headingPath: 'Digest',
    text: renderEvidenceTable(items),
    score: 1,
    reason: 'digest',
  };
}

/** `renor search`: the hits with the digest hit placed after any synthetic hits already leading, and the report. */
export async function attachDigest(args: {
  db: Database.Database;
  query: string;
  hits: RetrievalHit[];
  options: DigestOptions;
  provider: EmbeddingProvider;
  isLedgerNote?: (notePath: string) => boolean;
  queryVector?: number[];
}): Promise<{ hits: RetrievalHit[]; report: DigestReport }> {
  try {
    const { items, report } = await digestTable(args);
    if (items.length === 0) return { hits: args.hits, report };
    let at = 0;
    while (at < args.hits.length && args.hits[at].notePath.startsWith('_renor/')) at++;
    return { hits: [...args.hits.slice(0, at), digestItemsToHit(items), ...args.hits.slice(at)], report };
  } catch (err) {
    // Optional augmentation: a fault here must never take down the base search, and it is said, not left silent.
    return {
      hits: args.hits,
      report: {
        status: 'skipped', reason: 'digest-error', windowNotes: 0, notesWithDigest: 0, itemsConsidered: 0,
        itemsRendered: 0, tokens: 0, text: '', items: [], error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      },
    };
  }
}

/** The `reason` of the synthetic hits that lead a search page: the evidence table and the digest table. */
export const LEADING_SUMMARY_REASONS: readonly string[] = ['evidence', 'digest'];

/** How many hits at the head of a page are synthetic summary tables (they sit outside top_k and the ranking). */
export function leadingSummaryHits(hits: ReadonlyArray<{ reason?: string }>): number {
  let n = 0;
  while (n < hits.length && LEADING_SUMMARY_REASONS.includes(hits[n].reason ?? '')) n++;
  return n;
}
