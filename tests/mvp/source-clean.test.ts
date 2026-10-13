import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';

/**
 * The origin of an entry over the real hosted tools. A Renor user found entries saved with file-path garbage in their
 * origin field: an agent that builds its MCP call by hand had sent a path as `source`, and the note header ran it together
 * into one word (`/home/ana/atlas/BOARD.md` became `homeanaatlasBOARDmd`) while the ledger kept it whole. Over the real MCP
 * surface a path is now stored as the name it ends in by every tool that takes a `source`, the header writes the characters
 * it cannot keep as hyphens, a source is at most 40 characters, and a write that names no one is saved by the client that
 * made it (the product in its User-Agent), so an agent never has to pass one. What the dashboard shows ("by BOARD-md",
 * from memory_map and read_memory) is that name. Entries and events saved earlier are left exactly as they are. Synthetic
 * data only.
 */

const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';
const CLAUDE_CODE = 'claude-code/2.1.289 (external, cli)';
const ENV_KEYS = [
  'MVP_MEMORY_DIR', 'MVP_AUTH_STATE_PATH', 'MVP_BASE_URL', 'MVP_OWNER_EMAIL', 'MVP_OWNER_PASSWORD', 'MVP_PORT',
  'MVP_ALLOWED_CALLBACK_URIS', 'MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_SECRET_GUARD',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function makeConfig(memoryDir: string, authRoot: string, port: number): MvpConfig {
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MVP_OWNER_EMAIL = OWNER_EMAIL;
  process.env.MVP_OWNER_PASSWORD = OWNER_PASSWORD;
  process.env.MVP_PORT = String(port);
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  for (const key of ['MVP_HISTORY_DIR', 'MVP_LEDGER_REL', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER', 'RENOR_SECRET_GUARD']) delete process.env[key];
  // This fixture models hosted writes, including gateway headers and unnamed-key source fallbacks.
  return { ...loadMvpConfig(), gatewaySecret: 'synthetic-gateway-secret' };
}

async function authorize(app: Parameters<typeof request>[0]): Promise<string> {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'source-clean', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] })
    .expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeRes = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorizeRes.text.match(/name="ticket" value="([^"]+)"/)?.[1]!;
  const login = await request(app).post('/mvp-login').type('form').send({
    ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD,
  }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code')!;
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token;
}

/**
 * A fresh workspace, with `files` already on disk when it boots, and an MCP client that presents `userAgent` on every
 * request. Calls are sequential: the default stateless mode shares one MCP server.
 */
