# Renor

![Claude Code saves a decision to Renor; a fresh Codex session recalls it](docs/assets/renor-readme-demo.gif)\
*Self-hosted Renor, real session: Claude Code saves a decision, a fresh Codex session recalls it. Waiting time sped up.*

[![engine-public-ci](https://github.com/patrickpassosb/renor-engine/actions/workflows/engine-public-ci.yml/badge.svg?branch=main)](https://github.com/patrickpassosb/renor-engine/actions/workflows/engine-public-ci.yml)

**Renor is memory for coding agents: it keeps what you tell Claude Code, Codex or Cursor in a folder of Markdown files on your machine, and serves it back to any of them over MCP.**

Every new agent session starts from zero: you re-explain the project, last week's decision and why, the thing you corrected twice. With Renor, one agent saves it and the next one finds it. The memory is plain files you own. It runs locally, needs no account or API key, and sends nothing off your machine unless you configure a model. A hosted version with no install is at <https://renor.cloud>.

## Quickstart

You need **Node 22** and git. The install is the only step that needs the network.

```bash
git clone https://github.com/patrickpassosb/renor-engine.git
cd renor-engine
node -v                    # must print v22.x
npm ci && npm rebuild better-sqlite3 --ignore-scripts=false && npm run build
node scripts/smoke-self-hosted.mjs
```

The last command starts the MCP server, saves one fact (`Ada favorite_color cerulean`), searches for it three ways and stops. It works in a temporary folder that it deletes afterwards, so it never touches your notes. It ends with:

```text
PASS: self-hosted stdio MCP can remember and retrieve a current fact.
```

Downloaded a ZIP instead of cloning? It has no git history to stamp the build with, so build with `RENOR_BUILD_COMMIT=0000000 npm run build` instead. A wrong Node version or skipped install scripts: see [Troubleshooting](docs/self-hosting.md#troubleshooting).

## Connect your agent

Pick a folder for your memory (a new, empty one is fine; an Obsidian vault works too) and index it. Run this, and the commands below, from the `renor-engine` directory in the same shell:

```bash
export VAULT_PATH="$HOME/renor-notes"    # absolute path; created if missing
node dist/cli.js index
```

Each command below starts Renor with the Node 22 you are using now (`node -p process.execPath`), so the agent does not need Node 22 on its own `PATH`.

**Claude Code**

```bash
claude mcp add --scope user renor-local -e VAULT_PATH="$VAULT_PATH" -- "$(node -p process.execPath)" "$PWD/dist/cli.js" mcp
```

Restart Claude Code; `/mcp` lists `renor-local` in every project. `claude mcp remove renor-local` undoes it.

**Codex**

```bash
codex mcp add renor-local --env VAULT_PATH="$VAULT_PATH" -- "$(node -p process.execPath)" "$PWD/dist/cli.js" mcp
```

Restart Codex; `codex mcp list` shows it. `codex mcp remove renor-local` undoes it.

**Cursor**

Cursor reads MCP servers from `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project). This prints the entry:

```bash
node -e 'console.log(JSON.stringify({ mcpServers: { "renor-local": { command: process.execPath,
  args: [process.cwd() + "/dist/cli.js", "mcp"], env: { VAULT_PATH: process.env.VAULT_PATH } } } }, null, 2))'
```

Put it in that file, or merge the `renor-local` entry into an existing `mcpServers`, then check that `renor-local` is enabled in Cursor's MCP settings.

**Any other MCP client:** the command is `node dist/cli.js mcp` (stdio) with `VAULT_PATH` set.

Then ask your agent to remember something, and ask about it in a new session. What an agent saves is searchable at once. A Markdown file you add or edit by hand is searchable after you run `node dist/cli.js index` again.

## What is stored where

| What | Where |
| --- | --- |
| Your notes | Any Markdown files in `$VAULT_PATH`. Renor reads them; edit them with anything. |
| What agents save | Appended as Markdown in the same folder: facts to `System/Memory Events Ledger.md`, notes to `Memory/Daily/<date>.md`. |
| Search index | SQLite at `$VAULT_PATH/.semantic-memory/index.db`. Derived: `node dist/cli.js index` rebuilds it from the Markdown. |

Everything Renor keeps is in that one folder, so back it up, sync it or move it like any other folder. Nothing leaves your machine unless you set a model key: `EMBEDDING_PROVIDER=openai` sends your notes' text to OpenAI to embed it, and an evidence-model key (`RENOR_EVIDENCE_API_KEY` or an `OLLAMA_*` key) makes search send the notes it matched to that model. If your shell already exports such a key, add `-e RENOR_EVIDENCE_MODE=off` (Codex: `--env`) when you register the server. Every setting and its default: [docs/ENVIRONMENT-VARIABLES.md](docs/ENVIRONMENT-VARIABLES.md).

**Search without embeddings.** With nothing set, Renor uses no embedding model, so a note is found by its exact words: `blue notebook` finds "The blue notebook is on the desk", but `where is my notebook?` does not. Saved facts are found either way. For search by meaning, set `EMBEDDING_PROVIDER=openai` with `OPENAI_API_KEY`, or `local` to download a model once and run it on this machine, then run `node dist/cli.js rebuild` so existing notes are embedded ([details](docs/self-hosting.md#embeddings)).

## More

- [docs/self-hosting.md](docs/self-hosting.md): troubleshooting, embeddings, the HTTP server with OAuth sign-in, connecting agents over HTTP, the tool lists, owner names, multi-agent ("hive") tools (set `RENOR_CONNECTION_NAME` per agent), and how the vault is protected.
- [skill/SKILL.md](skill/SKILL.md): instructions to give your agent so it recalls and saves memory without being asked.

Renor is a single-owner engine: one person's notes, one set of agents. It is not a multi-user product.

## Contributing, license, security

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and tests and lists good first issues. Renor's own code is **AGPL-3.0-only** ([LICENSE](LICENSE)); files imported from the upstream project stay ISC ([NOTICE](NOTICE), [UPSTREAM.md](UPSTREAM.md)). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
