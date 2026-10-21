import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Scratch in RAM, not on the SSD.
 *
 * Every test that needs a directory makes it with `mkdtemp` under `os.tmpdir()`, so where `TMPDIR` points is where the
 * suite writes. Pointed at a disk, a run writes every fixture database, ledger, git repository and index to the SSD:
 * SQLite alone dirties about 85 KB for each fact saved through `remember` (a page for the row and one for each index,
 * in the write-ahead log), and `tests/memory/lifecycle-replay-performance.test.ts` replays 11,000 events, 1.2 GB.
 * Almost all of it is deleted again within seconds, but a laptop's SSD is worn by what is written, not by what is kept.
 *
 * So when the run was given a temp directory on a disk and RAM can spare the room, this moves it to a directory of this
 * run's own under `/dev/shm`, exported through `TMPDIR`, `TMP` and `TEMP`. Vitest starts its workers after
 * `globalSetup`, so they and every process they start inherit it. It does nothing when
 *
 *  - the temp directory is already RAM (the shared gate helper, `agent:gate`, `/tmp` on a tmpfs),
 *  - `RENOR_TEST_SCRATCH=disk` asks for the old behaviour,
 *  - it is a CI run (`CI` is set): those disks are thrown away and nothing there wears out,
 *  - `/dev/shm` is missing, is not RAM, or is mounted `noexec` (a test runs the scripts it writes there), or has less than 2 GiB
 *    free, or the machine has less than 4 GiB available, or its mount table cannot be read.
 *
 * When it keeps the disk, one line on stderr says why.
 *
 * What the suite keeps in scratch at once is small (the largest file measured peaks at about 160 MB), so the room asked
 * for is a margin, not a need.
 *
 * Nothing is left behind. The directory is removed when the run ends; a run that was killed leaves its directory, and
 * the next run removes it, because each directory records the process that made it and that process's start time (a pid
 * alone is reused). A directory is only ever removed by the process that made it or by this sweep of dead ones.
 */

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;
const MIN_SHM_FREE_BYTES = 2 * 1024 ** 3;
const MIN_MEM_AVAILABLE_BYTES = 4 * 1024 ** 3;
/** A directory with no owner file this old was abandoned between its creation and the file (a few microseconds apart). */
const ABANDONED_AFTER_MS = 10 * 60 * 1000;
const OWNER_FILE = '.owner';

/** `RENOR_TEST_SCRATCH=disk`: leave `TMPDIR` as the run was given it. */
export const OPT_OUT_VAR = 'RENOR_TEST_SCRATCH';
/** Set when the temp directory was moved: the one the run was given. */
export const MOVED_FROM_VAR = 'RENOR_TEST_SCRATCH_FROM';

export interface Probes {
  env: NodeJS.ProcessEnv;
  tmpdir: string;
  shm: string;
  uid: number | null;
  /** The filesystem type and the free bytes of the filesystem `dir` is on; null when it cannot be read. */
  fsOf(dir: string): { type: number; freeBytes: number } | null;
  /** `MemAvailable` in bytes; null where the machine does not say. */
  memAvailableBytes(): number | null;
  /** The mount options of the mount `dir` is on; null where they cannot be read. */
  mountOptions(dir: string): string[] | null;
}

export type Plan =
  | {
      move: false;
      reason: 'opted-out' | 'ci' | 'tmpdir-unreadable' | 'already-ram' | 'no-shm' | 'shm-noexec' | 'mount-unknown' | 'shm-too-small' | 'memory-low';
    }
  | { move: true; base: string };

const isRam = (type: number): boolean => type === TMPFS_MAGIC || type === RAMFS_MAGIC;

