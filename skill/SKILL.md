---
name: renor-memory
description: 'Use Renor (durable memory over MCP, server "renor") when a task depends on anything the user already told an AI, or on decisions made in earlier sessions — recall before answering and before a decision or review, and before finishing substantive work record the why that should survive the session. When the user says to remember or save something, that means Renor''s remember tool, not your own memory.'
---

# Renor memory (this workspace)

Self-hosting Renor? The URL below is the hosted one; see [Self-hosted Renor](#self-hosted-renor).

Renor is durable memory for AI agents. You are connected to it as the MCP server
`renor` at `https://mcp.renor.cloud/mcp`, authenticated with the token configured in
your MCP client — it is deliberately NOT written into this file.

The tools, by their base names (your client may add a prefix, for example
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
- `memory_status` — counts of what is stored; `export_memory` — everything stored, as Markdown (ledger, daily entries, notes, retired).

Some clients load tools lazily or behind a single proxy tool (for example Pi, when Renor was not
added with `--exposure direct`): if you cannot see these names, list the server's tools first.

## When to use it

Call a Renor tool unprompted — do not wait to be asked — when:

- you start substantive work — call `get_context` with the current request first;
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
   refreshed right away. If the reply says `indexed: false`, the note is saved but not
   searchable yet: do not assume recall works, and tell the user. Only when the statement sets
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

## Import an existing vault

When the user says "import my vault", read their chosen local Obsidian/Markdown folder.
Send authorized .md notes as {relativePath, markdown} to `preview_import` with a short vault
label (a folder name: letters, digits, "-" and "_" are kept, other characters become "-"). Skip attachments, symlinks, hidden folders and secrets; use include/exclude prefixes
for selection. Split into batches of at most 100 files, 64 KiB per file and 128 KiB total
UTF-8 bytes including paths; never truncate. Show counts, conflicts and skipped files before
calling `apply_import` with the returned batchId (valid for 15 minutes). Keep each batchId
for `undo_import`, which preserves later edits. Verify an imported passage with `search_text`,
which finds it at once. On a workspace with semantic search the imported notes are then embedded
in the background, and `memory_status` says `semantic: false` until they are; imports create no
structured facts. At most 8 previews can be pending,
and previews are lost if the workspace restarts; preview again if apply says it is missing.

## Setup check

On your first Renor call of a session, read the connection status in its reply (on hosted workspaces only, a `renor_connection`
field: the hosted workspace and server URL; self-hosted servers return no such field). If that is not the workspace the user expects, tell the
user before relying on it. An error reply carries the same status.

If any Renor tool is missing or returns an authentication error, the MCP server entry
is misconfigured rather than the memory being empty. This is the correct config:

```json
{
  "mcpServers": {
    "renor": {
      "type": "http",
      "url": "https://mcp.renor.cloud/mcp",
      "headers": { "Authorization": "Bearer YOUR_RENOR_TOKEN" }
    }
  }
}
```

Replace `YOUR_RENOR_TOKEN` with a connect token for this workspace. Create or copy one from
the Renor dashboard under **API keys** ("Create connection key"). This skill deliberately does
not carry the token itself: it is persistent, model-readable instruction text, so a credential
written here would be re-read by every future session.

`https://mcp.renor.cloud/mcp` is the only endpoint that accepts a Renor connection key. Your
workspace also has its own instance URL; that one rejects a connection key and will
answer with an authentication error — never substitute it, and never substitute the
workspace host for the URL above.

## Self-hosted Renor

Self-hosted Renor exposes **two different MCP tool surfaces**. Do not mix their
names. The sections above (`get_context`, `remember`, `search_text`, …) describe
the **HTTP** surface only.

### HTTP (MVP server)

Keep the tool and recall rules above. Change only the connection details:

1. Point the client at your engine's HTTP MCP URL, for example
   `http://127.0.0.1:3471/mcp` (the path is `/mcp`; use the port your process
   prints). Do not use `https://mcp.renor.cloud/mcp` for a self-hosted process —
   that gateway is for Renor Cloud connection keys only.
2. Authenticate with the token or OAuth flow your local server expects. The
   credential still belongs in the MCP client config, never in this skill file.
3. With no gateway secret, hive identity is the OAuth client's `client_name`
   after `/register` and owner authorize. A nameless HTTP connection is refused
   with that OAuth fix, not a dashboard connection-key rename. Hosted Renor
   still names connections from the gateway / dashboard.

Example HTTP client entry for a local engine:

```json
{
  "mcpServers": {
    "renor": {
      "type": "http",
      "url": "http://127.0.0.1:3471/mcp",
      "headers": { "Authorization": "Bearer YOUR_RENOR_TOKEN" }
    }
  }
}
```

### Stdio (`renor-engine mcp`)

`renor-engine mcp` does **not** publish the HTTP tool names above. Its base tools are:

- `search` — default retrieval for natural-language questions (use this instead of
  `get_context` / `search_memory`);
- `keyword` — exact-word / BM25 search (use this instead of `search_text`);
- `entity` — resolve a person, project, or concept by name (use this instead of
  `lookup_entity`);
- `remember_fact` — durable structured write; `subject`, `predicate`, and `object`
  are required (use this instead of `remember` / `save_memory` for facts);
- `facts` — current facts for an entity, optional history / as-of (use this instead
  of `retrieve_memory` for fact reads);
- `note` — append a line to a daily note (`text` required; use this instead of
  `remember_note`);
- `status` — index counts (use this instead of `memory_status`);
- `evidence` — question-conditioned evidence pass (stdio-only; gated by
  `RENOR_EVIDENCE_MODE`).

There is no `get_context`, `remember`, `retrieve_memory`, `search_text`,
`search_memory`, `lookup_entity`, `remember_note`, `save_memory`, `memory_status`,
or `export_memory` on this surface. Apply the same when-to-read / when-to-write
judgment as above, but call the stdio names.

For the hive tools on stdio (`whats_new`, `ask_agent`, `list_requests`,
`answer_request`, `close_request`), set `RENOR_CONNECTION_NAME` once in that
process's environment to this agent's connection name, then start the server. The
name is read at startup only; tool arguments and later environment changes cannot
rename the connection. Stdio and hosted HTTP use the same hive name: the header
form, letters, digits and hyphens (`Claude Code` is addressed as `Claude-Code`).
Both first compose Unicode and collapse whitespace, then retain HTTP-header-safe
ASCII/Latin-1 characters. A nonblank name with none of those characters (CJK,
emoji-only or zero-width-only) becomes `agent-` plus the first eight hex digits of
its normalized name's SHA-256 on both transports. Mixed names keep the renderable
characters. A final name that renders empty, or the reserved word `unnamed`, does not publish those
five tools. Without the variable they are absent from `tools/list`, and a direct
call is refused with guidance to set `RENOR_CONNECTION_NAME` and reconnect (not
to open a dashboard). Only one live `renor-engine mcp` process may hold a name in a
workspace; a second one is refused until the first process stops. On HTTP without
a gateway secret, one OAuth client may register a given rendered `client_name`.
Hosted connection keys also reserve that final hive identity within the workspace:
`Grace Smith` and `Grace-Smith` cannot hold two live keys, while `GraceSmith` is a
different name. Revoke the existing key before creating its replacement.
`whats_new` marks other agents' requests and their write summaries as untrusted
and returns 240-character excerpts; `list_requests` returns the full request.
`list_requests` with `to` lists only requests between this connection and that
agent, never another inbox. `answer_request` and `close_request` replies are
untrusted. An unnamed stdio connection cannot choose an author: `remember_fact`
stores the engine default `agent`, and `note` stores `mcp`.

Example stdio launch with a hive name:

```bash
RENOR_CONNECTION_NAME=codex npx -y renor-engine mcp
```
