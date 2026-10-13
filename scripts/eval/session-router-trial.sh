#!/usr/bin/env bash
# Session-router trial (RENOR_SESSION_ROUTER): the control and the router arms through the product benchmark client,
# then one paired report. One command; rerun the same command to resume.
# Each arm is a run on the eval run ledger (src/eval/runLedger.ts; RENOR_EVAL_RUN_LEDGER is forwarded): an arm whose
# exact configuration is already on record under another --out is refused, and the same --out continues it.
#
# Every arm is scripts/eval/run-longmemeval-product.ts (public CLI `index` + `search --json`, then answer + judge) with
# Vertex embeddings through the shared content-addressed embed-proxy cache. The arms differ ONLY in the router flag:
#   replace  RENOR_SESSION_ROUTER=replace  (the study's Tu: routed statements instead of the retrieved chunks)
#   union    RENOR_SESSION_ROUTER=union    (the study's BTu: retrieved chunks + the routed statements they lack)
#   control  RENOR_SESSION_ROUTER unset (the shipped default): NOT run by default. Captain's rule (2026-10-03): never
#            re-run the default configuration as a baseline. Pass --baseline-run <dir>, a recorded run of the
#            product benchmark client whose configuration matches (same reader, judge, client settings, dataset);
#            the report pairs the router arms with its per-question results and lists every setting that differs.
#            A fresh control is for questions no record covers (--ids-file) and needs --control-reason "<why>",
#            which the run records and the report prints.
# The router arms share one router cache (<out>/router-cache.db). A summary phase runs first: the product's own
# `renor index` with the router armed, per question, writes every note's title + summary (stats in
# <out>/summaries.jsonl), so the arms answer with every summary in place; union then replays replace's routing
# answers, so it adds reader/judge calls only. The report is <out>/report.md + <out>/report.json.
# --warm-max-calls N stops the summary phase before it could exceed N calls (exit 3, the arms do not run; rerun the
# same command to continue, e.g. after a provider's daily quota resets); --warm-only stops after the summary phase.
# The summary phase can use another endpoint than the router (summaries are cached by model, prompt and note, not by
# endpoint): --summary-base-url / --summary-key-env. --vertex-roles summaries,router,reader (any subset;
# --vertex-summaries is `--vertex-roles summaries`) sends those roles through scripts/eval/vertex-chat-proxy.ts to
# Vertex AI, billed to the eval project in RENOR_EVAL_VERTEX_PROJECT, with the same model names; the judge keeps its own
# endpoint. Every invocation appends each role's model and endpoint, never a key, to <out>/trial-runs.jsonl.
#
# Each product process gets a scrubbed environment: Node 22, the embedding proxy, the router's model settings in the
# router arms, and the evidence pass's keys only with --evidence on. Keys are read from this shell by NAME and never
# printed. The reader and judge keys reach the benchmark client only.
#
# Full 500, decision-grade (R3: promotion arms, no QA cache; ~$18 of summaries and ~$1 of routing at
# gemini-3.x-flash-lite list prices on Vertex AI, plus 2 x 500 reader + judge calls), paired with the product score of
# record (361/500: retrieval only, direct answers, no context dates, deepseek-v4.1-flash reader, gemma4:31b judge,
# whose settings these flags repeat; the reader and judge default to those):
#   bash scripts/eval/session-router-trial.sh --dataset ~/bench-data/longmemeval_s.json --out .eval-runs/router-trial-500 \
#     --baseline-run ~/renor-worktrees/product-truth/.eval-runs/product-baseline-500 --evidence off --context-dates off \
#     --vertex-roles summaries,router
# To pair with a run of another configuration, repeat its settings (--evidence, --context-dates, --answer-style, the
# reader and judge flags; RENOR_EVIDENCE_MODE / RENOR_EVIDENCE_SESSIONS pass through with --evidence on).
#
# A slice (the PageIndex scout's 36 + 12 questions, the run this PR reports), router + reader + summaries on Vertex:
#   bash scripts/eval/session-router-trial.sh --dataset ~/bench-data/longmemeval_s.json --out .eval-runs/router-trial-48 \
#     --ids-file <ids> --strata <subset.json> --evidence off --vertex-roles summaries,router,reader \
#     --answer-model gemini-3.5-flash-lite --judge-model openai/gpt-oss-120b \
#     --judge-base-url https://api.groq.com/openai/v1 --judge-key-env GROQ_API_KEY
#
# --smoke: offline plumbing check (eval-hash embeddings, no proxy, iteration arms with a QA cache, watermarked
# transport-smoke): point the model base URLs at a stub (tests/eval/session-router-trial.test.ts does).
#
# Exit status: 0 when every arm completed and the report was written; 2 for a usage or environment error; 3 when the
# summary phase stopped at --warm-max-calls; otherwise the failing step's status.
set -euo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

