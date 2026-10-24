# LongMemEval dev100 page guard for PR 951 (H11b and H12): the box command

Written 2026-10-24 for the server (firstmate inbox 023). Uses only the existing box page dump, `engine/scripts/eval/dump-pages-box.sh`, which runs `dump-longmemeval-pages.ts` under `env -i` with no keys and a cache-only embedding proxy (a text missing from the cache is an error). No model call, no embedding call, no credential.

## What it checks
1. **Byte-identical when off.** The dev100 pages from `origin/main` (bded2ed56) and from the PR branch with no flag set must have the same `pages.sha256`.
2. **Page figures not worse with the switch on.** Dev100 pages with `RENOR_KEYWORD_OR_ALL=1` (H11b) against the off pages: the share of questions whose gold answer session is on the page (recall at 20 hits) must not fall, and the number of questions that lose it must be reported.

H12 (`RENOR_SEARCH_TEXT_FALLBACK`) is an MCP `search_text` change and does not touch the dump; it is checked by its own replay (`h12-summary.json` and `h12-rows.json` in this folder).

## Inputs
- `DEV100_IDS`: `engine/scripts/eval/retrieval-ablation/ids/dev100.txt` in the source tree (committed on origin/main, 100 ids, sha256 `b2a9c0f58e43241e4eb1f4293ae6a43d9e20471271eb8fdf0d9c83b32419185e`, verified 2026-10-24 with `git show origin/main:...`). Use the copy in the tree; check the sha before the run.
- `DATASET`: `longmemeval_s.json`, sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`.
- `EMBED_CACHE`: a copy of `embed-cache.db` on the box (the 1.8 GB Vertex cache, namespace `vertex/gemini-embedding-001/768`). I could not verify its location on box-a5c070 from here; the server confirms the path.
- Source trees: `git archive` of `origin/main` (bded2ed56) and of `fm/renor-or-fallback` (PR 951 head, 489ecce23). Run `npm ci` in `engine/` with Node 22 (the pin is `engine/mise.toml`). Native modules are per Node major.

## Commands (on the box, in the two source trees)
```bash
set -euo pipefail
DATASET=/data/bench/longmemeval_s.json      # sha256 08d8dad4be43...
EMBED=/data/bench/embed-cache.db            # a copy; the proxy opens it, nothing is written
MAIN=/data/src/main/engine                  # git archive origin/main, npm ci done
PR=/data/src/pr951/engine                   # git archive fm/renor-or-fallback, npm ci done
IDS=$MAIN/scripts/eval/retrieval-ablation/ids/dev100.txt   # committed; check sha256 b2a9c0f5...185e first
OUT=/data/guard-dev100
mkdir -p "$OUT"

# 1. shipped main, no flags
(cd "$MAIN" && scripts/eval/dump-pages-box.sh --dataset "$DATASET" --embed-cache "$EMBED" --output "$OUT/main-off" --port 18801 -- --ids-file "$IDS")
# 2. PR branch, no flags (must be byte-identical to 1)
(cd "$PR" && scripts/eval/dump-pages-box.sh --dataset "$DATASET" --embed-cache "$EMBED" --output "$OUT/pr-off" --port 18802 -- --ids-file "$IDS")
# 3. PR branch, H11b on
(cd "$PR" && DUMP_ENV="RENOR_KEYWORD_OR_ALL=1" scripts/eval/dump-pages-box.sh --dataset "$DATASET" --embed-cache "$EMBED" --output "$OUT/pr-on" --port 18803 -- --ids-file "$IDS")

# 4. byte check and page figures
diff "$OUT/main-off/pages.sha256" "$OUT/pr-off/pages.sha256" && echo "BYTE-IDENTICAL: off == shipped"
python3 "$(dirname "$0")/guard-compare.py" "$OUT/pr-off" "$OUT/pr-on" > "$OUT/guard-compare.json"
cat "$OUT/guard-compare.json"
```

## Pass rule
- Step 4a must print `BYTE-IDENTICAL`. If not, the switch changes the default and the PR is blocked.
- `guard-compare.json`: `recallOff >= recallOn` is a fail; `losses` (questions that lose the gold session on the page with the switch on) are reported with ids and not hidden. A fall in recall at 20 hits blocks the PR.

## Environment check
`dump-pages-box.sh` runs the product process under `env -i` with only PATH, HOME and TMPDIR. It writes no key and reads none (no `OPENAI_*`, `OLLAMA_*`, `ANTHROPIC_*`). The proxy is `embed-proxy-cache-only.ts`: any missing text fails the run, so no live embedding happens. The only outbound traffic would be a Vertex call, which this proxy cannot make.

## guard-compare.py (scoring the pages, no model)
Recall at 20 hits: a question counts when a hit's note path is one of the question's answer sessions (`answer_session_ids`, or the `relevant` notePath list in `cases.jsonl`). Loss = on the page with the switch off, not with it on. Written next to this file: `guard-compare.py`.
