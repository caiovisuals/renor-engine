import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { latin1, rawPath, supportsNonUtf8Names } from '../helpers/nonUtf8Names';

/**
 * #188: `osm index` printed `Done. <n>/<m> indexed, <k> errors.` and exited 0
 * whatever `k` was, so anything that trusts the exit status accepted an
 * incomplete index — and the index path documents itself as fail-closed
 * (pipeline.ts resets a failed note's hash so the note is never reported
 * current). `rebuild` takes the same `indexVault` result and had the same hole.
 *
 * The existing contracts assert on the *stdout* pattern only
 * (tests/context/product-read-context-contract.test.ts,
 * tests/context/staleness-unarmed-contract.test.ts), so a regression in the
 * status could not be caught. These cases pin the status itself, on the shipped
 * CLI, through a real subprocess: one note in the fixture cannot be parsed, so
 * `indexVault` reports a real per-file error.
 *
 * The three direction-coverage cases at the end of the file (an empty vault,
 * a total failure, and a clean rebuild) are ported from the dedicated
 * exit-status test PR #197 carried and closed as superseded: that PR's status
 * assertions are already satisfied here, but its `0/1` total-failure and its
 * two success-direction cases were not. Its stderr assertions
 * (`incomplete: …` / `rebuild incomplete: …`) are deliberately NOT ported —
 * #210 shipped only the status, so asserting a transcript main does not emit
 * would be a CLI behaviour change rather than a lock on the existing fix. The
 * per-file `error indexing …` line main does emit is already asserted above.
 */

// Every case here spawns the CLI, and the engine's own vitest config sets no
// testTimeout (the root config's 15s is not what the engine gate loads), so each
// case carries an explicit budget rather than relying on the 5s default.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const tmpDirs: string[] = [];

/**
 * A vault with one indexable note, plus a second note whose YAML frontmatter
 * cannot be parsed — the failure has to come from the index path itself
 * (gray-matter throws inside indexFile), never from a missing provider.
 */
function mkvault(opts: { withBrokenNote: boolean; withGoodNote?: boolean }): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'index-exit-'));
  tmpDirs.push(vault);
  if (opts.withGoodNote !== false) {
    fs.writeFileSync(path.join(vault, 'good.md'), '# Good\n\nNothing special here.\n');
  }
  if (opts.withBrokenNote) {
    fs.writeFileSync(
      path.join(vault, 'broken.md'),
      '---\nkind: session\ntags: [a, b\n---\n# Broken\n\nUnterminated YAML flow sequence.\n',
    );
  }
  return vault;
}

function cliEnv(vault: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_BASE_URL',
    'RENOR_EXTRACTOR_API_KEY', 'RENOR_EXTRACTOR_API_KEYS', 'RENOR_EXTRACTOR_BASE_URL',
    'EMBEDDING_PROVIDER', 'DB_PATH', 'VAULT_PATH',
    'RENOR_TYPED_FACTS', 'RENOR_CHRONICLE', 'RENOR_PREFS',
  ]) delete env[key];
  env.VAULT_PATH = vault;
  env.DB_PATH = path.join(vault, '.semantic-memory', 'index.db');
  env.EMBEDDING_PROVIDER = 'eval-hash';
  return { ...env, ...extra };
}

