import { encode } from 'gpt-tokenizer';

/**
 * Tokens in `text` (o200k, gpt-tokenizer), with special-token spellings counted as the plain text they are.
 *
 * gpt-tokenizer's default `encode` treats `<|endoftext|>`, `<|im_start|>` and the other special-token spellings as chat
 * protocol and THROWS ("Disallowed special token found"). Benchmark haystacks and user notes contain those strings as
 * ordinary text: the 2026-10-21 LongMemEval-S nightly crashed at question ~351/500 on a haystack holding `<|endoftext|>`
 * (assembleClientContext, run-longmemeval-product.ts). Counting them as text is what the engine already does
 * (src/indexer/o200k.ts countO200k), and for text without such a spelling the count is identical to the default `encode`.
 */
const PLAIN_TEXT = { disallowedSpecial: new Set<string>() };

export function countTextTokens(text: string): number {
  return encode(text, PLAIN_TEXT).length;
}
