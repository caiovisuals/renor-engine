import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpPath } from '../helpers/tmpPath';
import { completion, EVIDENCE_PROVIDER_ENV, startStubChat, type StubChat } from '../helpers/stubChat';
import { openDb } from '../../src/db/client';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { engineSearchMemory, type Engine } from '../../src/mvp/engine';

/**
 * `renor search --json` names a note by the path the hosted tools name it by: relative to the vault.
 *
 * It printed the stored path, which is absolute on the host that ran the search. Every reply then carried the host's
 * filesystem layout and the name of its temporary directory (a benchmark vault is `renor-product-XXXXXX`), spent about
 * 13 tokens a hit on a string no reader uses (the client context assembled from the reply was byte-identical on 100 of
 * 100 questions without it), and was a different size wherever the vault lived (search-size study, 2026-10-05).
 *
 * Asserted at the real spawned CLI, with eval-hash embeddings and a local stub extractor: no model is called.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
// Each case spawns tsx (index or search); a loaded host can take tens of seconds.
const CLI_BUDGET_MS = 180_000;

const QUERY = 'How many days was the camping trip?';
const ITEMS = JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] });

// One note in a folder, one two folders down, one at the top: the three depths a path can have.
const TRIP = path.join('Sessions', 'trip.md');
const TOMATOES = path.join('Notes', 'Garden', 'tomatoes.md');
const INBOX = 'inbox.md';
const NOTES: Record<string, string> = {
  [TRIP]: '---\nkind: note\nsession_date: "2023-05-29T00:00:00.000Z"\n---\n\n# Trip\n\nWe went camping for 3 days near the lake.\n',
  [TOMATOES]: '# Tomatoes\n\nTomatoes need staking before the first frost.\n',
  [INBOX]: '# Inbox\n\nThe dentist appointment is on Tuesday at nine.\n',
};

const root = tmpPath('search-json-paths');
const vault = path.join(root, 'vault');
const dbPath = path.join(root, 'index.db');
let caseNo = 0;

/** The shipped CLI env: synthetic, offline, and without any provider credential or flag from the developer's shell. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    ...EVIDENCE_PROVIDER_ENV, 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
    'EMBEDDING_BATCH_SIZE', 'LLM_EXTRACTION', 'VAULT_PATH', 'DB_PATH', 'MEMORY_LEDGER', 'RENOR_STRUCTURED_CONTEXT',
    'RENOR_READ_HONESTY', 'RENOR_QUERY_SCOPED_ROWS', 'RENOR_VAULT_STALENESS', 'RENOR_SESSION_ROUTER',
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
    // Not run from the vault: where the process runs must not decide what it prints.
    execFile(TSX, ['src/cli.ts', ...args], { cwd: REPO_ROOT, env, timeout: CLI_BUDGET_MS },
      (err, stdout, stderr) => resolve({
        code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
      }));
  });
}

interface Hit { notePath: string; text: string; provenance?: { source: string } }

async function search(extra: Record<string, string>): Promise<{ stdout: string; body: Record<string, any> & { hits: Hit[] } }> {
  const cli = await runCli(['search', QUERY, '--json'], cliEnv(extra));
  expect(cli.code, cli.stderr).toBe(0);
  return { stdout: cli.stdout, body: JSON.parse(cli.stdout) };
}

/** What names the host: where the vault is, the temporary directory holding it, and that directory's bare name. */
const hostNames = () => [vault, path.dirname(root), path.basename(path.dirname(root)), os.tmpdir()];

/** The file at a path printed in a reply is the note the reply took its text from. */
function expectNames(notePath: string, text: string): void {
  expect(path.isAbsolute(notePath), notePath).toBe(false);
  expect(notePath.split(path.sep), notePath).not.toContain('..');
  expect(fs.readFileSync(path.join(vault, notePath), 'utf8'), notePath).toContain(text);
}

const servers: StubChat[] = [];
let off: Awaited<ReturnType<typeof search>>;

