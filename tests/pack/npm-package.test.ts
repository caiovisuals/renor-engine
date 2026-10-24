import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * `npx -y renor-engine mcp` is the one line a directory listing or a README gives a stranger. These tests pack the engine
 * the way `npm publish` would, read the file list, unpack the tarball somewhere that is not this repository and run the
 * server from it, as the package's own `bin`, with an empty home directory and no setting: it must remember a fact and
 * recall it. The dependencies are this checkout's own (a registry install is the one thing a unit test cannot do offline;
 * the publish runbook repeats the whole thing against the registry).
 */

const ENGINE = path.resolve(__dirname, '../..');
const BUDGET = 240_000;
const PATIENTLY = { timeout: 180_000 };

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let work = '';
let unpacked = '';
let packed: { name: string; version: string; files: Array<{ path: string }> };
let manifest: { name: string; version: string; bin: Record<string, string>; private?: boolean; license: string; dependencies: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

beforeAll(() => {
  work = scratch('renor-pack-');
  const destination = path.join(work, 'tarball');
  fs.mkdirSync(destination);
  // --ignore-scripts: packing must not rebuild; it packs the dist the suite just compiled.
  const pack = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: ENGINE, encoding: 'utf8', timeout: 120_000,
  });
  expect(pack.status, pack.stderr).toBe(0);
  packed = JSON.parse(pack.stdout)[0];
  const extract = path.join(work, 'extract');
  fs.mkdirSync(extract);
  const untar = spawnSync('tar', ['-xzf', path.join(destination, fs.readdirSync(destination)[0]), '-C', extract], { encoding: 'utf8' });
  expect(untar.status, untar.stderr).toBe(0);
  unpacked = path.join(extract, 'package');
  manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  // What `npm install` leaves next to the package: its dependencies, here this checkout's own.
  fs.symlinkSync(path.join(ENGINE, 'node_modules'), path.join(extract, 'node_modules'));
}, BUDGET);

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
});