async function startWorkspace(opts: { files?: Record<string, string>; userAgent?: string; agent?: string } = {}) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-source-clean-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-authroot-'));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(memoryDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, rel), content);
  }
  const config = makeConfig(memoryDir, authRoot, await freePort());
  const service = await startMvpService(config);
  const client = new Client({ name: 'source-clean', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(MVP_MCP_PATH, `http://127.0.0.1:${config.port}`),
    { requestInit: { headers: { Authorization: `Bearer ${await authorize(service.app)}`, 'User-Agent': opts.userAgent ?? CLAUDE_CODE, ...(opts.agent ? { 'x-renor-agent': opts.agent } : {}) } } },
  ));
  open.push({
    async close() {
      await client.close();
      service.httpServer.closeAllConnections?.();
      service.httpServer.close();
      await service.close();
      for (const dir of [memoryDir, authRoot]) fs.rmSync(dir, { recursive: true, force: true });
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const raw = (res.content as Array<{ text: string }>)[0].text;
    return { isError: Boolean(res.isError), raw, body: res.isError ? null : JSON.parse(raw) };
  };
  const read = (rel: string) => fs.readFileSync(path.join(memoryDir, rel), 'utf8');
  const listTools = async () => (await client.listTools()).tools;
  return { call, read, listTools, memoryDir, config };
}

type Workspace = Awaited<ReturnType<typeof startWorkspace>>;

const LEDGER = 'System/Memory Events Ledger.md';
/** Every source the ledger holds, in order, as its `- source:` lines store it. */
const ledgerSources = (ledger: string) => [...ledger.matchAll(/^- source: (.*)$/gm)].map((m) => m[1]);
/** What the dashboard lists as each memory's origin ("by X"), by the memory's own words. */
const mapSources = async (ws: Workspace) =>
  Object.fromEntries(((await ws.call('memory_map')).body.memories as Array<{ title: string; source: string | null }>).map((m) => [m.title, m.source]));

describe('a path sent as the source is stored as the name it ends in, by every tool that takes one', () => {
  it('remember (a note), remember_note, remember (a fact) and save_memory', async () => {
    const ws = await startWorkspace();
    const BOARD = '/home/ana/atlas/BOARD.md';
    const memoryPath = '~/.claude/projects/-home-ana-atlas/memory/t8.md';

    const note = await ws.call('remember', { statement: 'T8 root cause is the cache miss after a resume.', source: BOARD });
    expect(note.isError).toBe(false);
    expect(note.body.mode).toBe('note');
    const line = await ws.call('remember_note', { text: 'Round 3 started.', source: memoryPath });
    expect(line.isError).toBe(false);
    const fact = await ws.call('remember', { statement: 'The board is BOARD.', subject: 'Atlas', predicate: 'board', object: 'BOARD', source: BOARD });
    expect(fact.body).toMatchObject({ mode: 'fact', action: 'store' });
    const saved = await ws.call('save_memory', { subject: 'Atlas', predicate: 'journal', object: 'project:atlas', source: 'C:\\Users\\ana\\atlas\\NOTES.md' });
    expect(saved.body.action).toBe('store');

    // The note headers: no glued path, no directory of the sender's machine.
    const daily = ws.read(note.body.file);
    expect(daily).toMatch(/^- \[\d\d:\d\d:\d\d\] \(BOARD-md\) T8 root cause is the cache miss after a resume\.$/m);
    expect(daily).toMatch(/^- \[\d\d:\d\d:\d\d\] \(t8-md\) Round 3 started\.$/m);
    expect(daily).not.toMatch(/homeana|claudeprojects|Usersana/);

    // What the dashboard lists and reads as the origin is that name.
    expect(await mapSources(ws)).toMatchObject({
      'T8 root cause is the cache miss after a resume.': 'BOARD-md',
      'Round 3 started.': 't8-md',
    });
    const map = (await ws.call('memory_map')).body.memories as Array<{ id: string; title: string }>;
    const entry = map.find((m) => m.title.startsWith('T8 root cause'))!;
    expect((await ws.call('read_memory', { id: entry.id })).body.memory.source).toBe('BOARD-md');
    // The receipt's id is the entry as it was written, so it reads, retires and restores that same entry.
    expect(note.body.id).toBe(entry.id);
    expect((await ws.call('read_memory', { id: note.body.id })).body.memory).toMatchObject({ source: 'BOARD-md', kind: 'entry' });

    // The ledger: the names, and no path.
    const ledger = ws.read(LEDGER);
    expect(ledgerSources(ledger)).toEqual(['BOARD.md', 'NOTES.md']);
    expect(ledger).not.toMatch(/\/home\/ana|Users|\.claude/);
  });

  it('a long path no longer loses the fact it came with', async () => {
    const ws = await startWorkspace();
    const longPath = `/home/ana/${'very-long-directory-name/'.repeat(12)}STATE.md`;
    expect(longPath.length).toBeGreaterThan(256);
    for (const [tool, args] of [
      ['remember', { statement: 'The state file is STATE.', subject: 'Atlas', predicate: 'state_file', object: 'STATE', source: longPath }],
      ['save_memory', { subject: 'Atlas', predicate: 'state_owner', object: 'Builder', source: longPath }],
    ] as const) {
      const saved = await ws.call(tool, args);
      expect(saved.isError, `${tool}: ${saved.raw.slice(0, 200)}`).toBe(false);
      expect(saved.body.action).toBe('store');
    }
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['STATE.md', 'STATE.md']);
  });

  it('a source of any length is cut to 40 characters, and a name with separators keeps its words apart', async () => {
    const ws = await startWorkspace();
    await ws.call('remember_note', { text: 'A very long source.', source: 'x'.repeat(5000) });
    await ws.call('remember_note', { text: 'A plain source.', source: 'Claude Code' });
    await ws.call('remember_note', { text: 'A scoped source.', source: 'mcp:remember' });
    expect(await mapSources(ws)).toEqual({
      'A very long source.': 'x'.repeat(40),
      'A plain source.': 'Claude-Code',
      'A scoped source.': 'mcp-remember',
    });
  });

  it('tells an agent what a source is: the app or agent saving, never a path, and that it can be left out', async () => {
    const ws = await startWorkspace();
    const tools = await ws.listTools();
    for (const name of ['remember', 'remember_note', 'save_memory']) {
      const description = (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { description?: string }>).source.description;
      expect(description, name).toMatch(/Name of the app or agent saving this, for example claude-code/);
      expect(description, name).toMatch(/Leave it out to use the connecting client/);
      expect(description, name).toMatch(/Never a file path or document name/);
    }
  });
});

