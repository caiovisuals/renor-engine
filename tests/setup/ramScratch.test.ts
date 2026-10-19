import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../../vitest.config';
import { applyScratchPlan, createRunDir, MOVED_FROM_VAR, mountOptionsIn, OPT_OUT_VAR, planScratch, startTicks, sweepDeadRuns, useRealTmpdir, type Probes } from './ramScratch';

/**
 * The scratch placement (ramScratch.ts): a run whose temp directory is on a disk writes its fixtures to RAM instead, when
 * RAM can spare the room. These tests give the decision every reason to move and then take the reasons away one at a
 * time, and run the move itself against a directory standing in for /dev/shm, so nothing here depends on the machine
 * that runs them. The run's own scratch is checked at the end: whatever this machine decided, it must be consistent.
 */

const TMPFS = 0x01021994;
const RAMFS = 0x858458f6;
const EXT4 = 0xef53;
const BTRFS = 0x9123683e;
const GiB = 1024 ** 3;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A machine where the move is right: the temp directory is on btrfs, /dev/shm is a roomy tmpfs, memory is plentiful. */
type Machine = Partial<Probes> & { tmpFs?: number; shmFs?: number | null; shmFree?: number };
function machine(over: Machine = {}): Probes {
  const { tmpFs = BTRFS, shmFs = TMPFS, shmFree = 8 * GiB, ...rest } = over;
  const shm = rest.shm ?? '/dev/shm';
  const tmpdir = rest.tmpdir ?? '/home/user/.cache/gate-tmp/run-1';
  return {
    env: {},
    tmpdir,
    shm,
    uid: 1000,
    fsOf: (dir) => (dir === tmpdir ? { type: tmpFs, freeBytes: 100 * GiB } : dir === shm && shmFs !== null ? { type: shmFs, freeBytes: shmFree } : null),
    memAvailableBytes: () => 16 * GiB,
    mountOptions: () => ['rw', 'nosuid', 'nodev'],
    ...rest,
  };
}

describe('planScratch: when a run moves to RAM', () => {
  it('moves when its temp directory is on a disk and /dev/shm is a roomy tmpfs', () => {
    expect(planScratch(machine())).toEqual({ move: true, base: '/dev/shm/renor-vitest-1000' });
    expect(planScratch(machine({ tmpFs: EXT4 }))).toMatchObject({ move: true });
  });

  it('does not move when the temp directory is already RAM', () => {
    expect(planScratch(machine({ tmpFs: TMPFS }))).toEqual({ move: false, reason: 'already-ram' });
    expect(planScratch(machine({ tmpFs: RAMFS }))).toEqual({ move: false, reason: 'already-ram' });
  });

  it('does not move when RENOR_TEST_SCRATCH=disk asks for the old behaviour', () => {
    expect(planScratch(machine({ env: { [OPT_OUT_VAR]: 'disk' } }))).toEqual({ move: false, reason: 'opted-out' });
    // Any other value is the default.
    expect(planScratch(machine({ env: { [OPT_OUT_VAR]: 'ram' } }))).toMatchObject({ move: true });
  });

  it('does not move in a CI run, whose disk is thrown away', () => {
    expect(planScratch(machine({ env: { CI: 'true' } }))).toEqual({ move: false, reason: 'ci' });
    expect(planScratch(machine({ env: { CI: '1' } }))).toEqual({ move: false, reason: 'ci' });
    // CI=0 and CI=false are how a shell says "not CI".
    expect(planScratch(machine({ env: { CI: '0' } }))).toMatchObject({ move: true });
    expect(planScratch(machine({ env: { CI: 'false' } }))).toMatchObject({ move: true });
    expect(planScratch(machine({ env: { CI: '' } }))).toMatchObject({ move: true });
  });

  it('does not move when /dev/shm is missing or is not RAM', () => {
    expect(planScratch(machine({ shmFs: null }))).toEqual({ move: false, reason: 'no-shm' });
    expect(planScratch(machine({ shmFs: EXT4 }))).toEqual({ move: false, reason: 'no-shm' });
  });

  it('does not move when /dev/shm has less than 2 GiB free, and moves at exactly 2 GiB', () => {
    expect(planScratch(machine({ shmFree: 2 * GiB - 1 }))).toEqual({ move: false, reason: 'shm-too-small' });
    expect(planScratch(machine({ shmFree: 2 * GiB }))).toMatchObject({ move: true });
  });

  it('does not move when the machine has less than 4 GiB of memory available, and moves at exactly 4 GiB', () => {
    expect(planScratch(machine({ memAvailableBytes: () => 4 * GiB - 1 }))).toEqual({ move: false, reason: 'memory-low' });
    expect(planScratch(machine({ memAvailableBytes: () => 4 * GiB }))).toMatchObject({ move: true });
    // A machine that does not say how much is available is not refused on that account.
    expect(planScratch(machine({ memAvailableBytes: () => null }))).toMatchObject({ move: true });
  });

  it('does not move when the temp directory cannot be read', () => {
    expect(planScratch(machine({ fsOf: () => null }))).toEqual({ move: false, reason: 'tmpdir-unreadable' });
  });

  it('does not move when the mount the base is on is noexec, since a test runs the scripts it writes there', () => {
    expect(planScratch(machine({ mountOptions: () => ['rw', 'nosuid', 'nodev', 'noexec'] }))).toEqual({ move: false, reason: 'shm-noexec' });
    expect(planScratch(machine({ mountOptions: () => ['rw', 'nosuid', 'nodev'] }))).toMatchObject({ move: true });
  });

  it('reads the mount options of the base under /dev/shm', () => {
    const asked: string[] = [];
    planScratch(
      machine({
        mountOptions: (dir) => {
          asked.push(dir);
          return ['rw'];
        },
      }),
    );
    expect(asked).toEqual(['/dev/shm/renor-vitest-1000']);
  });

  it('does not move when the mount table cannot be read, since it cannot say whether scripts can run there', () => {
    expect(planScratch(machine({ mountOptions: () => null }))).toEqual({ move: false, reason: 'mount-unknown' });
  });
});

