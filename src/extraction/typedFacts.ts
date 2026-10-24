import type { ExtractorChatClient } from './extractionClient';

/**
 * C2 typed numeric-fact extraction (HYP-20260921-facts-product-join, ADR-0003
 * §4 payload schema for the fact lane). v1 schema only — value, unit, verb,
 * object, event — frozen prompt + model. Ledger KILLs bound this module:
 * N12/N14/N16b/N20/N25 (extractor-prompt variants are a structural ceiling —
 * no v2/v3/v4 prompt iteration) and H5 (one-pass multi-head — 48% row loss,
 * so this extracts facts only). Parse failures are EXPLICIT
 * extractor-parse-errors, retried ≤3 times, never silently `[]`, and never
 * cached (pipeline resets the note hash so the next pass retries).
 */

export const FACTS_MODEL = 'gemma4:31b';
/** extraction_version = schema:model (ADR §4): hash-keyed cache key component. */
export const FACTS_EXTRACTION_VERSION = `facts-v1:${FACTS_MODEL}`;
/** ≤3 attempts total on parse failure; a final failure is thrown, never swallowed. */
export const MAX_EXTRACT_ATTEMPTS = 3;

export interface ExtractedNumericFact {
  value: string;
  unit?: string;
  verb?: string;
  object: string;
  event?: string;
}

export class ExtractorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractorParseError';
  }
}

/**
 * Strip a leading/trailing markdown code fence from an LLM extraction response
 * before JSON.parse. The frozen gemma4:31b extractor emits ```json fences on a
 * fraction of responses despite strict-JSON prompt instructions (measured:
 * ~10–25% of notes fail as raw JSON on real LongMemEval session corpora).
 * JSON-strictness is preserved: everything that is not a fenced or bare JSON
 * object still fails hard as an explicit ExtractorParseError.
 */
/**
 * Repair a specific, measured malformation in gemma4:31b's extraction JSON: the
 * model renders a mixed-number literal (e.g. "1 1/2" as a unicode fraction) as a
 * TRUNCATED `\uXXXX` escape — `"1 \u00frac{1}{2}"`, i.e. `\u00f` followed by
 * `rac`. `\u00f` is not a valid escape because `r` is not a hex digit, so
 * JSON.parse throws "Bad Unicode escape".
 *
 * Measured on the failing LongMemEval note `09b651aa_3` (a long recipe session
 * with several mixed-number amounts): 5 of 6 identical temperature-0 calls
 * returned this malformation with finish_reason=stop and a well-formed tail —
 * it is NOT truncation and NOT a transient error, and the existing 3-attempt
 * retry therefore fails ~58% of the time on such a note. One unrecovered note
 * aborts the whole product run (the index precondition is fail-closed), which is
 * why structured-rows arms died mid-flight.
 *
 * The repair is deliberately minimal and lossless for every other input: it
 * rewrites only a `\u` escape whose four hex digits are NOT all hex. The intent
 * is unambiguous (the model tried to emit a hex escape and ran past it), so the
 * malformed escape is replaced with the replacement character rather than being
 * silently dropped or guessed. Valid escapes, including astral pairs, are
 * untouched, so this cannot alter a well-formed response.
 *
 * It repairs EVERY malformed escape in the response, and that is the whole point
 * of the global flag below. The measured note had SEVERAL mixed-number amounts
 * in one response, and a single response can carry several of these escapes; a
 * non-global replace left all but the first in place, so JSON.parse still threw
 * "Bad Unicode escape" and the note still aborted the run — the repair appeared
 * to work on the one-escape fixture in the test while the real input kept
 * failing. Found by the independent review of PR #156.
 *
 * This is a TRANSPORT repair, not a parse-strictness relaxation: after it runs,
 * a response that is not valid JSON still fails hard as ExtractorParseError.
 */
export function repairMalformedUnicodeEscapes(content: string): string {
  // A malformed escape is a backslash that INTRODUCES an escape — i.e. is not
  // itself escaped — followed by `u`, at most three hex digits, then a non-hex
  // character. Two things this must leave alone, and the second one is why the
  // run of backslashes is examined rather than just the last two characters:
  //
  //   - a VALID `\uXXXX` escape: at four hex digits the lookahead can never
  //     match, so it is skipped;
  //   - a LITERAL `u` after an ESCAPED backslash, e.g. the Windows path
  //     `"C:\\user"`. `\\` is ONE escaped backslash and the `u` is content, so
  //     the run of backslashes before that `u` is even; only an ODD run ends on
  //     an escape introducer. Matching the final two characters regardless
  //     rewrote the second backslash of the pair and corrupted real content:
  //     `C:\user` became `C:\ufffdser`. Silently changing valid user text is a
  //     worse failure than the malformation this repair exists to fix, and the
  //     independent review of PR #156 caught it.
  return content.replace(
    /(\\+)u([0-9a-fA-F]{0,3})(?![0-9a-fA-F])/g,
    (match: string, backslashes: string, hex: string) => {
      // Only an ODD run of backslashes ends on an escape introducer; an even run
      // is entirely escaped backslashes, so the `u` after it is ordinary content
      // and the match is left exactly as it was.
      if (backslashes.length % 2 === 0) return match;
      const introducer = backslashes.slice(0, -1);
      if (hex.length === 0) {
        // TWO SHAPES, TWO REPAIRS. With NO hex digit the model emitted a bare
        // backslash before an ordinary character (a Windows path, a regex, a
        // price like `\u`), and nothing was consumed as escape payload, so the
        // text is recoverable exactly: escape the backslash. Substituting
        // U+FFFD here DELETES the character that followed it, which is how
        // `C:\user` became `C:\ufffdser`.
        return `${introducer}\\\\u`;
      }
      // One to three hex digits: the model tried to emit a `\uXXXX` escape and
      // ran past it (the measured gemma4:31b truncated-fraction malformation).
      // Those characters really were escape payload, so the unambiguous repair
      // is the replacement character.
      return `${introducer}\\ufffd`;
    },
  );
}