describe('a write that names no one is saved by the client that made it', () => {
  it('uses the connection key\'s name ahead of the User-Agent, and a read shows that author', async () => {
    const ws = await startWorkspace({ userAgent: CLAUDE_CODE, agent: 'firstmate' });
    await ws.call('save_memory', { subject: 'Atlas', predicate: 'database', object: 'SQLite' });
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['firstmate']);
    const read = await ws.call('retrieve_memory', { subject: 'Atlas' });
    expect(read.body.facts[0].source).toBe('firstmate');
    const map = await ws.call('memory_map');
    expect(map.body.events.some((event: { source?: string }) => event.source === 'firstmate')).toBe(true);
  });

  it('uses the product in the client\'s User-Agent, through every tool that takes a source', async () => {
    const ws = await startWorkspace({ userAgent: CLAUDE_CODE });
    const note = await ws.call('remember', { statement: 'Remembered with no source.' });
    await ws.call('remember_note', { text: 'Noted with no source.' });
    await ws.call('remember', { statement: 'The deploy host is atlas-1.', subject: 'Atlas', predicate: 'deploy_host', object: 'atlas-1' });
    await ws.call('save_memory', { subject: 'Atlas', predicate: 'owner', object: 'Ana' });

    expect(ws.read(note.body.file)).toMatch(/^- \[\d\d:\d\d:\d\d\] \(claude-code\) Remembered with no source\.$/m);
    expect(await mapSources(ws)).toEqual({ 'Remembered with no source.': 'claude-code', 'Noted with no source.': 'claude-code' });
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['claude-code', 'claude-code']);
  });

  it('keeps a source the client names, and takes the client for a source that names no one', async () => {
    const ws = await startWorkspace({ userAgent: CLAUDE_CODE });
    await ws.call('remember_note', { text: 'Said by cursor.', source: 'cursor' });
    for (const [i, blank] of ['', '   ', '/', '!!!', './'].entries()) {
      await ws.call('remember_note', { text: `Blank source ${i}.`, source: blank });
      await ws.call('save_memory', { subject: `Atlas${i}`, predicate: 'p', object: 'o', source: blank });
    }
    const sources = await mapSources(ws);
    expect(sources['Said by cursor.']).toBe('cursor');
    for (let i = 0; i < 5; i++) expect(sources[`Blank source ${i}.`], `blank ${i}`).toBe('claude-code');
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['claude-code', 'claude-code', 'claude-code', 'claude-code', 'claude-code']);
  });

  it('a client that gives no usable name leaves each tool its own default', async () => {
    const ws = await startWorkspace({ userAgent: '(unknown client)' });
    await ws.call('remember', { statement: 'A remember note.' });
    await ws.call('remember_note', { text: 'A daily line.' });
    await ws.call('save_memory', { subject: 'Atlas', predicate: 'p', object: 'o' });
    expect(await mapSources(ws)).toEqual({ 'A remember note.': 'mcp-remember', 'A daily line.': 'mcp' });
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['agent']);
  });

  it('a User-Agent cannot write anything a source name cannot hold', async () => {
    const ws = await startWorkspace({ userAgent: 'x+esc,/1.0 (+https://example.com/BOARD.md)' });
    const note = await ws.call('remember', { statement: 'Saved by a strange client.' });
    expect(ws.read(note.body.file)).toMatch(/^- \[\d\d:\d\d:\d\d\] \(x-esc\) Saved by a strange client\.$/m);
    const other = await startWorkspace({ userAgent: 'evil/1.0 (+https://example.com/BOARD.md)' });
    await other.call('save_memory', { subject: 'Atlas', predicate: 'p', object: 'o' });
    expect(ledgerSources(other.read(LEDGER))).toEqual(['evil']);
  });
});

