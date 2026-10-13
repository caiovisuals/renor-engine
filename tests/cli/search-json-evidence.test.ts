import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpPath } from '../helpers/tmpPath';
import { completion, EVIDENCE_PROVIDER_ENV, startStubChat, type StubChat } from '../helpers/stubChat';

/**
 * `renor search --json` says what the evidence second pass did.
 *
 * It is the transport the authoritative benchmark runner reads, and it used to print only
 * `{hits}`: when the extractor failed (a 429 from an exhausted key, a 180 s timeout, a reply
 * the parser rejects) the table was simply absent, so a run that lost its evidence layer
 * looked exactly like one that kept it (issue #222; 5 of 29 `glm-5p3` searches in the
 * 2026-10-03 extractor study). With the pass on, the JSON now carries the same `evidence`
 * report the hosted `search_memory` tool returns. With `RENOR_SEARCH_EVIDENCE=0` the envelope
 * stays the frozen `{hits}` (tests/context/product-read-context-contract.test.ts).
 *
 * Asserted at the real spawned CLI, against a local stub extractor; no provider is reached.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
// Each case spawns tsx (index or search) a few times; a loaded host can take tens of seconds.
const CLI_BUDGET_MS = 180_000;

const ITEMS = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });
const QUERY = 'How many days was the camping trip?';

const root = tmpPath('search-json-evidence');
const vault = path.join(root, 'vault');
const dbPath = path.join(root, 'index.db');
let caseNo = 0;

/** The shipped CLI env: synthetic, offline, and without any provider credential from the developer's shell. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    ...EVIDENCE_PROVIDER_ENV, 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
    'EMBEDDING_BATCH_SIZE', 'LLM_EXTRACTION', 'VAULT_PATH', 'DB_PATH', 'MEMORY_LEDGER', 'RENOR_STRUCTURED_CONTEXT',
    'RENOR_READ_HONESTY', 'RENOR_QUERY_SCOPED_ROWS', 'RENOR_VAULT_STALENESS',
  ]) delete env[key];
  caseNo++;
  return {
    ...env,
    VAULT_PATH: vault,
    DB_PATH: dbPath,
    EMBEDDING_PROVIDER: 'eval-hash',
    // A fresh evidence cache per call: a table cached by one case must not answer the next.
    RENOR_EVIDENCE_CACHE: path.join(root, `evidence-cache-${caseNo}.db`),
    ...extra,
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(TSX, ['src/cli.ts', ...args], { cwd: REPO_ROOT, env, timeout: CLI_BUDGET_MS },
      (err, stdout, stderr) => resolve({
        code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
      }));
  });
}

async function searchJson(env: NodeJS.ProcessEnv): Promise<Record<string, any>> {
  const cli = await runCli(['search', QUERY, '--json'], env);
  expect(cli.code, cli.stderr).toBe(0);
  return JSON.parse(cli.stdout) as Record<string, any>;
}

const servers: StubChat[] = [];
async function stub(reply: Parameters<typeof startStubChat>[0]): Promise<StubChat> {
  const server = await startStubChat(reply);
  servers.push(server);
  return server;
}

beforeAll(async () => {
  fs.mkdirSync(path.join(vault, 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Sessions', 'trip.md'),
    '---\nkind: note\nsession_date: "2023-05-29T00:00:00.000Z"\n---\n\n# Trip\n\nWe went camping for 3 days near the lake.\n');
  const indexed = await runCli(['index'], cliEnv({ RENOR_SEARCH_EVIDENCE: '0' }));
  expect(indexed.code, indexed.stderr).toBe(0);
  expect(indexed.stdout).toMatch(/Done\.\s*1\/1 indexed, 0 errors/);
}, CLI_BUDGET_MS);

afterAll(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('search --json reports the evidence pass', () => {
  it('a failed extraction is in the JSON: state, reason, the extractor model and the provider status', async () => {
    const chat = await stub(() => ({ status: 400, body: { error: 'model not served' } }));
    const body = await searchJson(cliEnv({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    }));
    expect(chat.requests).toHaveLength(1);
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.some((hit: { notePath: string }) => hit.notePath === '_renor/evidence')).toBe(false);
    expect(body.evidence.status).toBe('skipped');
    expect(body.evidence.state).toBe('failed');
    expect(body.evidence.reason).toBe('extractor-error');
    expect(body.evidence.model).toBe('stub-extractor');
    expect(body.evidence.error).toMatch(/400/);
    expect(body.evidence.note).toMatch(/model call failed/i);
  }, CLI_BUDGET_MS);

  it('a reply the parser rejects is remembered across processes: the next search says so and calls nothing', async () => {
    // Empty at the token cap, as GLM-5.3-Flash on Nebius answered 36% of its dev100 extraction calls (2026-10-03).
    const chat = await stub(() => ({ body: completion('', 'length') }));
    const env = cliEnv({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    });
    const first = await searchJson(env);
    expect(chat.requests).toHaveLength(3);
    expect(first.evidence).toMatchObject({ state: 'failed', reason: 'extractor-parse-error', model: 'stub-extractor' });
    expect(first.evidence.error).toMatch(/finish_reason=length/);
    expect(first.evidence).not.toHaveProperty('fromCache');

    // Another process, the same notes and the same evidence cache file.
    const second = await searchJson(env);
    expect(chat.requests).toHaveLength(3);
    expect(second.evidence).toEqual({ ...first.evidence, fromCache: true });
    // The same notes, with no table before them (a score moves with the clock: its recency part).
    const shown = (body: Record<string, any>) => body.hits.map((hit: { notePath: string; text: string }) => [hit.notePath, hit.text]);
    expect(shown(second)).toEqual(shown(first));
    expect(second.hits.some((hit: { notePath: string }) => hit.notePath === '_renor/evidence')).toBe(false);
  }, 2 * CLI_BUDGET_MS);

  it('an attached table is reported ok, and still leads the hits', async () => {
    const chat = await stub(() => ({ body: completion(ITEMS) }));
    const body = await searchJson(cliEnv({
      RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    }));
    expect(chat.requests).toHaveLength(1);
    expect(body.evidence.state).toBe('ok');
    expect(body.evidence.model).toBe('stub-extractor');
    expect(body.evidence.fromCache).toBe(false);
    expect(body.evidence.items).toHaveLength(1);
    expect(body.hits[0].notePath).toBe('_renor/evidence');
    expect(body.hits[0].text).toContain('camping trip');
  }, CLI_BUDGET_MS);

  it('with no evidence model configured, it says "unavailable" and that nothing is broken', async () => {
    const body = await searchJson(cliEnv());
    expect(body.evidence.state).toBe('unavailable');
    expect(body.evidence.reason).toBe('extractor-unavailable');
    expect(body.evidence.note).toMatch(/nothing is broken/i);
  }, CLI_BUDGET_MS);

  it('switched off with RENOR_SEARCH_EVIDENCE=0, the envelope stays the frozen {hits}', async () => {
    const body = await searchJson(cliEnv({ RENOR_SEARCH_EVIDENCE: '0' }));
    expect(Object.keys(body).sort()).toEqual(['hits']);
  }, CLI_BUDGET_MS);
});
