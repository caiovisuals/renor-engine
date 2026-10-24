# Keyword OR query (H11b) and search_text fallback (H12): replay records, 2026-10-24

Replays on the engine's real keyword path (no model, no embedding call) over the 24 Oct agent-tasks run's stored queries.
Summaries and per-query rows are included so every figure in the PR body can be checked.

- `h11-summary.json`, `h11b-summary.json`, `h18-summary.json`: arms and gains/losses. `h11b-rows.json`, `h11-rows.json`: per query (`off`, `on`, `or`, `orlean`).
- `h11-stages.json`: where the needed note is lost (candidates, page, OR-query proxy).
- `h12-summary.json`, `search-text-queries.json`: the 254 stored `search_text` calls (128 empty) and the fallback replay.
- `queries.json`, `tasks.json`: the 409 first `get_context` queries and the gold text.
- `prereg-H11b-H18-H12.md`: pre-registration written before the replays.
- `box-guard-dev100.md`, `guard-compare.py`: the dev100 page guard command and its comparison script.

Replay scripts: `engine/scripts/eval/agent-tasks/h11-replay.ts`, `h11-stages.ts`, `h12-replay.ts`.
