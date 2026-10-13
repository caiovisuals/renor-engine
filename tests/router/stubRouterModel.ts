import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic stand-in for the session router's models (never a provider call).
 *
 *   summary prompt  -> one node per `=== CONVERSATION id=.. date=.. ===` block: the title is the block's first User line,
 *                      the summary is every User line of the block (so it holds the facts the router needs); a block
 *                      with no User turn is summarised from its own text.
 *   routing prompt  -> the node ids whose title or summary shares a word of 4+ letters with the question.
 *   benchmark reader / judge (the trial smoke) -> the reader names every cat the excerpts name (else "I don't know");
 *                      the judge says 1 when the answer holds every name in the ground truth; the client's two health
 *                      probes get exactly what they ask for.
 *
 * `behaviour` makes one kind of call fail in a chosen way, for the fallback tests.
 */
export type StubBehaviour = 'ok' | 'http-500' | 'garbage' | 'unknown-ids' | 'empty';

export interface StubCall {
  kind: 'summary' | 'route' | 'sentinel' | 'answer' | 'judge' | 'other';
  body: Record<string, unknown>;
}

const STOP = new Set(['what', 'which', 'when', 'where', 'with', 'that', 'this', 'have', 'from', 'about', 'many', 'much', 'does', 'question', 'date']);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(word => !STOP.has(word)));
}

export function kindOf(prompt: string): StubCall['kind'] {
  if (prompt.startsWith('You are building the table of contents')) return 'summary';
  if (prompt.includes('Memory tree structure:')) return 'route';
  if (/^Reply with exactly (OK|1) and nothing else\.$/.test(prompt)) return 'sentinel';
  if (prompt.startsWith('Conversation memory excerpts')) return 'answer';
  if (prompt.includes('Ground truth answer:')) return 'judge';
  return 'other';
}

const CAT_NAMES = ['Miso', 'Tofu'];

function stubBenchmarkReply(kind: StubCall['kind'], prompt: string): string {
  if (kind === 'sentinel') return prompt.includes('exactly OK') ? 'OK' : '1';
  if (kind === 'answer') {
    const excerpts = prompt.slice(0, prompt.indexOf('\n\nQuestion (asked on'));
    const named = CAT_NAMES.filter(name => excerpts.includes(name));
    return named.length > 0 ? named.join(' and ') : "I don't know";
  }
  if (kind === 'judge') {
    const gold = /^Ground truth answer: (.*)$/m.exec(prompt)?.[1] ?? '';
    const answer = /^Assistant's answer: (.*)$/m.exec(prompt)?.[1] ?? '';
    const needed = CAT_NAMES.filter(name => gold.includes(name));
    return needed.length > 0 && needed.every(name => answer.includes(name)) ? '1' : '0';
  }
  return '{}';
}

export function stubSummaryReply(prompt: string): string {
  const nodes: Array<{ id: string; title: string; summary: string }> = [];
  const blocks = prompt.split(/^=== CONVERSATION id=/m).slice(1);
  for (const block of blocks) {
    const id = block.slice(0, block.indexOf(' '));
    const userLines: string[] = [];
    const turns = block.split(/^### Turn \d+ — /m).slice(1);
    for (const turn of turns) {
      if (!turn.startsWith('User')) continue;
      userLines.push(turn.slice('User'.length).trim().split('\n').filter(Boolean).join(' '));
    }
    // A note that is not a chat (no User turns) is summarised from its own text.
    const text = block.slice(block.indexOf('===\n') + 4).replace(/\s+/g, ' ').trim();
    nodes.push({
      id,
      title: (userLines[0] ?? text).split(/\s+/).slice(0, 8).join(' '),
      summary: (userLines.length > 0 ? userLines.join(' ') : text).slice(0, 600),
    });
  }
  return JSON.stringify({ nodes });
}

export function stubRouteReply(prompt: string): string {
  const question = /^Question: (.*)$/m.exec(prompt)?.[1] ?? '';
  const wanted = words(question);
  const tree = prompt.slice(prompt.indexOf('Memory tree structure:\n') + 'Memory tree structure:\n'.length, prompt.indexOf('\n\nPlease reply'));
  const ids: string[] = [];
  for (const line of tree.split('\n')) {
    const node = JSON.parse(line) as { node_id: string; title: string; summary: string };
    const have = words(`${node.title} ${node.summary}`);
    if ([...wanted].some(word => have.has(word))) ids.push(node.node_id);
  }
  return JSON.stringify({ thinking: `matched ${ids.length} node(s) on shared words`, node_list: ids });
}

/** The reply text for one request, or null for an HTTP 500. */
export function stubReply(prompt: string, behaviour: { summary?: StubBehaviour; route?: StubBehaviour } = {}): string | null {
  const kind = kindOf(prompt);
  const mode = kind === 'summary' ? behaviour.summary ?? 'ok' : kind === 'route' ? behaviour.route ?? 'ok' : 'ok';
  if (mode === 'http-500') return null;
  if (mode === 'garbage') return 'I would rather not answer in JSON.';
  if (mode === 'empty') return kind === 'summary' ? '{"nodes": []}' : '{"thinking": "nothing fits", "node_list": []}';
  if (mode === 'unknown-ids') return kind === 'summary' ? '{"nodes": [{"id": "zz", "title": "t", "summary": "s"}]}' : '{"thinking": "", "node_list": ["9999", "abc"]}';
  if (kind === 'summary') return stubSummaryReply(prompt);
  if (kind === 'route') return stubRouteReply(prompt);
  return stubBenchmarkReply(kind, prompt);
}

/** An OpenAI-compatible `/v1/chat/completions` stub on 127.0.0.1 that records every request body. */
export async function startStubServer(behaviour: { summary?: StubBehaviour; route?: StubBehaviour } = {}): Promise<{
  baseUrl: string;
  calls: StubCall[];
  close: () => Promise<void>;
}> {
  const calls: StubCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const messages = (body.messages ?? []) as Array<{ content: string }>;
      const prompt = messages[messages.length - 1]?.content ?? '';
      calls.push({ kind: kindOf(prompt), body });
      const content = stubReply(prompt, behaviour);
      if (content === null) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"stub failure"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(content.length / 4) },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
