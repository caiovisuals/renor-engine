# Self-hosting Renor

The [README](../README.md) installs Renor, checks it and connects an agent. This page has the rest: troubleshooting, embeddings, the HTTP server, the tool lists, owner and agent names, and how the vault is protected.

Run every command from the directory that holds `package.json`. If you use mise, `node` means `mise exec node@22 -- node` and `npm` means `mise exec node@22 -- npm`. The `renor` command is `node dist/cli.js` until you link it (`npm link`); `node dist/cli.js --help` lists its subcommands (`index`, `search`, `watch`, `rebuild`, `mcp`, …).

## Troubleshooting

**Wrong Node version.** Renor needs **Node 22.16 or newer** (it uses Node's built-in SQLite; `.nvmrc` and `mise.toml` pin the tested Node 22). On an older Node every command stops at once with one line saying so:

```
renor-engine: Renor needs Node 22.16.0 or newer (it uses Node's built-in SQLite); this is Node 20.20.0. Fix: install Node 22 LTS or newer (https://nodejs.org), then run the command again.
```

**Vector search extension missing.** sqlite-vec arrives as a prebuilt optional dependency for your platform. An install with `--omit=optional` (or `optional=false` in an npm config) leaves it out, and every command stops with `renor-engine: the vector search extension (sqlite-vec) did not load ...` and the fix. Reinstall without omitting optional dependencies. Install scripts are not needed: `ignore-scripts=true` is fine.

**Installing offline.** `npm ci` needs the npm registry or a populated npm cache. Nothing after the install needs the network unless you configure a model.

**Agent says Renor has no tools, or fails to start it.** The agent starts `node dist/cli.js mcp` itself, so do not leave one running in a terminal. Register it with the absolute Node path the README uses (`"$(node -p process.execPath)"`), not a bare `node` that may resolve to another version in the agent's environment. `VAULT_PATH`, when you set it, must be absolute: unset or empty, the notes go to `~/.renor` (a hidden folder in your home directory, never an existing `renor` folder), so a server registered from a terminal where it was not exported starts, but on a folder you did not choose. The server prints `Renor memory: <path>` on stderr when it starts on that default; look for that line first when an agent seems to remember nothing, since it may be using a different folder than the one you index. Remove the server, run the README's `export` line, and add it again.

**A note is not found.** What an agent saves is indexed as it is saved. A Markdown file you add or edit by hand is found after the next `node dist/cli.js index`, or keep `node dist/cli.js watch` running. The server does not index on startup. Without embeddings, search matches exact words (see below).

**Start from a clean index.** `.semantic-memory/index.db` is derived data. `node dist/cli.js rebuild` (or deleting it and running `node dist/cli.js index`) recreates it from the folder; saved facts are replayed from `System/Memory Events Ledger.md`.

## Building from a ZIP or tarball

`npm run build` first runs `scripts/ci/stamp-build.mjs`, which writes `dist/BUILD.json`; the HTTP server's `/version` reports that commit. In a git checkout it reads the commit from git. A copy without `.git` (GitHub **Download ZIP**, a tarball, `git archive`) has no commit to read, so the build stops until `RENOR_BUILD_COMMIT` is set to a 7–40 character hex revision. It only affects the stamp: the code builds and runs the same either way. Use the revision you downloaded if you know it; `0000000` passes the check, and `/version` will report it.

```bash
cd renor-engine-*
node -v                    # v22.16 or newer
export RENOR_BUILD_COMMIT=0000000
npm ci && npm run build
node scripts/smoke-self-hosted.mjs
```

## Embeddings

| `EMBEDDING_PROVIDER` | What search does |
| --- | --- |
| unset (default) | No embedding model, nothing leaves your machine. A note is found when the query contains its exact words; saved facts are found by subject and value. |
| `local` | Downloads an embedding model (`Xenova/multilingual-e5-base` by default) on first use, then runs it on this machine. Search by meaning. |
| `openai` | Embeds with OpenAI; needs `OPENAI_API_KEY`, and the text of your notes is sent to OpenAI. Search by meaning. |
| `eval-hash` | Deterministic offline stand-in used by the tests. Makes no quality claim. |

After you change the provider on a folder that already holds notes, run `node dist/cli.js rebuild` so they are embedded again; a plain `index` skips notes that have not changed. [ENVIRONMENT-VARIABLES.md](ENVIRONMENT-VARIABLES.md) lists every setting and its default.

## Checking a folder

`node scripts/smoke-self-hosted.mjs` makes a temporary folder, removes it afterwards and ignores `VAULT_PATH`, so it never adds anything to your notes. It makes the MCP calls `tools/list`, `tools/call` for `remember_fact` with `{"subject":"Ada","predicate":"favorite_color","object":"cerulean"}`, then `search` with each of `What is Ada's favorite color?`, `Ada favorite color cerulean` and `cerulean`; it exits non-zero if a call fails or `cerulean` is missing. To check one folder instead, name it with an absolute path: `node scripts/smoke-self-hosted.mjs "$VAULT_PATH"`. The test fact then stays in that folder's memory.

## HTTP server

A second process with its own folder. It serves the product tools over HTTP on `127.0.0.1`, with OAuth sign-in for one owner. It needs macOS, Linux, or WSL2 on Windows: native Windows fails at startup because the OAuth client store reads a POSIX user id that Windows does not have. It does not read `VAULT_PATH`. `MVP_EMBEDDING_PROVIDER=none` uses no embedding model.

The OAuth client file must live in a directory that is mode `0700`, owned by you, and not inside the memory directory; a normal umask is rejected at startup. The memory directory holds your statements in plain text, so it is owner-only too: the server creates it `0700` and its files `0600`, tightens one that group or others can read (and says so in one log line), and refuses to start only when it cannot, for example because another user owns it.

```bash
export MVP_MEMORY_DIR="$PWD/.smoke/memory"
export MVP_PORT=39471
export MVP_BASE_URL="http://127.0.0.1:${MVP_PORT}"
export MVP_OWNER_EMAIL="owner@example.test"
export MVP_OWNER_PASSWORD="$(openssl rand -base64 18)"   # random; read it back with: echo "$MVP_OWNER_PASSWORD"
export MVP_AUTH_STATE_PATH="$PWD/.smoke/auth/clients.json"
export MVP_ALLOWED_CALLBACK_URIS="http://localhost:39472/callback"
export MVP_EMBEDDING_PROVIDER=none

mkdir -p "$MVP_MEMORY_DIR" "$(dirname "$MVP_AUTH_STATE_PATH")"
chmod 0700 "$MVP_MEMORY_DIR" "$(dirname "$MVP_AUTH_STATE_PATH")"

npm run mvp          # node dist/mvp/cli.js
```

`MVP_OWNER_PASSWORD` is the only gate on your memory, so use a long random one. The server refuses the placeholder values from older docs, very common passwords, and anything under 8 characters. Change `MVP_PORT` if 39471 is taken, and keep `MVP_BASE_URL` on the same port. Startup prints the MCP endpoint (`$MVP_BASE_URL/mcp`). A request with no token is refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$MVP_BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

That prints `401`. A request without a valid token is refused before its body is read, so a malformed or oversized body gets the same `401`, as a JSON-RPC body.

**Session ceiling.** With `MVP_MCP_JSON=false`, every open session holds a full MCP server in memory, about 0.3 MB measured. `MVP_MCP_MAX_SESSIONS` (default 100, at most 1000) caps how many stay open; a higher value stops startup with a message that names the ceiling. Idle sessions expire after `MVP_MCP_SESSION_TTL_MS`.

**Moving the memory folder.** Moving or restoring it (to another path, or from a backup) is safe: the first start at the new path removes the index rows the old path left behind and indexes the folder again before it answers, which re-embeds every note. Your Markdown and the ledger are never changed.

### Connect Claude Code over HTTP

Claude Code registers the redirect `http://localhost:<port>/callback` (the host is `localhost`, not `127.0.0.1`). The example above allowlists port 39472, and `--callback-port` must be that same port or registration is denied:

```bash
claude mcp add --transport http --scope local --callback-port 39472 renor-local-http "$MVP_BASE_URL/mcp"
```

Restart Claude Code, run `/mcp`, choose `renor-local-http`, and sign in as `MVP_OWNER_EMAIL` with `MVP_OWNER_PASSWORD`. For another port, set `MVP_ALLOWED_CALLBACK_URIS` to `http://localhost:<that-port>/callback`, restart `npm run mvp`, and pass the same port to `--callback-port`. The match is exact: no wildcards, and `127.0.0.1` is not `localhost`.

### Connect Codex over HTTP

Codex's redirect is its own loopback URI, not Claude Code's. Registration is denied until that exact URI is also listed in `MVP_ALLOWED_CALLBACK_URIS` (comma-separated). Add it, restart `npm run mvp`, then:

```bash
codex mcp add renor-local-http --url "$MVP_BASE_URL/mcp"
```

If the browser does not open, run `codex mcp login renor-local-http` in your own terminal, then restart Codex. Sign in as the owner email and password.

## Two different tool lists

The command-line server publishes eight tools: `search`, `evidence`, `keyword`, `entity`, `remember_fact`, `facts`, `status` and `note`. Naming its connection adds the five hive tools (below). The HTTP server publishes a different set of twenty-four tools, including `remember`, `get_context` and the five hive tools `whats_new`, `ask_agent`, `list_requests`, `answer_request` and `close_request`. [skill/SKILL.md](../skill/SKILL.md) describes the HTTP tools for an agent.

## Owner names

Renor treats no name as the owner by default. To have your name and first-person words ("I", "me", "my") resolve to your own facts, export `RENOR_OWNER_NAMES`: a comma-separated list whose first name is canonical and the others aliases of it (for example `RENOR_OWNER_NAMES="Ada Lovelace,Ada,Ada Byron"`). Unset, Renor only folds case and Unicode form.

## Hive connection names

The hive tools tell agents apart by connection name only. The name is not a tool argument.

- Command-line server: set `RENOR_CONNECTION_NAME=<agent name>` for `node dist/cli.js mcp` (with `-e` or `--env` when you register it). One process is one connection. With a name that does not render empty (not blank, not `unnamed`), the server registers the five hive tools under that name and `tools/list` returns thirteen tools instead of eight. The name is read at startup only: tool arguments and later environment changes cannot rename a connection. Unset, the server keeps the eight tools above and does not publish the hive; a direct hive call is refused with the instruction to set the variable and reconnect.
- HTTP server: the name is the OAuth client's `client_name`. Register one client per agent, authorize it as the owner, and the server reads that name back from the bearer token. The five hive tools refuse a client that has no name.

## Files in your vault

Both servers write only to regular files inside the vault. A symbolic link, a hard link or a FIFO planted in the vault (a cloned or shared notes folder, a synced folder) is refused, not followed: the write fails and says why. The vault folder itself may be a link. New files are created `0600` and new folders `0700`.

On Linux the server also checks, after it opens a file and before it writes, where the kernel says that file really is, and refuses unless it is inside the vault. That closes a race in which another process with write access inside your vault swaps a folder for a link while a write is in flight. On a system without `/proc` (macOS, Windows) that check is skipped, so the race stays open there: it needs a process that can already write inside your vault, which can edit your notes anyway. A refused write may leave an empty file outside the vault; it never leaves content.
