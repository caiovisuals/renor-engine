#!/usr/bin/env node
/**
 * MVP ARTIFACT STARTUP PROOF — the alpha deploy shape, not a mock.
 *
 * Each alpha tenant is one systemd unit whose ExecStart is node on
 * dist/mvp/cli.js (engine/scripts/alpha/provision-renor-tenant.sh) with
 * WorkingDirectory set to a release dir of the engine. That is package.json's
 * "mvp" script without npm in front of it, and the check below asserts the two
 * spellings still agree. Today that release dir happens to get a FULL
 * `npm ci` (devDependencies included), so a devDependency on the start path is
 * invisible until someone installs production dependencies only (`npm ci
 * --omit=dev`, `npm prune --omit=dev`, a different deploy) — at which point the
 * unit carries a valid build stamp and still dies at startup.
 *
 * This script removes that crutch. It builds the real artifact shape:
 *
 *     <tmp>/dist/**            <- build output (incl. dist/BUILD.json)
 *     <tmp>/package.json       <- the shipped manifest
 *     <tmp>/package-lock.json
 *     <tmp>/node_modules/**    <- `npm ci --omit=dev` ONLY
 *
 * then launches the unit's exact start command (`node dist/mvp/cli.js`), over a
 * real loopback port, and asserts the service actually serves. It fails loudly when
 * the start path needs anything a production install does not carry — the
 * historical defect being `tsx` (a devDependency) on the start path.
 *
 * Requires network for `npm ci` and the engine devDependencies (tsc) installed
 * in the source tree. Exit code 0 = the artifact runs; 1 = it does not.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MVP_ENTRY_REL = join('dist', 'mvp', 'cli.js');
const STAMP_REL = join('dist', 'BUILD.json');
// Same path GET /api/health reads from the compiled product API (dist/api/server.js).
const BUILD_MANIFEST_READ_RE = /join\)\((root),\s*'dist',\s*'BUILD\.json'\)/;
const DISCOVERY_PATH = '/.well-known/oauth-authorization-server';
const MCP_PATH = '/mcp';
const START_TIMEOUT_MS = 60_000;
const OWNER_EMAIL = 'artifact-owner@example.test';
const OWNER_PASSWORD = 'synthetic-owner-secret-123';

let artifactDir = null;
process.on('exit', () => {
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
});

function log(step, msg) {
  console.log(`[mvp-artifact] ${step}: ${msg}`);
}

function die(msg) {
  console.error(`\n[mvp-artifact] FAIL: ${msg}\n`);
  process.exit(1);
}

/** npm, resolved through the npm that launched this script. Used for the install steps only. */
function npmInvocation(args) {
  const cli = process.env.npm_execpath;
  return cli && existsSync(cli) ? { cmd: process.execPath, args: [cli, ...args] } : { cmd: 'npm', args };
}

function run(label, argv, opts = {}) {
  log(label, argv.join(' '));
  const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', ...opts });
  if (res.error) die(`${label}: could not run ${argv[0]}: ${res.error.message}`);
  if (res.status !== 0) die(`${label}: ${argv.join(' ')} exited ${res.status}`);
}

function runNpm(label, args, opts = {}) {
  const { cmd, args: full } = npmInvocation(args);
  run(label, [cmd, ...full], opts);
}

