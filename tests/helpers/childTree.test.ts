import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  execFileTree,
  killAllChildTrees,
  killTree,
  leakedChildGroups,
  liveChildGroups,
  spawnTree,
} from './childTree';

/**
 * The process-leak guard's own tests. It shipped with a filter that could never match and a
 * registry shared by every run on the machine, and nothing noticed, because the guard that was
 * supposed to notice had no test of its own.
 *
 * Each test gets a registry of its own: the guard of the run these tests are part of must not see a
 * child that a test starts on purpose, and a sweep that a test provokes must not leave a "leaked"
 * record in that run's registry.
 */

const ENGINE = path.resolve(__dirname, '../..');
const VITEST = path.join(ENGINE, 'node_modules/vitest/vitest.mjs');
const FIXTURE_CONFIG = path.join(ENGINE, 'tests/fixtures/child-tree/vitest.config.ts');

const NODE_SLEEP = ['-e', 'setTimeout(() => {}, 600000)'];
// A tsx-shaped pair: a supervisor and a grandchild that a SIGKILL of the supervisor alone leaves running.
const SUPERVISED = [
  '-e',
  `const { spawn } = require('child_process');
   const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
   console.log(g.pid);
   setTimeout(() => {}, 600000);`,
];

let registry: string;
let savedRegistry: string | undefined;
const started: ChildProcess[] = [];
const strays: number[] = [];
const scratch: string[] = [];

beforeEach(() => {
  savedRegistry = process.env.RENOR_CHILD_REGISTRY;
  registry = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-child-tree-test-'));
  process.env.RENOR_CHILD_REGISTRY = registry;
});

