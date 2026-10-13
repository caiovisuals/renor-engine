import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createVertexChatProxy, vertexModelName } from '../../scripts/eval/vertex-chat-proxy';

/**
 * scripts/eval/vertex-chat-proxy.ts offline: a service-account key made up for the test (a fresh RSA key) whose
 * token endpoint is a local stub, and a local stub standing in for Vertex's OpenAI-compatible chat endpoint. No
 * Google endpoint is ever called.
 */

interface Seen { auth: string | undefined; body: Record<string, unknown> }

async function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

async function fixture(expiresIn: number, upstreamStatus = 200) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vertex-chat-proxy-'));
  let issued = 0;
  const tokens = await serve((_req, body, res) => {
    const assertion = new URLSearchParams(body).get('assertion') ?? '';
    issued += 1;
    res.writeHead(assertion.split('.').length === 3 ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: `token-${issued}`, expires_in: expiresIn }));
  });
  const seen: Seen[] = [];
  const upstream = await serve((req, body, res) => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(upstreamStatus === 200
      ? JSON.stringify({ model: 'google/gemini-3.1-flash-lite', choices: [{ message: { role: 'assistant', content: '{"nodes": []}' } }], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 130 } })
      : JSON.stringify({ error: { code: upstreamStatus, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }));
  });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(root, 'sa.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_email: 'trial@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: `${tokens.url}/token`,
  }));
  const statsPath = path.join(root, 'stats.json');
  const proxy = createVertexChatProxy({ port: 0, statsPath, project: 'eval-project', location: 'global', keyFile, upstreamBase: upstream.url });
  const port = await proxy.start();
  const chat = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer vertex-proxy-local', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    chat, seen, statsPath, issued: () => issued,
    close: async () => { await proxy.close(); await tokens.close(); await upstream.close(); await fsp.rm(root, { recursive: true, force: true }); },
  };
}

describe('vertex-chat-proxy (offline)', () => {
  it('maps a bare model name to its Vertex publisher form and keeps one that already names it', () => {
    expect(vertexModelName('gemini-3.1-flash-lite')).toBe('google/gemini-3.1-flash-lite');
    expect(vertexModelName('google/gemini-3.5-flash-lite')).toBe('google/gemini-3.5-flash-lite');
  });

  it('forwards the request with the service account\'s token in place of the caller\'s key, and the reply unchanged', async () => {
    const fx = await fixture(3600);
    try {
      const response = await fx.chat({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'secret note text' }], temperature: 0, max_tokens: 6000, response_format: { type: 'json_object' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ model: 'google/gemini-3.1-flash-lite', usage: { total_tokens: 130 } });
      expect(fx.seen[0]).toEqual({
        auth: 'Bearer token-1',
        body: { model: 'google/gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'secret note text' }], temperature: 0, max_tokens: 6000, response_format: { type: 'json_object' } },
      });
      await fx.chat({ model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'again' }] });
      expect(fx.issued()).toBe(1); // a fresh token is reused
      const stats = fs.readFileSync(fx.statsPath, 'utf8');
      expect(JSON.parse(stats)).toMatchObject({
        upstream: { location: 'global' }, requests: 2, statuses: { 200: 2 }, tokenRenewals: 1,
        byModel: { 'gemini-3.1-flash-lite': { requests: 2, ok: 2, promptTokens: 240, completionTokens: 16, totalTokens: 260 } },
      });
      expect(stats).not.toContain('token-1');
      expect(stats).not.toContain('secret note text');
    } finally {
      await fx.close();
    }
  });

  it('renews the token before it expires, so a long run never sends an expired one', async () => {
    const fx = await fixture(60); // inside the five-minute margin: every call renews
    try {
      await fx.chat({ model: 'gemini-3.1-flash-lite', messages: [] });
      await fx.chat({ model: 'gemini-3.1-flash-lite', messages: [] });
      expect(fx.seen.map(s => s.auth)).toEqual(['Bearer token-1', 'Bearer token-2']);
    } finally {
      await fx.close();
    }
  });

  it('passes an upstream refusal through with its status, so the caller\'s retry policy applies', async () => {
    const fx = await fixture(3600, 429);
    try {
      const response = await fx.chat({ model: 'gemini-3.1-flash-lite', messages: [] });
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { status: 'RESOURCE_EXHAUSTED' } });
      expect(JSON.parse(fs.readFileSync(fx.statsPath, 'utf8'))).toMatchObject({ statuses: { 429: 1 }, byModel: { 'gemini-3.1-flash-lite': { requests: 1, ok: 0 } } });
    } finally {
      await fx.close();
    }
  });

  it('refuses what it does not serve', async () => {
    const fx = await fixture(3600);
    try {
      expect((await fx.chat({ messages: [] })).status).toBe(400);
      expect(fx.seen).toHaveLength(0);
    } finally {
      await fx.close();
    }
  });
});
