import fs from 'fs';
import os from 'os';
import path from 'path';
import { describeLiveGroups, killGroup, leakedChildGroups, liveChildGroups, registryDir } from '../helpers/childTree';

/**
 * The guard: a run that leaves a process behind FAILS.
 *
 * Test runs used to exit 0 while leaving servers and fixture engines running on the machine that
 * ran them — re-parented to the systemd --user manager, holding loopback ports that a later run
 * then picks, and holding memory and tempdir space. Nothing failed, so nothing noticed: the cost
 * showed up much later as a flaky gate, or as a full /tmp.
 *
 * Every long-lived child a suite starts is registered in a registry that belongs to THIS run (a
 * fresh directory created below and handed to every worker through the environment, so two gates
 * running at once on one machine never see or delete each other's records) and dropped from it when
 * the suite tears the child down. This is the other end of that registry, and
 * it fails the run if anything is still there:
 *
 *  * a group still alive after the last worker exited, and
 *  * a group a worker backstop had to sweep, which is recorded *before* the kill — once the
 *    backstop has cleaned up there is nothing left to look at, so without the record a run that
 *    leaked would pass.
 *
 * Vitest 4 dropped `globalTeardown`; a file wired through `globalSetup` exports `setup` and
 * `teardown` instead, and that is what this file is.
 *
 * The check is deliberately narrow — only groups this run registered, only ones still alive, and a
 * zombie does not count — so a clean run cannot trip it.
 */

/** The directory this run created, and so the only one it may delete. */
let owned: string | undefined;

/** Give this run a registry of its own: fresh, empty, and never shared with another run. */
export function setup(): void {
  owned = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-child-registry-'));
  // Vitest starts its workers after globalSetup, so they inherit this.
  process.env.RENOR_CHILD_REGISTRY = owned;
}

const RECHECK_MS = 500;

/** Block this (otherwise idle) teardown for a moment so a group still shutting down can finish. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function teardown(): void {
  // Every worker has exited by now, so the whole registry is this guard's to read: no ownership
  // filter, because there is no worker left whose children these could be.
  let live = liveChildGroups();
  if (live.length > 0) {
    // A child whose suite just signalled it may still be shutting down: one bounded recheck, so the
    // verdict does not depend on how fast the last worker's children exited.
    pause(RECHECK_MS);
    live = liveChildGroups();
  }
  const swept = leakedChildGroups();
  const leftovers = [...live, ...swept];
  // Swept groups are already dead; what is still running is in `live`, and it is the guard's to
  // clean up so a failing run does not also leave the process behind.
  for (const group of live) killGroup(group, 'SIGKILL');
  if (owned && registryDir() === owned) fs.rmSync(owned, { recursive: true, force: true });
  if (leftovers.length === 0) return;

  const error = new Error(
    `${leftovers.length} process group(s) outlived the test run that started them. A suite started ` +
      `a child and never tore it down, so it was still holding its ports, memory and tempdir space ` +
      `on this machine when the run ended. Start it through spawnTree()/execFileTree() and tear it ` +
      `down with killTree() (see engine/tests/helpers/childTree.ts):\n` +
      `${describeLiveGroups(leftovers)}\n` +
      `If a suite deliberately leaves a child running past the run, that is a process for the ` +
      `machine's owner to manage, not for a test to strand: register it with spawnTree() anyway, and ` +
      `this guard will name it here on every run.`,
  );
  // Vitest logs a `globalSetup` teardown error and moves on — it does not fail the run for one, so
  // throwing alone leaves the gate green. The exit code is what makes this a gate failure; the
  // throw is what makes it impossible to miss in the log.
  process.exitCode = 1;
  throw error;
}
