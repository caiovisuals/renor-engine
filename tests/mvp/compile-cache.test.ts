import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

/**
 * The per-workspace Node compile cache.
 *
 * Two halves, because the property is two-sided:
 *
 *  - CONFIGURATION refuses a cache directory that overlaps the memory, history or auth trees.
 *    Those trees are indexed, exported, or hold client secrets; compiled-code blobs belong in
 *    none of them. A refusal is REQUIRED here rather than a repair: silently relocating a
 *    misconfigured cache is how a shared directory would go unnoticed in the first place.
 *
 *  - ENABLEMENT is best-effort and must never keep the engine from starting. This is a speed
 *    optimisation, so an unwritable directory, a Node without compile-cache support, or
 *    NODE_DISABLE_COMPILE_CACHE=1 must all degrade to "no cache, engine runs".
 */

const BASE_ENV = { ...process.env };

function workspaceRoot(label: string): string {
  // Under the OS temp dir, which is what tmpdir() is for; every path here is synthetic.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `renor-cc-${label}-`));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true, mode: 0o700 });
  return root;
}

function baseEnvFor(root: string): NodeJS.ProcessEnv {
  const memoryDir = path.join(root, 'memory');
  const authStatePath = path.join(root, 'auth', 'clients.json');
  return {
    ...BASE_ENV,
    MVP_MEMORY_DIR: memoryDir,
    MVP_BASE_URL: 'http://127.0.0.1:3471',
    MVP_PORT: '3471',
    MVP_OWNER_EMAIL: 'owner@example.test',
    MVP_OWNER_PASSWORD: 'synthetic-secret',
    MVP_AUTH_STATE_PATH: authStatePath,
    MVP_ALLOWED_CALLBACK_URIS: '',
    MVP_GATEWAY_SECRET: '',
  };
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in BASE_ENV)) delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV);
});

describe('MVP_COMPILE_CACHE_DIR', () => {
  let root: string;

  beforeEach(() => {
    root = workspaceRoot('cfg');
  });

  it('has NO derived default: unset means no cache, never a path worked out from memory', async () => {
    // A default derived from MVP_MEMORY_DIR lands in a shared place when the memory directory is
    // (for example) /tmp/x: /tmp/cache/compile. Only the explicit, per-workspace value counts.
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root));
    delete process.env.MVP_COMPILE_CACHE_DIR;
    delete process.env.MVP_HISTORY_DIR;

    expect(loadMvpConfig().compileCacheDir).toBeNull();
  });

  it('accepts an explicit directory outside every data tree', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const explicit = path.join(root, 'cache', 'compile');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: explicit });

    expect(loadMvpConfig().compileCacheDir).toBe(explicit);
  });

  it('refuses a cache directory inside the memory tree', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), {
      MVP_COMPILE_CACHE_DIR: path.join(root, 'memory', 'cache'),
    });

    expect(() => loadMvpConfig()).toThrow(/MVP_COMPILE_CACHE_DIR/);
    expect(() => loadMvpConfig()).toThrow(/MVP_MEMORY_DIR/);
  });

  it('refuses a cache directory that CONTAINS the memory tree', async () => {
    // The dangerous direction is both ways: a cache directory that is an ancestor of the memory
    // directory would put the memory tree inside the cache.
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: root });

    expect(() => loadMvpConfig()).toThrow(/MVP_MEMORY_DIR/);
  });

  it('refuses a cache directory equal to the memory directory itself', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: path.join(root, 'memory') });

    expect(() => loadMvpConfig()).toThrow(/MVP_MEMORY_DIR/);
  });

  it('refuses a cache directory inside the promoted history tree', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const historyDir = path.join(root, 'history');
    fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    Object.assign(process.env, baseEnvFor(root), {
      MVP_HISTORY_DIR: historyDir,
      MVP_COMPILE_CACHE_DIR: path.join(historyDir, 'cache'),
    });

    expect(() => loadMvpConfig()).toThrow(/MVP_HISTORY_DIR/);
  });

  it('refuses a cache directory that contains the client registry', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: path.join(root, 'auth') });

    expect(() => loadMvpConfig()).toThrow(/MVP_AUTH_STATE_PATH/);
  });

  it('names the directory AND the tree in the refusal, so the fix is readable', async () => {
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const bad = path.join(root, 'memory', 'cache');
    Object.assign(process.env, baseEnvFor(root), { MVP_COMPILE_CACHE_DIR: bad });

    let message = '';
    try {
      loadMvpConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(bad);
    expect(message).toMatch(/rebuildable cache/);
  });

  it('a sibling directory of the memory tree is accepted even next to a history tree', async () => {
    // The layout the provisioner writes (state/cache/compile beside state/memory) must be legal.
    const { loadMvpConfig } = await import('../../src/mvp/config.js');
    const historyDir = path.join(root, 'history');
    fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    const explicit = path.join(root, 'cache', 'compile');
    Object.assign(process.env, baseEnvFor(root), {
      MVP_HISTORY_DIR: historyDir,
      MVP_COMPILE_CACHE_DIR: explicit,
    });

    const config = loadMvpConfig();
    expect(config.compileCacheDir).toBe(explicit);
    expect(config.historyDir).toBe(historyDir);
  });
});

