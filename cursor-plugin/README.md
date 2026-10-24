# Renor

Cursor plugin that connects agents to [Renor](https://renor.cloud), durable memory for AI agents, through Renor's hosted remote [Model Context Protocol](https://modelcontextprotocol.io/) server.

Tell an agent something once. Renor keeps it, and your agents in Cursor (and Claude Code, Codex, OpenCode and the rest) recall it when it is relevant later.

This plugin needs a Renor account (<https://renor.cloud>) and connects only to the hosted service. To connect Cursor to an engine you run yourself, skip the plugin and follow "Cursor" in the [engine README](https://github.com/renorai/renor-engine#connect-your-agent).

## Install

Until Renor is listed in Cursor's plugin directory, install it locally:

1. Copy this `cursor-plugin` folder to `~/.cursor/plugins/local/renor` (from the repository root: `mkdir -p ~/.cursor/plugins/local && cp -R cursor-plugin ~/.cursor/plugins/local/renor`).
2. Reload Cursor.
3. Open **Cursor Settings → MCP**, find `renor` and complete the Renor sign-in in your browser.

## MCP

```json
{
  "mcpServers": {
    "renor": {
      "type": "http",
      "url": "https://mcp.renor.cloud/mcp"
    }
  }
}
```

Auth is OAuth. Cursor prompts for Renor sign-in when the plugin connects; there is no key to copy and none is stored in the plugin. New to Renor? Create an account at <https://renor.cloud> first.

## Skill

`renor-memory` tells the agent when to use Renor without being asked:

- **Recall** with `get_context` when starting substantive work, before deciding something an earlier session may have settled, before reviewing another agent's work, and whenever you refer to something not in the conversation.
- **Save** with `remember` the decisions, root causes, corrections and preferences that should survive the session, with their reason. Status and progress logs are not saved, and credentials never are.

## What agents can do

| Category | Capabilities |
| --- | --- |
| Recall | Context packs, search by words or by meaning, current facts and their history, entity lookup |
| Save | Plain-language memories, structured facts that replace the old value, corrections that mark the earlier memory replaced |
| Own your data | Export your memories as Markdown, retire or restore a memory, import an existing Markdown or Obsidian vault |

The hosted runtime is the source of truth for tool names and schemas.

## Notes

- Tool calls run as the Renor user who authorizes the connection, in that user's own workspace.
- `https://mcp.renor.cloud/mcp` is the only Renor MCP endpoint.
- Renor's engine is open source (Apache-2.0) and can be self-hosted: <https://github.com/renorai/renor-engine>. This plugin points at the hosted service.

## Docs

- Renor docs: https://renor.mintlify.app
- Engine source: https://github.com/renorai/renor-engine
- Server URL: https://mcp.renor.cloud/mcp

## License

Apache-2.0, the same license as the rest of this repository.