describe('mountOptionsIn: the options of the mount a directory is on', () => {
  // The text of /proc/self/mounts: device, mount point, type, options, dump and pass.
  const table = [
    '/dev/root / ext4 rw,relatime 0 0',
    'tmpfs /dev/shm tmpfs rw,nosuid,nodev,noexec,relatime 0 0',
    'tmpfs /run/user/1000 tmpfs rw,nosuid,nodev 0 0',
    '/dev/sdb1 /mnt/with\\040space ext4 rw 0 0',
    '',
  ].join('\n');

  it('takes the mount the directory is on, the one with the longest mount point', () => {
    expect(mountOptionsIn(table, '/dev/shm/renor-vitest-1000')).toEqual(['rw', 'nosuid', 'nodev', 'noexec', 'relatime']);
    expect(mountOptionsIn(table, '/run/user/1000/x')).toEqual(['rw', 'nosuid', 'nodev']);
    expect(mountOptionsIn(table, '/home/user/.cache')).toEqual(['rw', 'relatime']);
  });

  it('uses the last entry when a mount point is stacked', () => {
    const tmpfs = 'tmpfs /mnt/data tmpfs rw,nosuid 0 0';
    const ext4 = '/dev/sdb1 /mnt/data ext4 rw,relatime 0 0';
    expect(mountOptionsIn([tmpfs, ext4].join('\n'), '/mnt/data/file')).toEqual(['rw', 'relatime']);
    expect(mountOptionsIn([ext4, tmpfs].join('\n'), '/mnt/data/file')).toEqual(['rw', 'nosuid']);
  });

  it('does not take a mount point that is only the start of the directory name', () => {
    expect(mountOptionsIn(table, '/dev/shmx/a')).toEqual(['rw', 'relatime']);
  });

  it('reads the octal escape a space in a mount point is written as', () => {
    expect(mountOptionsIn(table, '/mnt/with space/x')).toEqual(['rw']);
  });

  it('is null when no mount holds the directory', () => {
    expect(mountOptionsIn('', '/dev/shm')).toBeNull();
  });
});

