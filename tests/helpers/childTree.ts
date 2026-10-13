import { execFileSync, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Child processes a test starts, isolated so teardown can be sure it reached them.
 *
 * Two defects made test runs leave processes behind on the machine that ran them, all of them
 * re-parented to the systemd --user manager and still holding their loopback ports:
 *
 *  1. `node_modules/.bin/tsx` is a SUPERVISOR: it spawns the real
 *     `node --require tsx/preflight.cjs --import tsx/loader.mjs <entry>` as its own child.
 *     A teardown that does `child.kill('SIGKILL')` reaches only the supervisor — SIGKILL cannot
 *     be caught, so it cannot be relayed, and the server it wrapped keeps running. This leaked
 *     two gateway servers per run of the tests that start one, on runs that exited 0.
 *  2. A child spawned without `detached` inherits the test runner's process group, so nothing
 *     can be signalled as a unit: `child.kill()` is per-pid, and a signal aimed at the runner's
 *     group would also hit the runner.
 *
 * `spawnTree` puts every child in its OWN process group (`detached: true`, so the child is a
 * group leader and its pgid equals its pid) and `killTree` signals that whole group. Every
 * descendant inherits the group, so one call reaches the supervisor and everything below it,
 * signal choice aside.
 *
 * Every live group is also written to a registry that belongs to ONE run (see {@link registryDir})
 * and that the worker backstop and the vitest `globalSetup` guard read, so an interrupted run (a
 * gate timeout, a Ctrl-C) is still torn down, and a run that somehow did not tear down FAILS
 * instead of leaking silently.
 *
 * Identity. A process-group id is only a number, and the kernel recycles it. Nothing here signals
 * a group on the strength of the number: each child is started with a random `RENOR_CHILD_TREE_ID`
 * in its environment, which every descendant inherits, and a group counts as ours only while one
 * of its live members still carries that id (read from /proc/<pid>/environ). A recycled pgid
 * belonging to an unrelated process carries no such id and is left alone.
 */

const ID_VAR = 'RENOR_CHILD_TREE_ID';
const HAS_PROC = fs.existsSync('/proc/self/environ');

let fallbackDir: string | undefined;

/**
 * Where this run's registry lives.
 *
 * `globalSetup` (tests/setup/orphanGuard.ts) creates a directory owned by the run and exports it as
 * `RENOR_CHILD_REGISTRY`, which every worker inherits — so the registry is per run, never shared
 * with another gate on the machine. A process that uses the helper outside that setup gets a
 * private directory of its own instead of any well-known path.
 */
export function registryDir(): string {
  const fromEnv = process.env.RENOR_CHILD_REGISTRY;
  if (fromEnv) return fromEnv;
  fallbackDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'renor-child-registry-'));
  return fallbackDir;
}

interface RecordFile {
  id: string;
  owner: number;
  pgid: number;
  label: string;
  cwd: string;
  at: string;
  leaked?: true;
  reason?: string;
}

interface StoredRecord extends RecordFile {
  file: string;
}

let seq = 0;
const ids = new WeakMap<ChildProcess, string>();

function writeRecord(record: RecordFile): void {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(path.join(registryDir(), `${process.pid}-${seq++}`), JSON.stringify(record));
  } catch {
    // The guard is a backstop, not the mechanism: never fail a test because it could not register.
  }
}

function readRecords(): StoredRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  const out: StoredRecord[] = [];
  for (const entry of entries) {
    const file = path.join(registryDir(), entry);
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RecordFile>;
      if (typeof r.pgid === 'number' && typeof r.owner === 'number' && typeof r.id === 'string') {
        out.push({
          file,
          id: r.id,
          owner: r.owner,
          pgid: r.pgid,
          label: typeof r.label === 'string' ? r.label : 'unknown',
          cwd: typeof r.cwd === 'string' ? r.cwd : '',
          at: typeof r.at === 'string' ? r.at : '',
          ...(r.leaked ? { leaked: true as const, reason: typeof r.reason === 'string' ? r.reason : 'swept' } : {}),
        });
      }
    } catch {
      // A half-written record is not a live child; it is dropped with the run's directory.
    }
  }
  return out;
}

/** A registered process group that still has a running member this run started. */
export interface LiveGroup {
  pgid: number;
  id: string;
  label: string;
  cwd: string;
  pids: number[];
}

