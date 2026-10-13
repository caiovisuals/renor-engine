import fs from 'fs';
import path from 'path';

/**
 * A cross-process gate over the shared build manifest (`<engine>/dist/BUILD.json`).
 *
 * Some fixture tests have to install a manifest at the REAL location and watch the live
 * `/version` route answer it, so the path cannot be redirected the way a database or a fixture
 * directory can. That makes it a shared resource: two suite runs on one host both walk up to the
 * same file, and whichever stashes the other's manifest mid-window reads the other's fixture
 * instead of the stamp it wrote. The loser's stash is then the loser's, so the file is left
 * holding a hostile fixture after the run — a poisoning that outlives the process that caused it
 * and fails a later, innocent run.
 *
 * So the manifest is claimed for the whole window that needs it, the way a port block claims its
 * ports: the claim is a file the kernel creates exclusively, so two processes cannot both hold it,
 * and a holder that died without releasing does not wedge every later run.
 *
 * A live holder is waited for; a holder that is gone is displaced. The wait is bounded, because
 * waiting forever is how a lane stalls for hours — the caller fails and names the holder instead.
 */

interface Claim {
  /** Give the manifest back now. Idempotent. */
  release(): void;
}

/** True when `pid` is a process this machine still has, seen through signal 0. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claims the exclusive right to read and write the manifest at `manifestPath`, held until the
 * returned claim is released. `timeoutMs` bounds the wait for another run to finish with it.
 */
export async function claimManifest(manifestPath: string, timeoutMs = 180_000): Promise<Claim> {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const gate = path.join(dir, `${path.basename(manifestPath)}.manifest-gate`);
  const deadline = Date.now() + timeoutMs;
  let waited = 0;

  for (;;) {
    let held = false;
    try {
      // wx: fails when the file exists, atomically, so exactly one process gets through.
      const fd = fs.openSync(gate, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}`);
      } finally {
        fs.closeSync(fd);
      }
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (held) {
      return {
        release: () => {
          try {
            fs.rmSync(gate, { force: true });
          } catch {
            // Best effort: the next run displaces a stale gate by pid anyway.
          }
        },
      };
    }

    let holder: number | null = null;
    try {
      holder = Number(fs.readFileSync(gate, 'utf8').trim()) || null;
    } catch {
      // The holder released between our failed claim and this read: loop and claim.
    }
    if (holder !== null && holder !== process.pid && !alive(holder)) {
      // Its holder is gone, so whatever it was protecting is not being protected any more.
      fs.rmSync(gate, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the build manifest ${manifestPath} is held by process ${holder ?? '(unknown)'}, which is still running, ` +
          `and did not release it within ${timeoutMs} ms. Another suite run is using the shared ` +
          `manifest; wait for it, or remove ${gate} if that process is gone.`,
      );
    }
    await sleep(100);
    waited += 100;
  }
}
