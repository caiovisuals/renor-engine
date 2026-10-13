/**
 * The engine's tokenizer, loaded on first use rather than at import time.
 *
 * WHY THIS IS LAZY, with the measurement rather than the intuition: requiring
 * `gpt-tokenizer` costs ~344 ms on Node 22, of which ~205 ms is the o200k_base
 * BPE ranks table — the single heaviest module on a cold start of
 * dist/mvp/cli.js, ahead of express (97 ms) and the MCP SDK (205 ms). Both of
 * the engine's entry paths need it eventually (the chunker when it cuts a note,
 * the context assembler when it budgets a reply), so this is not a module that
 * can be dropped; it is one that a wake does not need yet.
 *
 * WHY THAT IS A REAL WIN RATHER THAN A MOVE: with every workspace asleep after
 * its idle period (#324), what the gateway waits for is the start, and a start
 * that never counts a token never loads a 344 ms table. Measured on Node 22
 * against a seeded fixture workspace, spawn -> Listening fell from 1119 ms to
 * 605 ms. The first operation that DOES count tokens then loads it, and with
 * this workspace's compile cache warm that load is ~63 ms cheaper than the one
 * it replaces — so the shift is smaller than the saving, not merely equal to it.
 *
 * WHY IT IS SAFE: `encode` is a pure function of its input. There is no
 * construction cost, no ordering requirement, no ambient state to initialise and
 * nothing that observes whether it was imported eagerly. The only observable
 * difference is WHEN the module is compiled, and this file is the single place
 * that decides that.
 */

/** The shape this file uses, so the dependency stays typed without being loaded. */
export type TokenEncoder = (
  text: string,
  options?: { disallowedSpecial?: Set<string> },
) => unknown[];

let encoder: TokenEncoder | null = null;

/**
 * A run of one kind of character (all whitespace, or none) this long is not encoded. The encoder's merge loop costs
 * time quadratic in the length of such a run: 60,000 characters of `x` take ~5 s, where prose of the same size takes
 * ~3 ms. Real text has no runs this long, so only a pathological or pasted blob reaches it.
 */
const LONG_RUN = 1_000;
const RUN_RE = /\S+|\s+/g;
/**
 * Characters per token for a long run, measured on this encoder (o200k): 60,000 `x` are 7,500 tokens and 60,000
 * spaces are 471. A blob of base64 or minified code is nearer the first, so the estimate is a middle figure for
 * non-space runs, and a generous one for whitespace.
 */
const CHARS_PER_TOKEN = { text: 4, space: 128 };

/**
 * The tokenizer's `encode`, loaded on first call.
 *
 * `disallowedSpecial: new Set()` is not optional and not a default here: special
 * token syntax (`<|im_start|>`, `<|endoftext|>`, …) can legitimately appear
 * inside note CONTENT, and gpt-tokenizer rejects such text as chat protocol by
 * default. Counting it as plain text is what keeps indexing from failing closed
 * on an imported ShareGPT history.
 *
 * A run of at least LONG_RUN characters is estimated (see CHARS_PER_TOKEN) and taken out of the text the encoder
 * sees, so the estimate is not its exact count. Text without such a run is counted exactly, as before.
 */
export function encodeTokens(text: string): number {
  if (encoder === null) {
    // A plain require, not a top-level import: that is the whole point of this
    // file. The engine compiles to CommonJS (tsconfig module Node16, package
    // type commonjs), so `require` is the loader this module is deferring.
    encoder = require('gpt-tokenizer').encode as TokenEncoder;
  }
  let estimated = 0;
  let rest = text;
  if (text.length >= LONG_RUN) {
    const runs = text.match(RUN_RE) ?? [];
    if (runs.some(run => run.length >= LONG_RUN)) {
      rest = runs
        .map(run => {
          if (run.length < LONG_RUN) return run;
          estimated += Math.ceil(run.length / (/\s/.test(run) ? CHARS_PER_TOKEN.space : CHARS_PER_TOKEN.text));
          return ' ';
        })
        .join('');
    }
  }
  return encoder(rest, { disallowedSpecial: new Set() }).length + estimated;
}

/** True once the tokenizer module has actually been loaded. Diagnostics and tests. */
export function tokenizerLoaded(): boolean {
  return encoder !== null;
}
