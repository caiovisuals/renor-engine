/**
 * Save latency at 1x, 4x and 16x of one workspace, through the real `remember` MCP tool, with the eval-hash stub.
 *
 *   npx tsx scripts/bench/save-scale.ts build   --cache <dir> --scale 1          (then 4, then 16)
 *   npx tsx scripts/bench/save-scale.ts measure --cache <dir> --scale 1 --workload note --saves 20 --label after --out raw.jsonl
 *       [--cpu-profile out.cpuprofile]   a V8 profile of the timed saves only (see cpu-profile.ts); never combine with timing
 *   npx tsx scripts/bench/save-scale.ts summarize raw.jsonl [more.jsonl ...]
 *
 * One unit of workspace (1x) is 50 topic notes, 10 past days of engine-written daily notes (5 entries each) and a
 * ledger of 250 fact saves over 100 subjects (5 predicates), each with its statement, as `remember` writes them;
 * 4x and 16x multiply every count. Notes come from a seeded PRNG: no real data. `build` makes the workspace and
 * indexes it in full once; `measure` restores it to the same path (the index holds absolute paths, so run one
 * measurement per cache at a time), starts the MCP service in process with a counting hash provider, waits out the
 * clock tick the engine distrusts a fresh file's stamp within, warms up (the first save in a process verifies every
 * file once), and then calls `remember` for real:
 *   note   every save is a note-mode `remember` (statement only);
 *   fact   every save is a fact-mode `remember`: a new value for a subject the workspace holds (a supersession);
 *   mixed  a fact save then a note save, over and over.
 * Each save records wall and CPU time, the texts it embedded and the Markdown files it read. Wall time on a shared
 * host is noisy: compare CPU time, and interleave the arms (old tree, new tree) and the sizes. To measure another
 * tree, export it (`git archive <ref> engine | tar -x -C /tmp/old`, symlink this engine's node_modules into it), copy
 * this script into it, and build its own cache there: a workspace built by one tree is measured by that tree.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { startMvpService, MVP_MCP_PATH } from '../../src/mvp/server';
import { attachEngine, engineIndex, engineRememberNote } from '../../src/mvp/engine';
import { remember } from '../../src/memory/lifecycle';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { CpuProfile } from './cpu-profile';

const UNIT = { topics: 50, days: 10, entriesPerDay: 5, events: 250, subjects: 100 };
const PREDICATES = ['status', 'owner', 'prefers', 'location', 'deadline'];
const WORDS = ('memory agent context ledger index recall query vector chunk heading project decision '
  + 'deploy release gateway tenant billing latency embedding schema migration review retry budget '
  + 'preference runtime editor terminal database webhook queue cache token session workspace').split(' ');
const OWNER_EMAIL = 'owner@example.test';
const OWNER_PASSWORD = 'synthetic-bench-secret-123';
/** A little over the engine's clock tick (2 s): the restored files are older than it by the first save. */
const CLOCK_TICK_WAIT_MS = 2_100;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sentence = (r: () => number, n: number) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
const subjectName = (i: number) => `${WORDS[i % WORDS.length]} ${WORDS[Math.floor(i / WORDS.length) % WORDS.length]} ${i}`;

/** Counts what it is asked to embed. */
class Counting extends EvalHashEmbeddingProvider {
  texts = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.texts += texts.length;
    return super.embed(texts);
  }
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = log; });
}

function configFor(memoryDir: string, port = 9): MvpConfig {
  Object.assign(process.env, {
    MVP_MEMORY_DIR: memoryDir,
    MVP_BASE_URL: `http://127.0.0.1:${port}`,
    MVP_PORT: String(port),
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    MVP_AUTH_STATE_PATH: path.join(path.dirname(memoryDir), 'auth', 'clients.json'),
  });
  for (const k of ['MVP_DB_PATH', 'MVP_EMBEDDING_PROVIDER', 'EMBEDDING_PROVIDER']) delete process.env[k];
  return loadMvpConfig();
}

