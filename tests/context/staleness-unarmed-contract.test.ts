import { it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { tmpPath } from '../helpers/tmpPath';

/**
 * The UN-ARMED `search --json` shape on a STALE vault — the case the shipped contract test
 * cannot reach.
 *
 * `tests/context/product-read-context-contract.test.ts` pins the frozen envelope with
 * `seedVault()`, whose fixture is a plain folder with no `.git`: `checkVaultStaleness` reports
 * `kind: 'plain'`, which is never stale, so its `Object.keys(cliBody).sort()).toEqual(['hits'])`
 * assertion never enters the staleness path at all. Measured at `d0af43f3` on a stale git vault
 * with `RENOR_VAULT_STALENESS` unset, the shipped CLI returned `['hits','vaultStaleness']` and the
 * repository's own assertion failed (`expected [ 'hits', 'vaultStaleness' ] to deeply equal
 * [ 'hits' ]`) — a contract break that 944/944 green could not see.
 *
 * This is deliberately asserted at the REAL spawned `renor search --json` surface, like the
 * contract test it complements, so a divergence between cli.ts and the module helper is itself
 * a failure. Both directions are pinned: unset must be byte-identical, and an explicitly armed
 * guard must still carry the verdict to the client.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

interface SeededVault {
  root: string;
  dbPath: string;
  ledger: string;
}

function seedVault(name: string): SeededVault {
  const root = tmpPath(name);
  fs.mkdirSync(path.join(root, 'Sessions'), { recursive: true });
  const write = (rel: string, sessionDate: string, body: string) => {
    const file = path.join(root, rel);
    fs.writeFileSync(
      file,
      `---\nkind: note\nsession_date: "${sessionDate}"\n---\n\n# ${path.basename(rel, '.md')}\n\n${body}\n`,
    );
    const when = new Date(sessionDate);
    fs.utimesSync(file, when, when);
  };
  write('Sessions/a-1.md', '2026-01-15T00:00:00.000Z', 'The machine runs on mains power at 300 W.');
  write('Sessions/b-2.md', '2026-01-16T00:00:00.000Z', 'The rack holds a UPS for nine minutes of runtime.');
  return { root, dbPath: path.join(root, '.semantic-memory', 'index.db'), ledger: 'System/Ledger.md' };
}

/** The shipped CLI/index env: synthetic, credential-free, offline. */
function cliEnv(vault: SeededVault, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
    'EMBEDDING_BATCH_SIZE', 'LLM_EXTRACTION', 'VAULT_PATH', 'DB_PATH', 'MEMORY_LEDGER',
    'RENOR_SEARCH_EVIDENCE', 'RENOR_STRUCTURED_CONTEXT', 'RENOR_QUERY_SCOPED_ROWS',
    'RENOR_VAULT_STALENESS',
  ]) delete env[key];
  return Object.assign(env, {
    VAULT_PATH: vault.root,
    DB_PATH: vault.dbPath,
    EMBEDDING_PROVIDER: 'eval-hash',
    RENOR_SEARCH_EVIDENCE: '0',
    MEMORY_LEDGER: vault.ledger,
  }, extra);
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeout: 120_000 },
      (err, stdout) => resolve({
        code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0),
        stdout: String(stdout),
      }));
  });
}

/** Index the fixture, then give the vault a git HEAD old enough to be stale (the D1 shape). */
async function indexThenMakeStale(vault: SeededVault): Promise<void> {
  const indexed = await runCli(['index'], cliEnv(vault));
  expect(indexed.code).toBe(0);
  expect(indexed.stdout).toMatch(/Done\.\s*2\/2 indexed, 0 errors/);
  const g = (args: string[]) => execFileSync('git', args, { cwd: vault.root, stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '.']);
  g(['config', 'user.email', 'contract@test.local']);
  g(['config', 'user.name', 'contract']);
  g(['add', '-A']);
  const old = { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T10:00:00', GIT_COMMITTER_DATE: '2026-09-01T10:00:00' };
  execFileSync('git', ['commit', '-q', '-m', 'old head'], { cwd: vault.root, env: old, stdio: ['ignore', 'pipe', 'pipe'] });
  const ageDays = Math.floor((Date.now() / 1000 - Number(
    execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: vault.root }).toString().trim(),
  )) / 86400);
  expect(ageDays).toBeGreaterThan(3); // the default head-age threshold
}

it('an UNSET RENOR_VAULT_STALENESS keeps the frozen search --json shape on a stale vault', async () => {
  const vault = seedVault('unarmed');
  await indexThenMakeStale(vault);

  const cli = await runCli(['search', 'what powers the machine', '--json'], cliEnv(vault));
  expect(cli.code).toBe(0);
  const body = JSON.parse(cli.stdout);
  // The same assertion the contract test makes, on the vault its own fixture cannot build.
  expect(Object.keys(body).sort()).toEqual(['hits']);
  expect(body.vaultStaleness).toBeUndefined();
}, 300_000);

it('an EXPLICITLY armed RENOR_VAULT_STALENESS=warn still carries the verdict to the client', async () => {
  const vault = seedVault('armed');
  await indexThenMakeStale(vault);

  const cli = await runCli(['search', 'what powers the machine', '--json'], cliEnv(vault, { RENOR_VAULT_STALENESS: 'warn' }));
  expect(cli.code).toBe(0);
  const body = JSON.parse(cli.stdout);
  expect(Object.keys(body).sort()).toEqual(['hits', 'vaultStaleness']);
  expect(body.vaultStaleness.stale).toBe(true);
  expect(body.vaultStaleness.headAgeDays).toBeGreaterThan(3);
}, 300_000);
