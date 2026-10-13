import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression: a chat call must not be able to hang forever.
 *
 * Both benchmark runners build an `AbortController` per attempt and arm a timer
 * against it. The timer used to be cleared the moment response HEADERS arrived,
 * while the body was still being consumed. A provider that accepted the request
 * and then stalled mid-body left the fetch pending with no timeout, no retry and
 * no error row — the run wedged silently with the process parked in ep_poll and
 * zero open requests.
 *
 * Measured 2026-09-26: a full-500 arm wedged at case 201 for 45+ minutes.
 *
 * The invariant is structural, so it is asserted against the source text rather
 * than by racing a real socket: `clearTimeout(timer)` may only appear inside the
 * `finally` of the attempt, never between `fetch(...)` and the body read.
 */

const REPO_ROOT = process.cwd();

const RUNNERS = [
  'scripts/eval/run-longmemeval-product.ts',
  'scripts/eval/run-longmemeval-qa.ts',
] as const;

/** Slice the `chatCall` implementation out of a runner without a TS parser. */
function chatCallSource(relPath: string): string {
  const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const start = source.indexOf('async function chatCall(');
  if (start === -1) throw new Error(`chatCall not found in ${relPath}`);
  const end = source.indexOf('API failed after', start);
  if (end === -1) throw new Error(`chatCall end marker not found in ${relPath}`);
  return source.slice(start, end);
}

describe('chat-call abort timer: armed through the body read', () => {
  for (const runner of RUNNERS) {
    it(`${runner} clears the abort timer in finally, not on headers`, () => {
      const fn = chatCallSource(runner);

      // The fix: the timer outlives the headers and is cleared in `finally`.
      expect(fn).toMatch(/finally\s*\{\s*clearTimeout\(timer\);/);

      // The defect: clearing right after the fetch resolves, before the body is
      // consumed. This is the exact bytes that shipped before 2026-09-26.
      expect(fn).not.toMatch(/signal: controller\.signal,\s*\}\);\s*clearTimeout\(timer\);/);

      // The timer must be armed before the fetch that it guards. Arming it after
      // would leave a window with no timeout at all.
      const armedAt = fn.indexOf('setTimeout(() => controller.abort()');
      const fetchAt = fn.indexOf('await fetch(');
      expect(armedAt).toBeGreaterThan(-1);
      expect(fetchAt).toBeGreaterThan(-1);
      expect(armedAt).toBeLessThan(fetchAt);
    });

    it(`${runner} reads a failed response body defensively`, () => {
      const fn = chatCallSource(runner);
      // A non-ok status must not be able to throw a second time while reporting
      // the first failure — the abort timer is live during that read.
      expect(fn).toMatch(/await response\.text\(\)\.catch\(\(\) => ''\)/);
    });
  }
});
