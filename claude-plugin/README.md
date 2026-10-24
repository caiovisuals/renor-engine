# Renor Claude Code plugin hooks (staging)

Hook code for the published Claude Code plugin, which lives in github.com/patrickpassosb/renor-skills. Firstmate copies
`hooks/` there, beside its `.claude-plugin/` manifests, `.mcp.json` and `skills/renor-memory`. When the plugin already
has a `hooks/hooks.json` (the recall and save hooks), the entries below are **added** to it; nothing is replaced.

## Handoff note (`hooks/handoff.mjs`)

**Default off.** Both hooks do nothing unless `RENOR_HANDOFF_NOTE=1`. The engine needs the same flag to publish the
`handoff_note` tool.

| Event | When it acts | What it does |
| --- | --- | --- |
| `SessionStart` (`startup`, `clear`) | Inside a git repo on a branch (not a detached HEAD); once per session | Adds one line telling the agent to call `handoff_note` `read` with this repo (origin's URL with credentials removed, or the repo's path when there is no origin) and branch, and to show the user the note once, with its date and writer. Silent on `resume` (the old context still holds the note) and on `compact`. |
| `Stop` | After new tool use since its last ask, at most once every `RENOR_HANDOFF_EVERY_MINUTES` (default 30), and never while `stop_hook_active` is set | Blocks the stop once and asks the agent to call `handoff_note` `write` (at most 200 words: what was in progress, the next step, open questions). Skipped when the agent already wrote the note itself. |

Why the hooks ask the agent rather than call Renor themselves: a hook holds no Renor credential, because hosted sign-in
is OAuth inside Claude Code. Claude Code's `mcp_tool` hook type is skipped on the first `SessionStart` (MCP servers are
not connected yet), and its input can only use fields from the hook's own JSON, which carries `cwd` but not the remote
or the branch. `SessionEnd` cannot make the agent act, so the write is done from `Stop`.

Composing with other `SessionStart` hooks: this one prints its own `additionalContext` and nothing else, so Claude
receives it next to the recall hook's. A per-session marker in `${CLAUDE_PLUGIN_DATA}` (or the temp directory) means a
second copy of this hook, say one in the plugin and one in settings, prints nothing.

The note itself is the engine's (`src/memory/handoff.ts`): one per repository and branch, overwritten, deleted 7 days
after it was written (a sweep, not only on reads; see `docs/ENVIRONMENT-VARIABLES.md` for what that delete reaches), and never returned by `get_context`, `search_memory`, `search_text`, `retrieve_memory`, `lookup_entity`,
`memory_map`, `read_memory`, `whats_new` or `export_memory`.
