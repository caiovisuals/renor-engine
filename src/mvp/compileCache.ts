import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { createLogger } from './log';

const log = createLogger('engine');

/**
 * This workspace's own Node compile cache, enabled before anything heavy loads.
 *
 * WHY IT IS HERE AND NOT IN cli.ts: cli.ts's own imports are resolved before any
 * statement in it runs, so a call there would enable the cache AFTER the modules
 * that dominate a cold start had already been compiled. This module is imported
 * first for its side effect, and nothing heavy is imported above it.
 *
 * WHY IT IS PER WORKSPACE: the cache is a write. Two workspaces sharing one
 * directory would be one workspace's engine creating files another workspace's
 * engine owns, which on a host where each workspace runs as its own OS account is
 * a cross-tenant write channel. The directory therefore comes from
 * MVP_COMPILE_CACHE_DIR, which provision-renor-tenant.sh derives per workspace
 * (`/var/lib/renor/<slug>/cache/compile`) rather than from a shared value. With the
 * variable unset there is NO cache: nothing is derived from MVP_MEMORY_DIR.
 *
 * WHY IT IS NEVER IN A DATA TREE: a cache directory that overlaps the memory,
 * history or auth trees is neither created nor enabled here (Node writes its
 * entries at exit, so enabling first would leave them behind even though
 * loadMvpConfig then refuses the start), because those trees are indexed,
 * exported, or hold client secrets.
 *
 * WHY A FAILURE IS NOT FATAL: this is a speed optimisation, not a correctness
 * input. Node's own contract for enableCompileCache is to report rather than
 * throw, and the engine must start on a read-only or unwritable cache dir, on a
 * Node build without compile-cache support, and with NODE_DISABLE_COMPILE_CACHE=1.
 * A refusal is reported once, on stderr, and startup continues — measurably
 * slower on some hosts, never wrong.
 */

/** Reported once per process, and only when the cache was not enabled. */
let reported = false;

export interface CompileCacheReport {
  enabled: boolean;
  /** The directory Node is using, when it accepted one. */
  directory: string | null;
  /** Why it was not used, when it was not. */
  reason: string | null;
  /** How many entries were copied in from the release's seed (0 when the cache already held entries or there is no seed). */
  seeded: number;
}

/** The data trees a compile cache must be disjoint from, in both directions. */
export interface CompileCacheTrees {
  memoryDir: string | null;
  historyDir: string | null;
  authStatePath: string | null;
}

/**
 * Why `dir` may not be a compile cache, or null when it may.
 *
 * ONE implementation, used twice: here, BEFORE the directory is created and the cache enabled
 * (a refused start must leave nothing behind in a data tree: Node writes its entries at process
 * exit, including the exit after a refusal), and by loadMvpConfig, which turns it into the
 * startup refusal. Dependency-free on purpose: this module runs before anything heavy loads.
 */
export function compileCacheOverlap(dir: string, trees: CompileCacheTrees): string | null {
  const inside = (a: string, b: string) => a !== b && b.startsWith(a + path.sep);
  const overlapsEither = (a: string, b: string) => a === b || inside(a, b) || inside(b, a);
  const labelled: Array<[string, string | null]> = [
    ['the fact memory directory (MVP_MEMORY_DIR)', trees.memoryDir],
    ['the promoted history directory (MVP_HISTORY_DIR)', trees.historyDir],
    ['the OAuth client registry (MVP_AUTH_STATE_PATH)', trees.authStatePath],
  ];
  for (const [label, tree] of labelled) {
    if (tree && overlapsEither(dir, tree)) {
      return `MVP_COMPILE_CACHE_DIR (${dir}) must not be equal to, contain, or sit inside ${label}. `
        + 'It is a rebuildable cache of compiled code, not user data, and a cache inside a data tree '
        + 'would be indexed, exported, or shipped with the workspace.';
    }
  }
  return null;
}

function resolvedEnvPath(name: string): string | null {
  const raw = (process.env[name] ?? '').trim();
  return raw === '' ? null : path.resolve(raw);
}

/**
 * Why an EXISTING cache directory may not be used, or null. A cache is loaded as code, so it
 * must be a real directory (not a symlink) that only this process's user can write: a
 * group- or world-writable one lets another account plant what this engine compiles from.
 */
function unsafeExistingDir(dir: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    return `cannot inspect ${dir} (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  if (st.isSymbolicLink()) return `${dir} is a symlink`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if ((st.mode & 0o022) !== 0) {
    return `${dir} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  }
  if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) {
    return `${dir} is owned by another user (uid ${st.uid})`;
  }
  return null;
}

function declined(reason: string): CompileCacheReport {
  if (!reported) {
    reported = true;
    log.warn('compile_cache_off', { reason, detail: 'the engine starts normally without it' });
  }
  return { enabled: false, directory: null, reason, seeded: 0 };
}

/**
 * The release's compile-cache seed, copied into this workspace's own (empty) cache.
 *
 * WHY: Node keys a cache entry by the file's path, so every release path starts a workspace's cache empty
 * (provision-renor-tenant.sh empties it when the pin moves), and the first wake after each release compiled the whole
 * module graph again: about 400 ms of CPU on the harness's small workspace, which a hosted unit's CPUQuota stretches to
 * about twice that in wall time. deploy-remote.sh runs `dist/mvp/compileSeed.js` once per release, at the release's final
 * path, into `<release>/.compile-seed`; the engine copies those entries into the cache it owns when that cache is empty.
 *
 * WHY A COPY AND NOT A SHARED CACHE: the per-workspace cache above is one account's own write. Pointing every workspace at
 * the release's directory would make it a shared one (or a read of one whose owner is another account). The copy keeps the
 * invariant: the engine only ever loads code from a directory it owns, which only it can write, and that the seed
 * filled before the first start.
 *
 * WHAT IS TRUSTED: only a seed directory that root (or this very account) owns and no group or other can write, holding
 * regular files, in the sub-directory Node names for this Node build and V8 flags (it ends in the owner's uid; the build
 * account's uid is not this workspace's, so the name is compared without it). Anything else is not read. A failure is
 * never fatal: the cache fills as it always did.
 */