async function build(memoryDir: string, scale: number) {
  const r = rng(1);
  const sections = ['Projects', 'Areas', 'Notes', 'Reference'];
  for (let i = 0; i < UNIT.topics * scale; i++) {
    const file = path.join(memoryDir, sections[i % sections.length], `topic-${String(i).padStart(5, '0')}.md`);
    const link = `topic-${String(Math.floor(r() * UNIT.topics * scale)).padStart(5, '0')}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      `---\nkind: note\ntags: [${WORDS[i % WORDS.length]}, ${WORDS[(i * 7) % WORDS.length]}]\n---`,
      `# Topic ${i} ${sentence(r, 3)}`,
      `${sentence(r, 40)} [[${link}]].`,
      `## Details\n${sentence(r, 60)}`,
      `## Decisions\n- ${sentence(r, 12)}\n- ${sentence(r, 12)}`,
    ].join('\n\n'));
  }
  const config = configFor(memoryDir);
  for (let d = 0; d < UNIT.days * scale; d++) {
    const day = new Date(Date.UTC(2025, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
    for (let e = 0; e < UNIT.entriesPerDay; e++) await engineRememberNote(config, `Seed day ${day} entry ${e}: ${sentence(r, 16)}`, day, 'seed');
  }
  const db = openDb(config.dbPath);
  runMigrations(db);
  const engine = attachEngine(db, config, new Counting()); // before anything is indexed: the index records this model
  const subjects = UNIT.subjects * scale;
  await quiet(async () => {
    for (let i = 0; i < UNIT.events * scale; i++) {
      const subject = subjectName(i % subjects);
      const predicate = PREDICATES[Math.floor(i / subjects) % PREDICATES.length];
      const object = `${sentence(r, 2)} ${i}`;
      await remember(db, config.memoryDir, config.ledgerRelPath, {
        subject, predicate, object, source: 'seed', statement: `Seeded statement ${i}: ${subject} ${predicate} ${object}.`,
      });
    }
    await engineIndex(db, config, engine);
  });
  const counts = {
    files: (await fsp.readdir(memoryDir, { recursive: true })).filter((f) => String(f).endsWith('.md')).length,
    chunks: db.prepare('SELECT COUNT(*) FROM chunks').pluck().get(),
    facts: db.prepare("SELECT COUNT(*) FROM facts WHERE source_path = '_mcp_'").pluck().get(),
    subjects: db.prepare("SELECT COUNT(*) FROM entities WHERE source_note = '_mcp_'").pluck().get(),
    ledgerBytes: fs.statSync(path.join(memoryDir, config.ledgerRelPath)).size,
  };
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return counts;
}

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

async function accessToken(app: Parameters<typeof request>[0]) {
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await request(app).post('/register')
    .send({ client_name: 'save-scale-bench', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'] }).expect(201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = await request(app).get('/authorize').query({
    client_id: reg.body.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).expect(200);
  const ticket = authorize.text.match(/name="ticket" value="([^"]+)"/)?.[1];
  const login = await request(app).post('/mvp-login').type('form')
    .send({ ticket, approve: 'on', email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(302);
  const code = new URL(login.headers.location, 'http://x').searchParams.get('code');
  const tokens = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: reg.body.client_id, client_secret: reg.body.client_secret, code_verifier: verifier,
  }).expect(200);
  return tokens.body.access_token as string;
}

const parse = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);

