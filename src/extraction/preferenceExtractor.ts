import type { ExtractorChatClient } from './extractionClient';
import { ExtractorParseError, MAX_EXTRACT_ATTEMPTS, stripExtractorCodeFence, repairMalformedUnicodeEscapes } from './typedFacts';

export { ExtractorParseError, stripExtractorCodeFence, repairMalformedUnicodeEscapes };

/**
 * C4 standing-preference extraction (HYP-20260921-prefs-extraction, ADR-0003
 * §4 payload schema for the preference lane). v1 schema only — statement,
 * kind — frozen prompt + model. `kind` is an UNVALIDATED RENDER-ONLY enum
 * (N12 KILL: taxonomy reliability is extractor-limited — never gate behavior
 * on it); it is NOT part of the dedupe key (norm(statement) is).
 *
 * Standing-vs-one-off is NOT prompt-only: the extractor prompt instructs the
 * model to reject one-off events, and a code-level structural guard
 * (`looksLikeOneOff`) drops extracted rows whose statement carries past-tense
 * one-off markers ("yesterday", "last <day>", "-ed <unit> ago", …). The
 * synthetic fixture enforces this both ways: "I always run Tuesdays" survives;
 * "I ran 5km yesterday" is rejected even when the model (stub) emits it.
 *
 * Ledger KILLs bound this module: N12/N14/N16b/N20/N25 (no prompt iteration
 * beyond v1), H5 (one-pass multi-head KILL — this extracts preferences only),
 * H6 (yield-prefilter KILL, skip ceiling 43.0% — the hash-keyed skip is the
 * only cost control), N15 (cap-80 KILL — selection is retrieval-scoped in the
 * composer, never a bigger cap). Parse failures are EXPLICIT
 * extractor-parse-errors, retried ≤3 times, never silently `[]`, and never
 * cached (pipeline resets the note hash so the next pass retries).
 */

export const PREFS_MODEL = 'gemma4:31b';
/** extraction_version = schema:model (ADR §4): hash-keyed cache key component. */
export const PREFS_EXTRACTION_VERSION = `prefs-v1:${PREFS_MODEL}`;

export interface ExtractedPreference {
  /** First-person-compatible standing rule, stated as the user's own words. */
  statement: string;
  /** Unvalidated render-only enum (like|dislike|policy|attribute, N12 KILL). */
  kind?: string;
}

/** RENOR_PREFS (default OFF). Opt in with 1/true/yes/on. No default flip. */
export function prefsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_PREFS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Structural guard for the standing-vs-one-off fixture (must not rely on the
 * prompt alone): a statement that describes a completed past-tense one-off
 * action is NOT a standing preference, even if the extractor emitted it.
 * Dataset-free — anchored on explicit temporal one-off markers only, never on
 * topic words (a standing rule about running Tuesdays must survive).
 */
export function looksLikeOneOff(statement: string): boolean {
  const s = statement.toLowerCase();
  const markers: RegExp[] = [
    /\byesterday\b/,
    /\blast (night|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    /\bthis (morning|afternoon|evening)\b/,
    /\b(earlier|ago)\b/,
    /\bjust (ran|did|finished|completed|bought|met|visited|attended|started|watched)\b/,
    /\b(i|we|he|she|they) (ran|walked|went|did|finished|completed|bought|met|visited|attended|watched|ate|drank|had) (yesterday|this morning|last )/,
    /\b(had|have) (just|already) /,
  ];
  return markers.some((re) => re.test(s));
}

const SYSTEM_PROMPT = `Extract STANDING PREFERENCES, CONSTRAINTS and durable PROFILE FACTS the USER asserts about themselves. Return STRICT JSON only — no YAML, no markdown code fences, no commentary.

Shape: {"prefs": [{"statement": "<first-person-compatible standing rule>", "kind": "like" | "dislike" | "policy" | "attribute"}]}

Rules:
- statement: durable rule or attribute as the user would say it (likes/dislikes, aversions, dietary restrictions, allergies, style/communication/tool preferences, standing policies like "I never...", "I always...", "I prefer... over...", durable personal attributes like job, family, pets, home, skills)
- kind: one of like, dislike, policy, attribute (best guess; never leave empty)
- STANDING only: what is persistently true or desired — NOT one-off events ("I ran 5km yesterday" is an event, "I always run Tuesdays" is a preference), NOT questions, NOT assistant suggestions, NOT hypotheticals
- Only preferences the USER asserted — first-person-compatible
- Each distinct preference ONCE. Extract 0-15 preferences.
- Do NOT extract from frontmatter metadata.`;

export async function extractPreferences(
  client: ExtractorChatClient,
  noteTitle: string,
  noteBody: string,
): Promise<ExtractedPreference[]> {
  // Truncate body to keep the prompt bounded (same budget as the other lanes).
  const body = noteBody.substring(0, 3000);

  const response = await client.chat.completions.create({
    model: PREFS_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Note: "${noteTitle}"\n\n${body}` },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new ExtractorParseError('extractor-parse-error: preference extraction returned empty content');
  }

  // JSON-strict after fence-strip: a fenced or bare response parses; YAML,
  // truncated JSON, or commentary still fails hard as an explicit parse error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(repairMalformedUnicodeEscapes(stripExtractorCodeFence(content)));
  } catch {
    throw new ExtractorParseError(
      `extractor-parse-error: preference extraction returned non-JSON response (head: ${content.slice(0, 80)})`,
    );
  }

  if (Array.isArray(parsed)) {
    // Schema-drift tolerance: some gemma4 responses emit the bare prefs array
    // without the {"prefs": ...} wrapper. Valid JSON either way; strict on shape.
    (parsed as { prefs?: unknown }).prefs = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray((parsed as { prefs?: unknown }).prefs)) {
    // Wrapper-key drift: gemma4 sometimes renames the wrapper key (e.g.
    // "merchants") or emits a single object. Rows without a non-empty
    // `statement` are dropped below, so mis-shaped rows can never become false
    // preferences — empty is the worst case.
    const firstArray = Object.values(parsed as Record<string, unknown>).find(
      (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null,
    );
    (parsed as { prefs?: unknown }).prefs = firstArray ?? [parsed];
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { prefs?: unknown }).prefs)) {
    throw new ExtractorParseError('extractor-parse-error: preference extraction response is missing a prefs array');
  }

  const prefs: ExtractedPreference[] = [];
  for (const raw of (parsed as { prefs: Array<Record<string, unknown> | null | undefined> }).prefs) {
    const statement = raw?.statement === undefined || raw?.statement === null ? '' : String(raw.statement).trim();
    if (!statement) continue; // malformed rows are dropped, not fatal
    // Structural standing-vs-one-off guard: one-off past-tense events are
    // rejected HERE, not just in the prompt (synthetic-fixture contract).
    if (looksLikeOneOff(statement)) continue;
    const pref: ExtractedPreference = { statement };
    const kind = raw?.kind;
    if (kind !== undefined && kind !== null && String(kind).trim()) {
      pref.kind = String(kind).trim(); // unvalidated render-only enum (N12)
    }
    prefs.push(pref);
  }
  return prefs;
}

/**
 * Retry wrapper: parse failures are retried up to MAX_EXTRACT_ATTEMPTS total;
 * the final failure is rethrown explicitly (never cached, never silent []).
 * Non-parse errors (network, auth) propagate immediately.
 */
export async function extractPreferencesWithRetry(
  extract: (title: string, body: string) => Promise<ExtractedPreference[]>,
  noteTitle: string,
  noteBody: string,
): Promise<ExtractedPreference[]> {
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