# Renor-on-BEAM (ICLR 2026)

BEAM data is CC BY-SA 4.0. Keep it local under `~/bench-data/beam/`.
Never commit or publicly mirror the chats.

Canonical scopes: `beam-128k-v1`, `beam-500k-v1`, `beam-1m-v1`, `beam-10m-v1`.
Scale gates: 128K go/no-go before 1M; 1M go/no-go before 10M.

## Official vs Renor evaluator

See `docs/evals/BEAM-SCHEMA.md` §5.3. Short version:

- Official judge is GPT (`gpt_llm`); Renor judge is `gemma4:31b`. Protocol-incomparable unless labelled.
- Official `event_ordering` headline uses `tau_norm`; Renor nugget scorer uses the unified LLM-judge score for all ten capabilities.
- Official parsing uses `json_repair`; Renor records parse failures.

Always archive a frozen-sample official-evaluator run before trusting a custom 400-q headline.

## Commands (128K)

```bash
python3 scripts/eval/beam/build-corpus.py \
  --beam-chats-dir ~/bench-data/beam/official-repo/chats/100K \
  --output ~/bench-data/beam/100k-adapter \
  --scale 128k

npm run eval:beam -- \
  --cases ~/bench-data/beam/100k-adapter/cases.jsonl \
  --output ~/bench-data/beam/retrieval-128k-vertex \
  --provider vertex --top-k 20

python3 scripts/eval/beam/assemble-sessions.py \
  --run ~/bench-data/beam/retrieval-128k-vertex \
  --output ~/bench-data/beam/retrieval-128k-sessions

# Chunk-level retrieval is the current QA path (full-session assembly exceeds 6k).
# Development 2026-09-20: Fireworks deepseek-v4p1-flash + Gemma nuggets = 0.464
# overall (cached). Not official GPT agreement. Not a 1M GO.
```

Export Renor answers into the official evaluator tree:

```bash
python3 scripts/eval/beam/export-official-answers.py \
  --cases ~/bench-data/beam/100k-adapter/cases.jsonl \
  --qa <qa-dir>/qa-cases.jsonl \
  --output ~/bench-data/beam/official-results \
  --scale 100K --name renor-answers.json
```

## Reader presets (`beam-product-qa.py`)

`--provider` is one of `fireworks` (the first runs), `nebius`, or `opencode-go` (the OpenCode Go subscription, `deepseek-v4.1-flash` at the lowest
reasoning setting, a screening reader: US$0 metered, tokens, requests and the Go allowance of each request recorded, five errors in a row stop the run).
A reasoning-on reader can spend the output cap on reasoning and return an empty answer: count empty answers before reading a score (LEDGER BH).