describe('applyScratchPlan: the move itself', () => {
  /** A directory standing in for /dev/shm, with the machine's other answers as in `machine()`. */
  function withShm(over: Machine = {}) {
    const shm = tmp('ram-scratch-shm-');
    const home = tmp('ram-scratch-home-');
    const env: NodeJS.ProcessEnv = { TMPDIR: home, TMP: home, TEMP: home };
    const probes = machine({ shm, tmpdir: home, uid: process.getuid?.() ?? null, env, ...over });
    return { shm, home, env, probes };
  }

  it('points TMPDIR, TMP and TEMP at a directory of its own under /dev/shm, and says where it came from', () => {
    const { shm, home, env, probes } = withShm();
    const dir = applyScratchPlan(probes)!;
    expect(dir).toBeDefined();
    expect(path.dirname(dir)).toBe(path.join(shm, `renor-vitest-${process.getuid?.()}`));
    expect(path.basename(dir)).toMatch(new RegExp(`^run-${process.pid}-`));
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([dir, dir, dir]);
    expect(env[MOVED_FROM_VAR]).toBe(home);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, '.owner'), 'utf8')).toBe(`${process.pid} ${startTicks(process.pid)}\n`);
  });

  it('leaves the environment alone when the plan is not to move', () => {
    const { home, env, probes } = withShm({ tmpFs: TMPFS });
    expect(applyScratchPlan(probes)).toBeUndefined();
    expect(env).toEqual({ TMPDIR: home, TMP: home, TEMP: home });
  });

  it('leaves the environment alone when the base under /dev/shm belongs to someone else', () => {
    const { home, env, probes } = withShm({ uid: (process.getuid?.() ?? 0) + 1 });
    expect(applyScratchPlan(probes)).toBeUndefined();
    expect(env).toEqual({ TMPDIR: home, TMP: home, TEMP: home });
  });

  it('leaves the environment alone when the base is not a directory (a link someone planted in the shared /dev/shm)', () => {
    const { shm, home, env, probes } = withShm();
    const target = tmp('ram-scratch-elsewhere-');
    fs.symlinkSync(target, path.join(shm, `renor-vitest-${process.getuid?.()}`));
    expect(applyScratchPlan(probes)).toBeUndefined();
    expect(env).toEqual({ TMPDIR: home, TMP: home, TEMP: home });
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('leaves the environment alone and says why in one line when the base is on a noexec mount', () => {
    const { home, env, probes } = withShm({ mountOptions: () => ['rw', 'noexec'] });
    const lines: string[] = [];
    expect(applyScratchPlan(probes, (line) => lines.push(line))).toBeUndefined();
    expect(env).toEqual({ TMPDIR: home, TMP: home, TEMP: home });
    expect(lines).toEqual([`ramScratch: scratch stays on disk (shm-noexec): ${home}`]);
  });

  it('says why in one line when the run directory cannot be made, and keeps the disk', () => {
    const { home, env, probes } = withShm({ uid: (process.getuid?.() ?? 0) + 1 });
    const lines: string[] = [];
    expect(applyScratchPlan(probes, (line) => lines.push(line))).toBeUndefined();
    expect(env).toEqual({ TMPDIR: home, TMP: home, TEMP: home });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ramScratch: scratch stays on disk \(.+ is not a directory of this user\): /);
    expect(lines[0].endsWith(`: ${home}`)).toBe(true);
  });

  it('says nothing when it moves, or when the temp directory was RAM already', () => {
    const lines: string[] = [];
    expect(applyScratchPlan(withShm().probes, (line) => lines.push(line))).toBeDefined();
    expect(applyScratchPlan(withShm({ tmpFs: TMPFS }).probes, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

describe('sweepDeadRuns: a killed run does not keep RAM', () => {
  const base = () => tmp('ram-scratch-base-');
  const run = (parent: string, name: string, owner?: string) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'scratch.db'), 'x');
    if (owner !== undefined) fs.writeFileSync(path.join(dir, '.owner'), owner);
    return dir;
  };

  it('removes the directory of a process that is gone, and keeps the directory of one that is running', () => {
    const parent = base();
    const mine = run(parent, `run-${process.pid}-aaaaaa`, `${process.pid} ${startTicks(process.pid)}\n`);
    const gone = run(parent, 'run-999999999-bbbbbb', `999999999 ${startTicks(process.pid)}\n`);
    expect(sweepDeadRuns(parent)).toEqual([gone]);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('takes a reused pid for a dead run: the pid is alive but it started at another time', () => {
    const parent = base();
    const reused = run(parent, `run-${process.pid}-cccccc`, `${process.pid} ${Number(startTicks(process.pid)) + 1}\n`);
    expect(sweepDeadRuns(parent)).toEqual([reused]);
  });

  it('judges a directory with no complete owner file by its age', () => {
    const parent = base();
    const empty = run(parent, 'run-111-dddddd');
    const partial = run(parent, 'run-222-eeeeee', '222');
    const now = Date.now();
    // Just made: its maker may be about to write the file.
    expect(sweepDeadRuns(parent, now)).toEqual([]);
    expect(fs.existsSync(empty) && fs.existsSync(partial)).toBe(true);
    // Abandoned for longer than a run takes to write one file.
    expect(sweepDeadRuns(parent, now + 11 * 60 * 1000).sort()).toEqual([empty, partial].sort());
  });

  it('touches nothing that is not a run directory', () => {
    const parent = base();
    const other = path.join(parent, 'keep-me');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(parent, 'run-notes.txt'), 'x');
    expect(sweepDeadRuns(parent, Date.now() + 24 * 60 * 60 * 1000)).toEqual([]);
    expect(fs.existsSync(other) && fs.existsSync(path.join(parent, 'run-notes.txt'))).toBe(true);
  });

  it('createRunDir sweeps the dead before it makes its own', () => {
    const parent = base();
    const gone = run(parent, 'run-999999999-ffffff', '999999999 1\n');
    const made = createRunDir(parent);
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(made)).toBe(true);
  });
});

describe('useRealTmpdir: the temp directory by its real path', () => {
  // macOS: TMPDIR is /var/folders/..., and /var is a symlink to private/var.
  const linked = () => {
    const home = tmp('real-tmpdir-');
    fs.mkdirSync(path.join(home, 'real', 'T'), { recursive: true });
    fs.symlinkSync('real', path.join(home, 'link'));
    return { real: fs.realpathSync(path.join(home, 'real')), link: path.join(home, 'link') };
  };

  it('replaces a TMPDIR that crosses a symlink with the real path', () => {
    const { real, link } = linked();
    const env: NodeJS.ProcessEnv = { TMPDIR: link };
    useRealTmpdir(env, link);
    expect(env.TMPDIR).toBe(real);
  });

  it('follows a symlink that is only part of the path', () => {
    const { real, link } = linked();
    const env: NodeJS.ProcessEnv = { TMPDIR: path.join(link, 'T') };
    useRealTmpdir(env, env.TMPDIR);
    expect(env.TMPDIR).toBe(path.join(real, 'T'));
  });

  it('leaves the environment exactly as it was when the temp directory is already real, set or not', () => {
    const { real } = linked();
    const set: NodeJS.ProcessEnv = { TMPDIR: real };
    useRealTmpdir(set, real);
    expect(set).toEqual({ TMPDIR: real });
    const unset: NodeJS.ProcessEnv = {};
    useRealTmpdir(unset, real);
    expect(unset).toEqual({});
  });

  it('leaves the environment alone when the temp directory cannot be resolved', () => {
    const missing = path.join(tmp('real-tmpdir-'), 'gone');
    const env: NodeJS.ProcessEnv = { TMPDIR: missing };
    useRealTmpdir(env, missing);
    expect(env).toEqual({ TMPDIR: missing });
  });

  it('is what this run did: os.tmpdir() is its own real path, so a test never starts from a symlinked temp directory', () => {
    expect(os.tmpdir()).toBe(fs.realpathSync(os.tmpdir()));
  });
});

describe('the suite is wired to it', () => {
  it('lists the placement before the other setup files, since the child-process registry they make goes under TMPDIR', () => {
    const entries = [config.test?.globalSetup ?? []].flat().map((entry) => path.basename(entry));
    expect(entries.indexOf('ramScratch.ts')).toBe(0);
    expect(entries).toContain('orphanGuard.ts');
  });

  it('keeps this run\'s scratch in RAM whenever the run was moved', ({ skip }) => {
    const from = process.env[MOVED_FROM_VAR];
    // Not moved: the temp directory was RAM already, or this machine could not spare the room.
    if (from === undefined) skip();
    const here = os.tmpdir();
    expect(here).not.toBe(from);
    expect(here.startsWith(`/dev/shm/renor-vitest-${process.getuid?.()}/run-`)).toBe(true);
    const type = Number(fs.statfsSync(here).type);
    expect([TMPFS, RAMFS]).toContain(type);
    expect(process.env.TMP).toBe(here);
    expect(process.env.TEMP).toBe(here);
  });
});
