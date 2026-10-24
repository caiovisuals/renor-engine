import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNote } from '../indexer/parser';
import { EvidenceCache, type EvidenceFailureEntry } from './evidenceCache';

/**
 * H10-v4 second-pass, question-conditioned evidence extraction (product path).
 *
 * Frozen mechanism (champion = 453/500 = 90.6%, docs/evals/results/
 * H10-V4-FULL500-20260919.md): given a question and the sessions retrieval
 * already selected, the extractor (gemma4:31b) lists every distinct relevant
 * item/event/amount with dates. It never computes totals and never sees gold.
 *
 * Productization adds:
 *   - content-addressed caching (exact rendered prompt -> parsed items, and,
 *     for a day, a reply that was not a table: EVIDENCE_FAILURE_TTL_MS);
 *   - session selection matching the promoted arm (20 sessions, 6,000 chars/session);
 *   - gating (off | auto | always), default off (src/evidence/gate.ts).
 */

export const EVIDENCE_PROMPT_TEMPLATE = `You extract evidence items from a user's dated conversation history.

QUESTION: {question}

Below are the sessions (with dates) that a memory system retrieved for this question.

TASK: List EVERY distinct item, event, or amount mentioned in the sessions that could be
relevant to answering the question. Rules:
- One entry per distinct item (e.g., each product, each trip, each device, each course, each amount).
- "action" = what happened (bought / visited / completed / raised / inherited / ...).
- "amount" = numeric value + unit when stated (e.g., "3 days", "$120", "100 points"); else "".
- "date" = the session/mention date when available; else "".
- Do NOT compute any totals. Do NOT merge different items. Include every candidate even if uncertain.
- Include items the question might count, even when the sessions mention them in passing.

SESSIONS:
{sessions}

Respond with ONLY minified JSON, no markdown:
{{"items":[{{"item":"...","action":"...","amount":"...","date":"..."}}]}}`;

export const EVIDENCE_MODEL_DEFAULT = 'gemma4:31b';
export const MAX_EVIDENCE_SESSIONS = 20;
export const EVIDENCE_SESSION_CHAR_CAP = 6000;

export interface EvidenceItem {
  item: string;
  action?: string;
  amount?: string;
  date?: string;
}

export interface EvidenceSessionInput {
  /** Stable session identity (note path in the product; stem in the eval). */
  stem: string;
  date?: string;
  text: string;
}

export interface EvidenceChatRequest {
  model: string;
  /**
   * Evidence sends one user turn. The write-path extractors send system +
   * user, so both roles are accepted.
   */
  messages: Array<{ role: 'user' | 'system'; content: string }>;
  temperature: 0;
  /**
   * Structured-output hint. The write-path extractors send
   * `{ type: 'json_object' }`. Omitted when the caller does not set it, so
   * evidence requests stay the same bytes.
   */
  response_format?: { type: 'json_object' };
  /**
   * Output-token ceiling. Omitted when the caller does not set it (the write-path extractors never do, and the
   * evidence pass only when the operator set RENOR_EVIDENCE_MAX_TOKENS, so their requests stay the same bytes);
   * the session router sets it so one answer has a bounded cost.
   */
  max_tokens?: number;
  /** Reasoning-effort bound (RENOR_EVIDENCE_REASONING_EFFORT). Omitted when unset. */
  reasoning_effort?: EvidenceReasoningEffort;
}

export interface EvidenceChatResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  /** The provider's total, when it reports one: on Gemini it also counts hidden thinking, which completion omits. */
  totalTokens?: number;
  latencyMs: number;
  /** The provider's `finish_reason`; `length` means the reply stopped at a token limit. */
  finishReason?: string;
}

/** The `reasoning_effort` values OpenAI-compatible providers share. Which ones a model accepts is the provider's call. */
export const EVIDENCE_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type EvidenceReasoningEffort = typeof EVIDENCE_REASONING_EFFORTS[number];

/**
 * Operator bounds on one evidence call. Unset, the request carries neither
 * field and is the same bytes as before the bounds existed.
 *
 * Measured 2026-10-03 (extractor-attribution study, section 6.2): with no
 * bound, a reasoning extractor runs to the provider's own ceiling, e.g. 32,768
 * reasoning tokens and no content, retried as a parse failure, or 17,346
 * completion tokens and 267 s for one 8K prompt. Set both before pointing
 * RENOR_EVIDENCE_MODEL at a reasoning model.
 */
export interface EvidenceRequestBounds {
  maxTokens?: number;
  reasoningEffort?: EvidenceReasoningEffort;
}

export type EvidenceChat = (request: EvidenceChatRequest) => Promise<EvidenceChatResponse>;

export interface EvidenceResult {
  items: EvidenceItem[];
  sessions: Array<{ stem: string; date?: string; chars: number }>;
  fromCache: boolean;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
}

export interface SelectOptions {
  /** Product read policy applied before relevance selection and truncation. */
  transformBody?: (body: string) => string;
  maxSessions?: number;
  charCap?: number;
}