beforeAll(async () => {
  for (const [rel, body] of Object.entries(NOTES)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), body);
  }
  const indexed = await runCli(['index'], cliEnv({ RENOR_SEARCH_EVIDENCE: '0' }));
  expect(indexed.code, indexed.stderr).toBe(0);
  expect(indexed.stdout).toMatch(/Done\.\s*3\/3 indexed, 0 errors/);
  off = await search({ RENOR_SEARCH_EVIDENCE: '0' });
}, 2 * CLI_BUDGET_MS);

afterAll(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('search --json prints a note by its path inside the vault', () => {
  it('names the three notes by their paths below the vault, and nothing in the reply says where the vault is', () => {
    expect(Object.keys(off.body)).toEqual(['hits']);
    expect(new Set(off.body.hits.map((hit) => hit.notePath))).toEqual(new Set([TRIP, TOMATOES, INBOX]));
    for (const hit of off.body.hits) expectNames(hit.notePath, hit.text);
    for (const host of hostNames()) expect(off.stdout).not.toContain(host);
  }, CLI_BUDGET_MS);

  it('is the path the hosted search_memory prints for the same notes', async () => {
    const db = openDb(dbPath);
    try {
      const provider = new EvalHashEmbeddingProvider();
      const vectorIndex = new VectorIndex(db, provider.dimensions);
      vectorIndex.initTable();
      const engine: Engine = { provider, vectorIndex, dims: provider.dimensions };
      const hosted = await engineSearchMemory(db, engine, vault, QUERY, 20);
      expect(hosted.ok, JSON.stringify(hosted)).toBe(true);
      const hostedPaths = new Set((hosted.hits as Hit[]).map((hit) => hit.notePath));
      expect(hostedPaths.size).toBeGreaterThan(0);
      for (const hit of off.body.hits) expect(hostedPaths, hit.notePath).toContain(hit.notePath);
    } finally {
      db.close();
    }
  }, CLI_BUDGET_MS);

  it('keeps the evidence table\'s own path, which is no file, and prints the paths of the sessions it read relative', async () => {
    const chat = await startStubChat(() => ({ body: completion(ITEMS) }));
    servers.push(chat);
    const { stdout, body } = await search({
      RENOR_SEARCH_EVIDENCE: '1', RENOR_EVIDENCE_BASE_URL: chat.baseUrl, RENOR_EVIDENCE_API_KEY: 'k', RENOR_EVIDENCE_MODEL: 'stub-extractor',
    });
    expect(chat.requests).toHaveLength(1);
    expect(body.evidence.state).toBe('ok');
    expect(body.hits[0].notePath).toBe('_renor/evidence');
    for (const hit of body.hits.slice(1)) expectNames(hit.notePath, hit.text);
    // The sessions the table was read from: the same notes, named the same way (not the host's stored path).
    const stems = body.evidence.sessions.map((session: { stem: string }) => session.stem);
    expect(stems.length).toBeGreaterThan(0);
    for (const stem of stems) expect(fs.existsSync(path.join(vault, stem)), stem).toBe(true);
    for (const stem of stems) expect(path.isAbsolute(stem), stem).toBe(false);
    for (const host of hostNames()) expect(stdout).not.toContain(host);
  }, CLI_BUDGET_MS);

  it('gives each hit\'s provenance, and the honesty report\'s, the path the hit has', async () => {
    const { stdout, body } = await search({ RENOR_SEARCH_EVIDENCE: '0', RENOR_READ_HONESTY: '1' });
    expect(body.hits.length).toBeGreaterThan(0);
    for (const hit of body.hits) {
      expectNames(hit.notePath, hit.text);
      expect(hit.provenance?.source).toBe(hit.notePath);
    }
    expect(body.readHonesty.provenance.map((p: { source: string }) => p.source)).toEqual(body.hits.map((hit) => hit.notePath));
    for (const host of hostNames()) expect(stdout).not.toContain(host);
  }, CLI_BUDGET_MS);

  it('still tells a person at their own terminal where the file is (the plain output is not the JSON transport)', async () => {
    const plain = await runCli(['search', QUERY], cliEnv({ RENOR_SEARCH_EVIDENCE: '0' }));
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toContain(path.join(vault, TRIP));
  }, CLI_BUDGET_MS);
});
