import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Start the slowest test files first.
 *
 * With a few workers and one 100-second file, the order decides how long a run takes: start that file last and every other
 * worker sits idle for 100 seconds at the end. vitest's own sequencer already does this from its cache, but a fresh worktree or
 * a CI checkout has no cache, so every file ties and the order is alphabetical. This sequencer uses, in this order, for each file:
 *   1. a failure in the last run (vitest's cache), first of all, as vitest does;
 *   2. the duration vitest cached from the last run in this tree;
 *   3. the duration recorded in tests/setup/test-durations.json (the nightly run writes a fresh candidate), when there is one;
 *   4. for a file in neither (new since the record), UNKNOWN_SECONDS: early, but behind the files known to be slower.
 * Ties break on the path, so two runs of one tree start files in one order. It only orders: it selects nothing and skips nothing.
 *
 * It does not extend vitest's `BaseSequencer` at module level: `tests/globalSetup.test.ts` imports `vitest.config.ts`, and with it this
 * file, inside a test worker, where `vitest/node` has no business being loaded. Vitest asks a sequencer for `sort` and `shard`; `shard`
 * is delegated to the real thing when it is asked for.
 */
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UNKNOWN_SECONDS = 15;

let recordedFiles;
function recorded() {
  if (recordedFiles === undefined) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(engineRoot, 'tests', 'setup', 'test-durations.json'), 'utf8'));
      recordedFiles = parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {};
    } catch {
      recordedFiles = {};
    }
  }
  return recordedFiles;
}

/** Pure: the order for `specs`, given what is known about each. `known(spec)` is `{ failed, seconds, name }`, any may be missing. */
export function orderBySeconds(specs, known, unknownSeconds = UNKNOWN_SECONDS) {
  const keyed = specs.map((spec) => {
    const info = known(spec) ?? {};
    return { spec, failed: info.failed === true, seconds: Number.isFinite(info.seconds) ? info.seconds : unknownSeconds, name: String(info.name ?? '') };
  });
  keyed.sort((a, b) => Number(b.failed) - Number(a.failed) || b.seconds - a.seconds || a.name.localeCompare(b.name));
  return keyed.map(({ spec }) => spec);
}

export default class DurationSequencer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async shard(files) {
    const { BaseSequencer } = await import('vitest/node');
    return new BaseSequencer(this.ctx).shard(files);
  }

  async sort(files) {
    const root = this.ctx.config.root;
    const recordedSeconds = recorded();
    return orderBySeconds([...files], (spec) => {
      const relative = path.relative(root, spec.moduleId).split(path.sep).join('/');
      const cached = this.ctx.cache.getFileTestResults(`${spec.project.name}:${relative}`);
      // The record is keyed by path in the repository (`engine/tests/...`), wherever the engine sits (the public cut has it at the root).
      const seconds = cached ? cached.duration / 1000 : recordedSeconds[`engine/${relative}`];
      return { name: relative, failed: cached?.failed === true, seconds };
    });
  }
}
