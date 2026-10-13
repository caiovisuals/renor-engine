import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { tmpPath } from '../helpers/tmpPath';
import { renderSession } from '../../scripts/eval/run-longmemeval-product';
import { startStubServer } from './stubRouterModel';
import { LEDGER, QUESTION, SESSIONS } from './fixtureSessions';

/**
 * RENOR_SESSION_ROUTER at the REAL spawned `renor index` / `renor search --json` surface (the benchmark's public entry
 * point), with eval-hash embeddings and a local OpenAI-compatible stub standing in for the router's models: the
 * offline path. No provider is ever called.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), which the suite builds before any test file loads (tests/globalSetup.ts): the
// surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const CLI_TIMEOUT_MS = 120_000;

function seedVault(name: string): string {
  const vault = tmpPath(`router-cli-${name}`);
  fs.mkdirSync(path.join(vault, 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
  for (const session of SESSIONS) {
    const file = path.join(vault, 'Sessions', `${session.id}.md`);
    fs.writeFileSync(file, renderSession(session.id, session.date, session.turns));
    // An imported transcript is written after its May session dates; future claims are now capped at mtime.
    const when = new Date(Date.UTC(2023, 5, 1));
    fs.utimesSync(file, when, when);
  }
  fs.writeFileSync(path.join(vault, LEDGER), '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n');
  return vault;
}

/** Synthetic, credential-free, offline: every key, provider and flag of the runner's own shell is dropped. */
function cliEnv(vault: string, dbPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OLLAMA_|RENOR_|OPENAI_|EMBEDDING_)/.test(key)) delete env[key];
  }
  for (const key of ['VAULT_PATH', 'DB_PATH', 'LLM_EXTRACTION', 'MEMORY_LEDGER']) delete env[key];
  return {
    ...env,
    VAULT_PATH: vault,
    DB_PATH: dbPath,
    EMBEDDING_PROVIDER: 'eval-hash',
    RENOR_SEARCH_EVIDENCE: '0',
    MEMORY_LEDGER: LEDGER,
    ...extra,
  };
}

