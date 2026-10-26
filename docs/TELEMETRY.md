# Sharing with Renor: telemetry and training data, your choice

Renor can learn from how its memory is used, **only if you choose to help**. Like other open-source tools that offer telemetry, it is a
setting you can read, preview, change and withdraw. **The default is off, on every install and every plan.** Nothing is recorded for
sharing and nothing is sent until you pick a level.

These are the command line's own words and facts. They are not the privacy policy; the public wording (policy, terms, website) is the
owner's and a lawyer's to approve, and is not part of this file.

## The three levels

| Level | What leaves your machine | Command |
| --- | --- | --- |
| `off` (default) | Nothing. Nothing new is recorded for sharing. | `renor-engine telemetry off` |
| `signals` | Anonymous labelled numbers, worked out **inside your own data folder** from the learning log. No text, no queries, no memory ids, no keys, no names, no paths. | `renor-engine telemetry signals` |
| `data` | The signals, plus the **text of the examples**: the query behind a retrieval, the text of the memories it returned, and the statements you saved. Renor may use that text to train and evaluate its own models. | `renor-engine telemetry data` |

A choice needs your confirmation that you are 18 or older. It is recorded in one small file with the level, the time, the id of the words
you saw (`engine-cli-2026-10-21` for the command line; the dashboard sends its own) and who set it. One record per install (self-hosted),
or per workspace (hosted). Choosing a level never changes your plan, quota or features.

## Commands

```
renor-engine telemetry status            the choice in force, what is held, where it would go (reads only)
renor-engine telemetry signals           show the words, ask, record the choice
renor-engine telemetry data              the same, for training data
renor-engine telemetry off               record off, stop at once, ask Renor to delete what it holds
renor-engine telemetry delete [--local]  ask Renor to delete what it holds; --local also empties your learning log
renor-engine telemetry preview [level]   debug mode: print exactly what would be sent (for a level you have not chosen yet too)
renor-engine telemetry send              share what is final and unsent now (the HTTP service does this on a timer)
renor-engine telemetry fields [level]    every field sent at each level
```

`signals` and `data` ask on a terminal; without one, add `--yes` once you have read the words they print. The commands read the learning log
of the memory folder named by `MVP_MEMORY_DIR` (or `--memory-dir`) and keep the choice in `<memory folder>/.memory-index/sharing`
(`--dir` or `RENOR_SHARING_DIR` choose another folder; with neither, `~/.config/renor`).

The install's own choice (the one in `~/.config/renor`, which `npx renor setup` writes) also limits every memory folder's choice on this
install: the stricter of the two is in force, and it never turns a memory folder on by itself. When the install's choice is off, the
service turns any memory folder's choice that is still on to off at its next sharing check, the same way `renor-engine telemetry off`
does (it stops, deletes the example texts and asks Renor to delete what was sent).

### Overrides and debug mode

- `RENOR_SHARING=off|signals|data` overrides the recorded choice **for that process, and can only lower it**. It cannot turn sharing on:
  a choice needs a record of the words you saw. `DO_NOT_TRACK=1` is the same as `RENOR_SHARING=off`, and also means that process makes no
  request at all.
- `RENOR_SHARING_DEBUG=1` (or `renor-engine telemetry preview`) is debug mode: the sender builds the exact request bodies, prints them, sends
  nothing and changes nothing. What debug prints is what a real run sends, byte for byte (a test compares them).

## Where the rows come from

The learning log (`RENOR_LEARNING_LOG`, [learning/FEEDBACK-LOG.md](learning/FEEDBACK-LOG.md)) records, as keyed hashes and numbers, what each
retrieval served, what each save changed and what each cite named. Choosing `signals` or `data` turns that recording on (it is read at every
call, so there is no restart); choosing `off` turns it off again, unless you also set `RENOR_LEARNING_LOG=1` yourself. The join that gives a
returned memory its label ("opened", "cited", "updated", "retired") is done **locally**, and only the finished rows can leave. A row is sent only
when its label is final: 24 hours after the event. Times are rounded to the hour.

Today the learning log is written by the HTTP service (`npm run mvp`, and the hosted service). `renor-engine mcp` over stdio does not write
one, so on its own it has nothing to share.

At `data`, the query and the text of what a reply served or a save wrote are also kept, in `sharing-examples.sqlite` in the sharing folder,
under the learning log's own keyed hashes, until they are sent. A text the secret scanner flags is never kept, so that example is sent
without text. A text is cut at 2,000 characters. Leaving `data` (to `signals` or `off`), or `delete`, removes that file at once.

## Every field sent

Each request is `{ protocol, action, batch_id, level, wording, rows, consent }` (`action` is `batch`), or `{ protocol, action: "delete" }` to ask
Renor to delete what it holds. `consent` is your install's record of the choice, `{ version, level, changed_at, wording, adult }`: the level
you chose, when, the wording you saw and your 18-or-older confirmation. Renor refuses a self-hosted batch without it and keeps it with the
rows as the evidence of your choice. A hosted workspace's batch has no `consent`: the dashboard's record is the evidence. A row is one of three kinds; each carries `kind`, which names its version. The names below are exactly the
fields; the engine checks every row against this table before a request is made and the endpoint refuses a row with any other field.

### Level `signals`

One row per retrieval (`retrieval-labelled/1`), with one entry per returned memory in `candidates`:

