import type { ExtractorChatClient } from './extractionClient';
import { ExtractorParseError, MAX_EXTRACT_ATTEMPTS, stripExtractorCodeFence, repairMalformedUnicodeEscapes } from './typedFacts';

export { ExtractorParseError, stripExtractorCodeFence, repairMalformedUnicodeEscapes };

/**
 * C3 chronicle event extraction (HYP-20260921-chronicle-extraction, ADR-0003
 * §4 payload schema for the event lane). v1 schema only — when, event,
 * entities — frozen prompt + model. `when` REPRODUCES THE USER'S OWN WORDING
 * ("last Saturday", relative days, times); the row's valid_from is derived
 * from the note's frontmatter date and stays NULL when unknown — a relative
 * `when` is never resolved into an invented normalized date. Ledger KILLs
 * bound this module: N12/N14/N16b/N20/N25 (extractor-prompt variants are a
 * structural ceiling — no v2/v3/v4 prompt iteration), H5 (one-pass multi-head
 * — 48% row loss, so this extracts events only), and H6 (zero-yield prefilter
 * KILL — the hash-keyed skip is the only cost control). Parse failures are
 * EXPLICIT extractor-parse-errors, retried ≤3 times, never silently `[]`, and
 * never cached (pipeline resets the note hash so the next pass retries).
 */

export const EVENTS_MODEL = 'gemma4:31b';
/** extraction_version = schema:model (ADR §4): hash-keyed cache key component. */
export const EVENTS_EXTRACTION_VERSION = `events-v1:${EVENTS_MODEL}`;

export interface ExtractedEvent {
  /** The user's own wording for when the event happened (never normalized). */
  when: string;
  /** Short event phrase (3-8 words). */
  event: string;
  entities?: string[];
}

/** RENOR_CHRONICLE (default OFF). Opt in with 1/true/yes/on. No default flip. */
export function chronicleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_CHRONICLE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const SYSTEM_PROMPT = `Extract KEY EVENTS the USER describes from the note. Return STRICT JSON only — no YAML, no markdown code fences, no commentary.

Shape: {"events": [{"when": "<exactly the user's own wording>", "event": "<short phrase, 3-8 words>", "entities": ["<comma-separated entities>"]}]}

Rules:
- when: reproduce the user's own wording for the time ("last Saturday", "yesterday", "March 3rd", "this morning") — NEVER convert it to a normalized or invented date
- event: short description of what happened (did / attended / started / cancelled / bought / met / visited / celebrated / completed / plans)
- entities: people, places, things involved; omit if none
- Only events the USER did or experienced — not the assistant, not hypotheticals, not third parties
- Each distinct event ONCE. Extract 0-15 events.
- Do NOT extract from frontmatter metadata.`;

export async function extractEvents(
  client: ExtractorChatClient,
  noteTitle: string,
  noteBody: string,
): Promise<ExtractedEvent[]> {
  // Truncate body to keep the prompt bounded (same budget as the legacy extractor).
  const body = noteBody.substring(0, 3000);

  const response = await client.chat.completions.create({
    model: EVENTS_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Note: "${noteTitle}"\n\n${body}` },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new ExtractorParseError('extractor-parse-error: event extraction returned empty content');
  }

  // JSON-strict after fence-strip: a fenced or bare response parses; YAML,
  // truncated JSON, or commentary still fails hard as an explicit parse error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(repairMalformedUnicodeEscapes(stripExtractorCodeFence(content)));
  } catch {
    throw new ExtractorParseError(
      `extractor-parse-error: event extraction returned non-JSON response (head: ${content.slice(0, 80)})`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).events)) {
    throw new ExtractorParseError('extractor-parse-error: event extraction response is missing an events array');
  }

  const events: ExtractedEvent[] = [];
  for (const raw of (parsed as any).events) {
    const when = raw?.when === undefined || raw?.when === null ? '' : String(raw.when).trim();
    const event = raw?.event === undefined || raw?.event === null ? '' : String(raw.event).trim();
    if (!when || !event) continue; // malformed rows are dropped, not fatal
    const extracted: ExtractedEvent = { when, event };
    const entities = raw?.entities;
    if (Array.isArray(entities) && entities.length > 0) {
      const cleaned = entities.map((e: unknown) => String(e).trim()).filter(Boolean);
      if (cleaned.length > 0) extracted.entities = cleaned;
    } else if (typeof entities === 'string' && entities.trim()) {
      // The research prompt asked for comma-separated entities; accept either shape.
      const cleaned = entities.split(',').map((e) => e.trim()).filter(Boolean);
      if (cleaned.length > 0) extracted.entities = cleaned;
    }
    events.push(extracted);
  }
  return events;
}

/**
 * Retry wrapper: parse failures are retried up to MAX_EXTRACT_ATTEMPTS total;
 * the final failure is rethrown explicitly (never cached, never silent []).
 * Non-parse errors (network, auth) propagate immediately.
 */
export async function extractEventsWithRetry(
  extract: (title: string, body: string) => Promise<ExtractedEvent[]>,
  noteTitle: string,
  noteBody: string,
): Promise<ExtractedEvent[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
    try {
      return await extract(noteTitle, noteBody);
    } catch (err) {
      if (!(err instanceof ExtractorParseError)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}