function runCli(
  args: string[],
  vault: string,
  timeout = 90_000,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(TSX, ['src/cli.ts', ...args], {
      cwd: REPO_ROOT,
      env: cliEnv(vault, extraEnv),
      timeout,
    }, (err, stdout, stderr) => {
      const error = err as NodeJS.ErrnoException & { code?: number | string } | null;
      resolve({
        code: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('index exit status on a partial index (#188)', () => {
  it('index exits non-zero when a note fails, and still prints the error count', async () => {
    const vault = mkvault({ withBrokenNote: true });
    const result = await runCli(['index'], vault);
    expect(result.stdout).toMatch(/Done\. 1\/2 indexed, 1 errors\./);
    expect(result.stderr).toMatch(/error indexing .*broken\.md/);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
  }, 90_000);

  it('index exits zero when every note indexes', async () => {
    const vault = mkvault({ withBrokenNote: false });
    const result = await runCli(['index'], vault);
    expect(result.stdout).toMatch(/Done\. 1\/1 indexed, 0 errors\./);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 90_000);

  it('a fact-extraction failure reaches the exit status instead of being swallowed', async () => {
    // #188's second blanket catch: the legacy LLM fact lane (LLM_EXTRACTION)
    // logged its failure, reset the note hash so the next pass retries, and
    // RESOLVED — so indexVault counted the note as indexed and `index` exited 0
    // with that note's facts missing. The endpoint here refuses instantly, so
    // the failure is a real one and not a config mistake.
    const vault = mkvault({ withBrokenNote: false });
    const armed = await runCli(['index'], vault, 90_000, {
      LLM_EXTRACTION: 'true',
      OPENAI_API_KEY: 'sk-not-a-real-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    });
    expect(armed.stderr).toMatch(/LLM extraction failed/);
    expect(armed.stdout).toMatch(/Done\. 0\/1 indexed, 1 errors\./);
    expect(armed.code, `${armed.stdout}\n${armed.stderr}`).toBe(1);

    // Control: the same vault with the lane disarmed extracts nothing and is a
    // clean index — the failure above drives the status, not the configuration.
    const disarmed = await runCli(['index'], vault);
    expect(disarmed.stdout).toMatch(/Done\. 1\/1 indexed, 0 errors\./);
    expect(disarmed.code).toBe(0);
  }, 180_000);

  it('rebuild carries the same failure contract, not a silent error count', async () => {
    const vault = mkvault({ withBrokenNote: true });
    const result = await runCli(['rebuild'], vault);
    expect(result.stdout).toMatch(/Rebuild complete\. 1\/2 indexed, 1 errors\./);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
  }, 90_000);

  // Ported from #197 (superseded). The cases above pin the failure direction of a
  // PARTIAL index; these three pin the edges around that status: nothing indexed
  // at all (0/1), nothing to index, and the success direction of `rebuild` on a
  // non-empty vault. A guard that fires when there is nothing to index
  // (`stats.total === 0`) would clear every earlier case and fail the empty-vault
  // case; a status that stops carrying the error count fails the 0/1 case.
  // (A guard of the form `indexed < total` would produce the same statuses these
  // fixtures expect, so it is not what these distinguish — the total-failure and
  // empty-vault pair is pinned by the guard going inert or over-firing.)
  it('index exits non-zero when nothing indexed at all, not only on a partial index', async () => {
    const vault = mkvault({ withBrokenNote: true, withGoodNote: false });
    const result = await runCli(['index'], vault);
    expect(result.stdout).toMatch(/Done\. 0\/1 indexed, 1 errors\./);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
  }, 90_000);

  it('index exits zero on an empty vault — nothing to index is not a failure', async () => {
    const vault = mkvault({ withBrokenNote: false, withGoodNote: false });
    const result = await runCli(['index'], vault);
    expect(result.stdout).toMatch(/Done\. 0\/0 indexed, 0 errors\./);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 90_000);

  it('rebuild exits zero on a vault that rebuilds cleanly', async () => {
    const vault = mkvault({ withBrokenNote: false });
    const result = await runCli(['rebuild'], vault);
    expect(result.stdout).toMatch(/Rebuild complete\. 1\/1 indexed, 0 errors\./);
    expect(result.code).toBe(0);
  }, 90_000);

  // A name another OS or locale wrote can hold bytes that are not UTF-8. The walk reports such
  // notes by name instead of returning a path that exists nowhere (`walkVault`'s
  // `onNonUtf8Markdown`); `indexVault` opts into that and returns the names. Two things then have
  // to hold on the shipped CLI, and neither is visible from the unit tests: a bad FOLDER name used
  // to make `scandir` throw out of the walk, so the whole pass died and every note in the vault
  // went unindexed while the command reported an error count nobody could attribute; and a skipped
  // note must never read as an error, because nothing failed and automation reads the status.
  // Skipped on a filesystem that cannot store such a name at all (APFS refuses it with EILSEQ).
  // `tests/indexer/index-vault-non-utf8-names.test.ts` asserts loudly that Linux can store one,
  // so a skip there would be a real gap rather than a platform limitation.
  it.skipIf(!supportsNonUtf8Names)('index names the notes it skipped for a non-UTF-8 name, indexes the rest, and still exits zero', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'index-exit-'));
    tmpDirs.push(vault);
    fs.writeFileSync(path.join(vault, 'good.md'), '# Good\n\nNothing special here.\n');
    fs.writeFileSync(path.join(vault, 'later.md'), '# Later\n\nStill worth recalling.\n');
    // A folder and a file whose names are Latin-1 bytes Node decodes as U+FFFD.
    fs.mkdirSync(rawPath(vault, latin1('Reunião')), { recursive: true });
    fs.writeFileSync(rawPath(vault, latin1('Reunião'), Buffer.from('ata.md')), '# Ata\n\nInside.\n');
    fs.writeFileSync(rawPath(vault, latin1('Reunião.md')), '# Root\n\nAt the root.\n');

    const result = await runCli(['index'], vault);
    expect(result.stdout).toMatch(/Done\. 2\/2 indexed, 0 errors\./);
    expect(result.stdout).toMatch(/not indexed\s+: 2 Markdown file\(s\) whose file or folder name is not valid UTF-8/);
    expect(result.stdout).toMatch(/Reuni\\xe3o\/ata\.md/);
    expect(result.stdout).toMatch(/Reuni\\xe3o\.md/);
    expect(result.stderr).not.toMatch(/error indexing/);
    // Nothing failed: the notes the indexer can address are all indexed, and a name it cannot
    // address is not a partial index (it would fail automation forever over one unrenameable file).
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 90_000);
});

