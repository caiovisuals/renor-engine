import { killAllChildTrees } from '../helpers/childTree';

/**
 * The last-resort teardown for processes a test started.
 *
 * A per-file `afterEach` is the right place to tear a suite's children down, and every suite that
 * starts one now does. It is not enough on its own: when the runner itself is signalled — a gate
 * timeout, a Ctrl-C, `agent:gate` tearing its workers down — the `afterEach` never runs, and the
 * servers it would have killed stay up holding their ports for the rest of the machine's day.
 *
 * This runs in every worker (see `setupFiles` in `vitest.config.ts`) and kills whatever is still
 * registered, on each signal that can end a worker, and on a clean exit. It is a backstop: the
 * normal path is still each suite's own teardown, which is precise about what it started.
 */
let installed = false;

function sweep(reason: string): void {
  const killed = killAllChildTrees(reason, 'SIGKILL');
  if (killed > 0) {
    // Loud on purpose: a run that needed the backstop is a run whose teardown has a gap. The
    // record is written before the kill, so the vitest globalTeardown guard still fails the run.
    process.stderr.write(`[child-tree] worker backstop (${reason}) killed ${killed} leftover process group(s)\n`);
  }
}

export function installChildTreeBackstop(): void {
  if (installed) return;
  installed = true;

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      sweep(signal);
      // Re-raise with the default disposition so the runner still dies the way it was told to.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
  process.on('exit', () => sweep('exit'));
}

installChildTreeBackstop();