DATASET="" OUT="" IDS_FILE="" STRATA="" LIMIT=0 ARMS="replace,union" EVIDENCE=on CONTEXT_DATES=on ITERATION=0 SMOKE=0
BASELINE_RUN="" CONTROL_REASON="" ANSWER_STYLE=direct
WARM_MAX_CALLS=1000000000 WARM_ONLY=0 SUMMARY_BASE_URL="" SUMMARY_KEY_ENV="" VERTEX_ROLES="" VERTEX_UPSTREAM=""
ROUTER_MODEL=gemini-3.5-flash-lite SUMMARY_MODEL=gemini-3.1-flash-lite
ROUTER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai ROUTER_KEY_ENV=GEMINI_API_KEY
ROUTER_TIMEOUT_MS=30000 ROUTER_RETRIES=6
ANSWER_MODEL=deepseek-v4.1-flash ANSWER_BASE_URL=https://ollama.com/v1 ANSWER_KEY_ENV=OLLAMA_API_KEY
JUDGE_MODEL=gemma4:31b JUDGE_BASE_URL="" JUDGE_KEY_ENV="" MAX_LIVE_CALLS="" EMBED_PROXY_PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dataset) DATASET="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --ids-file) IDS_FILE="$2"; shift 2 ;;
    --strata) STRATA="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --arms) ARMS="$2"; shift 2 ;;
    --baseline-run) BASELINE_RUN="$2"; shift 2 ;;
    --control-reason) CONTROL_REASON="$2"; shift 2 ;;
    --evidence) EVIDENCE="$2"; shift 2 ;;
    --context-dates) CONTEXT_DATES="$2"; shift 2 ;;
    --answer-style) ANSWER_STYLE="$2"; shift 2 ;;
    --iteration) ITERATION=1; shift ;;
    --smoke) SMOKE=1; ITERATION=1; shift ;;
    --warm-max-calls) WARM_MAX_CALLS="$2"; shift 2 ;;
    --warm-only) WARM_ONLY=1; shift ;;
    --summary-base-url) SUMMARY_BASE_URL="$2"; shift 2 ;;
    --summary-key-env) SUMMARY_KEY_ENV="$2"; shift 2 ;;
    --vertex-summaries) VERTEX_ROLES="${VERTEX_ROLES:+$VERTEX_ROLES,}summaries"; shift ;;
    --vertex-roles) VERTEX_ROLES="${VERTEX_ROLES:+$VERTEX_ROLES,}$2"; shift 2 ;;
    --vertex-upstream-base) VERTEX_UPSTREAM="$2"; shift 2 ;;
    --router-model) ROUTER_MODEL="$2"; shift 2 ;;
    --summary-model) SUMMARY_MODEL="$2"; shift 2 ;;
    --router-base-url) ROUTER_BASE_URL="$2"; shift 2 ;;
    --router-key-env) ROUTER_KEY_ENV="$2"; shift 2 ;;
    --router-timeout-ms) ROUTER_TIMEOUT_MS="$2"; shift 2 ;;
    --router-retries) ROUTER_RETRIES="$2"; shift 2 ;;
    --answer-model) ANSWER_MODEL="$2"; shift 2 ;;
    --answer-base-url) ANSWER_BASE_URL="$2"; shift 2 ;;
    --answer-key-env) ANSWER_KEY_ENV="$2"; shift 2 ;;
    --judge-model) JUDGE_MODEL="$2"; shift 2 ;;
    --judge-base-url) JUDGE_BASE_URL="$2"; shift 2 ;;
    --judge-key-env) JUDGE_KEY_ENV="$2"; shift 2 ;;
    --max-live-calls) MAX_LIVE_CALLS="$2"; shift 2 ;;
    --embed-proxy-port) EMBED_PROXY_PORT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "session-router-trial: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