function tail(lines, n) {
  return lines.slice(-n);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. Build the shipped output in the source tree: `npm run build` fires
  //    `prebuild` (scripts/ci/stamp-build.mjs) which writes dist/BUILD.json.
  //    --ignore-scripts=false is explicit: a user-level ~/.npmrc containing
  //    `ignore-scripts=true` silently suppresses pre/post lifecycle scripts and
  //    would leave the stamp unwritten — a stamp-less artifact must not pass.
  if (!existsSync(join(engineRoot, 'node_modules', 'typescript', 'bin', 'tsc'))) {
    die('engine devDependencies are missing (typescript not installed) — run `npm ci` in engine/ first');
  }
  runNpm('build', ['run', 'build', '--ignore-scripts=false'], { cwd: engineRoot });

  for (const rel of [MVP_ENTRY_REL, STAMP_REL]) {
    if (!existsSync(join(engineRoot, rel))) die(`the build did not emit ${rel}`);
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engineRoot, encoding: 'utf8' }).trim();
  const sourceStamp = JSON.parse(readFileSync(join(engineRoot, STAMP_REL), 'utf8'));
  if (sourceStamp.commit !== head) {
    die(`${STAMP_REL} reports commit ${sourceStamp.commit} but HEAD is ${head} — the stamp is not from this build`);
  }
  log('build', `${MVP_ENTRY_REL} + ${STAMP_REL} (commit ${head.slice(0, 12)}) emitted`);

  // 2. Assemble the artifact: build output (the shared CommonJS name reducer is copied into dist/memory by the build), manifest and lockfile.
  const lockPath = join(engineRoot, 'package-lock.json');
  if (!existsSync(lockPath)) die('engine/package-lock.json is missing — the artifact cannot be installed reproducibly');
  artifactDir = mkdtempSync(join(tmpdir(), 'renor-mvp-artifact-'));
  cpSync(join(engineRoot, 'dist'), join(artifactDir, 'dist'), { recursive: true });
  copyFileSync(join(engineRoot, 'package.json'), join(artifactDir, 'package.json'));
  copyFileSync(lockPath, join(artifactDir, 'package-lock.json'));
  log('artifact', `${artifactDir} (dist + package.json + package-lock.json, no TS application source, no node_modules)`);

  // 3. Install PRODUCTION dependencies only. Scripts stay enabled: deploy hosts
  //    build native deps (better-sqlite3), and skipping them would fail the
  //    service for a reason that has nothing to do with the start command.
  runNpm('install', ['ci', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], {
    cwd: artifactDir,
  });
  for (const rel of [join('node_modules', 'tsx'), join('node_modules', '.bin', 'tsx')]) {
    if (existsSync(join(artifactDir, rel))) {
      die(`the production artifact still ships ${rel} — the alpha start command must not depend on a devDependency`);
    }
  }
  for (const rel of [MVP_ENTRY_REL, STAMP_REL]) {
    if (!existsSync(join(artifactDir, rel))) die(`the artifact is missing ${rel}`);
  }
  // Dependencies the engine loads LAZILY (first token count, first OpenAI provider) are not
  // touched by startup, so a missing one would pass every check below and fail the first
  // request. Resolve them from the artifact, exactly as the engine will.
  const artifactRequire = createRequire(join(artifactDir, 'package.json'));
  for (const dep of ['gpt-tokenizer', 'openai']) {
    try {
      artifactRequire.resolve(dep);
    } catch {
      die(`the production artifact cannot resolve '${dep}', which the engine loads on first use rather than at startup`);
    }
  }

  // 4. The stamp must still be readable where the compiled code reads it.
  //
  //    The read moved: it used to be `join(__dirname, '..', 'BUILD.json')` inline in
  //    dist/api/server.js, and is now src/buildIdentity.ts's BUILD_MANIFEST_PATH, which
  //    resolves the package root and joins dist/BUILD.json so a source run and a compiled
  //    run both find it. The path therefore has to be checked where it now lives.
  //
  //    This check was STALE and failing on main (it asserted on a literal that stopped
  //    being emitted), which means the artifact's build stamp had not actually been proven
  //    present-and-findable since the read moved. It is repaired here rather than deleted:
  //    the property it protects — a stamped artifact whose stamp is where the code looks —
  //    is the whole reason this script exists, and a check that cannot run must be fixed,
  //    not dropped.
  const stampInArtifact = join(artifactDir, STAMP_REL);
  const buildIdentityJs = readFileSync(join(artifactDir, 'dist', 'buildIdentity.js'), 'utf8');
  if (!BUILD_MANIFEST_READ_RE.test(buildIdentityJs)) {
    die(`dist/buildIdentity.js no longer resolves dist/BUILD.json — this stamp assertion is stale, fix the check`);
  }
  // That the compiled code READS this stamp is proved at runtime, step 5: GET /version must
  // answer with this HEAD's commit. (A path comparison here would be a no-op: the stamp path is
  // joined from the same two parts on both sides.)
  // And the stamp must name the tree it ships with, not a build of something else.
  const artifactStamp = JSON.parse(readFileSync(stampInArtifact, 'utf8'));
  if (artifactStamp.commit !== head) {
    die(`${STAMP_REL} in the artifact reports commit ${artifactStamp.commit} but HEAD is ${head}`);
  }
  log('stamp', `${STAMP_REL} present, names commit ${head.slice(0, 12)}, and is where dist/buildIdentity.js reads it`);

  // 5. Launch the unit's EXACT start command.
  //
  // That command is now node on dist/mvp/cli.js, with no npm in front of it
  // (engine/scripts/alpha/provision-renor-tenant.sh renders the unit body, and
  // package.json's "mvp" script is the same `node dist/mvp/cli.js`). Running
  // npm here would test a command no workspace runs any more, so it would stop
  // proving the thing this script exists to prove.
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const memoryDir = join(artifactDir, 'runtime', 'memory');
  const authStatePath = join(artifactDir, 'runtime', 'auth', 'clients.json');
  // This workspace's own compile cache, in its own private state tree — the same
  // layout the provisioner creates. The artifact directory stands in for
  // /var/lib/renor/<slug>, so the cache is a SIBLING of memory, exactly as in
  // production, and the engine's refusal of a cache inside a data tree is
  // exercised rather than assumed.
  const cacheDir = join(artifactDir, 'runtime', 'cache', 'compile');
  // 0700: the service refuses to start on a world/group-readable memory or
  // client-registry directory (fail closed), and that is not this test's subject.
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(authStatePath), { recursive: true, mode: 0o700 });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MVP_')));
  // Deploy-like PATH: nothing from the source tree. `npm run` used to put the
  // invoking package's node_modules/.bin on PATH; with the unit ExecStarting node
  // directly that never happens in production, and this harness must not leak
  // this tree's devDependencies (tsx) into an artifact that must not have them.
  const sourceTreePath = (process.env.PATH ?? '')
    .split(':')
    .filter((entry) => entry && !resolve(entry).startsWith(engineRoot));
  Object.assign(childEnv, {
    // Pin the child to the Node that built this artifact's native deps.
    PATH: [dirname(process.execPath), ...sourceTreePath].join(':'),
    MVP_MEMORY_DIR: memoryDir,
    MVP_AUTH_STATE_PATH: authStatePath,
    MVP_COMPILE_CACHE_DIR: cacheDir,
    MVP_BASE_URL: baseUrl,
    MVP_PORT: String(port),
    MVP_OWNER_EMAIL: OWNER_EMAIL,
    MVP_OWNER_PASSWORD: OWNER_PASSWORD,
    MVP_EMBEDDING_PROVIDER: 'none',
  });
  // Assert the command this harness is about to run IS the command the unit
  // renders, so the two cannot drift apart silently: the unit body is generated
  // from `npm run mvp`'s definition, and a change to either one must be a
  // deliberate change to both.
  const manifest = JSON.parse(readFileSync(join(artifactDir, 'package.json'), 'utf8'));
  const mvpScript = manifest.scripts?.mvp ?? '';
  if (mvpScript !== `node ${MVP_ENTRY_REL}`) {
    die(`package.json's "mvp" script is \`${mvpScript}\`, but the unit ExecStarts \`node ${MVP_ENTRY_REL}\` `
      + '— the deploy start command and the artifact proof must be the same command');
  }
  const cmd = process.execPath;
  const args = [MVP_ENTRY_REL];
  log('start', `${cmd} ${args.join(' ')} (cwd=${artifactDir}, port=${port})`);
  const child = spawn(cmd, args, { cwd: artifactDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  const capture = (stream) => (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      output.push(`[mvp ${stream}] ${line}`);
      console.log(`[mvp ${stream}] ${line}`);
    }
  };
  child.stdout.on('data', capture('out'));
  child.stderr.on('data', capture('err'));
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  let served = null;
  let lastError = 'no response yet';
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      die(
        `the start command exited (code=${exited.code}, signal=${exited.signal}) before serving — the artifact does not run.\n`
        + `Last output:\n${tail(output, 12).join('\n')}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}${DISCOVERY_PATH}`, { headers: { accept: 'application/json' } });
      if (res.status === 200) {
        served = await res.json();
        break;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(250);
  }
  if (!served) die(`no service on ${baseUrl}${DISCOVERY_PATH} within ${START_TIMEOUT_MS}ms (last: ${lastError})`);
  // The SDK normalizes the configured issuer to a URL href, so compare hrefs.
  if (served.issuer !== new URL(baseUrl).href) {
    die(`OAuth discovery reported issuer ${served.issuer}, expected ${new URL(baseUrl).href} — that is not this instance`);
  }
  log('http', `GET ${DISCOVERY_PATH} -> 200 (issuer ${served.issuer})`);

  // The running engine must report the build identity this artifact was stamped with: this is
  // what proves dist/BUILD.json is where the compiled code reads it.
  const versionRes = await fetch(`${baseUrl}/version`);
  const version = versionRes.status === 200 ? await versionRes.json() : null;
  if (!version || version.commit !== head) {
    die(`GET /version -> ${versionRes.status} ${JSON.stringify(version)}, expected commit ${head}: the engine does not read this artifact's stamp`);
  }
  log('http', `GET /version -> 200 (commit ${head.slice(0, 12)})`);

  // The MCP surface is mounted and fails CLOSED: no bearer, no session.
  const mcpRes = await fetch(`${baseUrl}${MCP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  if (mcpRes.status !== 401) {
    die(`unauthenticated POST ${MCP_PATH} returned ${mcpRes.status}, expected 401 (fail closed)`);
  }
  log('http', `POST ${MCP_PATH} (no bearer) -> 401`);

  const banner = output.some((l) => l.includes('[mvp] Memory directory'));
  if (!banner) die(`the compiled CLI banner never appeared — dist/mvp/cli.js did not run.\n${tail(output, 12).join('\n')}`);
  log('start', 'compiled CLI ran (startup banner observed)');

  child.kill('SIGTERM');
  const killed = Date.now() + 10_000;
  while (!exited && Date.now() < killed) await delay(100);
  if (!exited) {
    child.kill('SIGKILL');
    die('the service did not exit on SIGTERM within 10s');
  }
  log('shutdown', `exited (code=${exited.code}, signal=${exited.signal}) on SIGTERM`);

  console.log(
    `\n[mvp-artifact] PASS — \`node ${MVP_ENTRY_REL}\` served ${baseUrl} from an artifact carrying build output +`
    + ` production dependencies only (no tsx), stamped at commit ${head.slice(0, 12)}.\n`,
  );
}

main().catch((err) => die(err instanceof Error ? err.stack ?? err.message : String(err)));
