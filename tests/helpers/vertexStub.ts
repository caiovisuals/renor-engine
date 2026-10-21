import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

/**
 * A local stand-in for Google's Vertex AI embedding service (the OAuth token endpoint and the `:predict` endpoint),
 * with the failure modes a real outage has, switched on and off while a test runs. No request leaves the machine and
 * no Google credential is involved: the key file it writes holds a throwaway RSA key and points `token_uri` here.
 *
 * `mode`: `ok` answers every request with deterministic 768-d vectors; `throttle` answers 429 (what Google did on
 * 2026-10-06 while the project used about 1% of its own quota); `unavailable` answers 503; `hang` accepts the request
 * and never answers it (a timeout).
 */
export type VertexStubMode = 'ok' | 'throttle' | 'unavailable' | 'hang';

export interface VertexStub {
  /** Where the provider is pointed (its `baseUrl`). */
  readonly baseUrl: string;
  /** A service-account key file for the provider: a throwaway key, its token endpoint this stub. */
  readonly keyFile: string;
  mode: VertexStubMode;
  /** Predict requests received, how many of them were answered with vectors, and the TCP connections the stub accepted (token requests included). */
  readonly counts: { requests: number; served: number; texts: number; connections: number };
  /** The task types of the served texts, so a test can tell a query from a document. */
  readonly taskTypes: string[];
  /** Add a delay before every answer (a slow, not refusing, service). */
  delayMs: number;
  /**
   * The token endpoint: requests received, the lifetime it gives a token (`expires_in`, seconds), a delay before it answers,
   * how many of the next requests it refuses with 500, and the bearer each predict request carried (in order), so a test can
   * tell which token a call used; while `hold` is set a token request is not answered until `releaseTokens`, so a test can
   * order events without timing them. Tokens are named `stub-token-1`, `stub-token-2` ... in the order they were issued.
   */
  readonly tokens: { requests: number; lifetimeS: number; delayMs: number; failing: number; used: string[]; hold: boolean };
  /** Answer the token requests held while `tokens.hold` was set. */
  releaseTokens(): void;
  /** Resolves once the token endpoint has received `count` requests (answered, refused or held), so a test waits for the stub to have seen an exchange instead of timing it. */
  tokenRequest(count: number): Promise<void>;
  /** Reset the next `count` predict requests instead of answering them: the socket is destroyed as the request arrives, as a connection the service closed meanwhile is. */
  resetNext(count?: number): void;
  /** Close the connections that have no request on them now, as Google's front end does when its idle timeout runs out. */
  closeIdleConnections(): void;
  close(): Promise<void>;
}

class Hash768 extends EvalHashEmbeddingProvider {
  dimensions = 768;
}

/** One throwaway key for every stub of a process: making an RSA key is the slowest thing a stub does, and nothing signed with it matters. */
let throwawayKey: string | undefined;
function throwawayKeyPem(): string {
  throwawayKey ??= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return throwawayKey;
}

/**
 * `keepAliveHint: false` gives the server no idle timeout of its own and so no `Keep-Alive: timeout=5` header on its answers,
 * which is how Google's front end answers: a caller's pool then decides alone how long it keeps a connection.
 */
export async function startVertexStub(options: { keepAliveHint?: boolean; tokenLifetimeS?: number } = {}): Promise<VertexStub> {
  const hash = new Hash768();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-stub-'));
  const sockets = new Set<import('net').Socket>();
  const hanging = new Set<http.ServerResponse>();
  const stub = {
    mode: 'ok' as VertexStubMode,
    delayMs: 0,
    counts: { requests: 0, served: 0, texts: 0, connections: 0 },
    taskTypes: [] as string[],
    tokens: { requests: 0, lifetimeS: options.tokenLifetimeS ?? 3600, delayMs: 0, failing: 0, used: [] as string[], hold: false },
  };
  let resetting = 0;
  const heldTokens: Array<() => void> = [];
  const tokenWaiters: Array<{ count: number; resolve: () => void }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/token') {
        const issued = ++stub.tokens.requests;
        for (const waiter of tokenWaiters.splice(0)) {
          if (issued >= waiter.count) waiter.resolve();
          else tokenWaiters.push(waiter);
        }
        const refuse = stub.tokens.failing > 0;
        if (refuse) stub.tokens.failing--;
        const reply = () => {
          if (refuse) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'synthetic token outage' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: `stub-token-${issued}`, expires_in: stub.tokens.lifetimeS }));
        };
        if (stub.tokens.hold) heldTokens.push(reply);
        else if (stub.tokens.delayMs > 0) setTimeout(reply, stub.tokens.delayMs);
        else reply(); // no timer: a test that fakes the clock still gets its answer
        return;
      }
      stub.counts.requests++;
      stub.tokens.used.push(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (resetting > 0) {
        resetting--;
        req.socket.destroy();
        return;
      }
      const answer = async () => {
        if (stub.delayMs > 0) await new Promise(resolve => setTimeout(resolve, stub.delayMs));
        if (stub.mode === 'throttle' || stub.mode === 'unavailable') {
          res.writeHead(stub.mode === 'throttle' ? 429 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: stub.mode === 'throttle' ? 429 : 503, message: 'synthetic outage' } }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { instances: Array<{ content: string; task_type: string }> };
        const vectors = await hash.embed(body.instances.map(i => i.content));
        stub.counts.served++;
        stub.counts.texts += body.instances.length;
        for (const i of body.instances) stub.taskTypes.push(i.task_type);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ predictions: vectors.map(values => ({ embeddings: { values, statistics: { token_count: 8 } } })) }));
      };
      if (stub.mode === 'hang') {
        hanging.add(res);
        res.on('close', () => hanging.delete(res));
        return;
      }
      void answer();
    });
  });
  if (options.keepAliveHint === false) server.keepAliveTimeout = 0;
  server.on('connection', socket => {
    stub.counts.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const keyFile = path.join(dir, 'key.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_email: 'stub@example.invalid',
    private_key: throwawayKeyPem(),
    token_uri: `${origin}/token`,
  }));

  return Object.assign(stub, {
    baseUrl: origin,
    keyFile,
    resetNext(count = 1) { resetting += count; },
    releaseTokens() { for (const reply of heldTokens.splice(0)) reply(); },
    tokenRequest(count: number) {
      return stub.tokens.requests >= count ? Promise.resolve() : new Promise<void>(resolve => { tokenWaiters.push({ count, resolve }); });
    },
    closeIdleConnections() { server.closeIdleConnections(); },
    async close() {
      for (const res of hanging) res.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}
