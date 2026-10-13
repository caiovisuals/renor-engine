#!/usr/bin/env node
/**
 * OpenAI-compatible localhost chat proxy to Vertex AI, for eval runs that bill model calls to the evaluation
 * project (RENOR_EVAL_VERTEX_PROJECT) instead of a per-model daily API quota. The session-router trial uses it for
 * its summary phase (scripts/eval/session-router-trial.sh --vertex-summaries).
 *
 * The product's chat transport (src/evidence/ollamaChat.ts) sends POST {baseUrl}/chat/completions with a fixed
 * bearer key. Vertex's OpenAI-compatible endpoint needs a short-lived OAuth token (about an hour) from the service
 * account in GOOGLE_APPLICATION_CREDENTIALS. This proxy holds that token and renews it before it expires, so a long
 * run never sends an expired one; maps a bare model name to Vertex's publisher form (`gemini-3.1-flash-lite` ->
 * `google/gemini-3.1-flash-lite`); forwards the request body otherwise unchanged; and returns the upstream status and
 * body unchanged (a 429 stays a 429, so the caller's own retry policy applies). Keys, tokens and message text are
 * never logged or written.
 *
 * Upstream: https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/endpoints/openapi/chat/completions
 * (`--location`, default `global`: the Gemini 3.x flash-lite models are served there and not in every regional endpoint,
 * verified 2026-10-03). Stats JSON, rewritten after every request: requests and tokens per model, statuses, token
 * renewals, so every number a run reports can name the endpoint that produced it.
 *
 *   node --import tsx scripts/eval/vertex-chat-proxy.ts --port 0 --stats-path <json> [--location global] [--upstream-base <url>]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';

/** Renew this long before the token's own expiry. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 300_000;

interface ServiceAccountKey { client_email: string; private_key: string; token_uri: string }

export interface VertexChatProxyOptions {
  port: number;
  statsPath: string;
  project: string;
  location: string;
  /** Service-account key file (GOOGLE_APPLICATION_CREDENTIALS). */
  keyFile: string;
  /** Upstream base URL override (tests); default: the Vertex host for `location`. */
  upstreamBase?: string;
}