describe('the npm package', () => {
  it('is renor-engine, Apache-2.0, with one bin named like the package that points at the built CLI', () => {
    expect(packed.name).toBe('renor-engine');
    expect(manifest.license).toBe('Apache-2.0');
    // `renor` is the setup CLI on npm; a second package claiming that command would collide on a global install.
    expect(manifest.bin).toEqual({ 'renor-engine': 'dist/cli.js' });
    expect(fs.readFileSync(path.join(unpacked, manifest.bin['renor-engine']), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('is at or past the version NOTICE and the public README name as the first Apache-2.0 release', () => {
    // NOTICE says "<v> and later are Apache-2.0"; a packed version below <v> would ship Apache metadata on an AGPL-era number.
    const boundary = (text: string) => /(\d+\.\d+\.\d+) and later are\s+Apache-2\.0/.exec(text.replace(/\s+/g, ' '))?.[1];
    const notice = boundary(fs.readFileSync(path.join(unpacked, 'NOTICE'), 'utf8'));
    expect(notice).toBeDefined();
    // The private tree packs README.public.md; the public export renames it README.md (oss/public-files.txt).
    const readme = ['README.public.md', 'README.md'].map(name => path.join(unpacked, name)).find(file => fs.existsSync(file))!;
    expect(boundary(fs.readFileSync(readme, 'utf8'))).toBe(notice);
    const parts = (v: string) => v.split('-')[0].split('.').map(Number);
    const [have, need] = [parts(manifest.version), parts(notice!)];
    const cmp = have[0] - need[0] || have[1] - need[1] || have[2] - need[2];
    expect(cmp, `package ${manifest.version} is below NOTICE's Apache-2.0 boundary ${notice}`).toBeGreaterThanOrEqual(0);
  });

  it('packs the built output and the legal files, and nothing else', () => {
    const files = packed.files.map(file => file.path).sort();
    // npm adds every README* by itself; README.public.md exists only in the private tree (the public export renames it README.md).
    const stray = files.filter(file => !(file.startsWith('dist/') || ['LICENSE', 'NOTICE', 'README.md', 'README.public.md', 'package.json'].includes(file)));
    expect(stray, 'files outside the whitelist in the tarball').toEqual([]);
    for (const needed of ['dist/cli.js', 'dist/mcp/server.js', 'dist/memory/hiveNameHeader.cjs', 'LICENSE', 'NOTICE', 'README.md']) {
      expect(files, needed).toContain(needed);
    }
    // Compiled sources only: no tests, fixtures, maps, databases, environment files or dependency folders.
    const unwanted = files.filter(file => /(^|\/)(tests?|fixtures|node_modules|\.git)(\/|$)|\.(map|db|sqlite|log|env)$|(^|\/)\.env/.test(file));
    expect(unwanted).toEqual([]);
  });

  it('carries no private path or key-shaped text', () => {
    const problems: string[] = [];
    // An absolute home directory of anyone but the reviewed placeholder users, or a key-shaped string.
    const privateText = /(?<![\w.\/-])\/(?:home|Users)\/(?!(?:example|test|user|ana|you|yourname)\b)[A-Za-z]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[opusr]_[A-Za-z0-9]{20,}/;
    for (const file of walk(unpacked)) {
      const bytes = fs.readFileSync(file);
      if (bytes.includes(0)) continue;
      if (privateText.test(bytes.toString('utf8'))) problems.push(path.relative(unpacked, file));
    }
    expect(problems).toEqual([]);
  });

  it('names every runtime dependency its compiled code needs, so a registry install finds them', () => {
    // The unpacked package resolves its modules from this checkout's node_modules; a dependency missing from
    // "dependencies" would pass that and fail for a stranger. Every bare import in dist/ must be declared or built in.
    // An optional peer dependency (the local embedding model) is declared on purpose and imported only when asked for.
    const optionalPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => manifest.peerDependenciesMeta?.[name]?.optional);
    const declared = new Set([...Object.keys(manifest.dependencies), ...optionalPeers]);
    const builtins = new Set(builtinModules);
    const missing = new Set<string>();
    // tsc emits CommonJS: every import is a require("x") or a dynamic import("x"); `from "x"` also appears in prose strings.
    const importRe = /(?:require|import)\(\s*["']([^."'\/][^"']*)["']\s*\)/g;
    for (const file of walk(path.join(unpacked, 'dist')).filter(f => f.endsWith('.js') || f.endsWith('.cjs'))) {
      // Only the compiled code that `mcp` can reach is the product; eval tooling imports dev dependencies on purpose.
      if (file.includes(`${path.sep}dist${path.sep}eval${path.sep}`)) continue;
      for (const match of fs.readFileSync(file, 'utf8').matchAll(importRe)) {
        const spec = match[1];
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (name.startsWith('node:') || builtins.has(name) || declared.has(name)) continue;
        missing.add(`${name} (${path.relative(unpacked, file)})`);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});

describe('the optional local embedding model', () => {
  it('is left out of the install, and asking for it says what to add', () => {
    expect(manifest.dependencies['@xenova/transformers'], 'hundreds of megabytes would slow the first npx start past a client\'s connect timeout').toBeUndefined();
    // The compiled provider alone in a folder with no node_modules above it, as in an install without the peer.
    const bare = path.join(work, 'bare');
    fs.mkdirSync(bare);
    fs.copyFileSync(path.join(unpacked, 'dist/embeddings/local.js'), path.join(bare, 'local.js'));
    const run = spawnSync(process.execPath, ['-e',
      "new (require('./local.js').LocalEmbeddingProvider)().embed(['x']).then(() => console.log('NO ERROR'), e => console.log(e.message))"],
    { cwd: bare, encoding: 'utf8', timeout: 60_000 });
    expect(run.stdout).toMatch(/EMBEDDING_PROVIDER=local needs the optional package @xenova\/transformers/);
  });
});

describe('npx renor-engine mcp, from the unpacked tarball', () => {
  /** The package's bin, run as `npx` runs it: from a folder that is not the repository, with only a home directory. */
  async function session(env: Record<string, string>, home: string) {
    const bin = path.join(unpacked, manifest.bin['renor-engine']);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, 'mcp'],
      cwd: home,
      env: { HOME: home, USERPROFILE: home, ...env },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'renor-engine-pack-test', version: '1.0.0' });
    await client.connect(transport, PATIENTLY);
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, undefined, PATIENTLY) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return JSON.parse(result.content.find(item => item.type === 'text')!.text!);
    };
    return { client, call, close: () => client.close(), stderr: () => stderr };
  }

  it('announces the packed package.json version from the MCP server and the CLI', async () => {
    const bin = path.join(unpacked, manifest.bin['renor-engine']);
    const cli = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(cli.stdout.trim()).toBe(manifest.version);
    const home = scratch('renor-pack-version-');
    try {
      const { client, close } = await session({}, home);
      try {
        expect(client.getServerVersion()).toMatchObject({ name: 'renor', version: manifest.version });
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('with nothing set, remembers a fact in ~/.renor and recalls it', async () => {
    const home = scratch('renor-pack-home-');
    // A folder of the user's own named renor (a clone, say) must never be written into.
    fs.mkdirSync(path.join(home, 'renor'));
    fs.writeFileSync(path.join(home, 'renor', 'mine.md'), 'mine\n');
    try {
      const { call, close, stderr } = await session({}, home);
      try {
        await call('remember_fact', { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' });
        const found = await call('search', { query: "What is Ada's favorite color?" });
        expect(JSON.stringify(found).toLowerCase()).toContain('cerulean');
        expect(stderr(), 'the server says where the notes are').toContain(`Renor memory: ${path.join(home, '.renor')}`);
      } finally {
        await close();
      }
      const ledger = path.join(home, '.renor', 'System', 'Memory Events Ledger.md');
      expect(fs.existsSync(ledger), 'the default notes folder is ~/.renor').toBe(true);
      expect(fs.readdirSync(path.join(home, 'renor')), 'an existing renor folder is left alone').toEqual(['mine.md']);
      expect(fs.readFileSync(ledger, 'utf8').toLowerCase()).toContain('cerulean');
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }, BUDGET);

  it('with VAULT_PATH set, uses that folder and leaves ~/.renor alone', async () => {
    const home = scratch('renor-pack-home-');
    const vault = path.join(home, 'elsewhere');
    try {
      const { call, close, stderr } = await session({ VAULT_PATH: vault }, home);
      try {
        await call('remember_fact', { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' });
        expect(stderr()).not.toContain('Renor memory:');
      } finally {
        await close();
      }
      expect(fs.existsSync(path.join(vault, 'System', 'Memory Events Ledger.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.renor'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }, BUDGET);
});
