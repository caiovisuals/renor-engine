/**
 * Privacy-safe error sanitizer: redacts host filesystem paths and bounds message length.
 * Preserves error descriptions, status codes, and syscalls without disclosing server directories.
 */
export function sanitizeErrorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  if (err && typeof err === 'object' && 'path' in err && typeof (err as any).path === 'string' && (err as any).path.length > 0) {
    message = message.split((err as any).path).join('[redacted-path]');
  }
  // Windows absolute paths: C:\...
  const winPath = /(?:^|(?<=[\s(]))(['"`]?)[a-zA-Z]:\\(?:[^\s'"`:,;()\[\]\\]+\\)*[^\s'"`:,;()\[\]]*\1/g;
  // Unix absolute paths: starts with / and has at least two segments (e.g. /home/user/vault or /tmp/x)
  const unixPath = /(?:^|(?<=[\s(]))(['"`]?)\/(?:[^\s'"`:,;()\[\]/]+\/)+[^\s'"`:,;()\[\]]*\1/g;
  return message.replace(winPath, '[redacted-path]').replace(unixPath, '[redacted-path]');
}

/**
 * Characters JSON.stringify leaves literal although a reader may treat them as structure rather than
 * data: the C1 controls (U+0085 NEXT LINE among them), the Unicode format controls — bidirectional
 * overrides and zero-width characters a stored memory can use to reorder or hide text — and the line
 * and paragraph separators. A memory is untrusted text; emitted raw, a bidirectional override makes
 * the reply read backwards in an agent's transcript and a zero-width or line separator can hide an
 * instruction from a human reviewer while the model still tokenizes it.
 *
 * Escaping them to a plain `\uXXXX` escape on the wire changes no tool's contract: JSON.stringify
 * already escapes every C0 control, any JSON parser reads the same string back, so the decoded value
 * is byte-identical while the raw reply an agent or a log reads shows the hidden character as an
 * escape instead of applying it. Mirrors lifecycle.ts JSON_LEAVES_LITERAL, which does the same for the
 * ledger's statement field. Surrogate pairs (astral format characters) are escaped unit by unit.
 *
 * The categories above are not the whole set a reader cannot see. Variation selectors (Mn: U+FE00–FE0F and the
 * supplement U+E0100–E01EF, which spell out bytes an instruction can hide in) and blank fillers (Lo, So or Mn: the Hangul
 * fillers, the braille blank, the combining grapheme joiner) are invisible in a transcript yet pass the categories
 * above, so they are listed by code point (adv report renor-adv-inj6b-1012, F4). Emoji presentation selectors (U+FE0F
 * after a symbol) are escaped too: still lossless after a JSON parse, a few bytes longer in the raw reply.
 */
const OUTPUT_INVISIBLE = new RegExp(
  '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}'
  + '\\u034F\\u115F\\u1160\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0\\u{E0100}-\\u{E01EF}]',
  'gu',
);

export function escapeInvisibleControls(text: string): string {
  return text.replace(OUTPUT_INVISIBLE, ch =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
}