describe('a URL with credentials leaves them in no file, by every tool that takes a source', () => {
  // Independent review of PR 388, finding P2, over the real hosted tools.
  it('a URL with no host names no one (the client is saved), a URL with a host is its host, and the password is nowhere', async () => {
    const ws = await startWorkspace({ userAgent: CLAUDE_CODE });
    const note = await ws.call('remember_note', { text: 'No host.', source: 'https://user:pass@' });
    await ws.call('remember_note', { text: 'A query.', source: 'https://user:pass@?q=1' });
    await ws.call('remember', { statement: 'A fragment.', source: 'https://user:pass@#frag' });
    await ws.call('remember', { statement: 'Atlas is on port 8080.', subject: 'Atlas', predicate: 'port', object: '8080', source: 'https://user:pass@:8080' });
    await ws.call('save_memory', { subject: 'Atlas', predicate: 'host', object: 'example.com', source: 'https://user:p@ss@example.com/x' });

    expect(await mapSources(ws)).toEqual({ 'No host.': 'claude-code', 'A query.': 'claude-code', 'A fragment.': 'claude-code' });
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['claude-code', 'example.com']);
    for (const file of [note.body.file, LEDGER]) {
      const raw = ws.read(file);
      for (const secret of ['user', 'pass', 'p@ss', 'ss@']) expect(raw, `${file} holds ${JSON.stringify(secret)}`).not.toContain(secret);
    }
  });
});

describe('a URL a browser reads with one separator or none leaves its credentials in no file either', () => {
  // Independent review of PR 388, second round (P2), over the real hosted tools: `https:/user:pass@example.com` and
  // `https:user:pass@example.com` parsed as a path or a plain name, so the whole userinfo reached the ledger.
  it('is its host, a URL with no host names no one, and the password is nowhere', async () => {
    const ws = await startWorkspace({ userAgent: CLAUDE_CODE });
    const note = await ws.call('remember_note', { text: 'One slash.', source: 'https:/user:pass@example.com' });
    await ws.call('remember', { statement: 'No separator.', source: 'https:user:pass@example.com' });
    await ws.call('remember', { statement: 'Atlas deploys over ftp.', subject: 'Atlas', predicate: 'deploy', object: 'ftp', source: 'ftp:/user:pass@' });
    await ws.call('save_memory', { subject: 'Atlas', predicate: 'host', object: 'example.com', source: 'HTTPS:\\user:pass@example.com/x' });

    expect(await mapSources(ws)).toEqual({ 'One slash.': 'example-com', 'No separator.': 'example-com' });
    expect(ledgerSources(ws.read(LEDGER))).toEqual(['claude-code', 'example.com']);
    for (const file of [note.body.file, LEDGER]) {
      const raw = ws.read(file);
      for (const secret of ['user', 'pass']) expect(raw, `${file} holds ${JSON.stringify(secret)}`).not.toContain(secret);
    }
  });
});

