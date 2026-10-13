import { describe, expect, it } from 'vitest';
import {
  repairMalformedUnicodeEscapes,
  stripExtractorCodeFence,
} from '../../src/extraction/typedFacts';

/**
 * Regression contract for the measured gemma4:31b malformation.
 *
 * On the LongMemEval note `09b651aa_3` (a long recipe session with mixed-number
 * amounts), 5 of 6 identical temperature-0 extraction calls returned JSON in
 * which the model rendered a unicode fraction as a TRUNCATED escape:
 *
 *   {"value": "1 \u00frac{1}{2}"}      -> `\u00f` + `rac`
 *
 * `\u00f` is invalid because `r` is not a hex digit, so JSON.parse throws
 * "Bad Unicode escape in JSON". finish_reason was `stop` with a well-formed
 * tail, so this is NOT truncation and NOT transient: the 3-attempt retry only
 * recovers ~42% of such notes, and one unrecovered note aborts the whole
 * product run because the index precondition is fail-closed. That is why
 * structured-rows arms died mid-flight.
 *
 * The repair is a TRANSPORT repair, not a parse-strictness relaxation: anything
 * that is not valid JSON after it still fails hard as ExtractorParseError.
 */
describe('repairMalformedUnicodeEscapes', () => {
  const parses = (s: string): boolean => {
    try { JSON.parse(repairMalformedUnicodeEscapes(s)); return true; } catch { return false; }
  };

  it('repairs the exact measured malformation', () => {
    const raw = '{"facts":[{"value":"1 \\u00frac{1}{2}","unit":"cups"}]}';
    expect(parses(raw)).toBe(true);
  });

  it('repairs a short escape that runs into the closing quote without consuming it', () => {
    // The quote must survive, or the string never terminates.
    const out = repairMalformedUnicodeEscapes('{"a":"2 \\u00f"}');
    expect(out.endsWith('"}')).toBe(true);
    expect(parses('{"a":"2 \\u00f"}')).toBe(true);
  });

  it('repairs EVERY malformed escape in one response, not only the first', () => {
    // The measured note carried several mixed-number amounts, so one response can
    // carry several of these escapes. A non-global replace repaired only the first
    // and JSON.parse still threw "Bad Unicode escape" — the repair looked correct
    // against a one-escape fixture while the real input kept failing the run.
    const raw = '{"facts":[{"value":"1 \\u00frac{1}{2}"},{"value":"2 \\u00frac{1}{4}"}]}';
    expect(parses(raw)).toBe(true);
    const repaired = repairMalformedUnicodeEscapes(raw);
    expect(repaired.match(/\\ufffd/g)?.length).toBe(2);
    expect(repaired).not.toMatch(/\\u00f/);
  });

  it('repairs a malformed escape while leaving a valid one in the same string alone', () => {
    const mixed = '{"a":"\\u00bc","b":"1 \\u00frac{1}{2}"}';
    const repaired = repairMalformedUnicodeEscapes(mixed);
    expect(repaired).toContain('\\u00bc');
    expect(repaired.match(/\\ufffd/g)?.length).toBe(1);
    expect(parses(mixed)).toBe(true);
  });

  it('does NOT touch a literal u after an ESCAPED backslash (valid JSON content)', () => {
    // `\\` is ONE escaped backslash and the following `u` is content, so this
    // Windows path is valid JSON and must survive byte-for-byte. The earlier
    // form matched the second backslash of the pair and rewrote it, turning
    // `C:\user` into `C:\ufffdser` — corrupting the user's own text, which is a
    // worse failure than the malformation this repair exists to fix.
    const raw = String.raw`{"x":"C:\\user"}`;
    expect(repairMalformedUnicodeEscapes(raw)).toBe(raw);
    expect((JSON.parse(repairMalformedUnicodeEscapes(raw)) as { x: string }).x).toBe(String.raw`C:\user`);
  });

  it('repairs a malformed escape while preserving an escaped backslash beside it', () => {
    const raw = String.raw`{"a":"C:\\x","b":"1 \u00frac{1}{2}"}`;
    const out = repairMalformedUnicodeEscapes(raw);
    expect(out).toContain(String.raw`C:\\x`);
    const parsed = JSON.parse(out) as { a: string; b: string };
    expect(parsed.a).toBe(String.raw`C:\x`);
    expect(parsed.b).toContain('\ufffd');
  });

  it('repairs a malformed escape that follows an ESCAPED backslash', () => {
    // Three backslashes: an escaped pair, then an escape introducer. The pair
    // must survive and the malformed escape must still be repaired.
    const raw = String.raw`{"a":"C:\\\u00frac{1}{2}"}`;
    const out = repairMalformedUnicodeEscapes(raw);
    const parsed = JSON.parse(out) as { a: string };
    expect(parsed.a).toBe('C:\\' + '\ufffdrac{1}{2}');
  });

  it('repairs a bare backslash WITHOUT deleting the character after it (no-payload shape)', () => {
    // A Windows path the model emitted with a single backslash is invalid JSON,
    // but it is NOT a truncated escape: nothing was consumed as escape payload,
    // so the text is recoverable exactly. Substituting U+FFFD here would DELETE
    // the `u` (`C:\ufffdser`); escaping the backslash preserves the path.
    const raw = String.raw`{"x":"C:\user"}`;
    expect(() => JSON.parse(raw)).toThrow(); // invalid before the repair, by construction
    const out = repairMalformedUnicodeEscapes(raw);
    expect(out).not.toContain('\ufffd');
    expect((JSON.parse(out) as { x: string }).x).toBe(String.raw`C:\user`);
  });

  it('leaves VALID escapes untouched — including astral pairs and BMP fractions', () => {
    const bmp = '{"a":"\\u00bc"}';
    expect(repairMalformedUnicodeEscapes(bmp)).toBe(bmp);
    const astral = '{"a":"\\ud83d\\ude00"}';
    expect(repairMalformedUnicodeEscapes(astral)).toBe(astral);
    const two = '{"a":"\\u00bc\\u00be"}';
    expect(repairMalformedUnicodeEscapes(two)).toBe(two);
  });

  it('does not touch ordinary text', () => {
    const plain = '{"value":"3.5","object":"km"}';
    expect(repairMalformedUnicodeEscapes(plain)).toBe(plain);
  });

  it('does NOT rescue genuinely truncated or non-JSON output', () => {
    expect(parses('{"a": ')).toBe(false);
    expect(parses('not json at all')).toBe(false);
    expect(parses('{"facts":[{"value":"1"')).toBe(false);
  });

  it('composes with fence stripping (the other measured model habit)', () => {
    const fenced = '```json\n{"facts":[{"value":"1 \\u00frac{1}{2}"}]}\n```';
    expect(parses(stripExtractorCodeFence(fenced))).toBe(true);
  });
});