const SEED_ENTRY = /^[0-9a-f]{8}$/;
const MAX_SEED_ENTRIES = 4096;
const MAX_SEED_ENTRY_BYTES = 32 * 1024 * 1024;

/** The directory deploy-remote.sh seeds for the release this code runs from, unless MVP_COMPILE_SEED_DIR names another. */
export function releaseSeedDir(): string {
  const explicit = resolvedEnvPath('MVP_COMPILE_SEED_DIR');
  return explicit ?? path.resolve(__dirname, '..', '..', '.compile-seed');
}

function trustedSeedDir(dir: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) !== 0) return false;
  const me = typeof process.geteuid === 'function' ? process.geteuid() : st.uid;
  return st.uid === 0 || st.uid === me;
}

/** `v22.23.2-x64-9de703df-1000` -> `v22.23.2-x64-9de703df`: Node's cache sub-directory without the uid it ends in. */
function withoutUid(name: string): string | null {
  const m = /^(v[0-9][\w.]*-[\w]+-[0-9a-f]+)-\d+$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Copy the seed into `target` (the versioned directory Node is using) when it holds no entries. Returns how many entries
 * were copied. An entry that is half written (a start killed during the copy) is rejected by Node's own checksum and compiled again.
 */
function seedFromRelease(target: string): number {
  try {
    const seedRoot = releaseSeedDir();
    if (!trustedSeedDir(seedRoot)) return 0;
    const want = withoutUid(path.basename(target));
    if (want === null) return 0;
    const sub = fs.readdirSync(seedRoot).find(name => withoutUid(name) === want);
    if (sub === undefined) return 0;
    const from = path.join(seedRoot, sub);
    if (!trustedSeedDir(from)) return 0;
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (fs.readdirSync(target).length > 0) return 0; // this workspace already has its own entries: never mix
    let copied = 0;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (!entry.isFile() || !SEED_ENTRY.test(entry.name)) continue;
      if (copied >= MAX_SEED_ENTRIES) break;
      const src = path.join(from, entry.name);
      if (fs.statSync(src).size > MAX_SEED_ENTRY_BYTES) continue;
      // Straight to the final name: Node checks each entry's size and checksum before it uses one and compiles again when
      // they do not match, so an entry a killed start left half written costs a compile, never a wrong result. A temporary
      // name and a rename would add 30 ms of syscalls for 588 entries.
      fs.copyFileSync(src, path.join(target, entry.name), fs.constants.COPYFILE_EXCL);
      copied++;
    }
    return copied;
  } catch {
    return 0; // a speed optimisation: whatever went wrong, the engine starts and fills its cache as it always did
  }
}

/**
 * Enable the cache and report what Node decided. Safe to call more than once;
 * Node returns ALREADY_ENABLED and the first directory wins.
 *
 * Only an EXPLICIT MVP_COMPILE_CACHE_DIR enables a cache. There is deliberately no derived
 * default: a directory worked out from MVP_MEMORY_DIR can land in a shared place (a memory
 * directory of /tmp/x derives /tmp/cache/compile), and a shared compile cache is a cross-user
 * write. The provisioner names a per-workspace directory in every env file it writes.
 */
export function enableWorkspaceCompileCache(): CompileCacheReport {
  const explicit = resolvedEnvPath('MVP_COMPILE_CACHE_DIR');
  if (explicit === null) {
    return { enabled: false, directory: null, reason: 'MVP_COMPILE_CACHE_DIR is not set', seeded: 0 };
  }
  // BEFORE mkdir and before enabling: a directory inside a data tree is skipped, never created.
  // loadMvpConfig still refuses the start with the full message afterwards.
  const overlap = compileCacheOverlap(explicit, {
    memoryDir: resolvedEnvPath('MVP_MEMORY_DIR'),
    historyDir: resolvedEnvPath('MVP_HISTORY_DIR'),
    authStatePath: resolvedEnvPath('MVP_AUTH_STATE_PATH'),
  });
  if (overlap !== null) {
    return { enabled: false, directory: null, reason: 'MVP_COMPILE_CACHE_DIR overlaps a data tree; no cache written', seeded: 0 };
  }
  if (typeof module.enableCompileCache !== 'function') {
    return declined('this Node build has no module.enableCompileCache');
  }
  // Create it here rather than trusting it to exist: the engine is the thing that writes into
  // it, and a 0700 directory it owns is the narrowest grant that lets it. mkdir with recursive
  // ignores EEXIST, so this is idempotent. A failure is not fatal: the checks below report it.
  try {
    fs.mkdirSync(explicit, { recursive: true, mode: 0o700 });
  } catch {
    // Reported through the checks below; nothing to add here.
  }
  const unsafe = unsafeExistingDir(explicit);
  if (unsafe !== null) return declined(unsafe);
  const result = module.enableCompileCache(explicit);
  const accepted = result.status === module.constants.compileCacheStatus.ENABLED
    || result.status === module.constants.compileCacheStatus.ALREADY_ENABLED;
  if (!accepted) {
    return declined(result.status === module.constants.compileCacheStatus.DISABLED
      ? 'disabled by NODE_DISABLE_COMPILE_CACHE'
      : result.message ?? `status ${result.status}`);
  }
  const directory = result.directory ?? explicit;
  return { enabled: true, directory, reason: null, seeded: seedFromRelease(module.getCompileCacheDir() ?? directory) };
}