async function measure(a: Record<string, string>) {
  const scale = Number(a.scale);
  const saves = Number(a.saves ?? 20);
  const warmup = Number(a.warmup ?? 3);
  const root = path.join(a.cache, 'work', `x${scale}`);
  const memoryDir = path.join(root, 'memory');
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(path.join(a.cache, 'pristine', `x${scale}`), memoryDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true, mode: 0o700 });
  const port = await freePort();
  const config = configFor(memoryDir, port);
  const provider = new Counting();
  const started = await quiet(() => startMvpService(config, provider));
  const client = new Client({ name: 'save-scale-bench', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MVP_MCP_PATH, `http://127.0.0.1:${port}`), {
    requestInit: { headers: { Authorization: `Bearer ${await accessToken(started.app)}` } },
  }));
  await new Promise((resolve) => setTimeout(resolve, CLOCK_TICK_WAIT_MS));

  const r = rng(1000 + scale);
  let n = 0;
  const reads: string[] = [];
  const readFile = fsp.readFile;
  (fsp as { readFile: unknown }).readFile = ((p: unknown, ...more: unknown[]) => {
    if (String(p).endsWith('.md')) reads.push(path.relative(memoryDir, String(p)));
    return (readFile as (...args: unknown[]) => unknown)(p, ...more);
  }) as typeof fsp.readFile;
  const note = async () => parse(await client.callTool({
    name: 'remember', arguments: { statement: `Bench note ${n++}: ${sentence(r, 14)}`, source: 'bench' },
  }));
  const fact = async () => {
    const i = n++;
    const subject = subjectName(Math.floor(r() * UNIT.subjects * scale));
    const predicate = PREDICATES[Math.floor(r() * PREDICATES.length)];
    return parse(await client.callTool({
      name: 'remember',
      arguments: { statement: `Bench fact ${i}: ${subject} ${predicate} bench value ${i}.`, subject, predicate, object: `bench value ${i}`, source: 'bench' },
    }));
  };
  const steps = a.workload === 'note' ? [note] : a.workload === 'fact' ? [fact] : [fact, note];
  const rows: Array<Record<string, unknown>> = [];
  let cpuProfile: CpuProfile | null = null;
  try {
    for (let i = 0; i < warmup + saves; i++) {
      if (i === warmup && a['cpu-profile']) cpuProfile = await CpuProfile.start();
      for (const step of steps) {
        reads.length = 0;
        const texts0 = provider.texts;
        const cpu0 = process.cpuUsage();
        const t0 = performance.now();
        const receipt = await step();
        const wallMs = performance.now() - t0;
        const cpu = process.cpuUsage(cpu0);
        if (!receipt.ok || (receipt.mode === 'note' && receipt.indexed !== true) || receipt.warning) {
          throw new Error(`save failed: ${JSON.stringify(receipt)}`);
        }
        if (i < warmup) continue;
        rows.push({ mode: receipt.mode, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, texts: provider.texts - texts0, reads: reads.length });
      }
    }
  } finally {
    if (cpuProfile) fs.writeFileSync(a['cpu-profile'], JSON.stringify(await cpuProfile.stop()));
    (fsp as { readFile: unknown }).readFile = readFile;
    await client.close();
    await started.close();
    started.httpServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.appendFileSync(a.out, `${JSON.stringify({ label: a.label, scale, workload: a.workload, node: process.version, load1: os.loadavg()[0], rows })}\n`);
}

function summarize(files: string[]) {
  const groups = new Map<string, Array<Record<string, number>>>();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const run = JSON.parse(line) as { label: string; scale: number; workload: string; rows: Array<Record<string, number> & { mode: string }> };
      for (const row of run.rows) {
        const key = `${run.workload}\t${row.mode}\t${String(run.scale).padStart(3, '0')}\t${run.label}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
    }
  }
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)];
  const out = ['| workload | save | scale | arm | saves | CPU median ms | wall median ms | wall p95 ms | texts/save | files read/save |', '|---|---|---:|---|---:|---:|---:|---:|---:|---:|'];
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key)!;
    const [workload, mode, scale, label] = key.split('\t');
    const col = (k: string) => rows.map((row) => row[k]);
    out.push(`| ${workload} | ${mode} | ${Number(scale)}x | ${label} | ${rows.length} | ${median(col('cpuMs')).toFixed(1)} | ${median(col('wallMs')).toFixed(1)} | ${p95(col('wallMs')).toFixed(1)} | ${Math.max(...col('texts'))} | ${Math.max(...col('reads'))} |`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'summarize') return summarize(rest);
  const a: Record<string, string> = { workload: 'note', label: 'current' };
  for (let i = 0; i < rest.length; i += 2) a[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (command === 'build') {
    const scale = Number(a.scale);
    const pristine = path.join(a.cache, 'pristine', `x${scale}`);
    const memoryDir = path.join(a.cache, 'work', `x${scale}`, 'memory');
    fs.rmSync(path.dirname(memoryDir), { recursive: true, force: true });
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    const counts = await build(memoryDir, scale);
    fs.mkdirSync(path.dirname(pristine), { recursive: true });
    fs.cpSync(memoryDir, pristine, { recursive: true }); // measure restores it to memoryDir, the path its index names
    fs.rmSync(path.dirname(memoryDir), { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ scale, ...counts })}\n`);
    return;
  }
  if (command === 'measure') return measure(a);
  throw new Error('usage: save-scale.ts build|measure|summarize ...');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
