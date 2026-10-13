import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';

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
    console.error(`[mvp] compile cache not enabled (${reason}); the engine starts normally without it`);
  }
  return { enabled: false, directory: null, reason };
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
    return { enabled: false, directory: null, reason: 'MVP_COMPILE_CACHE_DIR is not set' };
  }
  // BEFORE mkdir and before enabling: a directory inside a data tree is skipped, never created.
  // loadMvpConfig still refuses the start with the full message afterwards.
  const overlap = compileCacheOverlap(explicit, {
    memoryDir: resolvedEnvPath('MVP_MEMORY_DIR'),
    historyDir: resolvedEnvPath('MVP_HISTORY_DIR'),
    authStatePath: resolvedEnvPath('MVP_AUTH_STATE_PATH'),
  });
  if (overlap !== null) {
    return { enabled: false, directory: null, reason: 'MVP_COMPILE_CACHE_DIR overlaps a data tree; no cache written' };
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
  return { enabled: true, directory: result.directory ?? explicit, reason: null };
}

/**
 * The directory this process is actually using, or undefined when no cache is
 * enabled. Read from Node rather than recomputed, so it reports the truth even
 * when NODE_COMPILE_CACHE was set in the environment and won.
 */
export function activeCompileCacheDir(): string | undefined {
  return module.getCompileCacheDir();
}
