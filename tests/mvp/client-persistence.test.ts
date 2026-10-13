import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, createMvpApp, MVP_MCP_PATH, type MvpApp } from '../../src/mvp/server';
import { ClientRegistryError } from '../../src/mvp/client-store';
import type { Express } from 'express';

/**
 * CLIENT-PERSISTENCE regressions (restart contract for the DCR registry).
 *
 * The MVP previously kept registered OAuth clients in memory only; ChatGPT
 * registers a client ONCE and caches its client_id, so every service restart
 * broke fresh authorization with invalid_client. These tests pin the new
 * restart contract: registered client metadata persists in an explicit
 * owner-only store OUTSIDE the memory/history trees, a restart boots from
 * the SAME store, and the SAME client (no re-registration) authorizes again
 * with a fresh ticket + PKCE while memory/history keep working. Everything
 * else fails closed: corrupt/symlink/permission/bound/io-failure states
 * never yield a silently-reset or in-memory-only registry. Tickets and codes
 * are NOT persisted (single-use, short-lived). All data synthetic, loopback
 * only, no vault/Downloads access, no secrets in outputs.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const LOOPBACK_CB = 'http://127.0.0.1:1/callback';

const tmpDirs: string[] = [];
const services: { httpServer: import('http').Server }[] = [];
const apps: MvpApp[] = [];

afterEach(() => {
  while (services.length) {
    const s = services.pop()!;
    s.httpServer.closeAllConnections?.();
    s.httpServer.close();
  }
  while (apps.length) apps.pop()!.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function tmpdir0700(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); // mkdtemp is 0700
  tmpDirs.push(d);
  return d;
}

interface Boot {
  config: MvpConfig;
  app: Express;
  stop: () => void;
}

/** Boots a REAL listening service (true restart semantics). */
async function bootService(opts: {
  memoryDir: string;
  authStatePath: string;
  historyDir?: string;
  allowlist?: string;
}): Promise<Boot> {
  const port = await freePort();
  process.env.MVP_MEMORY_DIR = opts.memoryDir;
  process.env.MVP_AUTH_STATE_PATH = opts.authStatePath;
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = opts.allowlist ?? LOOPBACK_CB;
  if (opts.historyDir === undefined) delete process.env.MVP_HISTORY_DIR;
  else process.env.MVP_HISTORY_DIR = opts.historyDir;
  process.env.MVP_PORT = String(port);
  const config = loadMvpConfig();
  const started = await startMvpService(config);
  services.push(started);
  apps.push(started);
  return {
    config,
    app: started.app,
    stop: () => {
      started.httpServer.closeAllConnections?.();
      started.httpServer.close();
    },
  };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(app: Express): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
  const res = await request(app).post('/register')
    .send({ client_name: 'synthetic-persistence-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'] });
  expect(res.status).toBe(201);
  return { clientId: res.body.client_id, clientSecret: res.body.client_secret, redirectUri: LOOPBACK_CB };
}

async function getTicket(app: Express, clientId: string, redirectUri: string, challenge: string) {
  const res = await request(app).get('/authorize').query({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  });
  const ticket = res.status === 200 ? res.text.match(/name="ticket" value="([^"]+)"/)?.[1] ?? null : null;
  return { status: res.status, ticket, text: res.text };
}

async function ownerLogin(app: Express, _client: { clientId: string; clientSecret: string; redirectUri: string },
                         ticket: string) {
  const login = await request(app).post('/mvp-login')
    .type('form').send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (login.status !== 302) return { loginStatus: login.status, code: null };
  const code = new URL(login.headers.location as string, 'http://x').searchParams.get('code');
  return { loginStatus: 302, code };
}

async function exchangeToken(app: Express, client: { clientId: string; clientSecret: string; redirectUri: string },
                             code: string, verifier: string) {
  const res = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: client.redirectUri,
    client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier,
  });
  return { status: res.status, tokens: res.body };
}

async function fullAuthorize(app: Express, client: { clientId: string; clientSecret: string; redirectUri: string }): Promise<{
  status: number; tokens?: any; code?: string | null; ticket?: string | null;
}> {
  const { verifier, challenge } = pkce();
  const { status, ticket } = await getTicket(app, client.clientId, client.redirectUri, challenge);
  if (!ticket) return { status, ticket: null };
  const login = await ownerLogin(app, client, ticket);
  if (!login.code) return { status: login.loginStatus };
  const token = await exchangeToken(app, client, login.code, verifier);
  if (token.status !== 200) return { status: token.status };
  return { status: 200, tokens: token.tokens, code: login.code };
}

