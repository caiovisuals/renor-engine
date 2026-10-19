# Renor-on-LoCoMo

Internal research only (LoCoMo is CC BY-NC 4.0). Dataset stays in
`~/bench-data/locomo10.json` (sha256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`). Never commit
or publicly mirror it.

## Protocol

- Headline: categories 1–4 (1,540 questions), Gemma LLM-judge accuracy.
- Category 5 (446) is a **separate abstention metric**.
- Not the official LoCoMo token-overlap/F1 protocol. Cross-system comparison
  only under the same frozen evaluator, or labelled protocol-incomparable.
- Canonical cache scope: `locomo-cats14-v1` (adversarial: `locomo-adv-v1`).
- `RENOR_QA_SESSION` unique per process; never pin it to the cache scope.

## Commands

```bash
set -a && source ~/.config/agent-secrets/.env && set +a
export RENOR_EVAL_MAX_EMBED_TOKENS=20000000

python3 scripts/eval/locomo/build-corpus.py \
  --dataset ~/bench-data/locomo10.json \
  --output ~/bench-data/locomo/adapter

# retrieval (Vertex, per-conversation isolation)
npm run eval:locomo -- \
  --cases ~/bench-data/locomo/adapter/cases.jsonl \
  --output ~/bench-data/locomo/retrieval-vertex \
  --provider vertex --top-k 20

python3 scripts/eval/locomo/assemble-sessions.py \
  --run ~/bench-data/locomo/retrieval-vertex \
  --output ~/bench-data/locomo/retrieval-vertex-sessions

# development QA (eval cache allowed). Do not start while the full-500 lock is held.
# flock ~/bench-data/.renor-full500.lock \
RENOR_QA_CACHE_SCOPE=locomo-cats14-v1 RENOR_QA_SESSION="locomo-$(date +%s)" \
npm run eval:longmem:qa -- \
  --run ~/bench-data/locomo/retrieval-vertex-sessions \
  --output ~/bench-data/locomo/qa-dev \
  --recency-order --answer-style bestguess \
  --answer-model deepseek-v4.1-flash \
  --base-url https://opencode.ai/zen/go/v1 --api-key-env OPENCODE_API_KEY \
  --judge-model gemma4:31b --judge-base-url https://ollama.com/v1 \
  --judge-keys-env OLLAMA_CLOUD_KEY --concurrency 3 \
  --dataset ~/bench-data/locomo/adapter/locomo-dataset.json

python3 scripts/eval/locomo/score-locomo.py \
  --cases ~/bench-data/locomo/adapter/cases.jsonl \
  --results ~/bench-data/locomo/retrieval-vertex-sessions/results.jsonl \
  --qa ~/bench-data/locomo/qa-dev/qa-cases.jsonl \
  --output ~/bench-data/locomo/qa-dev
```

Authoritative headline QA uses `--no-cache`, unique `RENOR_QA_SESSION`, and
must complete with answerErrors=0 / judgeParseFailures=0.

## Options added 2026-10-18 (all default off; without them every output is byte-identical to before)

Why: the miss analysis of the 52.1% row (`docs/evals/results/locomo-delivery-20261018/README.md`) found that 65% of its misses stop in the corpus and 25% at the
page cap, and only 6% at the reader. The adapter skipped every turn that carries a picture, its own text included (1,226 of 5,882 turns), and the pages were
whole sessions cut at 6,000 tokens (8.3 of 12 retrieved sessions).

```bash
# the turns that carry a picture come back: text only, or text plus the dataset's BLIP caption as "[shared an image: ...]"
python3 scripts/eval/locomo/build-corpus.py --dataset ~/bench-data/locomo10.json \
  --output ~/bench-data/locomo/adapter-v2-caption --image-turns caption      # skip (default) | text | caption

# pages of turn windows (the turns the chunk hits matched +-N, "[...]" for the gap) over a different corpus, same retrieval
python3 scripts/eval/locomo/assemble-sessions.py --run ~/bench-data/locomo/retrieval-vertex \
  --output ~/bench-data/locomo/retrieval-vertex-windows2-caption \
  --corpus-from ~/bench-data/locomo/adapter-v2-caption --window 2            # both optional; neither = full sessions as before
```

`python3 scripts/eval/locomo/test_corpus_options.py` tests both (not wired into CI: `.github/**` is a critical path).

Category numbers in `cases.jsonl` are the dataset's own; the **names** `build-corpus.py` gives them are shifted and are kept because every recorded row carries
them: category 1 is multi-hop (the name says single-hop), 2 temporal (multi-hop), 3 open-domain (temporal), 4 single-hop (open-domain). The 2026-09-20 report's
"single-hop 38.3%" is category 1, its "multi-hop 42.1%" is category 2, "temporal 52.1%" is category 3 and "open-domain 60.6%" is category 4.

## Product-path runner (`run-locomo-product.ts`, 2026-10-18)

The harness above retrieves with `src/` directly and assembles the pages itself; its numbers are research diagnostics. `run-locomo-product.ts` is the LoCoMo twin of
`scripts/eval/run-longmemeval-product.ts`: an external client of the shipped `renor` CLI. Each conversation's rendered markdown is indexed **once** through
`src/cli.ts index`; each question is answered from `src/cli.ts search --json --top-k 20` (what an agent receives), and the client builds the page from that reply alone
(`assembleClientContext`: duplicate collapse, token cap, excerpt numbering, optional session dates). Gold (category, answer, gold turns) is scorer-side only; **one answer
contract applies to every question** (no gold-derived prompt, unlike the recorded rows, which ran categories 1-4 `bestguess` and the adversarial set `direct`).

```bash
# 0. the fixed corpus (picture turns back, BLIP caption as text) and the cache-only embed proxy (a miss is an error; no Vertex credential is loaded)
python3 scripts/eval/locomo/build-corpus.py --dataset ~/bench-data/locomo10.json --output ~/bench-data/locomo/adapter-v2-caption --image-turns caption
node --import tsx scripts/eval/embed-proxy-cache-only.ts --port <free port> --cache-db ~/.local/share/renor/embed-cache.db --stats-path <stats.json>

# 1. retrieval and the page audit: no model call, no spend. Writes replies/<id>.json.gz (the product's own reply), pages.jsonl (tokens, gold turns on the page), results.jsonl, cases.jsonl
EMBEDDING_BASE_URL=http://127.0.0.1:<port> EMBEDDING_MODEL=gemini-embedding-001 EMBEDDING_DIMS=768 OPENAI_API_KEY=local-embed-proxy \
  node --import tsx scripts/eval/locomo/run-locomo-product.ts --adapter ~/bench-data/locomo/adapter-v2-caption --output <dir> \
    --embedding-provider openai --stage retrieve --embed-proxy-stats <stats.json> [--ids-file <order.txt> --limit 300]

# 2. reader and judge over the stored replies of step 1 (same --output; refused if the product code, environment, corpus or top-K changed since)
node --import tsx scripts/eval/locomo/run-locomo-product.ts ... --stage answer --answer-style bestguess --context-dates --answer-max-tokens 20000 \
    --base-url http://127.0.0.1:<tap port>/fw/v1 --api-key-env TAP_DUMMY_KEY --max-live-calls <n> [--arm promotion --no-cache]

# 3. the recorded scorer reads the output unchanged
python3 scripts/eval/locomo/score-locomo.py --cases <dir>/cases.jsonl --results <dir>/results.jsonl --qa <dir>/qa-cases.jsonl --output <dir>
```

An arm changes one product setting with `--product-env RENOR_NAME=VALUE` (recorded in the manifest and the run ledger; credentials, endpoints, model slots and runner variables
are refused). Evidence extraction is off (`RENOR_SEARCH_EVIDENCE=0`) unless an arm sets it: a LoCoMo product row has a reader and a judge, no third model. Two arms that pin the
same `RENOR_QA_CACHE_SCOPE` and share `--cache-dir` replay a question whose page and answer are byte-identical, so such a pair is one draw, not two.
`tests/eval/locomo-product-runner.test.ts` is the offline contract (request bodies equal the LongMemEval product runner's, gold-mutation parity, index once per conversation, stage semantics, replay).

Headline (authoritative, `--no-cache`):
- cats 1–4 `bestguess`: **803/1540 = 52.1%** (`qa-cats14-cold-20260920`)
Development / paired:
- cats 1–4 `bestguess`: 799/1540 = 51.9% (`qa-cats14-dev-20260919`; paired net −4 vs cold)
- adversarial `direct` IDK: 360/446 = 80.7% (`qa-adv-dev-20260919`; not part of headline)
Reports: `LOCOMO-CATS14-COLD-20260920.md`, `LOCOMO-CATS14-DEV-20260919.md`, `LOCOMO-ADV-DEV-20260919.md`.