/**
 * Walk ranked hits as session identities, then hydrate each selected session
 * from the complete source note. Retrieved chunk text is never extractor input.
 * Unreadable/virtual/out-of-vault paths are skipped and later hits backfill.
 * The first maxSessions unique notes by encounter rank are selected.
 */
export async function loadEvidenceSessionsFromVault(
  hits: Array<{ notePath: string; text: string; session_date?: string }>,
  vaultPath: string,
  opts: SelectOptions = {},
): Promise<EvidenceSessionInput[]> {
  const maxSessions = opts.maxSessions ?? MAX_EVIDENCE_SESSIONS;
  const charCap = opts.charCap ?? EVIDENCE_SESSION_CHAR_CAP;
  if (maxSessions <= 0) throw new Error('maxSessions must be > 0');
  if (charCap <= 0) throw new Error('charCap must be > 0');

  const root = path.resolve(vaultPath);
  const seen = new Set<string>();
  const sessions: EvidenceSessionInput[] = [];

  for (const hit of hits) {
    if (!hit.notePath || seen.has(hit.notePath)) continue;
    seen.add(hit.notePath);

    const candidate = path.isAbsolute(hit.notePath)
      ? path.resolve(hit.notePath)
      : path.resolve(root, hit.notePath);
    const rel = path.relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;

    let raw: string;
    try {
      raw = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }

    const parsedBody = parseNote(candidate, raw).body;
    const body = opts.transformBody ? opts.transformBody(parsedBody) : parsedBody;
    if (!body) continue;
    const text = body.length > charCap ? `${body.slice(0, charCap)} …[truncated]` : body;
    sessions.push({ stem: hit.notePath, date: hit.session_date, text });
    if (sessions.length >= maxSessions) break;
  }
  return sessions;
}

function sessionBlock(session: EvidenceSessionInput): string {
  const date = session.date ?? '';
  return `--- Session dated ${date} ---\n${session.text}`;
}

/** Exact prompt the extractor receives; the cache keys on this string. */
export function renderEvidencePrompt(query: string, sessions: EvidenceSessionInput[]): string {
  return EVIDENCE_PROMPT_TEMPLATE
    .replace('{question}', query)
    .replace('{sessions}', sessions.map(sessionBlock).join('\n\n'));
}

/**
 * The extractor answered, and its answer is not a table: it did not parse, or it stopped at the token limit. This is
 * the one failure a search remembers (EVIDENCE_FAILURE_TTL_MS); an error before any answer is not. The message is the
 * parse error's, so a caller that reads messages reads what it read before.
 */
export class EvidenceReplyError extends Error {}

/**
 * Fail-fast parse: malformed items JSON throws; it is never cached.
 *
 * A reply the strict parse rejects is repaired for each malformed shape extractors were seen to write (2026-10-03
 * benchmark runs; tests/fixtures/evidence-replies.json), and the first repair whose result is, whole, a JSON object
 * with an items list gives the table. A well-formed object is found inside surrounding text, as it always was; a
 * repaired one is not, because a sentence that only quotes malformed JSON (a note's copy of the prompt's example) is no
 * table. A repair changes structure only, never a character inside a string, so no value is guessed. Any other reply
 * still throws the strict parse's own error.
 */
export function parseEvidenceItems(raw: string): EvidenceItem[] {
  const s = raw.trim().replace(/^```(?:json)?|```$/gm, '').trim();
  try {
    return parseItemsObject(s);
  } catch (err) {
    for (const repaired of repairedReplies(s)) {
      try {
        return itemsFromPayload(JSON.parse(repaired));
      } catch {
        // Not this shape.
      }
    }
    throw err;
  }
}

/** A JSON string (or the one the reply ends inside), a run of `{` or a run of `}`: a brace inside a string is text. */
const STRING_OR_BRACE_RUN = /"(?:[^"\\]|\\[\s\S])*(?:"|$)|\{+|\}+/g;

function* repairedReplies(s: string): Generator<string> {
  // The rows without the object around them: [{"item":...},...].
  if (s.startsWith('[')) yield `{"items":${s}}`;
  // The prompt's own example has doubled braces ({{"items":[{{...}}]}}), and models copy them, on every object or on
  // the outer one only: a run of 2n braces outside strings stands for n.
  const halved = s.replace(STRING_OR_BRACE_RUN, run => (run[0] === '"' || run.length % 2 === 1 ? run : run.slice(run.length / 2)));
  if (halved !== s) yield halved;
  // A reply cut off inside the list (at the token limit): the rows before the cut, then the list and object closed.
  // The cut row is dropped, never completed.
  let end = -1;
  for (const run of s.matchAll(STRING_OR_BRACE_RUN)) if (run[0][0] === '}') end = run.index + run[0].length;
  if (end > 0) yield `${s.slice(0, end)}]}`;
}

function parseItemsObject(s: string): EvidenceItem[] {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('extractor response did not contain a JSON object');
  let payload: unknown;
  try {
    payload = JSON.parse(m[0]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`extractor returned malformed JSON: ${detail}`);
  }
  return itemsFromPayload(payload);
}

function itemsFromPayload(payload: unknown): EvidenceItem[] {
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('extractor JSON must contain an items list');
  return items.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new Error(`extractor item ${index} must be an object`);
    }
    const it = rawItem as Record<string, unknown>;
    const item = typeof it.item === 'string' ? it.item.trim() : '';
    if (!item) throw new Error(`extractor item ${index} must contain a non-empty item string`);
    return {
      item,
      ...(it.action !== undefined ? { action: String(it.action) } : {}),
      ...(it.amount !== undefined ? { amount: String(it.amount) } : {}),
      ...(it.date !== undefined ? { date: String(it.date) } : {}),
    };
  });
}

