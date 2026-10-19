/**
 * The engine's token counter, loaded on first use rather than at import time.
 *
 * WHY THIS IS LAZY, with the measurement rather than the intuition: requiring
 * `gpt-tokenizer` cost ~344 ms on Node 22, of which ~205 ms is the o200k_base
 * BPE ranks table — the single heaviest module on a cold start of
 * dist/mvp/cli.js, ahead of express (97 ms) and the MCP SDK (205 ms). Both of
 * the engine's entry paths need a count eventually (the chunker when it cuts a
 * note, the context assembler when it budgets a reply), so this is not a module
 * that can be dropped; it is one that a wake does not need yet.
 *
 * WHY IT IS ./o200k AND NOT gpt-tokenizer ANY MORE: gpt-tokenizer builds a Map of
 * 200,000 strings, which is ~45 MiB of resident memory in every running
 * workspace for ever after its first count (~60 MiB under load). ./o200k counts
 * the same tokens from ~4 MiB of typed arrays; tests/indexer/o200k-counter.test.ts
 * holds its counts equal to gpt-tokenizer's. gpt-tokenizer stays a dependency for
 * the evaluation harness and for those tests, which are the oracle.
 * docs/performance/MEMORY-PER-WORKSPACE.md has the measurement.
 *
 * WHY IT IS SAFE: a count is a pure function of its input. There is no
 * construction cost, no ordering requirement, no ambient state to initialise and
 * nothing that observes whether it was imported eagerly. The only observable
 * difference is WHEN the vocabulary is built, and this file is the single place
 * that decides that.
 */

import { countO200k, o200kLoaded } from './o200k';

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
 * The token count of `text`, with the counter loaded on first call.
 *
 * Special token syntax (`<|im_start|>`, `<|endoftext|>`, …) is counted as plain
 * text, not refused: it can legitimately appear inside note CONTENT, and
 * gpt-tokenizer rejects such text as chat protocol by default. Counting it as
 * plain text is what keeps indexing from failing closed on an imported ShareGPT
 * history.
 *
 * A run of at least LONG_RUN characters is estimated (see CHARS_PER_TOKEN) and taken out of the text the encoder
 * sees, so the estimate is not its exact count. Text without such a run is counted exactly, as before.
 */
export function encodeTokens(text: string): number {
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
  return countO200k(rest) + estimated;
}

/** True once the counter module has actually been loaded. Diagnostics and tests. */
export function tokenizerLoaded(): boolean {
  return o200kLoaded();
}