export function stripExtractorCodeFence(content: string): string {
  const s = content.trim();
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
  return m ? m[1].trim() : s;
}

/** RENOR_TYPED_FACTS (default OFF). Opt in with 1/true/yes/on. No default flip. */
export function typedFactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_TYPED_FACTS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Content date for valid_from (ADR §4): frontmatter `session_date`, else
 * `date`, when parsable. NULL = unknown, never `now()`, never invented —
 * an unparsable date string stays NULL (unknown must remain distinguishable).
 * gray-matter parses bare YAML dates into JS Date objects; dates normalize to
 * day precision (content dates are dates, not timestamps).
 */
export function contentDateFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  for (const key of ['session_date', 'date']) {
    const raw = frontmatter[key];
    if (raw === undefined || raw === null) continue;
    if (raw instanceof Date) {
      if (Number.isNaN(raw.getTime())) continue;
      return raw.toISOString().slice(0, 10);
    }
    const s = String(raw).trim();
    if (!s) continue;
    const isoDay = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDay) return isoDay[1];
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

const SYSTEM_PROMPT = `Extract numeric facts from the note. Return STRICT JSON only — no YAML, no markdown code fences, no commentary.

Shape: {"facts": [{"value": "<number exactly as written>", "unit": "<unit or omit>", "verb": "<short verb phrase or omit>", "object": "<what the number is about>", "event": "<optional event label or omit>"}]}

Rules:
- value: the numeric quantity as written (e.g. "3:45", "42", "R$ 1.200", "15%")
- unit: measurement unit when stated (km, kg, hours, BRL, %, ...)
- verb: short snake_case verb phrase (e.g. "ran", "weighs", "costs", "deadline")
- object: the thing the number is about, in plain text
- Only numeric facts clearly stated in the note body. Extract 0-15 facts.
- Do NOT extract from frontmatter metadata.`;

export async function extractNumericFacts(
  client: ExtractorChatClient,
  noteTitle: string,
  noteBody: string,
): Promise<ExtractedNumericFact[]> {
  // Truncate body to keep the prompt bounded (same budget as the legacy extractor).
  const body = noteBody.substring(0, 3000);

  const response = await client.chat.completions.create({
    model: FACTS_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Note: "${noteTitle}"\n\n${body}` },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new ExtractorParseError('extractor-parse-error: fact extraction returned empty content');
  }

  // JSON-strict after fence-strip: a fenced or bare response parses; YAML,
  // truncated JSON, or commentary still fails hard as an explicit parse error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(repairMalformedUnicodeEscapes(stripExtractorCodeFence(content)));
  } catch {
    throw new ExtractorParseError(
      `extractor-parse-error: fact extraction returned non-JSON response (head: ${content.slice(0, 80)})`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { facts?: unknown }).facts)) {
    throw new ExtractorParseError('extractor-parse-error: fact extraction response is missing a facts array');
  }

  const facts: ExtractedNumericFact[] = [];
  for (const raw of (parsed as { facts: Array<Record<string, unknown> | null | undefined> }).facts) {
    const value = raw?.value === undefined || raw?.value === null ? '' : String(raw.value).trim();
    const object = raw?.object === undefined || raw?.object === null ? '' : String(raw.object).trim();
    if (!value || !object) continue; // malformed rows are dropped, not fatal
    const fact: ExtractedNumericFact = { value, object };
    for (const key of ['unit', 'verb', 'event'] as const) {
      const v = raw?.[key];
      if (v !== undefined && v !== null && String(v).trim()) fact[key] = String(v).trim();
    }
    facts.push(fact);
  }
  return facts;
}

/**
 * Retry wrapper: parse failures are retried up to MAX_EXTRACT_ATTEMPTS total;
 * the final failure is rethrown explicitly (never cached, never silent []).
 * Non-parse errors (network, auth) propagate immediately.
 */
export async function extractNumericFactsWithRetry(
  extract: (title: string, body: string) => Promise<ExtractedNumericFact[]>,
  noteTitle: string,
  noteBody: string,
): Promise<ExtractedNumericFact[]> {
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