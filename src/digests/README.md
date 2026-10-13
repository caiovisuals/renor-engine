# Write-time digests

A model writes a short dated list of what the user states in a note, **once, when the note is saved or changes**; search
then reads that list with **no model call**. Off by default. Design, measurements and the report:
`data/renor-write-time-digests/report.md` (firstmate home); the results ledger is `docs/evals/results/LEDGER.md` §K.

## The one switch

| Setting | Default | Meaning |
| --- | --- | --- |
| `RENOR_DIGESTS` | off | `on` / `off` (a typo is refused). Off: nothing runs, no cache file is made, `search_memory` and `memory_status` answer exactly what they did before. |

## Provider (static key, OpenAI-compatible)

Production uses Fireworks AI's **US-only** endpoint (zero retention and no training by contract, ToS §3.6):

```
RENOR_DIGEST_BASE_URL=https://api.fireworks.ai/inference/v1
RENOR_DIGEST_API_KEY=<key>                       # never logged
RENOR_DIGEST_MODEL=accounts/fireworks/routers/glm-5p3-flash-us
```

**The digest slot is the only provider digests use, and it needs both settings.** A digest call sends the text of notes (each
clipped to 20,000 characters; in a chat transcript a user turn is cut at 4,000 and an assistant turn at 300), and the Privacy
Policy, the LGPD page and the register of processing (ROPA P13) name one processor for it: Fireworks AI. So there is **no
fallback**: digests never borrow the evidence provider's key or URL (`RENOR_EVIDENCE_*`), the session router's, or an Ollama
Cloud key, and with `RENOR_DIGEST_BASE_URL` unset there is no default endpoint. With either setting missing:

- the **worker** does not start: `memory_status.digests` says `stopped` and why, the boot log says so, nothing is sent, and the
  memory service itself runs as it always did;
- **`renor index` / `renor rebuild`** refuse (`[digests] armed without a provider`, exit 1) before they touch the index.

Pointing the slot at a provider those pages do not name means updating the pages, the register and `docs/LGPD-POSTURE.md`
first, in the same change. (A benchmark arm that used the evidence provider for digests must now set the digest slot.)

Without an embedding provider the feature is off for the workspace (a digest is read by meaning).

## What runs

- **After a save** (`remember_note`, `remember` in note mode, `index_memory`, an import once its embeddings are whole) the
  engine calls `worker.notify()`, which only sets a timer: the save never waits for a model.
- **Batching:** the sweep runs 15 s after the last save and no sooner than 60 s after the previous sweep, one at a time.
- **Retries:** a failed sweep is tried again after 30 s, 60 s, 120 s ... up to 5 min (with jitter), at most 8 sweeps in a row;
  then the worker is `stopped` until the next start (a save tries once). The HTTP client retries on its own inside a call
  (`RENOR_DIGEST_RETRIES`, default 3).
- **Cost guard, per workspace:** every call is counted at list price in the workspace's own `digest-cache.db`
  (`RENOR_DIGEST_PRICE_IN_PER_M` 0.225, `RENOR_DIGEST_PRICE_OUT_PER_M` 0.75, the Fireworks US GLM-5.3-Flash prices). A call
  whose worst case (its prompt plus the whole 8,000-token output allowance) would take the UTC day past
  `RENOR_DIGEST_MAX_USD_PER_DAY` (default **0.50**) is not made; the worker is `paused-budget` until the day after the one
  that refused the call, wherever the sweep happens to end (one that runs past UTC midnight does not push the resume a day
  further). About 0.0003 USD a note, so 0.50 USD is about 1,500 notes a day; a larger import is digested over several days.
- **What the cost guard does not cover:** it is the background worker's, the only unattended path (the tenant service runs
  `dist/mvp/cli.js`, whose worker is guarded). `renor index` and `renor rebuild` are commands someone runs: they are **not
  capped** (`RENOR_DIGEST_MAX_USD_PER_DAY` does not apply to them, a test pins it), and the eval fills
  (`scripts/eval/digest-window-notes.ts`) call the same code over a shared cache. Their cost is the notes without a digest times
  about 0.0003 USD, and the `[digests] {...}` line they print says what the run used (`calls`, `promptTokens`,
  `completionTokens`). Never run them from an unattended job (cron, CI, a provisioning script) with `RENOR_DIGESTS` on. A cap
  at the 0.50 default would stop any benchmark fill above it (the dev100 fill cost 0.35 USD, `docs/evals/results/LEDGER.md` §K)
  unless the run raised it.
- **Forgetting:** at the start of every sweep, a digest of text a note no longer holds (edited, retired, file gone) is deleted.
  A note is *edited* once the **index** has seen it (a save, an import, `index_memory`, `renor index`): the digest follows the
  index, not the file, so a file changed behind the index's back keeps its digest, as search keeps its old chunks, until then.
  The deletion is part of a sweep, and a save starts none while the worker is `paused-budget` (up to a day) or has no provider,
  so the old digest of a note that changed then stays on disk until the next sweep. Search never reads it: a digest is found
  by the note's current hash. The cache sits beside the workspace's index and is removed with the workspace.
- **On-demand hosts:** the sweep is held in the idle monitor while it runs. A workspace that slept catches up at its next start.

## What search does

`search_memory` (not `get_context`: its 800-token budget is unmeasured with a 600-token table) reads the digests of the notes
the scoped window already holds, scores their items by cosine to the query embedding it already made, keeps the best
600 tokens (`RENOR_DIGEST_TOKENS`), orders them by date, and puts them first as one hit with reason `digest`, outside top_k.

## Observability

`memory_status` gains a `digests` object **only when the feature is on**: `state` (`idle`, `scheduled`, `running`,
`retrying`, `paused-budget`, `stopped`), `reason`, `consecutiveFailures`, `spentTodayUsd`, `maxUsdPerDay`, `lastSweep`.
Logs carry counts and states, never a key or note text.

## Tests

`tests/digests/` (CLI path with a stub model server, the worker with a manual clock, the MCP server in memory). No test
calls a provider.