function stubEnv(baseUrl: string): Record<string, string> {
  return {
    RENOR_EVIDENCE_BASE_URL: baseUrl,
    RENOR_EVIDENCE_API_KEY: 'stub-key',
    RENOR_ROUTER_MODEL: 'stub-router',
    RENOR_ROUTER_SUMMARY_MODEL: 'stub-summary',
    RENOR_ROUTER_RETRIES: '0',
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeout: CLI_TIMEOUT_MS }, (err, stdout, stderr) => resolve({
      code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
}

const summaryStats = (stdout: string) => {
  const line = stdout.split('\n').find(l => l.startsWith('[router] summaries '));
  if (!line) throw new Error(`no router summary line in: ${stdout}`);
  return JSON.parse(line.slice('[router] summaries '.length)) as Record<string, unknown>;
};

describe('renor index/search with RENOR_SESSION_ROUTER (spawned CLI, stub model server)', () => {
  it('off (unset, 0, off): index and search print the same bytes, no router field, no cache file, no model call', async () => {
    const stub = await startStubServer();
    try {
      const vault = seedVault('off');
      const outputs: Array<{ index: string; search: string }> = [];
      for (const [name, value] of [['unset', undefined], ['zero', '0'], ['off', 'off']] as const) {
        const dbPath = tmpPath(`router-cli-off-db-${name}/index.db`);
        // The router's provider settings are present: only the flag decides whether anything happens.
        const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl), ...(value === undefined ? {} : { RENOR_SESSION_ROUTER: value }) });
        const index = await runCli(['index'], env);
        expect(index.code, index.stderr).toBe(0);
        const search = await runCli(['search', '--json', QUESTION], env);
        expect(search.code, search.stderr).toBe(0);
        outputs.push({ index: index.stdout, search: search.stdout });
        expect(fs.existsSync(path.join(path.dirname(dbPath), 'router-cache.db'))).toBe(false);
      }
      expect(outputs[1]).toEqual(outputs[0]);
      expect(outputs[2]).toEqual(outputs[0]);
      expect(Object.keys(JSON.parse(outputs[0].search))).toEqual(['hits']);
      expect(outputs[0].index).not.toContain('[router]');
      expect(stub.calls).toHaveLength(0);
    } finally {
      await stub.close();
    }
  }, 6 * CLI_TIMEOUT_MS);

  it('replace: index writes the summaries, search returns the routed statements with its report, a repeat replays', async () => {
    const stub = await startStubServer();
    try {
      const vault = seedVault('replace');
      const dbPath = tmpPath('router-cli-replace-db/index.db');
      const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl), RENOR_SESSION_ROUTER: 'replace' });
      const index = await runCli(['index'], env);
      expect(index.code, index.stderr).toBe(0);
      expect(summaryStats(index.stdout)).toMatchObject({ model: 'stub-summary', notes: 4, cached: 0, summarized: 4, failed: 0, calls: 1 });
      expect(fs.existsSync(path.join(path.dirname(dbPath), 'router-cache.db'))).toBe(true);

      const first = await runCli(['search', '--json', QUESTION], env);
      expect(first.code, first.stderr).toBe(0);
      const body = JSON.parse(first.stdout) as { hits: Array<{ notePath: string; reason: string; text: string; session_date?: string }>; router: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(['hits', 'router']);
      expect(body.router).toMatchObject({ status: 'ok', mode: 'replace', model: 'stub-router', summaryModel: 'stub-summary', nodes: 4, fromCache: false });
      expect(body.hits.map(hit => path.basename(hit.notePath))).toEqual(['sess-cats-3.md', 'sess-cats-1.md']);
      // A note is named by its path below the vault, in the hits and in the router's report alike: no host path.
      const routed = (body.router as { routed: Array<{ notePath: string }> }).routed;
      expect(routed.length).toBeGreaterThan(0);
      for (const notePath of [...body.hits, ...routed].map(entry => entry.notePath)) {
        expect(path.isAbsolute(notePath), notePath).toBe(false);
        expect(fs.existsSync(path.join(vault, notePath)), notePath).toBe(true);
      }
      expect(body.hits.every(hit => hit.reason === 'router')).toBe(true);
      expect(body.hits[0].session_date).toBe('2023/05/20 (Sat) 09:15');
      expect(body.hits[1].text).toContain('### Turn 3 — User\n\nThanks! Miso is three years old.');
      expect(body.hits.some(hit => hit.text.includes('Here is a detailed answer'))).toBe(false);

      const routeCalls = () => stub.calls.filter(call => call.kind === 'route');
      expect(routeCalls()).toHaveLength(1);
      expect(routeCalls()[0].body).toMatchObject({
        model: 'stub-router', temperature: 0, max_tokens: 4096, response_format: { type: 'json_object' },
      });
      expect(stub.calls.filter(call => call.kind === 'summary')[0].body).toMatchObject({ model: 'stub-summary', max_tokens: 6000 });

      const second = await runCli(['search', '--json', QUESTION], env);
      expect(JSON.parse(second.stdout).router).toMatchObject({ status: 'ok', fromCache: true });
      expect(routeCalls()).toHaveLength(1);

      // A rebuild re-indexes from scratch, but no note changed: no summary is paid for twice.
      const rebuild = await runCli(['rebuild'], env);
      expect(rebuild.code, rebuild.stderr).toBe(0);
      expect(summaryStats(rebuild.stdout)).toMatchObject({ notes: 4, cached: 4, summarized: 0, calls: 0 });
      expect(stub.calls.filter(call => call.kind === 'summary')).toHaveLength(1);
    } finally {
      await stub.close();
    }
  }, 6 * CLI_TIMEOUT_MS);

  it('armed without a provider: index refuses, search steps aside (no-model) with exactly the unrouted hits', async () => {
    const vault = seedVault('no-provider');
    const dbPath = tmpPath('router-cli-no-provider-db/index.db');
    const onEnv = cliEnv(vault, dbPath, { RENOR_SESSION_ROUTER: '1' });
    const offEnv = cliEnv(vault, dbPath);
    const refused = await runCli(['index'], onEnv);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('[router] armed without a provider');
    expect(refused.stdout).not.toContain('Indexing:'); // refused before indexing anything

    expect((await runCli(['index'], offEnv)).code).toBe(0);
    const off = JSON.parse((await runCli(['search', '--json', QUESTION], offEnv)).stdout);
    const on = JSON.parse((await runCli(['search', '--json', QUESTION], onEnv)).stdout);
    expect(on.router).toMatchObject({ status: 'skipped', reason: 'no-model' });
    expect(on.hits).toEqual(off.hits);
  }, 5 * CLI_TIMEOUT_MS);

  it('a note the model could not summarise fails the index, and search falls back (summaries-incomplete)', async () => {
    const stub = await startStubServer({ summary: 'http-500' });
    try {
      const vault = seedVault('summary-failure');
      const dbPath = tmpPath('router-cli-summary-failure-db/index.db');
      const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl), RENOR_SESSION_ROUTER: 'replace' });
      const index = await runCli(['index'], env);
      expect(index.code).toBe(1);
      expect(index.stdout).toMatch(/Done\. (\d+)\/\1 indexed, 0 errors\./); // the notes themselves indexed
      expect(summaryStats(index.stdout)).toMatchObject({ notes: 4, summarized: 0, failed: 4 });
      expect(index.stderr).toContain('4 note(s) left without a summary');

      const off = JSON.parse((await runCli(['search', '--json', QUESTION], cliEnv(vault, dbPath))).stdout);
      const on = JSON.parse((await runCli(['search', '--json', QUESTION], env)).stdout);
      expect(on.router).toMatchObject({ status: 'skipped', reason: 'summaries-incomplete', nodes: 4, missingSummaries: 4 });
      expect(on.hits).toEqual(off.hits);
      expect(stub.calls.filter(call => call.kind === 'route')).toHaveLength(0);
    } finally {
      await stub.close();
    }
  }, 4 * CLI_TIMEOUT_MS);
});