| Field | Meaning |
| --- | --- |
| `retrieval-labelled/1.kind` | the row kind and version |
| `retrieval-labelled/1.hour` | the hour it happened, UTC (`2026-10-21T14`) |
| `retrieval-labelled/1.tool` | `get_context`, `search_memory` or `retrieve_memory` |
| `retrieval-labelled/1.ranker` | the ranking procedure (`baseline` for the shipped one) |
| `retrieval-labelled/1.build` | the commit of the running build, or null |
| `retrieval-labelled/1.model` | the embedding model identity, or null |
| `retrieval-labelled/1.retrieval` | the reply's retrieval mode (`facts`, `hybrid`, `semantic`, `keyword`), or null |
| `retrieval-labelled/1.served` | how many memories the reply held |
| `retrieval-labelled/1.reply_tokens_bucket` | the reply's size class: the next power of two above its token count |
| `retrieval-labelled/1.relevant` | the engine's own verdict that something matched, or null |
| `retrieval-labelled/1.truncated` | whether the reply was cut to its budget, or null |
| `retrieval-labelled/1.candidates.rank` | position in the reply |
| `retrieval-labelled/1.candidates.kind` | `fact`, `note` or `unkeyed` |
| `retrieval-labelled/1.candidates.lane` | which lane matched (`fact`, `fts`, `semantic`, ...) |
| `retrieval-labelled/1.candidates.score` | the reply's score, 4 decimals, or null |
| `retrieval-labelled/1.candidates.matched` | whether the reply marked it as matched, or null |
| `retrieval-labelled/1.candidates.current` | for a fact read, whether the value was current, or null |
| `retrieval-labelled/1.candidates.opened` | within 24 hours, your AI opened this memory (`read_memory`); null when it cannot be told |
| `retrieval-labelled/1.candidates.cited` | within 24 hours, a save cited it |
| `retrieval-labelled/1.candidates.updated` | within 24 hours, it was replaced by a newer value |
| `retrieval-labelled/1.candidates.retired` | within 24 hours, it was retired |
| `retrieval-labelled/1.candidates.delay_bucket` | how long until the first of those happened: `<1m`, `<10m`, `<1h`, `<1d`, `>=1d`, or null |

One row per save (`save-outcome/1`):

| Field | Meaning |
| --- | --- |
| `save-outcome/1.kind` | the row kind and version |
| `save-outcome/1.hour` | the hour of the save, UTC |
| `save-outcome/1.tool` | `remember`, `save_memory` or `remember_note` |
| `save-outcome/1.op` | `create` or `supersede` |
| `save-outcome/1.item` | `fact`, `note`, `event` or `unkeyed` |
| `save-outcome/1.has_cites` | whether the save named memories it builds on |
| `save-outcome/1.reads_bucket` | how many later reads served it within 24 hours: `0`, `1`, `2-3`, `4-7`, `8+` |
| `save-outcome/1.opened` | it was opened within 24 hours |
| `save-outcome/1.cited` | it was cited within 24 hours |
| `save-outcome/1.superseded` | it was replaced within 24 hours |
| `save-outcome/1.retired` | it was retired within 24 hours |

One row per finished session (`session-aggregate/1`):

| Field | Meaning |
| --- | --- |
| `session-aggregate/1.kind` | the row kind and version |
| `session-aggregate/1.hour` | the hour the session began, UTC |
| `session-aggregate/1.length_bucket` | `<1m`, `<10m`, `<1h`, `<6h`, `>=6h` |
| `session-aggregate/1.reads_bucket` | reads in the session, as a count bucket |
| `session-aggregate/1.saves_bucket` | saves in the session |
| `session-aggregate/1.empty_reads_bucket` | reads that returned nothing |
| `session-aggregate/1.first_call` | the first tool the session called (a read or save tool, else `other`) |

**Never sent at any level:** the keyed hashes in your learning log, memory ids, subjects, predicates, note paths, headings, scope names,
agent names, your session ids, or an address or name of yours. The only link between rows is one random secret per install, kept in your
sharing folder; Renor sees only its SHA-256, so it can find and delete your rows when you ask.

### Level `data` (everything above, plus)

| Field | Meaning |
| --- | --- |
| `retrieval-labelled/1.query` | the text of the query behind the retrieval, or null if none was kept |
| `retrieval-labelled/1.candidates.text` | the text the reply served for that memory, or null if none was kept |
| `save-outcome/1.text` | the statement that was saved, or null if none was kept |

Memories can hold information about you and about other people. A text that looks like a secret (a key, a password, a token) is left out;
no scanner is perfect, so choose `data` only if you accept that.

## What happens to what you send

- The endpoint is a Renor function separate from product analytics, PostHog, Sentry and Langfuse; nothing here goes to any of them. It
  authenticates each request with your install's secret, limits how often an install may post, and stores the rows apart from your account.
- **Retention:** signal rows are kept up to 12 months; text examples up to 6 months. Then they are deleted.
- **Withdrawal and deletion:** `off` and `delete` ask the endpoint to delete everything it holds for your install, at once. If `DO_NOT_TRACK=1`
  is set, nothing at all may be sent: `off` deletes the local example texts, records here that the deletion is owed (keeping the install's
  secret it needs), says so, and the first run without `DO_NOT_TRACK=1` sends it and then removes the rest. Otherwise,
  if the endpoint cannot be reached, the request is kept and retried. Rows Renor refuses for good are never sent again: when it says sharing is
  closed, the sender sends nothing until Renor's status says it is open again; when it says the workspace's choice is off, off is applied here
  too; when it refuses the consent record, nothing is sent until you choose a level again. A deletion is never held back. Backups can hold a copy for up to 7 more days. A ranking setting already fitted from rows is not
  recalled; the next fit leaves yours out.
- **Hosted workspaces:** the owner chooses in the dashboard. Renor records the choice in the control plane and the workspace obeys it at the
  next call; the endpoint refuses rows from a workspace whose recorded choice does not allow them, so off holds even if the workspace has not yet
  been told.
- Self-hosted installs send nothing by default; the code that sends is in `src/sharing/` and is the only place a request is made.