JUDGE_BASE_URL="${JUDGE_BASE_URL:-$ANSWER_BASE_URL}"
JUDGE_KEY_ENV="${JUDGE_KEY_ENV:-$ANSWER_KEY_ENV}"

fail() { echo "session-router-trial: $*" >&2; exit 2; }
[ -n "$DATASET" ] && [ -f "$DATASET" ] || fail "--dataset <longmemeval_s.json> is required and must exist"
[ -n "$OUT" ] || fail "--out <dir> is required"
[ -z "$IDS_FILE" ] || [ -f "$IDS_FILE" ] || fail "--ids-file $IDS_FILE does not exist"
[ -z "$STRATA" ] || [ -f "$STRATA" ] || fail "--strata $STRATA does not exist"
case "$EVIDENCE" in on|off) ;; *) fail "--evidence must be on or off" ;; esac
case "$CONTEXT_DATES" in on|off) ;; *) fail "--context-dates must be on or off" ;; esac
case "$ANSWER_STYLE" in direct|bestguess|count) ;; *) fail "--answer-style must be direct, bestguess or count" ;; esac
IFS=',' read -r -a ARM_LIST <<< "$ARMS"
for arm in "${ARM_LIST[@]}"; do
  case "$arm" in control|replace|union) ;; *) fail "unknown arm '$arm' (control, replace, union)" ;; esac
done
case ",$ARMS," in
  *,control,*) [ -n "$CONTROL_REASON" ] || fail "a fresh control re-runs the default configuration: pair with a recorded run (--baseline-run), or say why one is unavoidable (--control-reason \"...\") and limit it to the questions no record covers (--ids-file)" ;;
esac
[ -z "$BASELINE_RUN" ] || [ -f "$BASELINE_RUN/qa-cases.jsonl" ] || fail "--baseline-run $BASELINE_RUN has no qa-cases.jsonl (a run of run-longmemeval-product.ts)"
[ -z "$BASELINE_RUN" ] || BASELINE_RUN="$(cd "$BASELINE_RUN" && pwd)"
IFS=',' read -r -a VERTEX_LIST <<< "$VERTEX_ROLES"
on_vertex() { case ",$VERTEX_ROLES," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
for role in "${VERTEX_LIST[@]}"; do
  case "$role" in summaries|router|reader) ;; *) fail "unknown --vertex-roles role '$role' (summaries, router, reader)" ;; esac
done
need_key() { [ -n "${!1:-}" ] || fail "the $2 key env $1 is not set in this shell"; }
on_vertex reader || need_key "$ANSWER_KEY_ENV" reader
need_key "$JUDGE_KEY_ENV" judge
case ",$ARMS," in *,replace,*|*,union,*) on_vertex router || need_key "$ROUTER_KEY_ENV" router ;; esac
[ -z "$SUMMARY_KEY_ENV" ] || need_key "$SUMMARY_KEY_ENV" summary
if [ -n "$VERTEX_ROLES" ]; then
  ! on_vertex summaries || [ -z "$SUMMARY_BASE_URL" ] || fail "--vertex-roles summaries and --summary-base-url name two summary endpoints"
  [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -n "${RENOR_EVAL_VERTEX_PROJECT:-}" ] \
    || fail "--vertex-roles needs GOOGLE_APPLICATION_CREDENTIALS and RENOR_EVAL_VERTEX_PROJECT"
