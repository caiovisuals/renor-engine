import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Shared by tests/mvp/handoff-note.test.ts and tests/memory/gateway-handoff.test.ts: the synthetic note, and one sweep of
// every hosted read path a note could leak through.

/**
 * MARK is in the note and is sent as a query, to try to pull the note out. INSIDE is in the note and in no query, so a
 * reply that carries it carries the note (a reply may echo its query, so MARK alone would prove nothing).
 */
export const MARK = 'quokkahandoff';
export const INSIDE = 'wombatline';
export const NOTE = `In progress: ${MARK} refactor of the Fjord parser, ${INSIDE} halfway. Next step: run the parser tests. Open question: keep SQLite?`;
export const REPO = 'git@github.com:acme/fjord.git';

/** Every text block of a tool reply, joined: export_memory answers in two. */
async function allText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), text: (res.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n') };
}

/** Each read path, with the queries a user's plain wording or the note's own words would send. */
export async function everyReadReply(client: Client, extraQueries: string[] = []): Promise<Array<[string, string]>> {
  const replies: Array<[string, string]> = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    replies.push([`${name} ${JSON.stringify(args)}`, (await allText(client, name, args)).text]);
  };
  for (const query of [MARK, 'Fjord parser next step', 'handoff note', 'what was in progress', ...extraQueries]) {
    await call('get_context', { query });
    await call('search_memory', { query });
    await call('search_text', { query });
    await call('memory_map', { query });
  }
  await call('get_context', {});
  await call('memory_map', {});
  for (const subject of ['Fjord', MARK, 'user']) await call('retrieve_memory', { subject });
  for (const name of ['Fjord', MARK, 'parser']) await call('lookup_entity', { name });
  await call('whats_new', { include_own: true });
  await call('whats_new', { since: '2000-01-01T00:00:00.000Z', include_own: true });
  await call('search_history', { query: MARK });
  // Each memory memory_map lists, read whole.
  const map = JSON.parse((await allText(client, 'memory_map', { limit: 200 })).text);
  const ids = JSON.stringify(map).match(/"id":"([^"]+)"/g)?.map(m => m.slice(6, -1)) ?? [];
  for (const id of ids) await call('read_memory', { id });
  // The whole export, section by section, following nextSection.
  let args: Record<string, unknown> = {};
  for (let page = 0; page < 20; page++) {
    const { text } = await allText(client, 'export_memory', args);
    replies.push([`export_memory ${JSON.stringify(args)}`, text]);
    const manifest = JSON.parse(text.split('\n')[0]);
    if (!manifest.nextSection) break;
    args = { section: manifest.nextSection, offset: manifest.nextItem ?? 0 };
  }
  return replies;
}

