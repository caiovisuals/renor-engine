import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic stand-in for the digest model (never a provider call): one item per User turn of each
 * `=== CONVERSATION id=.. date=.. ===` block, the item being the turn's own text and the turn label its provenance.
 * A block with no User turn gets an empty list. `behaviour` makes the call fail in a chosen way.
 */
export type DigestStubBehaviour = 'ok' | 'http-500' | 'garbage';

export interface DigestStubCall {
  body: Record<string, unknown>;
  prompt: string;
}

export function stubDigestReply(prompt: string): string {
  const notes: Array<{ id: string; items: Array<Record<string, string>> }> = [];
  for (const block of prompt.split(/^=== CONVERSATION id=/m).slice(1)) {
    const id = block.slice(0, block.indexOf(' '));
    const date = /date=(.*?) ===/.exec(block)?.[1] ?? '';
    const items: Array<Record<string, string>> = [];
    for (const match of block.matchAll(/^\[Turn (\d+) User\]\n(.*)$/gm)) {
      items.push({ item: match[2].trim().slice(0, 120), action: 'said', amount: '', date, turn: `Turn ${match[1]}` });
    }
    // A note with no turns (a daily note): one item per entry line, `- [time] (source) text`.
    if (items.length === 0 && !/^\[Turn \d+ /m.test(block)) {
      for (const match of block.matchAll(/^- \[[^\]]*\] \([^)]*\) (.*)$/gm)) {
        items.push({ item: match[1].trim().slice(0, 120), action: 'said', amount: '', date, turn: '' });
      }
    }
    notes.push({ id, items });
  }
  return JSON.stringify({ notes });
}

export async function startDigestStub(behaviour: DigestStubBehaviour = 'ok'): Promise<{
  baseUrl: string;
  calls: DigestStubCall[];
  close: () => Promise<void>;
}> {
  const calls: DigestStubCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const messages = (body.messages ?? []) as Array<{ content: string }>;
      const prompt = messages[messages.length - 1]?.content ?? '';
      calls.push({ body, prompt });
      if (behaviour === 'http-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"stub failure"}');
        return;
      }
      const content = behaviour === 'garbage' ? 'I would rather not answer in JSON.' : stubDigestReply(prompt);
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