fi
[ "$SMOKE" = 1 ] || { [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -n "${RENOR_EVAL_VERTEX_PROJECT:-}" ]; } || [ -n "$EMBED_PROXY_PORT" ] \
  || fail "Vertex embeddings need GOOGLE_APPLICATION_CREDENTIALS and RENOR_EVAL_VERTEX_PROJECT (or --embed-proxy-port of a running proxy)"

# Node: the engine's pin, like the agent gate (a different major fails native modules for the wrong reason).
PIN="$(sed -n 's/^node *= *"\{0,1\}\([0-9][0-9]*\).*/\1/p' "$ENGINE/mise.toml" | head -1)"
ACTIVE="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[ -n "$PIN" ] && [ "$ACTIVE" = "$PIN" ] || fail "node major ${ACTIVE:-none} on PATH, the engine pins $PIN: put Node $PIN first on PATH"
NODE_BIN="$(dirname "$(command -v node)")"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
DATASET="$(cd "$(dirname "$DATASET")" && pwd)/$(basename "$DATASET")"
[ -z "$IDS_FILE" ] || IDS_FILE="$(cd "$(dirname "$IDS_FILE")" && pwd)/$(basename "$IDS_FILE")"
[ -z "$STRATA" ] || STRATA="$(cd "$(dirname "$STRATA")" && pwd)/$(basename "$STRATA")"
cd "$ENGINE"

# Cases per arm (for the default live-call budget: answer + judge per case).
CASES="$(node -e '
  const fs = require("fs");
  const [dataset, ids, limit] = process.argv.slice(1);
  let n = JSON.parse(fs.readFileSync(dataset, "utf8")).length;
  if (ids) n = new Set(fs.readFileSync(ids, "utf8").trim().split(/\r?\n/).filter(Boolean)).size;
  const cap = Number(limit);
  console.log(cap > 0 ? Math.min(cap, n) : n);
' "$DATASET" "$IDS_FILE" "$LIMIT")"
MAX_LIVE_CALLS="${MAX_LIVE_CALLS:-$((CASES * 2))}"
echo "session-router-trial: $CASES case(s) per arm, arms=$ARMS, evidence=$EVIDENCE, router=$ROUTER_MODEL, summaries=$SUMMARY_MODEL, reader=$ANSWER_MODEL, judge=$JUDGE_MODEL, out=$OUT"

# Embedding proxy (Vertex gemini-embedding-001, 768-d, shared content-addressed cache), unless one is given.
PROXY_PID="" VERTEX_PID=""
cleanup() {
  [ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true
  [ -z "$VERTEX_PID" ] || kill "$VERTEX_PID" 2>/dev/null || true
}
trap cleanup EXIT
# Start a localhost proxy and echo the port it listens on (both proxies log `listening on 127.0.0.1:<port>`).
await_port() { # <pid> <log> <name>
  local port=""
  for _ in $(seq 1 120); do
    port="$(sed -n 's/.*listening on 127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$2" | head -1)"
    [ -n "$port" ] && { echo "$port"; return 0; }
    kill -0 "$1" 2>/dev/null || { cat "$2" >&2; fail "the $3 exited before listening"; }
    sleep 0.5
  done
  fail "the $3 did not start listening within 60 s (see $2)"
}
if [ "$SMOKE" = 0 ] && [ -z "$EMBED_PROXY_PORT" ]; then
  : > "$OUT/embed-proxy.log"
  env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$HOME" \
    GOOGLE_APPLICATION_CREDENTIALS="$GOOGLE_APPLICATION_CREDENTIALS" \
    RENOR_EVAL_VERTEX_PROJECT="$RENOR_EVAL_VERTEX_PROJECT" RENOR_EVAL_VERTEX_LOCATION="${RENOR_EVAL_VERTEX_LOCATION:-}" \
    node --import tsx scripts/eval/embed-proxy.ts --port 0 --stats-path "$OUT/embed-proxy-stats.json" \
    >> "$OUT/embed-proxy.log" 2>&1 &
  PROXY_PID=$!
  EMBED_PROXY_PORT="$(await_port "$PROXY_PID" "$OUT/embed-proxy.log" "embed proxy")"
