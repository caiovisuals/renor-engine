import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

/**
 * The breaker suite's workspace: the REAL product MCP tool surface, in process, on the deterministic
 * eval-hash embedder. One workspace is one memory directory, one SQLite index and one MCP server bound
 * to one in-memory client — the same shape `run-renorbench-product.ts` drives, so every attack goes
 * through the tools an agent actually calls (`createMvpApp`, the handlers the hosted service serves).
 *
 * Free and deterministic by construction: the injected hash provider makes no network call and no
 * model runs; the process environment is set once (the product's own settings, never a credential)
 * and every workspace config is a plain clone with its own `memoryDir`/`dbPath`. Opening the same
 * root twice is two sessions on one workspace (cross-agent recall); opening two roots is two
 * workspaces (isolation).
 */

/** Environment keys this suite touches; saved once and restored by `restoreBreakerEnv`. */
const TOUCHED_ENV = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD',
  'MVP_PORT', 'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER',
  'EMBEDDING_PROVIDER', 'MVP_DB_PATH', 'RENOR_SEARCH_EVIDENCE', 'RENOR_SECRET_GUARD',
  'RENOR_STRUCTURED_CONTEXT', 'RENOR_DIGESTS', 'RENOR_CONTEXT_RELEVANCE', 'RENOR_CONTEXT_RELEVANCE_MIN',
  'RENOR_SESSION_EXPAND', 'RENOR_EVIDENCE_MODE', 'RENOR_ON_DEMAND',
];

const savedEnv = Object.fromEntries(TOUCHED_ENV.map(key => [key, process.env[key]]));

export function restoreBreakerEnv(): void {
  for (const key of TOUCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

/** Roots `makeBaseConfig` created; the test file's afterAll removes them with the workspace roots. */
export const baseRoots: string[] = [];

/**
 * A base config loaded once for the whole file: a throwaway memory dir satisfies the required
 * settings, and every workspace below overrides `memoryDir`/`dbPath`. The embedding provider is
 * `none` because the real provider is injected per workspace, never read from the environment.
 */
export function makeBaseConfig(): MvpConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-breaker-base-'));
  baseRoots.push(root);
  const memoryDir = path.join(root, 'memory');
  const authDir = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  for (const key of TOUCHED_ENV) delete process.env[key];
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-owner-secret-123',
    MVP_EMBEDDING_PROVIDER: 'none',
    RENOR_SEARCH_EVIDENCE: '0',
  });
  const config = loadMvpConfig();
  return config;
}

/** One tool call, exactly as an agent reads it: the joined text of every content item, the parsed first item, and ms. */
export interface ToolCall {
  isError: boolean;
  text: string;
  body: any;
  ms: number;
}

export interface BreakerWorkspace {
  memoryDir: string;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  /** The engine stops mid-session: the server (and its transport) is closed, the client is left to observe. */
  stopServer(): Promise<void>;
  close(): Promise<void>;
}

/** A workspace root under the system temp dir; callers own cleanup of the roots they create. */
export function newWorkspaceRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `renor-breaker-${label}-`));
}

export async function openWorkspace(root: string, base: MvpConfig): Promise<BreakerWorkspace> {
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const config: MvpConfig = {
    ...base,
    memoryDir,
    dbPath: path.join(memoryDir, '.memory-index', 'index.db'),
    explicitDbPath: null,
  };
  const app: MvpApp = createMvpApp(config, new EvalHashEmbeddingProvider());
  await app.embeddingRebuild;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'renor-breaker', version: '0.1.0' });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);

  let appClosed = false;
  const closeApp = async () => { if (!appClosed) { appClosed = true; await app.close().catch(() => undefined); } };

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCall> => {
    const started = performance.now();
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000 });
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.map(item => item.text ?? '').join('\n');
      let body: any = null;
      if (res.isError !== true && content[0]?.text) {
        try { body = JSON.parse(content[0].text); } catch { body = null; }
      }
      return { isError: res.isError === true, text, body, ms: Math.round(performance.now() - started) };
    } catch (err) {
      return { isError: true, text: err instanceof Error ? err.message : String(err), body: null, ms: Math.round(performance.now() - started) };
    }
  };

  return {
    memoryDir,
    call,
    stopServer: closeApp,
    async close() {
      await client.close().catch(() => undefined);
      await closeApp();
    },
  };
}

/** Run `fn` against a fresh workspace and always close it. */
export async function withWorkspace<T>(root: string, base: MvpConfig, fn: (ws: BreakerWorkspace) => Promise<T>): Promise<T> {
  const ws = await openWorkspace(root, base);
  try { return await fn(ws); } finally { await ws.close(); }
}

/** Every text a workspace stores on disk (excluding the derived index), for a leak check. */
export function storedText(memoryDir: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '.memory-index') walk(full); }
      else parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(memoryDir)) walk(memoryDir);
  return parts.join('\n');
}
