/**
 * Model-free benchmark of idempotent structured remember through the registered MCP tool.
 * Run from the repository root under nice 19, one process at a time:
 *
 *   mise exec node@22 -- node --import ./engine/node_modules/tsx/dist/loader.mjs \
 *     engine/scripts/bench/remember-repeat-latency.ts .gate/latency-2/arm.json label [--profile] [--context] [--conflicts]
 *
 * Builds/reuses an isolated synthetic fixture: 90 notes, 1,000 scoped/global facts and two
 * statements. A repeat returns nochange before indexing or embedding. Query-omitted
 * get_context is a control that does not embed either. The injected provider is null;
 * no local model, synthetic vector, paid call or real workspace is used.
 *
 * Compare A B A B processes on the same persisted fixture and frozen response clock.
 * Each case has 50 warm calls and 200 measured calls. CPU/wall timers stay real, complete
 * replies are hashed without normalization, and load plus product source hash are recorded.
 * --context records agentMemory.ts provenance and profiles query-omitted get_context.
 * --conflicts uses a separate fixture with conflicting global/named-scope values.
 * Profiles diagnose stages separately; do not use their timings as headline measurements.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMvpApp } from '../../src/mvp/server';
import { loadMvpConfig } from '../../src/mvp/config';
import { withBenchEnv, stat } from './mcp-latency';
import { CpuProfile } from './cpu-profile';

const output = process.argv[2];
if (!output) throw new Error('usage: remember-repeat-latency.ts <output.json> <label> [--profile] [--context] [--conflicts]');
const repo = path.resolve(__dirname, '../../..');
const context = process.argv.includes('--context');
const conflicts = process.argv.includes('--conflicts');
const root = path.join(repo, conflicts ? '.gate/latency-3/conflict-fixture' : '.gate/latency-2/fixture');
const productSource = context ? 'engine/src/mvp/agentMemory.ts' : 'engine/src/memory/lifecycle.ts';
const RealDate = Date;
const frozen = Date.UTC(2026, 9, 7, 12);

function notes(memoryDir: string): void {
  for (let i = 0; i < 60; i++) {
    const day = new RealDate(frozen - i * 86400000).toISOString().slice(0, 10);
    const file = path.join(memoryDir, `Memory/Daily/${day}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = `# ${day}\n\n`;
    for (let j = 0; j < 17; j++) {
      const n = i * 17 + j;
      body += `- [12:${String(j).padStart(2, '0')}:00] (bench) Project ${n % 250} uses Service ${(n + 1) % 250}. Review the gateway release, deploy configuration, memory export and privacy policy. The maintenance schedule includes latency checks and documentation updates for Project ${(n + 7) % 250}.\n\n`;
    }
    fs.writeFileSync(file, body);
  }
  for (let i = 0; i < 30; i++) {
    const file = path.join(memoryDir, `Notes/Plan-${i}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ntags: [operations, planning]\n---\n# Plan ${i}\n\nProject ${i} integrates with Service ${i}. [[Plan-${(i + 1) % 30}]]\n\n## Deployment\nReview the gateway release and maintain the documentation.\n\n## Follow-up\nMonitor the latency budget and protect memory exports.\n`);
  }
}

const fact = (i: number) => ({
  subject: `Project ${i % 250}`,
  predicate: `status_${Math.floor(i / 250)}`,
  object: `Service ${i % 125}`,
  scope: i % 2 ? 'project:renor' : 'global',
});

async function main() {
  await withBenchEnv(false, 'default', async () => {
    const memoryDir = path.join(root, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'auth'), { recursive: true, mode: 0o700 });
    Object.assign(process.env, {
      MVP_MEMORY_DIR: memoryDir,
      MVP_AUTH_STATE_PATH: path.join(root, 'auth/clients.json'),
      MVP_BASE_URL: 'http://127.0.0.1:1',
      MVP_OWNER_EMAIL: 'bench@example.test',
      MVP_OWNER_PASSWORD: 'synthetic-bench-secret-123',
      MVP_PORT: '1',
      MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    });
    const app = createMvpApp(loadMvpConfig(), null);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await app.server.connect(st);
    const client = new Client({ name: 'repeat-latency', version: '0' });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) throw new Error(JSON.stringify(response.content));
      return response;
    };
    try {
      if (!fs.existsSync(path.join(root, 'ready'))) {
        notes(memoryDir);
        for (let i = 0; i < 1000; i++) await call('save_memory', fact(i));
        await call('index_memory', {});
        for (let i = 0; i < 2; i++) {
          await call('remember', { ...fact(i), statement: `Project ${i} uses Service ${i}.` });
        }
        fs.writeFileSync(path.join(root, 'ready'), '1');
      }
      if (conflicts) {
        await call('save_memory', { subject: 'Project 1', predicate: 'status_0', object: 'Other service', scope: 'global' });
      }
      globalThis.Date = class extends RealDate {
        constructor(v?: any) { super(v === undefined ? frozen : v); }
        static now() { return frozen; }
      } as DateConstructor;
      const cases = [
        { name: 'remember', args: { ...fact(1), statement: 'Project 1 uses Service 1.' } },
        { name: 'remember', args: { ...fact(0), statement: 'Project 0 uses Service 0.' } },
        { name: 'get_context', args: { scope: 'project:renor' } },
        { name: 'get_context', args: {} },
      ];
      const result: any = {
        label: process.argv[3],
        node: process.version,
        loadStart: os.loadavg(),
        shape: {},
        embeddingProvider: 'none (nochange and query-omitted reads do not embed)',
        productSource,
        sourceSha256: crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(repo, productSource))).digest('hex'),
        cases: [],
      };
      for (const table of ['notes', 'chunks', 'facts', 'entities']) {
        result.shape[table] = app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      }
      let profile: CpuProfile | null = null;
      if (process.argv.includes('--profile')) profile = await CpuProfile.start();
      for (const c of profile ? cases.slice(context ? 2 : 0, context ? 3 : 1) : cases) {
        const wall: number[] = [], cpu: number[] = [];
        let digest = '';
        for (let i = -50; i < 200; i++) {
          const c0 = process.cpuUsage(), t0 = performance.now();
          const response = await call(c.name, c.args);
          const elapsed = performance.now() - t0, used = process.cpuUsage(c0);
          const current = crypto.createHash('sha256').update(JSON.stringify(response)).digest('hex');
          if (digest && digest !== current) throw new Error('nondeterministic complete reply');
          digest = current;
          if (i >= 0) {
            wall.push(elapsed);
            cpu.push((used.user + used.system) / 1000);
          }
        }
        result.cases.push({ ...c, wall: stat(wall), cpu: stat(cpu), wallSamples: wall, cpuSamples: cpu, digest });
      }
      if (profile) fs.writeFileSync(`${output}.cpuprofile`, JSON.stringify(await profile.stop()));
      result.loadEnd = os.loadavg();
      fs.writeFileSync(output, JSON.stringify(result, null, 2));
      console.log(JSON.stringify({
        ...result, cases: result.cases.map(({ wallSamples, cpuSamples, ...c }: any) => c),
      }, null, 2));
    } finally {
      globalThis.Date = RealDate;
      await client.close();
      await app.close();
    }
  });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
