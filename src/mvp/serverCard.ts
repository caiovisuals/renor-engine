/**
 * The public server card of the hosted MCP server, in the format Smithery documents for a static card at
 * /.well-known/mcp/server-card.json: the server's identity, its one remote endpoint, its auth, and the tools an
 * agent sees. It holds public metadata and nothing per user.
 *
 * The gateway serves the committed file apps/gateway/src/shared/server-card.json. scripts/gateway/generate-server-card.ts
 * writes that file from the live tool list, and tests/review/gateway-server-card.test.ts fails while the two differ.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** The MCP server's identity: its initialize reply and this card both take it from here. */
export const SERVER_NAME = 'renor';
export const SERVER_VERSION = '0.1.0';
export const SERVER_TITLE = 'Renor';
/** The hosted server's one public endpoint (the gateway's /mcp), Streamable HTTP. */
export const SERVER_ENDPOINT = 'https://mcp.renor.cloud/mcp';

export interface ServerCard {
  serverInfo: { name: string; title: string; version: string };
  remotes: Array<{ type: 'streamable-http'; url: string }>;
  authentication: { required: true; schemes: ['oauth2'] };
  tools: Tool[];
  resources: [];
  prompts: [];
}

function byName(a: Tool, b: Tool): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The card for the tools an agent sees, in name order, so the file does not depend on registration order. */
export function buildServerCard(tools: readonly Tool[]): ServerCard {
  return {
    serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    remotes: [{ type: 'streamable-http', url: SERVER_ENDPOINT }],
    authentication: { required: true, schemes: ['oauth2'] },
    tools: [...tools].sort(byName),
    resources: [],
    prompts: [],
  };
}

/** The exact bytes the gateway serves: two-space JSON with a final newline. */
export function serverCardText(card: ServerCard): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}
