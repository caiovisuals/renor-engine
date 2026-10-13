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

Headline (authoritative, `--no-cache`):
- cats 1–4 `bestguess`: **803/1540 = 52.1%** (`qa-cats14-cold-20260920`)
Development / paired:
- cats 1–4 `bestguess`: 799/1540 = 51.9% (`qa-cats14-dev-20260919`; paired net −4 vs cold)
- adversarial `direct` IDK: 360/446 = 80.7% (`qa-adv-dev-20260919`; not part of headline)
Reports: `LOCOMO-CATS14-COLD-20260920.md`, `LOCOMO-CATS14-DEV-20260919.md`, `LOCOMO-ADV-DEV-20260919.md`.