/**
 * Enable the cache the way the engine does, in a CHILD process.
 *
 * Node allows exactly ONE compile cache per process: the first enableCompileCache() wins and
 * every later call reports ALREADY_ENABLED with the first directory (verified on Node 22 — a
 * second call naming a different directory returns the FIRST one). So testing this in-process
 * would make the assertions depend on which test ran first, and would let one case silently
 * assert another case's directory. A child process is also what actually happens: every wake is
 * a fresh process.
 */
function enableInChild(env: Record<string, string | undefined>): {
  enabled: boolean;
  directory: string | null;
  reason: string | null;
  cacheRootMode: string | null;
} {
  const script = `
    const { enableWorkspaceCompileCache } = require(${JSON.stringify(path.resolve(__dirname, '../../dist/mvp/compileCache.js'))});
    const report = enableWorkspaceCompileCache();
    const fs = require('node:fs');
    const mode = (() => {
      try { return (fs.statSync(process.env.MVP_COMPILE_CACHE_DIR).mode & 0o777).toString(8); }
      catch { return null; }
    })();
    process.stdout.write(JSON.stringify({ ...report, cacheRootMode: mode }));
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...BASE_ENV, ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
  }
  return JSON.parse(res.stdout);
}

describe('enabling the workspace compile cache', () => {
  let root: string;

  beforeEach(() => {
    root = workspaceRoot('enable');
  });

  it('enables a cache in this workspace\'s own directory and creates it 0700', () => {
    const dir = path.join(root, 'cache', 'compile');
    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_COMPILE_CACHE_DIR: dir,
    });

    expect(report.enabled).toBe(true);
    expect(report.reason).toBeNull();
    // Node scopes entries by Node version under the directory it is given, so what it reports
    // back may be that versioned child. What matters for isolation is that it is inside THIS
    // workspace's directory and nowhere else.
    expect(report.directory === dir || report.directory!.startsWith(dir + path.sep)).toBe(true);
    expect(report.cacheRootMode).toBe('700');
  });

  it('a workspace that never named a directory gets NO cache, and nothing is created beside memory', () => {
    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_COMPILE_CACHE_DIR: undefined,
    });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/MVP_COMPILE_CACHE_DIR is not set/);
    expect(fs.existsSync(path.join(root, 'cache'))).toBe(false);
  });

  it('refuses an existing directory that group or others can write', () => {
    // Loading V8 code from a directory another account can write is loading code that account
    // chose. 0777 was accepted before this check existed.
    const dir = path.join(root, 'cache', 'compile');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);

    const report = enableInChild({ MVP_MEMORY_DIR: path.join(root, 'memory'), MVP_COMPILE_CACHE_DIR: dir });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/writable by group or others/);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o777);
  });

  it('refuses a cache directory that is a symlink', () => {
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target, { mode: 0o700 });
    const link = path.join(root, 'cache-link');
    fs.symlinkSync(target, link);

    const report = enableInChild({ MVP_MEMORY_DIR: path.join(root, 'memory'), MVP_COMPILE_CACHE_DIR: link });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/symlink/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each([
    ['memory', (r: string) => path.join(r, 'memory', 'ccache')],
    ['history', (r: string) => path.join(r, 'history', 'ccache')],
    ['auth', (r: string) => path.join(r, 'auth')],
  ])('does not create or enable a cache inside the %s tree', (label, pick) => {
    fs.mkdirSync(path.join(root, 'history'), { recursive: true, mode: 0o700 });
    const dir = pick(root);

    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_HISTORY_DIR: path.join(root, 'history'),
      MVP_AUTH_STATE_PATH: path.join(root, 'auth', 'clients.json'),
      MVP_COMPILE_CACHE_DIR: dir,
    });

    expect(report.enabled).toBe(false);
    // 'auth' is the directory that CONTAINS the registry, so it exists already: what must hold
    // is that nothing was written into it.
    if (label === 'auth') expect(filesUnder(dir)).toEqual([]);
    else expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports, and does not throw, when the directory cannot be used', () => {
    // A path whose parent is a FILE cannot be created. Startup must continue: this is a speed
    // optimisation and must never be the reason a workspace fails to wake.
    const blocker = path.join(root, 'not-a-dir');
    fs.writeFileSync(blocker, 'this is a file, not a directory');

    const report = enableInChild({
      MVP_MEMORY_DIR: path.join(root, 'memory'),
      MVP_COMPILE_CACHE_DIR: path.join(blocker, 'cache'),
    });

    // Node may still accept the directory name and simply fail to write; what is asserted is
    // that the call returned a report at all, with a reason when it declined.
    if (!report.enabled) expect(report.reason).toBeTruthy();
    expect(report.directory === null || typeof report.directory === 'string').toBe(true);
  });

  it('declines cleanly when nothing is configured at all', () => {
    const report = enableInChild({
      MVP_MEMORY_DIR: undefined,
      MVP_COMPILE_CACHE_DIR: undefined,
    });

    expect(report.enabled).toBe(false);
    expect(report.reason).toMatch(/MVP_COMPILE_CACHE_DIR/);
  });
});

/**
 * The real entry point, spawned. Node writes its cache entries when the process exits, and a
 * refused start exits too, so the only honest proof that a refusal leaves nothing behind is to
 * run `dist/mvp/cli.js`, let it refuse, and count what is in the data tree afterwards.
 */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
}

function runCli(env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [path.resolve(__dirname, '../../dist/mvp/cli.js')], {
    env: { ...env, MVP_EMBEDDING_PROVIDER: 'none', NODE_DISABLE_COMPILE_CACHE: undefined } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stderr: res.stderr ?? '' };
}

describe('a start refused for an overlapping cache directory', () => {
  it.each([
    ['memory', (r: string) => path.join(r, 'memory', 'ccache'), /MVP_MEMORY_DIR/],
    ['auth', (r: string) => path.join(r, 'auth'), /MVP_AUTH_STATE_PATH/],
  ])('refuses and writes no file into the %s tree', (label, pick, message) => {
    const root = workspaceRoot('cli');
    const dir = pick(root);

    const res = runCli({ ...baseEnvFor(root), MVP_COMPILE_CACHE_DIR: dir });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(message);
    expect(filesUnder(path.join(root, 'memory'))).toEqual([]);
    expect(filesUnder(path.join(root, 'auth'))).toEqual([]);
    // The auth case names the directory holding the registry, which exists already.
    if (label !== 'auth') expect(fs.existsSync(dir)).toBe(false);
  });

  it('control: the same start with a disjoint cache directory does fill it', async () => {
    // Without this the two tests above would pass on a CLI that never writes a cache at all.
    const root = workspaceRoot('cli-ctl');
    const dir = path.join(root, 'cache', 'compile');
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    try {
      const { port } = blocker.address() as net.AddressInfo;
      const env = {
        ...baseEnvFor(root), MVP_COMPILE_CACHE_DIR: dir,
        MVP_PORT: String(port), MVP_BASE_URL: `http://127.0.0.1:${port}`,
      };
      // Keeping the port occupied makes startup fail after cache enablement, even as root.
      // The failed process still exits and flushes its cache entries.
      const res = runCli(env);

      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/EADDRINUSE/);
      expect(filesUnder(dir).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close(err => err ? reject(err) : resolve());
      });
    }
  });
});

