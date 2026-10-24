import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenAI-compatible `/chat/completions` endpoint for the evidence client.
 *
 * It records the Authorization header and the exact body bytes of every request, so a test
 * can assert what a provider would actually receive (which key, which fields), and answers
 * each request from `reply`. Nothing leaves 127.0.0.1.
 */
export interface StubChatRequest {
  authorization: string | undefined;
  body: string;
}

export interface StubChatReply {
  status?: number;
  body: unknown;
}

export interface StubChat {
  baseUrl: string;
  requests: StubChatRequest[];
  close: () => Promise<void>;
}

export async function startStubChat(reply: (request: StubChatRequest) => StubChatReply): Promise<StubChat> {
  const requests: StubChatRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const request = { authorization: req.headers.authorization, body };
      requests.push(request);
      const answer = reply(request);
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>(resolve => {
      // fetch keeps connections alive; close them or server.close() waits for them.
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** An OpenAI-shaped completion. `content: undefined` leaves the message without content. */
export function completion(content: string | undefined, finishReason = 'stop'): Record<string, unknown> {
  return {
    choices: [{ message: content === undefined ? {} : { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

/** The provider env names the evidence client reads. Tests clear them so a developer shell never reaches a provider. */
export const EVIDENCE_PROVIDER_ENV = [
  'RENOR_EVIDENCE_API_KEY', 'RENOR_EVIDENCE_API_KEYS', 'RENOR_EVIDENCE_BASE_URL', 'RENOR_EVIDENCE_MODEL',
  'RENOR_EVIDENCE_CACHE', 'RENOR_EVIDENCE_MODE', 'RENOR_EVIDENCE_SESSIONS', 'RENOR_EVIDENCE_MAX_TOKENS', 'RENOR_EVIDENCE_REASONING_EFFORT', 'RENOR_SEARCH_EVIDENCE',
  'RENOR_EVIDENCE_OPTIN', 'RENOR_EVIDENCE_KEY_FILE', 'RENOR_EVIDENCE_DAILY_CAP',
  'OLLAMA_CLOUD_KEY_1', 'OLLAMA_CLOUD_KEY_2', 'OLLAMA_CLOUD_KEY_3', 'OLLAMA_CLOUD_KEY_4', 'OLLAMA_MAX_KEY', 'OLLAMA_API_KEY',
] as const;