async function mcpCall(config: MvpConfig, accessToken: string, method: string, toolName?: string, args?: Record<string, unknown>) {
  const client = new Client({ name: 'persistence-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
  );
  await client.connect(transport);
  try {
    if (method === 'initialize' || !toolName) {
      const tools = await client.listTools();
      return tools;
    }
    const res = await client.callTool({ name: toolName, arguments: args ?? {} });
    return JSON.parse((res.content as { text: string }[])[0].text);
  } finally {
    await client.close();
  }
}

/** Minimal synthetic promoted-history fixture (reviewed promotion shape). */
function writeSyntheticHistory(historyDir: string): void {
  // reviewed promotion shape: note files sit DIRECTLY in the history dir;
  // the manifest entry's rel is the marker `notes/<name>` (see src/mvp/history.ts)
  const convId = 'conv-persist-0001';
  const fm = [
    'type: "journal"', 'source: "ChatGPT export"', `conversation_id: "${convId}"`,
    'title: "Synthetic persistence calibration chat"',
    'created: "2023-11-14T22:13:20Z"', 'updated: "2023-11-14T22:23:20Z"',
    'memory_layer: "history"', 'trust: "untrusted-transcript"',
    `source_sha256: "${crypto.randomBytes(32).toString('hex')}"`,
    `content_sha256: "${crypto.randomBytes(32).toString('hex')}"`,
    'source_member: "conversations-000.json"', 'source_index: 0',
    'source_ref: "conversations-000.json#0"', 'quarantined: false', 'redacted: 0',
    'omitted_branch_messages: 0', 'reasoning_excluded: 0', 'internal_channels_excluded: 0',
    'hidden_excluded: 0', 'other_roles_excluded: 0', 'attachments_omitted: 0',
    'unsupported_content_excluded: 0', 'off_branch_defects: 0', 'active_branch_nodes: 2', 'total_mapping_nodes: 2',
  ].join('\n');
  const note = `---\n${fm}\n---\n\n# Synthetic persistence calibration chat\n\n`
    + `> [!warning] Untrusted historical transcript\n\n## Visible active branch\n\n`
    + `**[user]** 2023-11-14T22:13:20Z\n\nHow do I calibrate the ZYNTHETIC-QUARTZ-PERSIST oscillator?`
    + `\n\n**[assistant]** 2023-11-14T22:13:40Z\n\nThe ZYNTHETIC-QUARTZ-PERSIST oscillator is calibrated weekly with the reference jig.\n`;
  fs.writeFileSync(path.join(historyDir, 'chatgpt-conv-persist-0001.md'), note, 'utf-8');
  fs.writeFileSync(path.join(historyDir, 'promote-manifest.json'), JSON.stringify({
    schema: 'chatgpt-promote-manifest/1', staging_manifest_digest: '0'.repeat(64),
    notes: {
      'chatgpt-conv-persist-0001.md': {
        rel: 'notes/chatgpt-conv-persist-0001.md', conversation_id: convId,
        note_sha256: crypto.createHash('sha256').update(note, 'utf-8').digest('hex'),
        staging_manifest_digest: '0'.repeat(64),
      },
    },
  }, null, 2), 'utf-8');
}

function validStoreWith(clients: unknown[]): string {
  return JSON.stringify({ schema: 'mvp-oauth-clients/1', clients });
}

function syntheticClientRecord(id: string): Record<string, unknown> {
  return {
    client_id: id, client_secret: `synthetic-secret-${id}`,
    redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'],
    token_endpoint_auth_method: 'client_secret_basic', client_id_issued_at: 1_700_000_000,
  };
}

describe('CLIENT-PERSISTENCE: restart contract (register once, restart, re-authorize)', () => {
  it('CRITICAL: register once -> use tools -> restart from same store (no re-registration) -> same clientId/secret authorizes again and memory/history still work; old ticket/code replay fails', async () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const authStatePath = path.join(authRoot, 'clients.json');
    const historyDir = tmpdir0700('mvp-cp-history-');
    writeSyntheticHistory(historyDir);

    // --- run 1: register ONCE and use everything
    const run1 = await bootService({ memoryDir, authStatePath, historyDir });
    const client = await registerClient(run1.app);
    const auth1 = await fullAuthorize(run1.app, client);
    expect(auth1.status).toBe(200);
    const saved = await mcpCall(run1.config, auth1.tokens.access_token, 'call', 'save_memory',
      { subject: 'PersistSubject', predicate: 'survives_restart', object: 'yes', source: 'chatgpt' });
    expect(saved.ok).toBe(true);
    const retrieved = await mcpCall(run1.config, auth1.tokens.access_token, 'call', 'retrieve_memory',
      { subject: 'PersistSubject' });
    expect(retrieved.facts.length).toBe(1);
    const search1 = await mcpCall(run1.config, auth1.tokens.access_token, 'call', 'search_history',
      { query: 'ZYNTHETIC-QUARTZ-PERSIST' });
    expect(search1.ok).toBe(true);
    expect(search1.results.length).toBeGreaterThanOrEqual(1);

    // capture a live ticket + code from run 1 for the replay assertions
    const { verifier: vOld, challenge: cOld } = pkce();
    const t1 = await getTicket(run1.app, client.clientId, client.redirectUri, cOld);
    expect(t1.ticket).toBeTruthy();
    const loginOld = await ownerLogin(run1.app, client, t1.ticket!);
    expect(loginOld.code).toBeTruthy();

    // the store on disk holds ONLY schema + clients (no tickets/codes/tokens)
    const rawStore = fs.readFileSync(authStatePath, 'utf-8');
    const parsedStore = JSON.parse(rawStore);
    expect(Object.keys(parsedStore).sort()).toEqual(['clients', 'schema']);
    expect(parsedStore.clients.length).toBe(1);
    expect(parsedStore.clients[0].client_id).toBe(client.clientId);
    expect(JSON.stringify(parsedStore)).not.toContain('ticket');
    expect(rawStore.includes(loginOld.code!)).toBe(false);
    // the store lives OUTSIDE the memory and history trees
    expect(authStatePath.startsWith(memoryDir)).toBe(false);
    expect(authStatePath.startsWith(historyDir)).toBe(false);

    // --- STOP the service, RESTART from the SAME store, DO NOT re-register
    run1.stop();
    const run2 = await bootService({ memoryDir, authStatePath, historyDir });

    // the SAME client authorizes again with a fresh ticket + PKCE
    const auth2 = await fullAuthorize(run2.app, client);
    expect(auth2.status).toBe(200);

    // memory and history still work after the restart
    const retrieved2 = await mcpCall(run2.config, auth2.tokens.access_token, 'call', 'retrieve_memory',
      { subject: 'PersistSubject' });
    expect(retrieved2.facts.length).toBe(1);
    expect(JSON.stringify(retrieved2)).toContain('survives_restart');
    const search2 = await mcpCall(run2.config, auth2.tokens.access_token, 'call', 'search_history',
      { query: 'ZYNTHETIC-QUARTZ-PERSIST' });
    expect(search2.ok).toBe(true);
    expect(search2.results.length).toBeGreaterThanOrEqual(1);
    // export returns [meta, raw ledger markdown]: the persisted fact must be
    // in the ledger bytes, and the OAuth registry must never surface in it
    const exportClient = new Client({ name: 'persistence-export-client', version: '0.1.0' });
    const exportTransport = new StreamableHTTPClientTransport(
      new URL(MVP_MCP_PATH, `http://127.0.0.1:${run2.config.port}`),
      { requestInit: { headers: { Authorization: `Bearer ${auth2.tokens.access_token}` } } },
    );
    await exportClient.connect(exportTransport);
    const exportRes = await exportClient.callTool({ name: 'export_memory', arguments: {} });
    await exportClient.close();
    const exportMeta = JSON.parse((exportRes.content as { text: string }[])[0].text);
    const exportLedger = (exportRes.content as { text: string }[])[1].text;
    expect(exportMeta.bytes).toBeGreaterThan(0);
    expect(exportLedger).toContain('PersistSubject');
    // the registry never surfaces in exports
    expect(exportLedger).not.toContain('client_secret');
    expect(exportLedger).not.toContain(path.basename(authStatePath));

    // old ticket replay on run 2 fails (tickets are not persisted: single-use, short-lived)
    const replayLogin = await request(run2.app).post('/mvp-login')
      .type('form').send({ ticket: t1.ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(replayLogin.status).toBe(403);
    // old code replay on run 2 fails (codes are not persisted either)
    const oldCodeExchange = await request(run2.app).post('/token').type('form').send({
      grant_type: 'authorization_code', code: loginOld.code, redirect_uri: client.redirectUri,
      client_id: client.clientId, client_secret: client.clientSecret, code_verifier: vOld,
    });
    expect(oldCodeExchange.status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it('unknown client_id is rejected at /authorize (no fabricated clients)', async () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const authStatePath = path.join(tmpdir0700('mvp-cp-auth-'), 'clients.json');
    const svc = await bootService({ memoryDir, authStatePath });
    const { challenge } = pkce();
    const res = await request(svc.app).get('/authorize').query({
      client_id: 'totally-unknown-client-id', redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain('ticket');
  });

  it('a persisted client whose callback was REMOVED from the allowlist cannot authorize after restart (current allowlist enforced)', async () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const authStatePath = path.join(tmpdir0700('mvp-cp-auth-'), 'clients.json');
    const run1 = await bootService({ memoryDir, authStatePath });
    const client = await registerClient(run1.app);
    run1.stop();
    // restart with an EMPTY allowlist: the persisted client survives, but its
    // callback is no longer allowlisted, so fresh authorization is refused
    const run2 = await bootService({ memoryDir, authStatePath, allowlist: '' });
    const { challenge } = pkce();
    const res = await request(run2.app).get('/authorize').query({
      client_id: client.clientId, redirect_uri: client.redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(res.status).toBe(403);
    expect(res.text).toContain('no longer allowlisted');
  });
});

/** Boots nothing: a store that is corrupt/unsafe must fail registry load. */
function expectStartupFails(authStatePath: string, memoryDir: string) {
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = authStatePath;
  process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
  delete process.env.MVP_HISTORY_DIR;
  let registryError: unknown = null;
  try {
    createMvpApp(loadMvpConfig());
  } catch (err) {
    registryError = err;
  }
  expect(registryError).toBeInstanceOf(ClientRegistryError);
  expect((registryError as Error).message).toContain('not usable');
}

describe('CLIENT-PERSISTENCE: store integrity fails closed (never silently reset)', () => {

  it('corrupt JSON store fails closed at startup', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, '{not valid json', { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it('valid JSON but wrong schema version fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, JSON.stringify({ schema: 'mvp-oauth-clients/2', clients: [] }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it('a store written by the live ChatGPT connector (response_types present) loads fine; still-unknown fields fail closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, validStoreWith([
      {
        client_id: 'synthetic-live-shape', client_name: 'Synthetic connector client',
        redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic',
        client_id_issued_at: 1_700_000_000, scope: 'memory', client_secret: 'synthetic-secret',
        client_secret_expires_at: 0,
      },
    ]), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    // config-level validation passes, registry loads (no throw)
    process.env.MVP_MEMORY_DIR = tmpdir0700('mvp-cp-memory-');
    process.env.MVP_AUTH_STATE_PATH = p;
    process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
    process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
    process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
    delete process.env.MVP_HISTORY_DIR;
    let threw: unknown = null;
    try { createMvpApp(loadMvpConfig()); } catch (err) { threw = err; }
    expect(threw).toBeNull();
  });

  it('unknown top-level or client fields fail closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, JSON.stringify({ schema: 'mvp-oauth-clients/1', clients: [], extra: 1 }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it('symlink store file fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const target = path.join(authRoot, 'real.json');
    fs.writeFileSync(target, validStoreWith([]), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const p = path.join(authRoot, 'clients.json');
    fs.symlinkSync(target, p);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it('symlinked store DIRECTORY fails closed', () => {
    const realRoot = tmpdir0700('mvp-cp-real-');
    const linkRoot = tmpdir0700('mvp-cp-link-'); // 0700, holds the symlink
    fs.rmSync(linkRoot, { recursive: true, force: true });
    tmpDirs.splice(tmpDirs.indexOf(linkRoot), 1);
    const dirWithLink = tmpdir0700('mvp-cp-holder-');
    fs.symlinkSync(realRoot, path.join(dirWithLink, 'authroot'));
    expectStartupFails(path.join(dirWithLink, 'authroot', 'clients.json'), tmpdir0700('mvp-cp-memory-'));
  });

  it('group/world-readable store file (0644) fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    fs.writeFileSync(p, validStoreWith([]));
    fs.chmodSync(p, 0o644);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it('group/world-accessible store directory (0755) fails closed', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    fs.chmodSync(authRoot, 0o755);
    expectStartupFails(path.join(authRoot, 'clients.json'), tmpdir0700('mvp-cp-memory-'));
  });

  it('store exceeding the bounded client limit fails closed (not trimmed)', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    const many = Array.from({ length: 101 }, (_, i) => syntheticClientRecord(`bulk-${i}`));
    fs.writeFileSync(p, validStoreWith(many), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    expectStartupFails(p, tmpdir0700('mvp-cp-memory-'));
  });

  it('a valid store at the bound still boots, and further registration is refused (store bound)', async () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    const many = Array.from({ length: 100 }, (_, i) => syntheticClientRecord(`bulk-${i}`));
    fs.writeFileSync(p, validStoreWith(many), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    const svc = await bootService({ memoryDir: tmpdir0700('mvp-cp-memory-'), authStatePath: p });
    const res = await request(svc.app).post('/register')
      .send({ client_name: 'over-bound', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });
});

describe('CLIENT-PERSISTENCE: disk-first registration and I/O failure', () => {
  it('failed disk write acknowledges NO client (not even in memory)', async ({ skip }) => {
    if (process.getuid?.() === 0) skip('requires a non-root process so directory permissions deny writes');
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const p = path.join(authRoot, 'clients.json');
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const svc = await bootService({ memoryDir, authStatePath: p });
    fs.chmodSync(authRoot, 0o500); // owner r-x: reads fine, writes fail (still owner-only)
    const res = await request(svc.app).post('/register')
      .send({ client_name: 'io-fail-client', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    fs.chmodSync(authRoot, 0o700);
    expect(res.status).toBe(500);            // ServerError: persist failed
    expect(res.body.error).toBe('server_error');
    const attemptedId = res.body.client_id; // never echoed anyway
    expect(attemptedId).toBeUndefined();
    // no store file was created => the failed client cannot authorize
    expect(fs.existsSync(p)).toBe(false);
    const { challenge } = pkce();
    // even a guessed/known client_id from a failed write is unknown:
    const probe = await request(svc.app).get('/authorize').query({
      client_id: 'guessed-after-io-failure', redirect_uri: LOOPBACK_CB, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
    });
    expect(probe.status).toBeGreaterThanOrEqual(400);
    // after the store becomes writable again, registration works
    const ok = await request(svc.app).post('/register')
      .send({ client_name: 'recovers', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(ok.status).toBe(201);
  });

  it('registration audit output contains no secrets or full client identifiers', async () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const svc = await bootService({ memoryDir, authStatePath: path.join(authRoot, 'clients.json') });
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const reg = await request(svc.app).post('/register')
      .send({ client_name: 'audit-check', redirect_uris: [LOOPBACK_CB], grant_types: ['authorization_code'] });
    expect(reg.status).toBe(201);
    const logged = lines.join('\n');
    expect(logged).not.toContain(reg.body.client_secret);
    expect(logged).not.toContain(reg.body.client_id);
    expect(logged).toContain('dcr_ok'); // metadata-only audit still fires
  });

  it('MVP_AUTH_STATE_PATH inside the memory dir, inside the history dir, or a Markdown file is rejected at config time', () => {
    const memoryDir = tmpdir0700('mvp-cp-memory-');
    const historyDir = tmpdir0700('mvp-cp-history-');
    process.env.MVP_MEMORY_DIR = memoryDir;
    process.env.MVP_HISTORY_DIR = historyDir;
    process.env.MVP_BASE_URL = 'http://127.0.0.1:3471';
    process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
    process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
    process.env.MVP_ALLOWED_CALLBACK_URIS = LOOPBACK_CB;
    process.env.MVP_AUTH_STATE_PATH = path.join(memoryDir, 'clients.json');
    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH must not be inside the fact memory directory/);
    process.env.MVP_AUTH_STATE_PATH = path.join(historyDir, 'clients.json');
    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH must not be equal to or overlap the promoted history directory/);
    process.env.MVP_AUTH_STATE_PATH = '/tmp/somewhere/clients.md';
    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH must not be a Markdown file/);
    process.env.MVP_AUTH_STATE_PATH = '';
    expect(() => loadMvpConfig()).toThrow(/Missing required configuration MVP_AUTH_STATE_PATH/);
  });

  it('missing auth-state directory fails closed at startup (operator must create it 0700)', () => {
    const authRoot = tmpdir0700('mvp-cp-auth-');
    const missing = path.join(authRoot, 'missing-dir', 'clients.json');
    expectStartupFails(missing, tmpdir0700('mvp-cp-memory-'));
  });
});