describe('the tokenizer is loaded on first use', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('does not require gpt-tokenizer at import time, and does on the first count', async () => {
    // The measurement this protects: requiring gpt-tokenizer costs ~344 ms on Node 22, of which
    // ~205 ms is the o200k_base table, and nothing before the engine is Listening counts a token.
    //
    // Run in a child process against require.cache, because the property is about what a FRESH
    // module graph contains: this test file has already loaded plenty, and an in-process check
    // could only ever observe this process's cache, not whether importing the module loads the
    // tokenizer.
    const script = `
      const loaded = () => Object.keys(require.cache).filter((k) => k.includes('gpt-tokenizer')).length;
      const before = loaded();
      const mod = require(${JSON.stringify(path.resolve(__dirname, '../../dist/indexer/tokenizer.js'))});
      const afterImport = loaded();
      const reportedAfterImport = mod.tokenizerLoaded();
      const count = mod.encodeTokens('a short note about cold starts');
      process.stdout.write(JSON.stringify({
        before, afterImport, reportedAfterImport,
        afterFirstCount: loaded(), reportedAfterCount: mod.tokenizerLoaded(), count,
      }));
    `;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
    if (res.status !== 0) throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
    const out = JSON.parse(res.stdout) as {
      before: number; afterImport: number; reportedAfterImport: boolean;
      afterFirstCount: number; reportedAfterCount: boolean; count: number;
    };

    // Nothing loaded it before this test, so a non-zero here would be leakage from elsewhere.
    expect(out.before).toBe(0);
    expect(out.afterImport).toBe(0);
    expect(out.reportedAfterImport).toBe(false);

    // The work is DEFERRED, not skipped: the first count loads it and returns a real count.
    expect(out.afterFirstCount).toBeGreaterThan(0);
    expect(out.reportedAfterCount).toBe(true);
    expect(out.count).toBeGreaterThan(0);
  });

  it('counts tokens identically to gpt-tokenizer called directly', async () => {
    const { encodeTokens } = await import('../../src/indexer/tokenizer.js');
    const { encode } = await import('gpt-tokenizer');

    for (const sample of [
      'hello world',
      'A note with <|im_start|> special-token syntax inside it, which must count as plain text.',
      'unicode: ação, 日本語, emoji \u{1f9e0}, and a very long '.repeat(50),
      '',
    ]) {
      expect(encodeTokens(sample)).toBe(encode(sample, { disallowedSpecial: new Set() }).length);
    }
  });
});
