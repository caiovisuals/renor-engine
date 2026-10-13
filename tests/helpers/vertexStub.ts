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
  /** Predict requests received, and how many of them were answered with vectors. */
  readonly counts: { requests: number; served: number; texts: number };
  /** The task types of the served texts, so a test can tell a query from a document. */
  readonly taskTypes: string[];
  /** Add a delay before every answer (a slow, not refusing, service). */
  delayMs: number;
  close(): Promise<void>;
}

class Hash768 extends EvalHashEmbeddingProvider {
  dimensions = 768;
}

export async function startVertexStub(): Promise<VertexStub> {
  const hash = new Hash768();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-stub-'));
  const sockets = new Set<import('net').Socket>();
  const hanging = new Set<http.ServerResponse>();
  const stub = {
    mode: 'ok' as VertexStubMode,
    delayMs: 0,
    counts: { requests: 0, served: 0, texts: 0 },
    taskTypes: [] as string[],
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
        return;
      }
      stub.counts.requests++;
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
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(dir, 'key.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_email: 'stub@example.invalid',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: `${origin}/token`,
  }));

  return Object.assign(stub, {
    baseUrl: origin,
    keyFile,
    async close() {
      for (const res of hanging) res.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}
