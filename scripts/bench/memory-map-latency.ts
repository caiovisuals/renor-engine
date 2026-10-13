/**
 * Model-free memory_map benchmark through the registered MCP tool. Run from the repository root:
 *
 *   mise exec node@22 -- node --import ./engine/node_modules/tsx/dist/loader.mjs \
 *     engine/scripts/bench/memory-map-latency.ts .gate/latency/before.json before [--profile] [--whole]
 *
 * Reuse the same generated fixture between arms. It contains 60 daily notes (17 entries each),
 * 30 ordinary notes and 1,000 lifecycle facts, indexed through index_memory without embeddings.
 * This tool never embeds or extracts: injecting a null provider accurately exercises memory_map,
 * whose implementation uses only note files and the existing index. No live workspace is read.
 *
 * Forty measured calls per case follow three warm calls. The complete response, including its
 * timestamp, is byte-stable because the clock is frozen; no returned field is removed or normalised.
 * Profile runs diagnose stages and should not supply headline timings. On a shared laptop,
 * alternate baseline and candidate processes and use the unchanged lookups as load controls.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMvpApp } from '../../src/mvp/server';
import { loadMvpConfig } from '../../src/mvp/config';
import { withBenchEnv, stat } from './mcp-latency';
import { CpuProfile } from './cpu-profile';

const output = process.argv[2];
if (!output)
  throw new Error('usage: memory-map-latency.ts <output.json> <label> [--profile] [--whole]');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const root = path.join(REPO_ROOT, '.gate/latency/fixture-v3');
const frozen = Date.UTC(2026, 9, 7, 12);
const RealDate = Date;
const date = (i: number) => new RealDate(frozen - i * 86400000).toISOString().slice(0, 10);

async function main() {
  await withBenchEnv(false, 'default', async () => {
    const memoryDir = path.join(root, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'auth'), { recursive: true, mode: 0o700 });
    Object.assign(process.env, {
      MVP_MEMORY_DIR: memoryDir,
      MVP_AUTH_STATE_PATH: path.join(root, 'auth', 'clients.json'),
      MVP_BASE_URL: 'http://127.0.0.1:1',
      MVP_OWNER_EMAIL: 'bench@example.test',
      MVP_OWNER_PASSWORD: 'synthetic-bench-secret-123',
      MVP_PORT: '1',
      MVP_ALLOWED_CALLBACK_URIS: 'http://127.0.0.1:1/callback',
    });
    const app = createMvpApp(loadMvpConfig(), null);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await app.server.connect(st);
    const client = new Client({ name: 'map-latency', version: '0' });
    await client.connect(ct);
    try {
      if (!fs.existsSync(path.join(root, 'ready'))) {
        for (let i = 0; i < 60; i++) {
          const rel = `Memory/Daily/${date(i)}.md`;
          const file = path.join(memoryDir, rel);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          let body = `# ${date(i)}\n\n`;
          for (let j = 0; j < 17; j++) {
            const n = i * 17 + j;
            body += `- [12:${String(j).padStart(2, '0')}:00] (bench) Project ${n % 250} uses Service ${(n + 1) % 250}. Review the gateway release, deploy configuration, memory export and privacy policy. The maintenance schedule includes latency checks and documentation updates for Project ${(n + 7) % 250}.\n\n`;
          }
          fs.writeFileSync(file, body);
        }
        for (let i = 0; i < 30; i++) {
          const file = path.join(memoryDir, `Notes/Plan-${i}.md`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(
            file,
            `---\ntags: [operations, planning]\n---\n# Plan ${i}\n\nProject ${i} integrates with Service ${i}. [[Plan-${(i + 1) % 30}]]\n\n## Deployment\nReview the gateway release and maintain the documentation.\n\n## Follow-up\nMonitor the latency budget and protect memory exports.\n`,
          );
        }
        for (let i = 0; i < 1000; i++) {
          const subject = `${i % 2 ? 'Service' : 'Project'} ${Math.floor(i / 2) % 125}`;
          const res = await client.callTool({
            name: 'save_memory',
            arguments: {
              subject,
              predicate: `relation_${Math.floor(i / 250)}`,
              object: `Project ${(i + 1) % 125} works with Service ${(i + 7) % 125}`,
              valid_from: `${date(2)}T12:00:00Z`,
            },
          });
          if (res.isError) throw Error(JSON.stringify(res.content));
        }
        const indexed = await client.callTool({ name: 'index_memory', arguments: {} });
        if (indexed.isError) throw Error(JSON.stringify(indexed.content));
        fs.writeFileSync(path.join(root, 'ready'), '1');
      }
      // Freeze the map's timestamp, with no response normalisation.
      globalThis.Date = class extends RealDate {
        constructor(v?: any) {
          super(v === undefined ? frozen : v);
        }
        static now() {
          return frozen;
        }
      } as DateConstructor;
      const cases = [{}, { limit: 20 }, { query: 'Project 7' }, { query: 'Service 12', limit: 3 }];
      const results: any = {
        shape: {},
        cases: [],
        label: process.argv[3],
        embeddingProvider: 'none (unused by memory_map)',
        sourceSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(REPO_ROOT, 'engine/src/memorymap/memoryMap.ts')))
          .digest('hex'),
      };
      for (const table of ['notes', 'chunks', 'facts', 'entities'])
        results.shape[table] = app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      let profile: CpuProfile | null = null;
      if (process.argv.includes('--profile')) profile = await CpuProfile.start();
      for (const args of process.argv.includes('--whole') ? cases.slice(0, 1) : cases) {
        const samples: number[] = [],
          cpu: number[] = [];
        let digest = '';
        let bytes = 0;
        for (let i = -3; i < 40; i++) {
          const c0 = process.cpuUsage(),
            t0 = performance.now();
          const res = await client.callTool({ name: 'memory_map', arguments: args });
          const ms = performance.now() - t0,
            used = process.cpuUsage(c0);
          if (res.isError) throw Error(JSON.stringify(res.content));
          const text = (res.content as any)[0].text;
          const d = crypto.createHash('sha256').update(text).digest('hex');
          if (digest && digest !== d) throw Error('nondeterministic map');
          digest = d;
          bytes = Buffer.byteLength(text);
          if (i >= 0) {
            samples.push(ms);
            cpu.push((used.user + used.system) / 1000);
          }
        }
        results.cases.push({
          args,
          wall: stat(samples),
          cpu: stat(cpu),
          samples,
          cpuSamples: cpu,
          digest,
          bytes,
        });
      }
      if (profile) fs.writeFileSync(`${output}.cpuprofile`, JSON.stringify(await profile.stop()));
      fs.writeFileSync(output, JSON.stringify(results, null, 2));
      console.log(
        JSON.stringify(
          { ...results, cases: results.cases.map(({ samples, cpuSamples, ...x }: any) => x) },
          null,
          2,
        ),
      );
    } finally {
      globalThis.Date = RealDate;
      await client.close();
      await app.close();
    }
  });
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
