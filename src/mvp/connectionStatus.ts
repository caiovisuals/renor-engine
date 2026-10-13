/**
 * Which Renor an agent is talking to, said once and whenever something is wrong.
 *
 * Agents could not tell that they were connected to the wrong server, or that a connection had silently dropped:
 * absence was silent. So the first tool reply of an MCP session carries one short status block, and so does every
 * error a tool returns, with a sentence on how to reconnect. A later successful reply of the same session carries
 * nothing, so the status costs a few dozen tokens once per session, not a line on every reply.
 *
 * The status is an extra trailing text block on the reply. The block a tool always returned is untouched, so
 * nothing that reads a reply by its first block changes.
 *
 * It is on only for a hosted workspace (the provisioner writes MVP_INSTANCE_ID, the workspace's slug, into every
 * tenant's environment); an engine run any other way answers as it always did.
 */

/** The one public MCP URL every hosted workspace is reached through (the gateway routes it to the workspace). */
export const HOSTED_MCP_URL = 'https://mcp.renor.cloud/mcp';

export interface ConnectionStatus {
  /** The workspace's slug, as the control plane names it. */
  workspace: string;
  url: string;
}

/**
 * The status of the hosted workspace this process serves, or null when it is not one (no MVP_INSTANCE_ID, or
 * RENOR_CONNECTION_STATUS=0, the way to switch it off).
 */
export function connectionStatusFromEnv(env: NodeJS.ProcessEnv): ConnectionStatus | null {
  if ((env.RENOR_CONNECTION_STATUS ?? '').trim() === '0') return null;
  const workspace = (env.MVP_INSTANCE_ID ?? '').trim().toLowerCase();
  // The slug shape the control plane issues; anything else is not a hosted workspace's name.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(workspace)) return null;
  return { workspace, url: HOSTED_MCP_URL };
}

/** What an agent is told on its first reply: where it is, and what to do if that is not where it expected to be. */
function firstSentence(status: ConnectionStatus): string {
  return `Connected to Renor's hosted workspace "${status.workspace}" at ${status.url}; if that is not the workspace you expect, tell the user.`;
}

/** What an agent is told on an error: where it is, and how to connect again. */
function errorSentence(status: ConnectionStatus): string {
  return `Renor hosted workspace "${status.workspace}" at ${status.url}. If Renor stops answering or refuses you, reconnect: sign in again through your client's MCP settings for ${status.url}.`;
}

/** The one-line text block: a stable machine-readable field, and one short sentence. */
export function connectionStatusBlock(status: ConnectionStatus, kind: 'first' | 'error'): { type: 'text'; text: string } {
  const message = kind === 'first' ? firstSentence(status) : errorSentence(status);
  return {
    type: 'text',
    text: JSON.stringify({ renor_connection: { hosted: true, workspace: status.workspace, url: status.url }, message }),
  };
}

/**
 * Decides, per MCP session, which replies carry the status. One of these per session server: the first tool reply
 * takes the announcement (a session that has none to announce, because it has no session to begin, never does), and
 * an error always carries it.
 */
export class ConnectionAnnouncer {
  private announced: boolean;

  constructor(
    private readonly status: ConnectionStatus | null,
    announceFirst: boolean,
  ) {
    this.announced = !announceFirst;
  }

  /** The reply, with the status block appended where it belongs, or the reply itself where it does not. */
  decorate<T extends { content?: unknown; isError?: boolean }>(result: T, first: boolean): T {
    if (this.status === null || !Array.isArray(result?.content)) return result;
    const error = result.isError === true;
    if (!error && !first) return result;
    return { ...result, content: [...result.content, connectionStatusBlock(this.status, error ? 'error' : 'first')] };
  }

  /** Called when a tool call starts: true for exactly one call in the session, the first. */
  takeFirst(): boolean {
    if (this.announced) return false;
    this.announced = true;
    return true;
  }
}