fi

# Each role's endpoint, key and the label the run records for it. Roles on Vertex share one chat proxy.
ROUTER_KEY="${!ROUTER_KEY_ENV:-}" ROUTER_ENDPOINT="$ROUTER_BASE_URL"
READER_KEY="${!ANSWER_KEY_ENV:-}" READER_ENDPOINT="$ANSWER_BASE_URL"
if [ -n "$VERTEX_ROLES" ]; then
  : > "$OUT/vertex-chat-proxy.log"
  vertex_args=(--port 0 --stats-path "$OUT/vertex-chat-proxy-stats.json")
  [ -z "$VERTEX_UPSTREAM" ] || vertex_args+=(--upstream-base "$VERTEX_UPSTREAM")
  env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$HOME" \
    GOOGLE_APPLICATION_CREDENTIALS="$GOOGLE_APPLICATION_CREDENTIALS" RENOR_EVAL_VERTEX_PROJECT="$RENOR_EVAL_VERTEX_PROJECT" \
    node --import tsx scripts/eval/vertex-chat-proxy.ts "${vertex_args[@]}" >> "$OUT/vertex-chat-proxy.log" 2>&1 &
  VERTEX_PID=$!
  VERTEX_URL="http://127.0.0.1:$(await_port "$VERTEX_PID" "$OUT/vertex-chat-proxy.log" "Vertex chat proxy")/v1"
  VERTEX_LABEL="vertex-ai (location global, openapi chat/completions, via scripts/eval/vertex-chat-proxy.ts)"
  [ -z "$VERTEX_UPSTREAM" ] || VERTEX_LABEL="vertex-ai (upstream $VERTEX_UPSTREAM, via scripts/eval/vertex-chat-proxy.ts)"
  if on_vertex router; then ROUTER_BASE_URL="$VERTEX_URL" ROUTER_KEY=vertex-proxy-local ROUTER_ENDPOINT="$VERTEX_LABEL"; fi
  if on_vertex reader; then ANSWER_BASE_URL="$VERTEX_URL" READER_KEY=vertex-proxy-local READER_ENDPOINT="$VERTEX_LABEL"; fi
fi
# The summary phase's endpoint: the router's unless given, or Vertex AI through the chat proxy.
SUMMARY_URL="$ROUTER_BASE_URL" SUMMARY_KEY="$ROUTER_KEY" SUMMARY_ENDPOINT="$ROUTER_ENDPOINT"
if [ -n "$SUMMARY_BASE_URL" ]; then
  SUMMARY_URL="$SUMMARY_BASE_URL" SUMMARY_ENDPOINT="$SUMMARY_BASE_URL" SUMMARY_KEY="${!SUMMARY_KEY_ENV:-$ROUTER_KEY}"
fi
if on_vertex summaries; then SUMMARY_URL="$VERTEX_URL" SUMMARY_KEY=vertex-proxy-local SUMMARY_ENDPOINT="$VERTEX_LABEL"; fi

