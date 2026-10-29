import { escapeInvisibleControls } from './sanitize';

export const TOON_HEADER = 'Format: TOON\n';

/** TOON permits Unicode escapes for BMP scalars, but rejects escaped surrogate pairs and lone surrogates. */
function checkScalars(text: string): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0xd800 && cp <= 0xdfff) || (cp > 0xffff && escapeInvisibleControls(ch) !== ch)) {
      throw new Error('TOON cannot safely represent this Unicode scalar');
    }
  }
}

/** Fixed encoding of the existing JSON value, without a token-size comparison or a JSON fallback. */
export async function renderToon(text: string): Promise<string> {
  // The official encoder is ESM. Default JSON requests never load it.
  const { encode, escapeString, rawString } = await import('@toon-format/toon');
  const encoded = encode(JSON.parse(text), {
    replacer: (_key, value) => {
      if (typeof value !== 'string') return value;
      checkScalars(value);
      if (escapeInvisibleControls(value) === value) return value;
      // Quote the scalar before escaping hidden characters; never escape TOON's structural newlines.
      return rawString(`"${escapeInvisibleControls(escapeString(value))}"`);
    },
  });
  // Keys do not pass through the scalar replacer. Refuse any hidden key or invalid scalar left by the encoder.
  checkScalars(encoded);
  if (encoded.split('\n').some(line => escapeInvisibleControls(line) !== line)) {
    throw new Error('TOON contains an unsafe literal control');
  }
  return TOON_HEADER + encoded;
}
