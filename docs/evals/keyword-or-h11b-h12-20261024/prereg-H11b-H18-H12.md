# Pre-registration: H11b, H18 and H12 (firstmate inbox 021, 2026-10-24T07:42Z)

Written before any of the three replays. Claimant: renor-goal-better-temporal-2. Inputs: `queries.json` (the 409 stored first `get_context` queries) and `tasks.json` (gold text) in this folder, and the copied index of the 24 Oct run. Replays run the engine's real `get_context` keyword path with no embedding provider and no model call.

## Order
1. **H11b first** (candidate generation, the largest loss at 145 of 409 not in any candidate).
2. **H18 on the H11b base** (page assembly, 98 of 264 candidates cut before the reply).
3. **H12** (`search_text` fallback), after both.

## H11b: one OR query over the content words (RENOR_KEYWORD_OR_ALL=1; default off)
- Arm: the keyword lane issues one FTS expression: the question's content words joined by OR, each quoted, top 6. BM25 already weights rare words highest (their inverse document frequency is largest). No extra weighting is added.
- Default: the shipped variants, byte-identical when unset.
- Keep, all of: needed-on-page on the real reply rises by at least 5 points over the default (today 40.8% on the 409 queries); no kind's losses exceed its gains by more than 2; mean tokens rise at most 5%; off is byte-identical; RenorBench and the LongMemEval dev100 page figures not worse (free replays, no model call).
- Kill: anything else.

## H18: page composition, on the H11b base
- Arm: `RENOR_CONTEXT_LEAN_ITEMS=1` on top of H11b. Base: H11b. The page budget stays 800 tokens.
- Keep: needed-on-page rises by at least 3 points over H11b alone, tokens rise at most 5%.
- Kill: otherwise. If H11b is killed, H18 runs on the default base instead and is labelled so.

## H12: `search_text` fallback when the exact phrase is empty
- Arm: when the exact phrase finds nothing, the reply runs the same words as an OR query and labels the reply as a fallback. Default: exact phrase only.
- Keep: at least 10 of the 128 empty replies gain the needed note, and no non-empty reply changes.
- Kill: otherwise.

## Not allowed
Changing the 409 queries, the gold text, the scorer, or the page budget after seeing a result; a second arm to rescue a kill; a model or embedding call in a replay; any reply count taken from the proxy instead of the real engine.