export interface VertexChatProxyStats {
  upstream: { endpoint: string; location: string };
  requests: number;
  statuses: Record<string, number>;
  byModel: Record<string, { requests: number; ok: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
  tokenRenewals: number;
  startedAt: string;
  lastAt: string | null;
}

/** `gemini-3.1-flash-lite` -> `google/gemini-3.1-flash-lite`; a name that already names its publisher is kept. */
export function vertexModelName(model: string): string {
  return model.includes('/') ? model : `google/${model}`;
}

function writeStats(statsPath: string, stats: VertexChatProxyStats): void {
  const tmp = `${statsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statsPath);
}

export function createVertexChatProxy(options: VertexChatProxyOptions) {
  if (!/^[a-z0-9-]+$/.test(options.location)) throw new Error('Invalid Vertex location');
  const host = options.location === 'global' ? 'aiplatform.googleapis.com' : `${options.location}-aiplatform.googleapis.com`;
  const base = (options.upstreamBase ?? `https://${host}/v1/projects/${options.project}/locations/${options.location}/endpoints/openapi`).replace(/\/+$/, '');
  const stats: VertexChatProxyStats = {
    upstream: { endpoint: 'vertex-ai openapi chat/completions', location: options.location },
    requests: 0,
    statuses: {},
    byModel: {},
    tokenRenewals: 0,
    startedAt: new Date().toISOString(),
    lastAt: null,
  };

  let token: { value: string; expiresAt: number } | null = null;
  let renewing: Promise<string> | null = null;

  /** OAuth2 JWT-bearer grant, the same exchange src/embeddings/vertex.ts makes for embeddings. */
  async function renewToken(): Promise<string> {
    const key = JSON.parse(fs.readFileSync(options.keyFile, 'utf8')) as ServiceAccountKey;
    if (!key.client_email || !key.private_key || !key.token_uri) {
      throw new Error('Service-account key file must contain client_email, private_key and token_uri');
    }
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: key.token_uri, iat: now, exp: now + 3600,
    })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
    const response = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    if (!response.ok) throw new Error(`Vertex token exchange failed: ${response.status}`);
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Vertex token exchange returned no access_token');
    token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    stats.tokenRenewals += 1;
    return token.value;
  }

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - TOKEN_MARGIN_MS) return token.value;
    renewing ??= renewToken().finally(() => { renewing = null; });
    return renewing;
  }

  function reply(res: http.ServerResponse, status: number, body: string): void {
    stats.statuses[String(status)] = (stats.statuses[String(status)] ?? 0) + 1;
    stats.lastAt = new Date().toISOString();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
    try {
      writeStats(options.statsPath, stats);
    } catch {
      // a stats write never fails the response
    }
  }

  async function handle(raw: string, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      reply(res, 400, JSON.stringify({ error: { message: 'vertex-chat-proxy: request body is not valid JSON' } }));
      return;
    }
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    if (!model) {
      reply(res, 400, JSON.stringify({ error: { message: 'vertex-chat-proxy: request names no model' } }));
      return;
    }
    const entry = (stats.byModel[model] ??= { requests: 0, ok: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    entry.requests += 1;
    stats.requests += 1;
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, model: vertexModelName(model) }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      reply(res, 502, JSON.stringify({ error: { message: `vertex-chat-proxy: upstream unreachable: ${error instanceof Error ? error.message : String(error)}` } }));
      return;
    }
    const text = await upstream.text();
    if (upstream.ok) {
      entry.ok += 1;
      try {
        const usage = (JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
        entry.promptTokens += usage?.prompt_tokens ?? 0;
        entry.completionTokens += usage?.completion_tokens ?? 0;
        entry.totalTokens += usage?.total_tokens ?? 0;
      } catch {
        // the body is forwarded as it came; counting is best effort
      }
    }
    reply(res, upstream.status, text);
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/^\/(v1\/)?chat\/completions$/.test(req.url ?? '')) {
      reply(res, 404, JSON.stringify({ error: { message: `vertex-chat-proxy: only POST /v1/chat/completions is served (got ${req.method} ${req.url})` } }));
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => { void handle(raw, res); });
  });

  return {
    server,
    stats,
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : options.port;
          writeStats(options.statsPath, stats);
          process.stderr.write(`[vertex-chat-proxy] listening on 127.0.0.1:${port} upstream=vertex-ai location=${options.location}\n`);
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise(resolve => server.close(() => {
        try { writeStats(options.statsPath, stats); } catch { /* best effort */ }
        resolve();
      }));
    },
  };
}

async function main(): Promise<void> {
  const program = new Command()
    .name('vertex-chat-proxy')
    .requiredOption('--port <n>', 'localhost port to listen on (0 = ephemeral)')
    .requiredOption('--stats-path <path>', 'stats JSON, rewritten after every request')
    .option('--location <location>', 'Vertex location of the chat endpoint', 'global')
    .option('--upstream-base <url>', 'another OpenAI-compatible base to forward to instead of Vertex (a private endpoint, or a local stub)');
  program.parse(process.argv);
  const opts = program.opts<{ port: string; statsPath: string; location: string; upstreamBase?: string }>();
  const project = process.env.RENOR_EVAL_VERTEX_PROJECT?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!project || !keyFile) throw new Error('RENOR_EVAL_VERTEX_PROJECT and GOOGLE_APPLICATION_CREDENTIALS are required');
  fs.mkdirSync(path.dirname(path.resolve(opts.statsPath)), { recursive: true });
  const proxy = createVertexChatProxy({
    port: Number(opts.port), statsPath: path.resolve(opts.statsPath), project, location: opts.location, keyFile,
    ...(opts.upstreamBase ? { upstreamBase: opts.upstreamBase } : {}),
  });
  await proxy.start();
  const shutdown = (): void => { proxy.close().then(() => process.exit(0), () => process.exit(1)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1]?.endsWith('vertex-chat-proxy.ts') === true;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
