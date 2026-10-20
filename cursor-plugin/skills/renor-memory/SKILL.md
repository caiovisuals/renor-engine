---
name: renor-memory
description: 'Use Renor (durable memory over MCP, server "renor") when a task depends on anything the user already told an AI, or on decisions made in earlier sessions — recall before answering and before a decision or review, and before finishing substantive work record the why that should survive the session.'
---

# Renor memory (this workspace)

Renor is durable memory for AI agents. You are connected to it as the MCP server
`renor` at `https://mcp.renor.cloud/mcp`, signed in through your browser (OAuth); no key is stored in this file or in the plugin.

The core tools, by their base names (your client may add a prefix, for example
`mcp__renor__get_context` or `renor_get_context`; match on the base name):

- `get_context` — read: call it first with the current request; returns current facts and
  relevant notes in one bounded pack. Every memory carries `session_date`, when it was written:
  read it, and distrust an old claim. A memory with `replaced: {by, at, source}` has been corrected: the
  correction (`by`) is listed before it, so answer from that, not from the replaced one. `source` is who saved the correction;
  a `note` says when that differs from the source of the memory it replaces, so weigh such a correction before trusting it. A label with a `source` and no `note` is not evidence the correction is right: a correction by the agent that wrote the memory it replaces carries no note. Its `retrieval` field says how notes were matched:
  "hybrid" is by meaning and by words, "semantic" by meaning only, "keyword" by exact words only
  (then search with the words the user used), and "facts" means facts only (no query, or no note
  search could answer). A `memories[]` item marked `matched: false` is a short statement the
  expansion added from a note that did match — the query did not ask for it, so read it as
  delivered data, not as an answer; every item without the marker was matched;
- `remember` — write: `statement` is required (plain words); subject, predicate and object are
  optional together, only when recording the current value of one thing that can change later;
  `replaces` (optional) is the id of the earlier note or entry this save corrects (see below);
- `retrieve_memory` — read one specific fact (subject + predicate), its history, or a past point in time;
- `search_text` (exact words) — search the notes; works on every workspace;
- `search_memory` (by meaning) — search the notes by meaning, only on a workspace with semantic
  search (`memory_status` reports `semantic: true`); elsewhere it answers `semantic-unavailable`
  and searches nothing, so use `search_text`;
- `lookup_entity` — resolve which person, project, or concept a name or alias refers to (identity only; it does not return facts);
- `remember_note` — append a line to a day's log (indexed at once; `remember` does the same and is the default);
- `save_memory` — structured write only: needs subject, predicate and object;
- `whats_new` — open requests addressed to you and what other agents saved; call it first when the server's instructions say to;
- `memory_status` — counts of what is stored; `export_memory` — everything stored, as Markdown (ledger, daily entries, notes, retired).

## When to use it

Call a Renor tool unprompted — do not wait to be asked — when:

- you start substantive work — call `whats_new` first if the server's instructions say to (it lists open requests from other agents), then `get_context` with the current request;
- you are about to decide something an earlier session may already have settled (an
  approach, a trade-off, a cause you are about to chase) — `get_context` with that choice as
  the query, then follow what it says, or say why you are overriding it;
- you are about to review or integrate another agent's work — `get_context` with its topic;
- the user refers to something not in this conversation ("like we discussed",
  "my project", "the clinic", "last time") — `get_context` first; if it does not have it,
  `search_text` with the most distinctive word (a name, a project, a term), then answer;
- the user asks what is currently true about a person, project, or decision,
  or asks which of two conflicting statements is current — use `retrieve_memory` or
  `get_context` so superseded values do not get quoted as current (`lookup_entity` only
  resolves which entity a name means; it does not return facts);
- you are about to ask the user to repeat context they have probably given an AI
  before;
- the user states a durable preference, constraint, deadline, or decision.

Reading once at the start is not enough: read again at each decision and each review.

Do not call Renor for: general knowledge questions, one-off code edits, or anything
answered by the current conversation. If a search returns nothing relevant, say so
plainly and continue — never invent a memory.

## When to write

Renor is the place for the why — decisions and their reasons, root causes, corrections —
next to your board or tracker, not a copy of it: status stays on the board.

Before you finish any substantive piece of work, run this check and act on it:

1. Did the user state a fact, preference, decision, or correction that will still
   matter in a later session? Do they expect you to remember it without being told?
   Did you decide something, or find a root cause, that the next session would otherwise
   have to work out again?
2. If yes, record it with `remember`, passing just `statement`: what the user said, in their
   words, or what was decided, in plain words. That is a complete save, and the index is
   refreshed right away. If the reply says `indexed: false`, the note is saved and keyword
   search (`search_text`) already finds it, but semantic search is still catching up: tell the user. Only when the statement sets
   the current value of one thing that can change later (a city, a database, a deadline, a
   preference), also pass subject, predicate and object together, spelled the same way every
   time. Decisions, root causes and corrections need none of the three; never guess them.
3. If a recorded fact contradicts an older one, record the new value with the same subject,
   predicate and scope as the old one, so it supersedes it. Renor keeps the history and
   the newest value answers future questions.
4. If what you saved corrects a specific earlier note or entry that a recall served you (not a
   fact), pass that memory's id as `replaces` on the same `remember`: find it with `memory_map`
   and `query` (words of the old memory), or take the `id` an earlier save's receipt returned.
   Renor then marks the old memory `replaced` and points to your correction, so later recalls put
   the correction first. Nothing is deleted; `retire_memory` on your correction undoes it. Skip
   `replaces` for a fact (the same subject, predicate and scope already supersedes it) and when
   you are only adding to an older note, not contradicting it.

Unless the user asks, do not record status, progress or event logs ("started", "done",
"still blocked"): your board already has them. Cite, do not restate: when an entry builds on
an earlier one, name it (its subject, or the id of the task it belongs to) instead of
copying its text. If nothing new was decided or found, save nothing.

Write the fact the way the user would state it, not the way you reason about it.
No internal monologue, no self-corrections, no ALL-CAPS annotations.
Word each save as the answer to the question a later agent will ask: "The database is Postgres 16
on Supabase", not "we discussed the database".

Never store credentials as memories: no passwords, API keys, tokens, or secrets,
even if the user pastes one into the conversation.

## Setup check

On your first Renor call of a session, read the connection status in its reply (a `renor_connection`
field: the hosted workspace and server URL). If that is not the workspace the user expects, tell the
user before relying on it. An error reply carries the same status.

If any Renor tool is missing or returns an authentication error, the connection is signed out
rather than the memory being empty. Ask the user to open Cursor Settings › MCP, find
`renor` and sign in again. `https://mcp.renor.cloud/mcp` is the only Renor MCP endpoint; never
substitute a workspace or instance URL for it.