export interface EvidenceExtractorOptions {
  chat: EvidenceChat;
  cache?: EvidenceCache | null;
  model?: string;
  bounds?: EvidenceRequestBounds;
}

/**
 * Runs (or replays) the second pass. A cache hit performs no model call.
 */
export class EvidenceExtractor {
  private readonly chat: EvidenceChat;
  private readonly cache: EvidenceCache | null;
  readonly model: string;
  readonly bounds: EvidenceRequestBounds;

  constructor(opts: EvidenceExtractorOptions) {
    this.chat = opts.chat;
    this.cache = opts.cache ?? null;
    this.model = opts.model ?? EVIDENCE_MODEL_DEFAULT;
    this.bounds = opts.bounds ?? {};
  }

  /** The exact prompt the extractor receives for `query` over `sessions`, and the key its table is cached under. */
  private promptAndKey(query: string, sessions: EvidenceSessionInput[]): { prompt: string; key: string } {
    const prompt = renderEvidencePrompt(query, sessions);
    // A bound changes what the provider returns, so it is part of the cache
    // identity: a bounded arm never replays an unbounded arm's table.
    return { prompt, key: EvidenceCache.computeKey(this.model, prompt, this.bounds) };
  }

  /** The key extract() caches `query` over `sessions` under, computed the one way extract() computes it. */
  cacheKey(query: string, sessions: EvidenceSessionInput[]): string {
    return this.promptAndKey(query, sessions).key;
  }

  /** The failure remembered under `key` (EVIDENCE_FAILURE_TTL_MS), or null. Never calls the model. */
  replayFailure(key: string): EvidenceFailureEntry | null {
    return this.cache?.getFailure(key) ?? null;
  }

  /**
   * Remembers that the extraction under `key` failed with `error`, so the same request does not pay for it again.
   * A failure the cache cannot store is still reported, as it always was; only the next search pays again.
   */
  rememberFailure(key: string, error: string): void {
    try {
      this.cache?.putFailure(key, { model: this.model, error, failedAt: Date.now() });
    } catch (err) {
      process.stderr.write(`[evidence] could not remember a failed extraction: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** The extraction cached under `key`, or null. Never calls the model. */
  replay(key: string): EvidenceResult | null {
    const cached = this.cache?.get(key) ?? null;
    if (!cached) return null;
    return {
      items: cached.items,
      sessions: cached.sessions,
      fromCache: true,
      model: cached.model,
      usage: { promptTokens: cached.promptTokens, completionTokens: cached.completionTokens },
      latencyMs: 0,
    };
  }

  async extract(query: string, sessions: EvidenceSessionInput[]): Promise<EvidenceResult> {
    if (sessions.length === 0) throw new Error('evidence extraction requires at least one session');
    const { prompt, key } = this.promptAndKey(query, sessions);
    const cached = this.replay(key);
    if (cached) return cached;
    const res = await this.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      ...(this.bounds.maxTokens !== undefined ? { max_tokens: this.bounds.maxTokens } : {}),
      ...(this.bounds.reasoningEffort !== undefined ? { reasoning_effort: this.bounds.reasoningEffort } : {}),
    });
    let items: EvidenceItem[];
    try {
      items = parseEvidenceItems(res.content);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Same parse failure (same retry policy), but a reply cut at a token
      // limit says so rather than reading as malformed by the model.
      throw new EvidenceReplyError(res.finishReason === 'length'
        ? `extractor reply stopped at the token limit (finish_reason=length): ${detail}`
        : detail);
    }
    const sessionMeta = sessions.map(s => ({ stem: s.stem, ...(s.date ? { date: s.date } : {}), chars: s.text.length }));
    const usage = {
      promptTokens: res.promptTokens ?? Math.ceil(prompt.length / 4),
      completionTokens: res.completionTokens ?? Math.ceil(res.content.length / 4),
    };
    this.cache?.put(key, {
      items,
      sessions: sessionMeta,
      model: this.model,
      question: query,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      createdAt: new Date().toISOString(),
    });
    return { items, sessions: sessionMeta, fromCache: false, model: this.model, usage, latencyMs: res.latencyMs };
  }
}
