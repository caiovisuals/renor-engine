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
 *   - gating (off | auto | always), default always, with an explicit off switch.
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

/**
 * EXHAUSTIVE enumeration variant of the evidence prompt (RENOR_EVIDENCE_ENUMERATE,
 * default OFF — opt in with 1/true/yes/on).
 *
 * Why this exists, measured: the shipped prompt asks for items "that could be
 * relevant to answering the question" — a relevance FILTER applied to an
 * enumeration task. On the champion's 23 count/aggregate wrongs that filter is
 * the binding constraint: the evidence table holds a mean of 5.3 items, and 13 of
 * the 23 have FEWER items than the gold count requires. The count-contract arm
 * proved the reader's arithmetic is correct — it lists 2 items and answers "2"
 * for gold 3 — so the items are simply absent from the table it counts.
 *
 * Prompt-variant A/B on one case (gpt4_31ff4165, "How many health-related devices
 * do I use in a day?", gold 4) at temperature 0:
 *
 *   shipped prompt    :  4 items,  134 completion tokens
 *   this variant      : 27 items,  936 completion tokens
 *
 * The variant asks for everything mentioned and states that completeness is the
 * only goal, that missing an item is a failure, and that including an irrelevant
 * item is NOT a failure — the exact inverse of the shipped relevance filter.
 *
 * Scope discipline: this changes the EVIDENCE prompt only. The frozen
 * judge/extractor model, the retrieval ranking, the schema, the item payload and
 * the fact/chronicle/preference lanes are untouched. Default OFF, so shipped
 * behaviour is byte-identical unless an eval arm opts in.
 */
export const EVIDENCE_PROMPT_TEMPLATE_EXHAUSTIVE = `You extract a COMPLETE inventory of items from a user's dated conversation history.

QUESTION: {question}

Below are the sessions (with dates) that a memory system retrieved for this question.

TASK: List EVERY distinct item, device, object, purchase, place, person, activity, event or amount mentioned ANYWHERE in the sessions below — whether or not it appears relevant to the question. Completeness is the ONLY goal.
Rules:
- COMPLETENESS OVER BREVITY. If the sessions mention ten things, list all ten. Do not summarise, do not select, do not rank, do not judge relevance.
- Missing an item is a failure. Including an item that turns out to be irrelevant is NOT a failure.
- One entry per distinct item (e.g., each product, each device, each trip, each course, each amount).
- Do NOT merge different items. Do NOT compute any totals.
- "action" = what happened (bought / visited / completed / raised / inherited / used / ...).
- "amount" = numeric value + unit when stated (e.g., "3 days", "$120", "100 points"); else "".
- "date" = the session/mention date when available; else "".

SESSIONS:
{sessions}

Respond with ONLY minified JSON, no markdown:
{{"items":[{{"item":"...","action":"...","amount":"...","date":"..."}}]}}`;

/**
 * RENOR_EVIDENCE_ENUMERATE (default OFF).
 *
 *   unset / 0 / off  -> shipped relevance-filtered prompt (default)
 *   1/true/yes/on    -> `all`: enumerate everything mentioned (MEASURED NO-GO —
 *                       14.6x context for +3/-1 coverage; kept for the record)
 *   scoped           -> enumerate every instance of the TYPE the question counts
 *
 * `scoped` exists because `all` failed for a reason unrelated to enumeration
 * itself: it returned 84 items/case on average (p50 67, max 228) by listing
 * steps, sleep hours and battery counts alongside the counted objects. Scoping
 * the enumeration to the counted type should add the missing instances without
 * the irrelevant mass. Same goal as `all`, different mechanism — so it is a
 * distinct variant, not a retry of a refuted one.
 */
export type EvidenceEnumerateMode = 'off' | 'all' | 'scoped';

export function evidenceEnumerateMode(env: NodeJS.ProcessEnv = process.env): EvidenceEnumerateMode {
  const raw = (env.RENOR_EVIDENCE_ENUMERATE ?? '').trim().toLowerCase();
  if (raw === 'scoped') return 'scoped';
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return 'all';
  return 'off';
}

/** Back-compat boolean form (true for either enumeration mode). */
export function evidenceEnumerateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return evidenceEnumerateMode(env) !== 'off';
}

/**
 * SCOPED enumeration template: the model first names the entity type the question
 * counts, then lists every instance of that type. Deliberately instructs the model
 * to EXCLUDE the incidental magnitudes it is not being asked to count (steps per
 * day, hours of sleep, battery pack sizes) — the exact mass that made `all`
 * unusable. Gold-blind: the only input is the user's question and the retrieved
 * sessions.
 */