/** pgid -> its non-zombie pids, from one `ps`. A zombie answers kill(0) but is not running. */
function membersByPgid(): Map<number, number[]> {
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 20_000 });
  } catch {
    return new Map();
  }
  const byPgid = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!m || m[3].startsWith('Z')) continue;
    const key = Number(m[2]);
    const list = byPgid.get(key);
    if (list) list.push(Number(m[1]));
    else byPgid.set(key, [Number(m[1])]);
  }
  return byPgid;
}

/** Does this pid carry the id of the child that started it? Unreadable means "not provably ours". */
function carries(pid: number, id: string): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`${ID_VAR}=${id}`);
  } catch {
    return false;
  }
}

/** The members of `pgid` that are provably descendants of the spawn that was given `id`. */
function ownMembers(pgid: number, id: string, byPgid: Map<number, number[]>): number[] {
  const pids = byPgid.get(pgid) ?? [];
  // Without /proc there is no way to tell, so fall back to the number (this host is Linux).
  return HAS_PROC ? pids.filter((pid) => carries(pid, id)) : pids;
}

/** Every registered process group of this run that is still running (one owner, or all of them). */
export function liveChildGroups(ownerPid?: number): LiveGroup[] {
  const byPgid = membersByPgid();
  const live: LiveGroup[] = [];
  for (const r of readRecords()) {
    if (r.leaked || (ownerPid !== undefined && r.owner !== ownerPid)) continue;
    const pids = ownMembers(r.pgid, r.id, byPgid);
    if (pids.length > 0) live.push({ pgid: r.pgid, id: r.id, label: r.label, cwd: r.cwd, pids });
  }
  return live;
}

/**
 * Groups a sweep had to kill because nothing else did, i.e. children that outlived their suite.
 *
 * The evidence is written *before* the kill: once the backstop has cleaned up there is nothing left
 * for the guard to observe, so a run that leaked would pass. Recording at sweep time is what lets
 * the guard still fail the run after the machine has been left clean.
 */
export interface LeakedGroup {
  pgid: number;
  label: string;
  cwd: string;
  reason: string;
  at: string;
}

/** Every group a sweep in this run had to clean up (one owner, or all of them). */
export function leakedChildGroups(ownerPid?: number): LeakedGroup[] {
  return readRecords()
    .filter((r) => r.leaked && (ownerPid === undefined || r.owner === ownerPid))
    .map((r) => ({ pgid: r.pgid, label: r.label, cwd: r.cwd, reason: r.reason ?? 'swept', at: r.at }));
}

function label(cmd: string, args: readonly string[]): string {
  return [path.basename(cmd), ...args].join(' ').slice(0, 200);
}

/**
 * Spawn a long-lived child in its own process group, registered so the run can prove it died.
 *
 * `detached: true` is the whole point: it makes the child a process-group leader, so `-pid`
 * addresses its group and every descendant it spawns (including the process tsx supervises) is
 * reachable by one signal. `stdio` must be piped by the caller for output to be readable, exactly
 * as with `spawn`. The child is `unref`'d so a leaked one cannot hold a worker open; its pipes still
 * keep the event loop alive while a caller is reading them.
 */
export function spawnTree(cmd: string, args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
  if (opts.detached === false) throw new Error('spawnTree always detaches the child into its own process group');
  const id = randomUUID();
  const child = spawn(cmd, args as string[], {
    ...opts,
    detached: true,
    env: { ...(opts.env ?? process.env), [ID_VAR]: id },
  });
  child.unref();
  ids.set(child, id);
  if (child.pid !== undefined) {
    writeRecord({ id, owner: process.pid, pgid: child.pid, label: label(cmd, args), cwd: process.cwd(), at: new Date().toISOString() });
  }
  return child;
}

const TERM_GRACE_MS = 2_000;

/**
 * `execFile` without a callback, in its own process group. Same contract as {@link spawnTree}, plus
 * what `execFile` guaranteed and a callback-less caller still relies on:
 *
 *  - `timeout`: the group is signalled with `killSignal` (SIGTERM) when it fires, and SIGKILLed if
 *    it ignores that, so a hung child cannot outlive its bound.
 *  - `maxBuffer` (default 1 MiB, as in `execFile`): a child that writes more than that to stdout or
 *    to stderr is killed rather than left running unbounded.
 *  - both pipes are drained, so a caller that reads only one of them cannot deadlock the child on
 *    a full 64 KiB pipe. Data listeners the caller adds in the same tick still see every chunk.
 *  - `encoding` is applied to the streams the caller reads.
 *
 * It is `spawn` underneath, not `execFile`, because `execFile` silently drops `detached`.
 */
