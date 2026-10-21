import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * B7 regression: real CLI startup/rebuild. The ledger replay must be AWAITED
 * before readiness, replay errors must block startup (not be swallowed in a
 * background promise), and `rebuild` must replay the ledger after clearing the
 * derived tables or it would silently drop every lifecycle fact.
 *
 * Spawns the actual CLI (the compiled `dist/cli.js`) with synthetic temp vaults, a
 * dummy OpenAI key and no embedding calls (the synthetic vault ignores the
 * System/ dir via .semanticignore, so indexVault walks zero files).
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(): string {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1a-cli-'));
  tmpDirs.push(v);
  fs.writeFileSync(path.join(v, '.semanticignore'), 'System/\n');
  fs.mkdirSync(path.join(v, 'System'), { recursive: true });
  fs.writeFileSync(path.join(v, LEDGER), [
    `---`, `type: memory-ledger`, `---`, ``, `# Memory Events Ledger`, ``,
    `## MEM_CLI1 · 2026-09-09T00:00:00.000Z`,
    `- kind: store`,
    `- subject: SynthCli`,
    `- predicate: role`,
    `- object: survivor`,
    `- source: cli-test`,
    ``,
  ].join('\n'));
  return v;
}

function cliEnv(vault: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['OPENAI_API_KEY', 'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL', 'EMBEDDING_DIMS', 'LLM_EXTRACTION', 'MEMORY_LEDGER',
    'DB_PATH', 'VAULT_PATH']) delete env[k];
  env.VAULT_PATH = vault;
  env.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
  env.EMBEDDING_PROVIDER = 'openai';
  env.OPENAI_API_KEY = 'sk-test-dummy-key-not-real'; // never used: no chunks to embed
  return env;
}

function runCli(command: string, vault: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, command], {
      cwd: REPO_ROOT,
      env: cliEnv(vault),
      timeout: 90_000,
    }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0),
        stdout: String(stdout), stderr: String(stderr),
      });
    });
  });
}

function runCliWithEnv(command: string, vault: string, overrides: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = cliEnv(vault);
    delete env.EMBEDDING_PROVIDER;
    Object.assign(env, overrides);
    execFile(process.execPath, [CLI, command], { cwd: REPO_ROOT, env, timeout: 90_000 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0),
        stdout: String(stdout), stderr: String(stderr),
      });
    });
  });
}

function currentFacts(vault: string): any[] {
  const db = new Database(path.join(vault, '.semantic-memory', 'index.db'), { readonly: true });
  try {
    return db.prepare(
      `SELECT f.object_text, f.valid_to FROM facts f JOIN entities e ON f.subject_entity_id = e.id
       WHERE e.canonical_name = 'SynthCli' AND e.source_note = '_mcp_'`
    ).all();
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('B7: CLI startup awaits replay before readiness', () => {
  it('indexes notes without contacting OpenAI when only an ambient API key is set', async () => {
    const v = mkvault();
    fs.writeFileSync(path.join(v, 'private-note.md'), '# Private\nDo not upload this text.\n');
    const res = await runCliWithEnv('index', v, {
      OPENAI_API_KEY: 'sk-ambient',
      EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1',
    });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('Semantic search is off; set EMBEDDING_PROVIDER=openai to turn it on.');
    expect(res.stdout).toContain('Done. 1/1 indexed, 0 errors.');
  }, 120_000);

  it('rebuild replays the ledger after clearing derived tables (lifecycle fact survives)', async () => {
    const v = mkvault();
    const res = await runCli('rebuild', v);
    expect(res.code).toBe(0);
    // The rebuild wiped facts/entities/chunks/notes; only an awaited post-clear
    // replay can leave the lifecycle fact in place.
    const facts = currentFacts(v);
    expect(facts).toHaveLength(1);
    expect(facts[0].object_text).toBe('survivor');
    expect(facts[0].valid_to).toBeNull();
  }, 120_000);

  it('index applies the ledger replay before the command finishes', async () => {
    const v = mkvault();
    const res = await runCli('index', v);
    expect(res.code).toBe(0);
    expect(currentFacts(v)).toHaveLength(1);
  }, 120_000);

  it('an unreadable ledger path (EISDIR) blocks CLI startup with a non-zero exit', async () => {
    // Astra probe A3 / Kimi R3: a read failure must block readiness, not be
    // silently treated as an empty ledger. Real CLI spawn, not a unit parser call.
    const v = mkvault();
    fs.rmSync(path.join(v, LEDGER));
    fs.mkdirSync(path.join(v, LEDGER), { recursive: true }); // directory where the file belongs
    const res = await runCli('index', v);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/EISDIR|ledger read failed/i);
  }, 120_000);

  it('a missing ledger on a known-new empty vault still starts cleanly', async () => {
    const v = mkvault();
    fs.rmSync(path.join(v, LEDGER)); // no ledger ever written
    const res = await runCli('index', v);
    expect(res.code).toBe(0);
  }, 120_000);

  it('a corrupt ledger blocks CLI startup with a non-zero exit (not a swallowed background error)', async () => {
    const v = mkvault();
    fs.appendFileSync(path.join(v, LEDGER), [
      ``,
      `## mem_BROKEN · 2026-09-09T00:00:00.000Z`,
      `- subject: SynthCorrupt`, // missing required predicate/object fields
      ``,
    ].join('\n'));
    const res = await runCli('index', v);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/ledger/i);
  }, 120_000);

  it('a corrupt ledger also blocks rebuild with a non-zero exit', async () => {
    const v = mkvault();
    fs.appendFileSync(path.join(v, LEDGER), [
      ``,
      `## mem_BROKEN2 · 2026-09-09T00:00:00.000Z`,
      `- subject: SynthCorrupt`,
      ``,
    ].join('\n'));
    const res = await runCli('rebuild', v);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/ledger/i);
  }, 120_000);
});