describe('a control character in a source no longer loses the save, by every tool that takes one', () => {
  // Independent review of PR 388, P3: a newline in the source made the fact tools fail with "control characters" (the note tools
  // kept the entry). It is dropped, and the save goes on.
  it('drops it from the note header, the ledger and what the dashboard lists', async () => {
    const ws = await startWorkspace({ userAgent: CLAUDE_CODE });
    const note = await ws.call('remember_note', { text: 'A newline in the path.', source: '/home/ana/atlas/BOARD\n.md' });
    const said = await ws.call('remember', { statement: 'A tab in the name.', source: 'Claude\tCode' });
    const fact = await ws.call('remember', { statement: 'The board is BOARD.', subject: 'Atlas', predicate: 'board', object: 'BOARD', source: '/home/ana/atlas/BOARD\n.md' });
    const saved = await ws.call('save_memory', { subject: 'Atlas', predicate: 'journal', object: 'project:atlas', source: 'bad\x00source' });
    const forged = 'poc\n## mem_FORGED1 · 2026-09-09T00:00:00.000Z'; // a source that tries to start an event block of its own
    const hostile = await ws.call('save_memory', { subject: 'Atlas', predicate: 'owner', object: 'Ana', source: forged });
    for (const [name, result] of [['remember_note', note], ['remember (a note)', said], ['remember (a fact)', fact], ['save_memory', saved], ['save_memory (hostile)', hostile]] as const) {
      expect(result.isError, `${name}: ${result.raw.slice(0, 200)}`).toBe(false);
    }
    expect(fact.body).toMatchObject({ mode: 'fact', action: 'store' });
    expect(saved.body.action).toBe('store');

    expect(await mapSources(ws)).toEqual({ 'A newline in the path.': 'BOARD-md', 'A tab in the name.': 'ClaudeCode' });
    const ledger = ws.read(LEDGER);
    expect(ledgerSources(ledger)).toEqual(['BOARD.md', 'badsource', forged.replace(/\n/g, '').slice(0, 40)]);
    expect(ledger.match(/^## mem_/gim)).toHaveLength(3); // one event block per fact: the forged header started none of its own
    for (const file of [note.body.file, LEDGER]) expect(ws.read(file), file).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });
});

describe('entries and events saved before are left exactly as they are', () => {
  // The shapes the old writers made: a note header with a path run together, and a ledger event with the path whole.
  const NOTE = '---\nkind: note\nupdated: 2026-10-05\n---\n# 2026-10-05\n\n- [19:02:11] (homeanaatlasBOARDmd) saved the T8 root cause\n- [19:05:00] (mcpremember) an older note';
  const EVENT = [
    '', '## MEM_OLD0001 · 2026-10-05T19:03:00.000Z', '- kind: store', '- subject: Atlas', '- predicate: board', '- object: BOARD',
    '- source: /home/ana/atlas/BOARD.md', '',
  ].join('\n');
  const LEDGER_HEAD = '---\ntype: memory-ledger\ntitle: Memory Events Ledger\n---\n\n# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.\n';
  const DAILY = 'Memory/Daily/2026-10-05.md';

  it('keeps every byte, still reads them as stored, and appends the new ones clean', async () => {
    const ws = await startWorkspace({ files: { [DAILY]: NOTE, [LEDGER]: LEDGER_HEAD + EVENT } });

    // Boot replayed the old event: the fact is current. Once indexed, the old entries are listed with the origin they were stored with.
    expect((await ws.call('retrieve_memory', { subject: 'Atlas' })).body.facts).toMatchObject([{ predicate: 'board', object: 'BOARD', current: true }]);
    expect((await ws.call('index_memory')).isError).toBe(false);
    expect(await mapSources(ws)).toEqual({ 'saved the T8 root cause': 'homeanaatlasBOARDmd', 'an older note': 'mcpremember' });

    await ws.call('remember_note', { text: 'a new one', date: '2026-10-05', source: '/home/ana/atlas/BOARD.md' });
    await ws.call('remember_note', { text: 'a new one with no source', date: '2026-10-05' });
    await ws.call('remember', { statement: 'The journal is project:atlas.', subject: 'Atlas', predicate: 'journal', object: 'project:atlas', source: '/home/ana/atlas/BOARD.md' });

    const daily = ws.read(DAILY);
    expect(daily.startsWith(NOTE)).toBe(true);
    expect(daily.slice(NOTE.length)).toMatch(/^\n- \[\d\d:\d\d:\d\d\] \(BOARD-md\) a new one\n- \[\d\d:\d\d:\d\d\] \(claude-code\) a new one with no source$/);
    const ledger = ws.read(LEDGER);
    expect(ledger.startsWith(LEDGER_HEAD + EVENT)).toBe(true);
    expect(ledgerSources(ledger)).toEqual(['/home/ana/atlas/BOARD.md', 'BOARD.md']);
    expect(await mapSources(ws)).toEqual({
      'saved the T8 root cause': 'homeanaatlasBOARDmd', 'an older note': 'mcpremember', 'a new one': 'BOARD-md', 'a new one with no source': 'claude-code',
    });
  });
});