export function execFileTree(cmd: string, args: readonly string[], opts: ExecFileOptions = {}): ChildProcess {
  const { timeout = 0, maxBuffer = 1024 * 1024, killSignal = 'SIGTERM', encoding, ...rest } = opts;
  const child = spawnTree(cmd, args, rest as SpawnOptions);
  const timers: NodeJS.Timeout[] = [];
  const stop = (): void => {
    killTree(child, killSignal as NodeJS.Signals);
    const escalate = setTimeout(() => killTree(child, 'SIGKILL'), TERM_GRACE_MS);
    escalate.unref();
    timers.push(escalate);
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    if (encoding && encoding !== 'buffer') stream.setEncoding(encoding as BufferEncoding);
    let seen = 0;
    stream.on('data', (chunk: Buffer | string) => {
      seen += chunk.length;
      if (seen > maxBuffer) {
        seen = Number.NEGATIVE_INFINITY; // kill once, not on every later chunk
        stop();
      }
    });
  }
  if (timeout > 0) {
    const timer = setTimeout(stop, timeout);
    timer.unref();
    timers.push(timer);
  }
  child.once('close', () => timers.forEach(clearTimeout));
  return child;
}

/**
 * Signal a child's whole process group, whatever signal it takes.
 *
 * The group is the target, not the pid: that is what reaches a supervised grandchild. It is only
 * signalled when it is provably this child's: while the leader is still unreaped its pid cannot
 * have been recycled; after that, the group must still hold a process carrying the child's id. A
 * SIGKILL also drops the child's registry record (it is torn down); any other signal keeps it, so
 * a child that ignores SIGTERM is still named by the guard.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  const pgid = child.pid;
  // 0 would signal the caller's own group and 1 every process the user owns: never reachable
  // through spawn, but this is exported infrastructure.
  if (pgid === undefined || pgid <= 1) return false;
  const leaderUnreaped = child.exitCode === null && child.signalCode === null;
  const id = ids.get(child);
  let signalled = false;
  if (leaderUnreaped || (id !== undefined && ownMembers(pgid, id, membersByPgid()).length > 0)) {
    try {
      process.kill(-pgid, signal);
      signalled = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH' && leaderUnreaped) {
        try {
          signalled = child.kill(signal);
        } catch {
          // fall through: nothing more can be done for this child
        }
      }
    }
  }
  if (signal === 'SIGKILL') forgetTree(child);
  return signalled;
}

/** Drop a child's registry record without signalling it (it exited on its own). */
export function forgetTree(child: ChildProcess): void {
  const id = ids.get(child);
  if (id === undefined) return;
  for (const r of readRecords()) {
    if (r.id === id && !r.leaked) fs.rmSync(r.file, { force: true });
  }
}

/** Signal one live group, but only through members that still carry its id. */
export function killGroup(group: LiveGroup, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (group.pgid <= 1) return;
  if (ownMembers(group.pgid, group.id, membersByPgid()).length === 0) return; // gone, or not ours any more
  try {
    process.kill(-group.pgid, signal);
  } catch {
    for (const pid of group.pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone between the scan and here.
      }
    }
  }
}

/**
 * Kill every group a given owner (default: this process) registered and still holds.
 *
 * Scoped to the owner on purpose: the registry is one directory shared by every worker of the run,
 * so a sweep that ignored ownership would have whichever worker exited first kill the children of
 * every worker still running its tests. `null` means every owner; only the guard at the end of the
 * run uses it, because by then no worker is using the registry.
 *
 * This is the backstop for the paths a per-file `afterEach` cannot reach: a gate timeout or a Ctrl-C
 * that kills the runner before teardown, and a test body still running after its own timeout fired.
 */
export function killAllChildTrees(
  reason = 'swept',
  signal: NodeJS.Signals = 'SIGKILL',
  ownerPid: number | null = process.pid,
): number {
  const live = liveChildGroups(ownerPid ?? undefined);
  for (const group of live) {
    writeRecord({ id: group.id, owner: ownerPid ?? process.pid, pgid: group.pgid, label: group.label, cwd: group.cwd, at: new Date().toISOString(), leaked: true, reason });
    killGroup(group, signal);
  }
  return live.length;
}

/** Human-readable lines for the guard's failure message: what it is, where, and which pids. */
export function describeLiveGroups(groups: (LiveGroup | LeakedGroup)[]): string {
  return groups
    .map((g) => {
      const pids = 'pids' in g ? g.pids.join(',') : 'already swept';
      const when = 'at' in g && g.at ? ` first seen ${g.at}` : '';
      return `  pgid ${g.pgid} (${pids}) cwd ${g.cwd}${when}\n    ran: ${g.label}`;
    })
    .join('\n');
}
