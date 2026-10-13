import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { encode } from 'gpt-tokenizer';
import { tmpPath } from '../helpers/tmpPath';
import { renderSession } from '../../scripts/eval/run-longmemeval-product';
import { LEDGER, QUESTION, SESSIONS } from '../router/fixtureSessions';
import { startDigestStub } from './stubDigestModel';

/**
 * RENOR_DIGESTS at the REAL spawned `renor index` / `renor search --json` surface, with eval-hash embeddings and a local
 * OpenAI-compatible stub standing in for the digest model: the offline path. No provider is ever called.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), which the suite builds before any test file loads (tests/globalSetup.ts): the
// surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const CLI_TIMEOUT_MS = 120_000;

function seedVault(name: string, extra: Array<{ id: string; date: string; text: string }> = []): string {
  const vault = tmpPath(`digests-cli-${name}`);
  fs.mkdirSync(path.join(vault, 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'System'), { recursive: true });
  const when = new Date(Date.UTC(2023, 4, 1));
  for (const session of SESSIONS) {
    const file = path.join(vault, 'Sessions', `${session.id}.md`);
    fs.writeFileSync(file, renderSession(session.id, session.date, session.turns));
    fs.utimesSync(file, when, when);
  }
  for (const note of extra) {
    const file = path.join(vault, 'Sessions', `${note.id}.md`);
    fs.writeFileSync(file, renderSession(note.id, note.date, [{ role: 'user', content: note.text }]));
    fs.utimesSync(file, when, when);
  }
  fs.writeFileSync(path.join(vault, LEDGER), '---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n');
  return vault;
}

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

const stubEnv = (baseUrl: string, cache: string): Record<string, string> => ({
  RENOR_DIGEST_BASE_URL: baseUrl,
  RENOR_DIGEST_API_KEY: 'stub-key',
  RENOR_DIGEST_MODEL: 'stub-digest',
  RENOR_DIGEST_RETRIES: '0',
  RENOR_DIGEST_CACHE: cache,
});

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeout: CLI_TIMEOUT_MS }, (err, stdout, stderr) => resolve({
      code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
}

const digestStats = (stdout: string) => {
  const line = stdout.split('\n').find(l => l.startsWith('[digests] '));
  if (!line) throw new Error(`no digest line in: ${stdout}`);
  return JSON.parse(line.slice('[digests] '.length)) as Record<string, unknown>;
};

type SearchBody = {
  hits: Array<{ notePath: string; reason: string; text: string }>;
  digest?: { status: string; reason?: string; windowNotes: number; notesWithDigest: number; itemsRendered: number; tokens: number; text: string; items: Array<{ notePath: string; source: string; item: string }> };
};

describe('renor index/search with RENOR_DIGESTS (spawned CLI, stub model server)', () => {
  it('off (unset, 0, off): index and search print the same bytes, no digest field, no cache file, no model call', async () => {
    const stub = await startDigestStub();
    try {
      const vault = seedVault('off');
      const outputs: Array<{ index: string; search: string }> = [];
      for (const [name, value] of [['unset', undefined], ['zero', '0'], ['off', 'off']] as const) {
        const dbPath = tmpPath(`digests-cli-off-db-${name}/index.db`);
        const cache = tmpPath(`digests-cli-off-cache-${name}/digest-cache.db`);
        const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl, cache), ...(value === undefined ? {} : { RENOR_DIGESTS: value }) });
        const index = await runCli(['index'], env);
        expect(index.code, index.stderr).toBe(0);
        const search = await runCli(['search', '--json', QUESTION], env);
        expect(search.code, search.stderr).toBe(0);
        outputs.push({ index: index.stdout, search: search.stdout });
        expect(fs.existsSync(cache)).toBe(false);
        expect(fs.existsSync(path.join(path.dirname(dbPath), 'digest-cache.db'))).toBe(false);
      }
      expect(outputs[1]).toEqual(outputs[0]);
      expect(outputs[2]).toEqual(outputs[0]);
      expect(Object.keys(JSON.parse(outputs[0].search))).toEqual(['hits']);
      expect(outputs[0].index).not.toContain('[digests]');
      expect(stub.calls).toHaveLength(0);
    } finally {
      await stub.close();
    }
  }, 6 * CLI_TIMEOUT_MS);

  it('on: index writes the digests with one batched call; search adds the table with no model call; a repeat replays', async () => {
    const stub = await startDigestStub();
    try {
      const vault = seedVault('on');
      const dbPath = tmpPath('digests-cli-on-db/index.db');
      const cache = tmpPath('digests-cli-on-cache/digest-cache.db');
      const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl, cache), RENOR_DIGESTS: '1' });
      const index = await runCli(['index'], env);
      expect(index.code, index.stderr).toBe(0);
      expect(digestStats(index.stdout)).toMatchObject({ model: 'stub-digest', notes: 4, cached: 0, digested: 4, failed: 0, calls: 1, skippedUncached: 0 });
      expect(fs.existsSync(cache)).toBe(true);
      expect(stub.calls).toHaveLength(1);
      // The shipped request shape: temperature 0, a bounded answer and a low reasoning effort.
      expect(stub.calls[0].body).toMatchObject({ model: 'stub-digest', temperature: 0, reasoning_effort: 'low', max_tokens: 8000 });

      const control = await runCli(['search', '--json', QUESTION], cliEnv(vault, dbPath));
      const callsBeforeSearch = stub.calls.length;
      const search = await runCli(['search', '--json', QUESTION], env);
      expect(search.code, search.stderr).toBe(0);
      expect(stub.calls).toHaveLength(callsBeforeSearch);
      const body = JSON.parse(search.stdout) as SearchBody;
      expect(Object.keys(body)).toEqual(['hits', 'digest']);
      expect(body.hits[0]).toMatchObject({ notePath: '_renor/digest', reason: 'digest' });
      expect(body.hits[0].text).toContain('Miso');
      expect(body.hits[0].text).toContain('Tofu');
      expect(body.digest).toMatchObject({ status: 'ok', windowNotes: 4, notesWithDigest: 4 });
      expect(body.digest!.text).toBe(body.hits[0].text);
      expect(body.digest!.tokens).toBe(encode(body.hits[0].text).length);
      // Provenance: every rendered item names its note and the turn it was said in. The note is named below the vault, as
      // every other path in the reply is, so the report names no directory of the host.
      expect(body.digest!.items.length).toBe(body.digest!.itemsRendered);
      for (const item of body.digest!.items) {
        expect(item.notePath).toMatch(/^Sessions\/sess-[^/]*\.md$/);
        expect(item.source).toMatch(/^Turn \d+$/);
      }
      // Retrieval itself is untouched: the other hits are exactly the control's.
      const controlHits = (JSON.parse(control.stdout) as SearchBody).hits;
      expect(body.hits.slice(1)).toEqual(controlHits);

      const again = await runCli(['index'], env);
      expect(again.code, again.stderr).toBe(0);
      expect(digestStats(again.stdout)).toMatchObject({ notes: 4, cached: 4, digested: 0, calls: 0, embeddedTexts: 0 });
      expect(stub.calls).toHaveLength(callsBeforeSearch);
    } finally {
      await stub.close();
    }
  }, 6 * CLI_TIMEOUT_MS);

  it('the table is bounded by RENOR_DIGEST_TOKENS and ordered oldest first', async () => {
    const stub = await startDigestStub();
    try {
      const vault = seedVault('budget');
      const dbPath = tmpPath('digests-cli-budget-db/index.db');
      const cache = tmpPath('digests-cli-budget-cache/digest-cache.db');
      const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl, cache), RENOR_DIGESTS: '1' });
      expect((await runCli(['index'], env)).code).toBe(0);
      const wide = JSON.parse((await runCli(['search', '--json', QUESTION], env)).stdout) as SearchBody;
      const tight = JSON.parse((await runCli(['search', '--json', QUESTION], { ...env, RENOR_DIGEST_TOKENS: '110' })).stdout) as SearchBody;
      expect(wide.digest!.tokens).toBeLessThanOrEqual(600);
      expect(tight.digest!.tokens).toBeLessThanOrEqual(110);
      expect(tight.digest!.itemsRendered).toBeLessThan(wide.digest!.itemsRendered);
      const dates = wide.digest!.text.split('\n').filter(l => l.startsWith('- ')).map(l => l.split(' | ').pop()!);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
    } finally {
      await stub.close();
    }
  }, 6 * CLI_TIMEOUT_MS);

  it('cache-only: a vault digested earlier is read with no key and no call; a new note is skipped on purpose, not a failure', async () => {
    const stub = await startDigestStub();
    try {
      const cache = tmpPath('digests-cli-only-cache/digest-cache.db');
      const first = cliEnv(seedVault('only-1'), tmpPath('digests-cli-only-db-1/index.db'), { ...stubEnv(stub.baseUrl, cache), RENOR_DIGESTS: '1' });
      expect((await runCli(['index'], first)).code).toBe(0);
      const calls = stub.calls.length;

      const vault = seedVault('only-2', [{ id: 'sess-new-5', date: '2023/05/28 (Sun) 08:00', text: 'I bought a red bicycle yesterday.' }]);
      const env = cliEnv(vault, tmpPath('digests-cli-only-db-2/index.db'), { RENOR_DIGESTS: '1', RENOR_DIGEST_MODEL: 'stub-digest', RENOR_DIGEST_CACHE: cache, RENOR_DIGEST_CACHE_ONLY: '1' });
      const index = await runCli(['index'], env);
      expect(index.code, index.stderr).toBe(0);
      expect(digestStats(index.stdout)).toMatchObject({ notes: 5, cached: 4, digested: 0, skippedUncached: 1, failed: 0, calls: 0 });
      const search = JSON.parse((await runCli(['search', '--json', QUESTION], env)).stdout) as SearchBody;
      expect(search.digest).toMatchObject({ status: 'ok' });
      expect(search.digest!.text).toContain('Miso');
      expect(stub.calls).toHaveLength(calls);
    } finally {
      await stub.close();
    }
  }, 6 * CLI_TIMEOUT_MS);

  it('armed with no provider: index refuses (exit 1) instead of looking like an empty digest', async () => {
    const vault = seedVault('noprov');
    const env = cliEnv(vault, tmpPath('digests-cli-noprov-db/index.db'), { RENOR_DIGESTS: '1', RENOR_DIGEST_CACHE: tmpPath('digests-cli-noprov-cache/digest-cache.db') });
    const index = await runCli(['index'], env);
    expect(index.code).toBe(1);
    expect(index.stderr).toContain('[digests] armed without a provider');
  }, 2 * CLI_TIMEOUT_MS);

  it('armed with only the evidence provider configured: index refuses (exit 1) and the evidence provider is never called', async () => {
    // The Privacy Policy names one digests processor. Another provider's key and URL being set must not make notes go there.
    const evidence = await startDigestStub();
    try {
      const vault = seedVault('evidence-only');
      const env = cliEnv(vault, tmpPath('digests-cli-evidence-db/index.db'), {
        RENOR_DIGESTS: '1',
        RENOR_DIGEST_CACHE: tmpPath('digests-cli-evidence-cache/digest-cache.db'),
        RENOR_EVIDENCE_BASE_URL: evidence.baseUrl,
        RENOR_EVIDENCE_API_KEY: 'evidence-key',
      });
      const index = await runCli(['index'], env);
      expect(index.code).toBe(1);
      expect(index.stderr).toContain('[digests] armed without a provider');
      // It says what to set, and that nothing else is borrowed.
      expect(index.stderr).toContain('RENOR_DIGEST_BASE_URL');
      expect(index.stderr).toContain('RENOR_DIGEST_API_KEY');
      expect(evidence.calls).toHaveLength(0);
      expect(index.stdout + index.stderr).not.toContain('evidence-key');
    } finally {
      await evidence.close();
    }
  }, 2 * CLI_TIMEOUT_MS);

  it('the daily cost cap is the background worker\'s: an operator-run index is not held to it (README, "Cost guard")', async () => {
    // Documented exemption, pinned so that adding a guard here is a decision made in the open: `renor index` and
    // `renor rebuild` are one-shot commands someone runs (the eval fills too), and they print what they spent.
    const stub = await startDigestStub();
    try {
      const vault = seedVault('uncapped');
      const env = cliEnv(vault, tmpPath('digests-cli-uncapped-db/index.db'), {
        ...stubEnv(stub.baseUrl, tmpPath('digests-cli-uncapped-cache/digest-cache.db')),
        RENOR_DIGESTS: '1',
        RENOR_DIGEST_MAX_USD_PER_DAY: '0.000001',
      });
      const index = await runCli(['index'], env);
      expect(index.code, index.stderr).toBe(0);
      expect(digestStats(index.stdout)).toMatchObject({ digested: 4, failed: 0, calls: 1 });
      expect(digestStats(index.stdout).promptTokens).toBeGreaterThan(0);
      expect(stub.calls).toHaveLength(1);
    } finally {
      await stub.close();
    }
  }, 2 * CLI_TIMEOUT_MS);

  it('a model that fails or answers in prose fails the index and leaves search exactly the control (said, not silent)', async () => {
    for (const behaviour of ['garbage', 'http-500'] as const) {
      const stub = await startDigestStub(behaviour);
      try {
        const vault = seedVault(`fail-${behaviour}`);
        const dbPath = tmpPath(`digests-cli-fail-${behaviour}-db/index.db`);
        const cache = tmpPath(`digests-cli-fail-${behaviour}-cache/digest-cache.db`);
        const env = cliEnv(vault, dbPath, { ...stubEnv(stub.baseUrl, cache), RENOR_DIGESTS: '1' });
        const index = await runCli(['index'], env);
        expect(index.code).toBe(1);
        expect(digestStats(index.stdout)).toMatchObject({ digested: 0, failed: 4 });
        const search = await runCli(['search', '--json', QUESTION], env);
        expect(search.code, search.stderr).toBe(0);
        const body = JSON.parse(search.stdout) as SearchBody;
        expect(body.digest).toMatchObject({ status: 'skipped', reason: 'no-digests' });
        expect(body.hits.every(hit => !hit.notePath.startsWith('_renor/'))).toBe(true);
      } finally {
        await stub.close();
      }
    }
  }, 6 * CLI_TIMEOUT_MS);
});