# Every invocation records what it ran against (models and endpoints; never a key).
node -e '
  const [file, ...pairs] = process.argv.slice(1);
  const record = Object.fromEntries(pairs.map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  const git = (args) => require("child_process").execFileSync("git", args, { encoding: "utf8" }).trim();
  record.at = new Date().toISOString();
  record.gitSha = git(["rev-parse", "HEAD"]);
  record.gitDirty = git(["status", "--porcelain"]).length > 0;
  require("fs").appendFileSync(file, JSON.stringify(record) + "\n");
' "$OUT/trial-runs.jsonl" "arms=$ARMS" "cases=$CASES" "idsFile=${IDS_FILE:+$(basename "$IDS_FILE")}" "evidence=$EVIDENCE" \
  "contextDates=$CONTEXT_DATES" "answerStyle=$ANSWER_STYLE" "smoke=$SMOKE" "vertexRoles=$VERTEX_ROLES" "baselineRun=$BASELINE_RUN" "controlReason=$CONTROL_REASON" \
  "summaryModel=$SUMMARY_MODEL" "summaryEndpoint=$SUMMARY_ENDPOINT" \
  "routerModel=$ROUTER_MODEL" "routerEndpoint=$ROUTER_ENDPOINT" "readerModel=$ANSWER_MODEL" "readerEndpoint=$READER_ENDPOINT" \
  "judgeModel=$JUDGE_MODEL" "judgeEndpoint=$JUDGE_BASE_URL"

# The router's settings, identical for the summary phase and both router arms.
router_env() {
  ROUTER_ENV=(RENOR_ROUTER_MODEL="$ROUTER_MODEL" RENOR_ROUTER_SUMMARY_MODEL="$SUMMARY_MODEL"
    RENOR_ROUTER_BASE_URL="$ROUTER_BASE_URL" RENOR_ROUTER_API_KEY="$ROUTER_KEY"
    RENOR_ROUTER_CACHE="$OUT/router-cache.db" RENOR_ROUTER_TIMEOUT_MS="$ROUTER_TIMEOUT_MS" RENOR_ROUTER_RETRIES="$ROUTER_RETRIES")
}
# The product's embedding settings: Vertex through the proxy, or eval-hash for --smoke.
embedding_env() {
  if [ "$SMOKE" = 1 ]; then
    EMBEDDING_ENV=(EMBEDDING_PROVIDER=eval-hash)
  else
    EMBEDDING_ENV=(EMBEDDING_PROVIDER=openai OPENAI_API_KEY=embed-proxy-local EMBEDDING_BASE_URL="http://127.0.0.1:$EMBED_PROXY_PORT/v1"
      EMBEDDING_MODEL=gemini-embedding-001 EMBEDDING_DIMS=768)
  fi
}

case ",$ARMS," in
  *,replace,*|*,union,*)
    router_env; embedding_env
    warm=(--dataset "$DATASET" --log "$OUT/summaries.jsonl" --max-calls "$WARM_MAX_CALLS" --limit "$LIMIT")
    [ -z "$IDS_FILE" ] || warm+=(--ids-file "$IDS_FILE")
    echo "session-router-trial: summary phase ($SUMMARY_MODEL at $SUMMARY_ENDPOINT) -> $OUT/summaries.jsonl"
    status=0
    # The router's settings with the summary endpoint in place of its own (later assignments win in env).
    env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" RENOR_SESSION_ROUTER=replace RENOR_SEARCH_EVIDENCE=0 \
      "${ROUTER_ENV[@]}" "${EMBEDDING_ENV[@]}" \
      RENOR_ROUTER_BASE_URL="$SUMMARY_URL" RENOR_ROUTER_API_KEY="$SUMMARY_KEY" \
      RENOR_TRIAL_SUMMARY_ENDPOINT="$SUMMARY_ENDPOINT" \
      node --import tsx scripts/eval/session-router-warm.ts "${warm[@]}" || status=$?
    if [ "$status" = 3 ]; then
      echo "session-router-trial: the summary phase stopped at --warm-max-calls $WARM_MAX_CALLS; rerun the same command to continue" >&2
      exit 3
    fi
    [ "$status" = 0 ] || exit "$status"
    ;;
esac
if [ "$WARM_ONLY" = 1 ]; then echo "session-router-trial: --warm-only: summaries are in place, no arm was run"; exit 0; fi

