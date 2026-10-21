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

/**
 * The Renor logo the server offers as its icon (MCP `serverInfo.icons`): the 48x48 frame of the site's favicon
 * (public/favicon.ico), as a PNG inline in a data: URI. It reaches a client inside the initialize reply, so showing it
 * fetches nothing from another host and it cannot change or disappear with a website deploy.
 */
export const SERVER_ICON_PNG_BASE64 = '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';
/** The icon set the initialize reply carries: that one PNG. */
export const SERVER_ICONS = [{ src: `data:image/png;base64,${SERVER_ICON_PNG_BASE64}`, mimeType: 'image/png', sizes: ['48x48'] }];

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