export function planScratch(probes: Probes): Plan {
  if (probes.env[OPT_OUT_VAR] === 'disk') return { move: false, reason: 'opted-out' };
  const ci = probes.env.CI;
  if (ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false') return { move: false, reason: 'ci' };
  const here = probes.fsOf(probes.tmpdir);
  if (!here) return { move: false, reason: 'tmpdir-unreadable' };
  if (isRam(here.type)) return { move: false, reason: 'already-ram' };
  const shm = probes.fsOf(probes.shm);
  if (!shm || !isRam(shm.type)) return { move: false, reason: 'no-shm' };
  // The run's directories go under this base, and a test runs the scripts it writes there: the mount it is on must allow that.
  const base = path.join(probes.shm, `renor-vitest-${probes.uid ?? 'user'}`);
  const options = probes.mountOptions(base);
  if (!options) return { move: false, reason: 'mount-unknown' };
  if (options.includes('noexec')) return { move: false, reason: 'shm-noexec' };
  if (shm.freeBytes < MIN_SHM_FREE_BYTES) return { move: false, reason: 'shm-too-small' };
  const available = probes.memAvailableBytes();
  if (available !== null && available < MIN_MEM_AVAILABLE_BYTES) return { move: false, reason: 'memory-low' };
  return { move: true, base };
}

/** Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot. Null when there is no such process. */
export function startTicks(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is in parentheses and may hold spaces and parentheses; the fields after it are plain.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Removes the run directories under `base` whose process is gone; returns what it removed. A directory whose owner file
 * is missing or not yet complete (its maker is between two calls) is judged by its age instead, so a run that is
 * starting right now is never taken for a dead one.
 */
export function sweepDeadRuns(base: string, now: number = Date.now()): string[] {
  const removed: string[] = [];
  for (const name of fs.readdirSync(base)) {
    if (!/^run-\d+-/.test(name)) continue;
    const dir = path.join(base, name);
    try {
      let owner: string[] = [];
      try {
        owner = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').split('\n')[0].split(' ');
      } catch {
        // No owner file yet.
      }
      const [pid, ticks] = owner;
      const named = /^\d+$/.test(pid ?? '') && /^\d+$/.test(ticks ?? '');
      const dead = named ? startTicks(Number(pid)) !== ticks : now - fs.statSync(dir).mtimeMs > ABANDONED_AFTER_MS;
      if (!dead) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Another run removed it first, or it cannot be read: leave it to the next sweep.
    }
  }
  return removed;
}

/** A directory of this process's own under `base`, owner-only, after the dead runs' are swept. */
export function createRunDir(base: string, uid: number | null = process.getuid?.() ?? null): string {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  // /dev/shm is shared and world-writable: use the base only if it is a real directory that is ours.
  const info = fs.lstatSync(base);
  if (!info.isDirectory() || (uid !== null && info.uid !== uid)) throw new Error(`${base} is not a directory of this user`);
  sweepDeadRuns(base);
  const dir = fs.mkdtempSync(path.join(base, `run-${process.pid}-`));
  fs.writeFileSync(path.join(dir, OWNER_FILE), `${process.pid} ${startTicks(process.pid)}\n`);
  return dir;
}

/**
 * Moves `env`'s temp directory into RAM when the plan says to; returns the directory it made, or undefined. When it does not
 * move, `say` gets one line with the reason, unless the temp directory was RAM already.
 */
export function applyScratchPlan(probes: Probes, say: (line: string) => void = () => {}): string | undefined {
  const plan = planScratch(probes);
  if (!plan.move) {
    if (plan.reason !== 'already-ram') say(`ramScratch: scratch stays on disk (${plan.reason}): ${probes.tmpdir}`);
    return undefined;
  }
  let dir: string;
  try {
    dir = createRunDir(plan.base, probes.uid);
  } catch (error) {
    // No room to make one, or a base that is not ours: the run keeps the temp directory it was given.
    say(`ramScratch: scratch stays on disk (${(error as Error).message}): ${probes.tmpdir}`);
    return undefined;
  }
  probes.env[MOVED_FROM_VAR] = probes.tmpdir;
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) probes.env[name] = dir;
  return dir;
}

/**
 * The mount options of the mount `dir` is on, from the text of `/proc/self/mounts`: the entry whose mount point holds `dir`
 * and is the longest. Null when no entry does.
 */
export function mountOptionsIn(mounts: string, dir: string): string[] | null {
  let best: { at: string; options: string[] } | undefined;
  for (const line of mounts.split('\n')) {
    const [, mountPoint, , options] = line.split(' ');
    if (mountPoint === undefined || options === undefined) continue;
    // A space, tab, newline or backslash in a mount point is written as an octal escape.
    const at = mountPoint.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const holds = dir === at || dir.startsWith(at.endsWith('/') ? at : `${at}/`);
    if (holds && (best === undefined || at.length >= best.at.length)) best = { at, options: options.split(',') };
  }
  return best?.options ?? null;
}

export function realProbes(shm = '/dev/shm'): Probes {
  try {
    shm = fs.realpathSync(shm);
  } catch {
    // Leave an unavailable path for fsOf to reject without aborting setup.
  }
  return {
    env: process.env,
    tmpdir: os.tmpdir(),
    shm,
    uid: process.getuid?.() ?? null,
    fsOf(dir) {
      try {
        const stats = fs.statfsSync(dir);
        return { type: Number(stats.type), freeBytes: Number(stats.bavail) * Number(stats.bsize) };
      } catch {
        return null;
      }
    },
    memAvailableBytes() {
      try {
        const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1];
        return kb === undefined ? null : Number(kb) * 1024;
      } catch {
        return null;
      }
    },
    mountOptions(dir) {
      try {
        return mountOptionsIn(fs.readFileSync('/proc/self/mounts', 'utf8'), dir);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Names the temp directory by its real path, in `env`. macOS gives every process a TMPDIR under /var/folders, and /var is a
 * symlink to private/var, so a test that makes a directory there and hands it to code that refuses a path with a symlink in it
 * (the OAuth client store) fails for the platform and not for the code, and one that compares such a path with a realpath
 * fails the same way. `os.tmpdir()` reads TMPDIR first, so exporting the real path settles it for the workers and for every
 * process they start. A temp directory that is already its own real path, or that cannot be resolved, leaves `env` as it was.
 */
export function useRealTmpdir(env: NodeJS.ProcessEnv, tmpdir: string = os.tmpdir()): void {
  let real: string;
  try {
    real = fs.realpathSync(tmpdir);
  } catch {
    return;
  }
  if (real !== tmpdir) env.TMPDIR = real;
}

/** The directory this run made, and so the only one it may delete. */
let owned: string | undefined;

/** Runs before every other `globalSetup` file, so the child-process registry they make is in RAM as well. */
export function setup(): void {
  owned ??= applyScratchPlan(realProbes(), (line) => process.stderr.write(`${line}\n`));
  useRealTmpdir(process.env);
}

export function teardown(): void {
  if (owned) fs.rmSync(owned, { recursive: true, force: true });
  owned = undefined;
}