run_arm() {
  local arm="$1"
  local -a armenv=()
  if [ "$arm" != control ]; then
    router_env
    armenv+=(RENOR_SESSION_ROUTER="$arm" "${ROUTER_ENV[@]}")
  fi
  if [ "$EVIDENCE" = off ]; then
    armenv+=(RENOR_SEARCH_EVIDENCE=0)
  else
    # The shipped evidence pass reads its own provider: pass exactly the names it reads, when they are set.
    local name
    for name in RENOR_EVIDENCE_MODE RENOR_EVIDENCE_SESSIONS RENOR_EVIDENCE_MODEL RENOR_EVIDENCE_BASE_URL RENOR_EVIDENCE_API_KEY RENOR_EVIDENCE_API_KEYS \
      RENOR_EVIDENCE_MAX_TOKENS RENOR_EVIDENCE_REASONING_EFFORT OLLAMA_CLOUD_KEY_1 OLLAMA_CLOUD_KEY_2 OLLAMA_CLOUD_KEY_3 OLLAMA_CLOUD_KEY_4 OLLAMA_MAX_KEY OLLAMA_API_KEY; do
      [ -z "${!name:-}" ] || armenv+=("$name=${!name}")
    done
  fi
  # Every arm is a run on the eval run ledger (src/eval/runLedger.ts), the shared one unless RENOR_EVAL_RUN_LEDGER
  # names another file: this scrubbed environment would otherwise drop that choice.
  [ -z "${RENOR_EVAL_RUN_LEDGER:-}" ] || armenv+=(RENOR_EVAL_RUN_LEDGER="$RENOR_EVAL_RUN_LEDGER")
  local -a cache=(--arm promotion --no-cache)
  if [ "$ITERATION" = 1 ]; then cache=(--arm iteration --cache-dir "$OUT/qa-cache.db"); armenv+=(RENOR_QA_CACHE_SCOPE=session-router-trial); fi
  local -a slice=()
  [ -z "$IDS_FILE" ] || slice+=(--ids-file "$IDS_FILE")
  [ "$CONTEXT_DATES" = off ] || slice+=(--context-dates)
  slice+=(--answer-style "$ANSWER_STYLE")
  local -a embedding=(--embedding-provider openai --embed-proxy-stats "$OUT/embed-proxy-stats.json")
  if [ "$SMOKE" = 1 ]; then
    embedding=(--embedding-provider eval-hash --transport-smoke)
  else
    # The client sets EMBEDDING_PROVIDER from --embedding-provider; the rest of the proxy settings come from here.
    embedding_env
    armenv+=("${EMBEDDING_ENV[@]:1}")
  fi
  echo "session-router-trial: arm $arm -> $OUT/$arm"
  env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    RENOR_TRIAL_READER_KEY="$READER_KEY" RENOR_TRIAL_JUDGE_KEY="${!JUDGE_KEY_ENV}" \
    "${armenv[@]}" \
    node --import tsx scripts/eval/run-longmemeval-product.ts \
      --dataset "$DATASET" --output "$OUT/$arm" "${embedding[@]}" --top-k 20 --max-context-tokens 6000 \
      --limit "$LIMIT" "${slice[@]}" "${cache[@]}" --max-live-calls "$MAX_LIVE_CALLS" \
      --answer-model "$ANSWER_MODEL" --base-url "$ANSWER_BASE_URL" --api-key-env RENOR_TRIAL_READER_KEY \
      --judge-model "$JUDGE_MODEL" --judge-base-url "$JUDGE_BASE_URL" --judge-api-key-env RENOR_TRIAL_JUDGE_KEY
}

for arm in "${ARM_LIST[@]}"; do run_arm "$arm"; done

report=(--out "$OUT" --dataset "$DATASET" --arms "$ARMS")
[ -z "$STRATA" ] || report+=(--strata "$STRATA")
[ -z "$BASELINE_RUN" ] || report+=(--baseline "$BASELINE_RUN")
env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$HOME" node --import tsx scripts/eval/session-router-trial-report.ts "${report[@]}"