export const EVIDENCE_PROMPT_TEMPLATE_SCOPED = `You extract a COMPLETE inventory of one specific kind of entity from a user's dated conversation history.

QUESTION: {question}

Below are the sessions (with dates) that a memory system retrieved for this question.

STEP 1 — From the QUESTION, decide the single kind of thing being counted or totalled. Examples: "how many items of clothing" -> garments; "how many devices do I use" -> devices; "how many albums did I buy" -> albums; "how much did I spend in total" -> purchases with an amount; "how many properties did I view" -> properties.

STEP 2 — List EVERY instance of THAT kind found ANYWHERE in the sessions below. Completeness is the only goal.
Rules:
- Do NOT list incidental magnitudes of the same sentences. If counting devices, do NOT list "10,000 steps", "7-9 hours of sleep", "size 13 batteries" or "8-10 glasses of fluid" — those are not devices.
- Do NOT summarise, do NOT select, do NOT rank, do NOT judge relevance.
- Missing an instance of the counted kind is a failure. Including one that turns out to be irrelevant is NOT a failure.
- Keep each entry short: the entity itself, plus the amount/detail if the question is about an amount.
- Do NOT merge different instances. Do NOT compute any totals.

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
  /** Query text used by body-relevance ranking (RENOR_EVIDENCE_BODY_RANK). */
  query?: string;
  /** Explicit override of the RENOR_EVIDENCE_BODY_RANK env flag. */
  bodyRank?: boolean;
}

/**
 * H9-family stop list (same shape as mvp/agentMemory.ts FTS_STOP_WORDS).
 */
const BODY_RANK_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'where', 'when',
  'why', 'how', 'do', 'does', 'did', 'to', 'for', 'of', 'in', 'on', 'at', 'with', 'and',
  'or', 'my', 'your', 'our', 'their', 'his', 'her', 'it', 'this', 'that', 'about',
]);

/** Unicode-aware lexical tokens: letter/number runs, 2..64 chars (H9 family). */
function bodyRankTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,64}/gu) ?? []).slice(0, 20000);
}

/**
 * Deterministic, gold-blind lexical query-term overlap between a query and a
 * candidate note body: total frequency of each distinct non-stop query term in
 * the body. Zero model calls and zero embeddings at query time.
 */
export function scoreBodyOverlap(query: string, body: string): number {
  const queryTerms = new Set(
    bodyRankTokens(query).filter(term => !BODY_RANK_STOP_WORDS.has(term)),
  );
  if (queryTerms.size === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of bodyRankTokens(body)) counts.set(token, (counts.get(token) ?? 0) + 1);
  let score = 0;
  for (const term of queryTerms) score += counts.get(term) ?? 0;
  return score;
}

/** Opt-in kill-switch for body-relevance selection; default off. */
export function bodyRankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_EVIDENCE_BODY_RANK ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Walk ranked hits as session identities, then hydrate each selected session
 * from the complete source note. Retrieved chunk text is never extractor input.
 * Unreadable/virtual/out-of-vault paths are skipped and later hits backfill.
 *
 * Default (RENOR_EVIDENCE_BODY_RANK off): the first maxSessions unique notes by
 * encounter rank. With RENOR_EVIDENCE_BODY_RANK=1: every unique candidate note
 * among the hits is hydrated (same ≤charCap truncation), scored by
 * `scoreBodyOverlap`, and the top maxSessions are selected by
 * (score desc, hit rank asc, notePath asc). Deterministic and gold-blind;
 * per-session hydrated text and therefore extraction prompt bytes are
 * unchanged, so the evidence content-addressed cache stays valid.
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
  const bodyRank = opts.bodyRank ?? bodyRankEnabled();

  const root = path.resolve(vaultPath);
  const seen = new Set<string>();
  const candidates: Array<EvidenceSessionInput & { hitRank: number }> = [];

  for (let hitRank = 0; hitRank < hits.length; hitRank++) {
    const hit = hits[hitRank];
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
    candidates.push({ stem: hit.notePath, date: hit.session_date, text, hitRank });
    if (!bodyRank && candidates.length >= maxSessions) break;
  }

  // Flag-off path must be byte-identical to shipped behavior — strip the
  // internal hitRank before returning (review finding P2-1).
  if (!bodyRank) return candidates.map(({ hitRank, ...session }: EvidenceSessionInput & { hitRank: number }) => session);
  return selectSessionsByBodyOverlap(opts.query ?? '', candidates).slice(0, maxSessions);
}

/**
 * Body-relevance selection: score desc, then hit rank asc, then notePath asc.
 * Fully deterministic; a zero-score query degrades to encounter order.
 */
function selectSessionsByBodyOverlap(
  query: string,
  candidates: Array<EvidenceSessionInput & { hitRank: number }>,
): EvidenceSessionInput[] {
  const scored = candidates.map(candidate => ({
    candidate,
    score: scoreBodyOverlap(query, candidate.text),
  }));
  scored.sort((a, b) =>
    b.score - a.score
    || a.candidate.hitRank - b.candidate.hitRank
    || (a.candidate.stem < b.candidate.stem ? -1 : a.candidate.stem > b.candidate.stem ? 1 : 0));
  return scored.map(({ candidate }) => ({
    stem: candidate.stem,
    date: candidate.date,
    text: candidate.text,
  }));
}

function sessionBlock(session: EvidenceSessionInput): string {
  const date = session.date ?? '';
  return `--- Session dated ${date} ---\n${session.text}`;
}

/** Exact prompt the extractor receives; the cache keys on this string. */
export function renderEvidencePrompt(query: string, sessions: EvidenceSessionInput[]): string {
  const mode = evidenceEnumerateMode();
  const template = mode === 'scoped' ? EVIDENCE_PROMPT_TEMPLATE_SCOPED
    : mode === 'all' ? EVIDENCE_PROMPT_TEMPLATE_EXHAUSTIVE
    : EVIDENCE_PROMPT_TEMPLATE;
  return template
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
