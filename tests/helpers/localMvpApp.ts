import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMvpConfig } from '../../src/mvp/config';
import { createMvpApp, type MvpApp } from '../../src/mvp/server';

/**
 * The MVP app on a loopback base URL with its own private memory and client-store directories, built the way
 * `npm run mvp` builds it, for tests that send it requests with a chosen Host or Origin. No embedding model, no
 * network. `cleanup()` closes every app made and restores the environment and the directories.
 */

export const LOCAL_PORT = 39571;
export const OWNER_EMAIL = 'owner@example.test';
export const OWNER_PASSWORD = 'synthetic-owner-secret-123';

const ENV_KEYS = [
  'MVP_PORT', 'MVP_BASE_URL', 'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_DB_PATH', 'MVP_OWNER_EMAIL',
  'MVP_OWNER_PASSWORD', 'MVP_ALLOWED_CALLBACK_URIS', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'MVP_GATEWAY_SECRET',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tmpDirs: string[] = [];
const apps: MvpApp[] = [];

export interface LocalApp {
  app: MvpApp;
  memoryDir: string;
  authStatePath: string;
}

export function localApp(options: { baseUrl?: string; gatewaySecret?: string; memoryDir?: string } = {}): LocalApp {
  const memoryDir = options.memoryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-local-mem-'));
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-local-auth-'));
  tmpDirs.push(memoryDir, authDir);
  const authStatePath = path.join(authDir, 'clients.json');
  Object.assign(process.env, {
    MVP_PORT: String(LOCAL_PORT),
    MVP_BASE_URL: options.baseUrl ?? `http://127.0.0.1:${LOCAL_PORT}`,
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: authStatePath,
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_ALLOWED_CALLBACK_URIS: 'http://localhost:39472/callback',
    MVP_EMBEDDING_PROVIDER: 'none',
  });
  delete process.env.MVP_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  if (options.gatewaySecret) process.env.MVP_GATEWAY_SECRET = options.gatewaySecret;
  else delete process.env.MVP_GATEWAY_SECRET;
  const app = createMvpApp(loadMvpConfig());
  apps.push(app);
  return { app, memoryDir, authStatePath };
}

export async function cleanupLocalApps(): Promise<void> {
  for (const app of apps.splice(0)) await app.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