afterEach(() => {
  for (const child of started.splice(0)) killTree(child);
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (savedRegistry === undefined) delete process.env.RENOR_CHILD_REGISTRY;
  else process.env.RENOR_CHILD_REGISTRY = savedRegistry;
  fs.rmSync(registry, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // kill(0) also answers for a zombie that has not been reaped yet.
  try {
    return !/^Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, ''));
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/** A tsx-shaped child, up once the grandchild has reported its pid. */
async function startSupervised(): Promise<{ child: ChildProcess; grandchild: number }> {
  const child = spawnTree(process.execPath, SUPERVISED, { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  const grandchild = await new Promise<number>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
  return { child, grandchild };
}

describe('registering and signalling a child tree', () => {
  it("liveChildGroups(owner) returns the group spawnTree just created in that owner's own process", async () => {
    const child = spawnTree(process.execPath, NODE_SLEEP, { stdio: 'ignore' });
    started.push(child);
    const mine = liveChildGroups(process.pid);
    expect(mine.map((g) => g.pgid)).toEqual([child.pid]);
    // and a different owner does not claim it
    expect(liveChildGroups(process.pid + 1)).toEqual([]);
  });

  it('killTree reaches the supervisor AND the grandchild it wrapped, and drops the record', async () => {
    const { child, grandchild } = await startSupervised();
    expect(alive(grandchild)).toBe(true);
    expect(killTree(child)).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(await until(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(fs.readdirSync(registry)).toEqual([]);
    // the shape the leak had: signalling only the supervisor leaves the server running
    const pair = await startSupervised();
    pair.child.kill('SIGKILL');
    expect(await until(() => pair.child.signalCode !== null)).toBe(true);
    expect(alive(pair.grandchild)).toBe(true);
    // ...but the group is still addressable after its leader died, and still ours
    expect(liveChildGroups(process.pid).map((g) => g.pids)).toEqual([[pair.grandchild]]);
    expect(killTree(pair.child)).toBe(true);
    expect(await until(() => !alive(pair.grandchild))).toBe(true);
  });

  it('a signal other than SIGKILL keeps the record, so a child that ignores it is still named', async () => {
    const child = spawnTree(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 600000)"], { stdio: 'ignore' });
    started.push(child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    killTree(child, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(liveChildGroups(process.pid).map((g) => g.pgid)).toEqual([child.pid]);
  });

  it('killAllChildTrees kills what the owner still holds, returns how many, and records the leak first', async () => {
    const { child, grandchild } = await startSupervised();
    expect(killAllChildTrees('probe')).toBe(1);
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(await until(() => child.signalCode !== null)).toBe(true);
    expect(leakedChildGroups().map((g) => ({ pgid: g.pgid, reason: g.reason }))).toEqual([{ pgid: child.pid, reason: 'probe' }]);
    // nothing is left for a second sweep
    expect(killAllChildTrees('again')).toBe(0);
  });

  it('a sweep scoped to one owner leaves another owner’s children alone', async () => {
    const child = spawnTree(process.execPath, NODE_SLEEP, { stdio: 'ignore' });
    started.push(child);
    expect(killAllChildTrees('probe', 'SIGKILL', process.pid + 1)).toBe(0);
    expect(alive(child.pid!)).toBe(true);
  });
});

describe('identity: a group number is not enough', () => {
  it('does not report, and never signals, a recycled pgid that an unrelated process now holds', async () => {
    // A process of its own group that this registry never started: what a recycled pgid looks like.
    const stranger = spawn(process.execPath, NODE_SLEEP, { detached: true, stdio: 'ignore' });
    stranger.unref();
    strays.push(stranger.pid!);
    fs.writeFileSync(
      path.join(registry, `${process.pid}-stale`),
      JSON.stringify({ id: 'a-spawn-that-is-long-dead', owner: process.pid, pgid: stranger.pid, label: 'stale', cwd: ENGINE, at: '' }),
    );
    expect(liveChildGroups()).toEqual([]);
    expect(killAllChildTrees('probe', 'SIGKILL', null)).toBe(0);
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('killTree on a reaped child will not signal a group that no longer carries its id', async () => {
    const child = spawnTree(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    const stranger = spawn(process.execPath, NODE_SLEEP, { detached: true, stdio: 'ignore' });
    stranger.unref();
    strays.push(stranger.pid!);
    // Make the exited child's pid collide with the stranger's group, as a recycled pid would.
    Object.defineProperty(child, 'pid', { value: stranger.pid });
    expect(killTree(child)).toBe(false);
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('refuses pids that would signal the caller’s own group or every process', () => {
    expect(killTree({ pid: 0 } as unknown as ChildProcess)).toBe(false);
    expect(killTree({ pid: 1 } as unknown as ChildProcess)).toBe(false);
    expect(killTree({ pid: -5 } as unknown as ChildProcess)).toBe(false);
    expect(killTree({} as unknown as ChildProcess)).toBe(false);
  });

  it('spawnTree will not take a child out of its own process group', () => {
    expect(() => spawnTree(process.execPath, NODE_SLEEP, { detached: false })).toThrow(/own process group/);
  });
});

describe('execFileTree keeps what execFile promised', () => {
  it('kills a child that outlives `timeout`, even one that ignores SIGTERM', async () => {
    const child = execFileTree(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 600000)"], { timeout: 400 });
    started.push(child);
    expect(await until(() => child.exitCode !== null || child.signalCode !== null, 8_000)).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('kills a child that writes more than `maxBuffer`', async () => {
    const child = execFileTree(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 600000)"], { maxBuffer: 1000 });
    started.push(child);
    expect(await until(() => child.exitCode !== null || child.signalCode !== null, 8_000)).toBe(true);
  });

  it('drains stderr too, so a caller that reads neither cannot deadlock the child on a full pipe', async () => {
    const child = execFileTree(process.execPath, ['-e', "process.stderr.write('e'.repeat(300000)); process.stdout.write('o'.repeat(300000)); process.exit(0)"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    started.push(child);
    expect(await until(() => child.exitCode === 0, 8_000)).toBe(true);
  });

  it('still hands the caller every chunk it listens for', async () => {
    const child = execFileTree(process.execPath, ['-e', "console.error('hello from stderr'); setTimeout(() => process.exit(0), 100)"]);
    started.push(child);
    const seen: string[] = [];
    child.stderr!.on('data', (d: Buffer) => seen.push(String(d)));
    await new Promise((resolve) => child.once('exit', resolve));
    expect(seen.join('')).toContain('hello from stderr');
  });
});

describe('the run guard and the worker backstop, in a nested vitest run', () => {
  interface Nested {
    child: ChildProcess;
    output: () => string;
    exited: Promise<number | null>;
  }

  /** `tmp` is the TMPDIR of the run: two runs given the same one are two gates sharing a machine's /tmp. */
  function nested(env: Record<string, string>, tmp = sharedTmp()): Nested {
    const child = spawnTree(process.execPath, [VITEST, 'run', '--config', FIXTURE_CONFIG, '--maxWorkers=1'], {
      cwd: ENGINE,
      env: { ...process.env, TMPDIR: tmp, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(child);
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d));
    child.stderr!.on('data', (d: Buffer) => (out += d));
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
    return { child, output: () => out, exited };
  }

  function sharedTmp(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-child-tree-nested-'));
    scratch.push(tmp);
    return tmp;
  }

  function info(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-child-tree-info-'));
    scratch.push(dir);
    return path.join(dir, 'info.json');
  }

  const read = (file: string): { pgid: number; grandchild: number } => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('a run whose suite tears its child down exits 0 and leaves nothing', async () => {
    const file = info();
    const run = nested({ FIXTURE_MODE: 'clean', FIXTURE_INFO: file });
    expect(await run.exited, run.output()).toBe(0);
    expect(alive(read(file).grandchild)).toBe(false);
  }, 60_000);

  it('a run that leaks a child exits 1, names it, and leaves nothing running', async () => {
    const file = info();
    const run = nested({ FIXTURE_MODE: 'leak', FIXTURE_INFO: file });
    expect(await run.exited).toBe(1);
    expect(run.output()).toMatch(/outlived the test run/);
    expect(await until(() => !alive(read(file).grandchild))).toBe(true);
  }, 60_000);

  it('a leaking run still fails when another run starts and finishes while it is going (one registry per run)', async () => {
    const file = info();
    const tmp = sharedTmp();
    const leaking = nested({ FIXTURE_MODE: 'hold-then-leak', FIXTURE_HOLD_MS: '6000', FIXTURE_INFO: file }, tmp);
    expect(await until(() => fs.existsSync(file), 30_000)).toBe(true);
    const other = nested({ FIXTURE_MODE: 'clean', FIXTURE_INFO: info() }, tmp);
    expect(await other.exited, other.output()).toBe(0);
    expect(await leaking.exited, leaking.output()).toBe(1);
    expect(leaking.output()).toMatch(/outlived the test run/);
    expect(await until(() => !alive(read(file).grandchild))).toBe(true);
  }, 90_000);

  it('a real Ctrl-C mid-run (SIGINT to the whole process group) leaves zero orphans, by the worker backstop alone', async () => {
    const file = info();
    const run = nested({ FIXTURE_MODE: 'hold', FIXTURE_INFO: file, FIXTURE_GUARD: '0' });
    expect(await until(() => fs.existsSync(file), 30_000), run.output()).toBe(true);
    const { pgid, grandchild } = read(file);
    expect(alive(grandchild)).toBe(true);
    process.kill(-run.child.pid!, 'SIGINT'); // what a terminal does: the runner and its workers together
    await run.exited;
    expect(await until(() => !alive(grandchild), 10_000), run.output()).toBe(true);
    // Vitest drops a dying worker's stderr, so the proof that it was the backstop is its record: the
    // sweep writes it before it kills (the nested run has no guard and inherits this test's registry).
    expect(leakedChildGroups().map((g) => ({ pgid: g.pgid, reason: g.reason }))).toEqual([{ pgid, reason: 'SIGINT' }]);
  }, 90_000);
});
