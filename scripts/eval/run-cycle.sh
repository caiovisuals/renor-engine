#!/usr/bin/env bash
set -euo pipefail
# Engine tree, resolved from this script (NOT `git rev-parse --show-toplevel`:
# since the engine became a subtree that returns the platform root, where the
# engine's npm scripts do not exist and the site's `npm test` is a no-op stub).
ROOT="${RENOR_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"
OUT_ROOT="${RENOR_EVAL_OUTPUT_ROOT:-$ROOT/.eval-runs}"
mkdir -p "$OUT_ROOT"
if [[ -n "${RENOR_EVAL_RUN_DIR:-}" ]]; then
  RUN_DIR="$RENOR_EVAL_RUN_DIR"
  mkdir -m 700 "$RUN_DIR" # exclusive: fail if an old run exists
else
  RUN_DIR="$(mktemp -d "$OUT_ROOT/cycle-XXXXXXXX")"
fi
BASELINE="${RENOR_EVAL_BASELINE:-}"
if [[ -n "$BASELINE" ]]; then
  mkdir "$RUN_DIR/baseline"
  for file in manifest.json cases.jsonl results.jsonl summary.json; do
    cp "$BASELINE/$file" "$RUN_DIR/baseline/$file"
  done
  BASELINE="$RUN_DIR/baseline"
fi
trap 'status=$?; printf "%s\n" "$status" > "$RUN_DIR/exit-status"' EXIT
if [[ "${RENOR_EVAL_RUN_TESTS:-1}" == 1 ]]; then npm test 2>&1 | tee "$RUN_DIR/tests.log"; fi
if [[ "${RENOR_EVAL_RUN_BUILD:-1}" == 1 ]]; then
  npm run build 2>&1 | tee "$RUN_DIR/build.log"
  npm run eval:typecheck 2>&1 | tee "$RUN_DIR/eval-typecheck.log"
fi
npm run eval:renor -- --output "$RUN_DIR/retrieval" 2>&1 | tee "$RUN_DIR/eval.log"
npm run --silent eval:analyze -- "$RUN_DIR/retrieval" > "$RUN_DIR/failures.json"
if [[ -n "$BASELINE" ]]; then
  npm run --silent eval:compare -- "$BASELINE" "$RUN_DIR/retrieval" | tee "$RUN_DIR/comparison.json"
fi
printf '%s\n' "$RUN_DIR/retrieval"
