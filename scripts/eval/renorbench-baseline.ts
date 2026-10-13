import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { sha256 } from '../../src/eval/artifacts';
import {
  CHUNK_ARM,
  DEFAULT_BASE_REF,
  RENORBENCH_ARMS,
  checkWithMergeBase,
  loadRunDir,
  parseBaseline,
  planRecord,
  readBaseline,
  readMergeBaseState,
  type BaselineCheck,
  type MergeBaseState,
  type RenorBenchArm,
  type RenorBenchBaseline,
} from '../../src/eval/renorbenchBaseline';

/**
 * `check <runDir>`   compare a hash RenorBench run with the committed baseline AND with the baseline the
 *                    merge-base (origin/main) has, whichever is stricter. Exit 0 equal or better (or lower
 *                    with a recorded deliberate lowering), 1 a tracked quality metric dropped, 2 the
 *                    baseline, the merge-base or the run cannot be compared (fails closed).
 * `record <runDir>`  write the baseline from a clean-tree hash run. A deliberate act: --reason is stored
 *                    in the file and a lower score needs --accept-lower, which writes the `lowering` record
 *                    the check then looks for.
 * `--arm chunk|product|product-v2|documents` says which arm's baseline the run is held to (default chunk, the arm the gate has
 *                    always checked); a run of another arm is refused, never judged by this arm's metrics.
 * The JSON verdict goes to stdout in both cases; the agent gate parses it.
 */
const EXIT_REGRESSED = 1;
const EXIT_INCOMPARABLE = 2;

const program = new Command().name('renorbench-baseline')
  .option('--arm <arm>', `which arm: ${RENORBENCH_ARMS.map(arm => arm.name).join(', ')} (chunk is the retrieval hits; product and product-v2 are the search_memory reply on the v1 and the v2 suite; documents is whether a probed section of a handbook-style note reaches the reply)`, CHUNK_ARM.name)
  .option('--baseline <path>', "baseline file (default: the arm's committed baseline)")
  .option('--base-ref <ref>', 'the ref whose merge-base holds the floor', DEFAULT_BASE_REF)
  // Tests only: the gate never passes it. `none` = the baseline file is new on the base.
  .option('--merge-base-baseline <path|none>', 'read the merge-base baseline from this file instead of git');

/** The arm `--arm` names; anything else is refused before any file is read. */
function selectedArm(): RenorBenchArm {
  const name = program.opts<{ arm: string }>().arm;
  const arm = RENORBENCH_ARMS.find(candidate => candidate.name === name);
  if (!arm) fail(`--arm must be ${RENORBENCH_ARMS.map(candidate => candidate.name).join(' or ')}, not ${name}`, EXIT_INCOMPARABLE);
  return arm;
}

function baselineFileOf(arm: RenorBenchArm): string {
  return path.resolve(program.opts<{ baseline?: string }>().baseline ?? arm.baselineRelativePath);
}

function mergeBaseState(baselineFile: string, arm: RenorBenchArm): MergeBaseState {
  const { baseRef, mergeBaseBaseline } = program.opts<{ baseRef: string; mergeBaseBaseline?: string }>();
  if (mergeBaseBaseline === undefined) return readMergeBaseState(baselineFile, baseRef, arm);
  if (mergeBaseBaseline === 'none') return { kind: 'new' };
  try {
    const text = fs.readFileSync(mergeBaseBaseline, 'utf8');
    return { kind: 'file', baseline: parseBaseline(text, mergeBaseBaseline, arm), sha256: sha256(Buffer.from(text)) };
  } catch (err) {
    return { kind: 'unavailable', problem: `cannot read the merge-base baseline override: ${(err as Error).message}` };
  }
}

function fail(problem: string, exitCode: number): never {
  const check: BaselineCheck = { ok: false, verdict: 'INCOMPARABLE', problem, regressed: [], improved: [], categoryRegressions: [], metrics: [] };
  console.log(JSON.stringify(check, null, 2));
  process.exit(exitCode);
}

program.command('check <runDir>').action((runDir: string) => {
  const arm = selectedArm();
  const baselineFile = baselineFileOf(arm);
  let check: BaselineCheck;
  try {
    const run = loadRunDir(path.resolve(runDir));
    if (run.manifest.benchmark !== arm.benchmark) throw new Error(`the run is for benchmark ${String(run.manifest.benchmark)}, but --arm ${arm.name} checks ${arm.benchmark}`);
    check = checkWithMergeBase(readBaseline(baselineFile, arm), run, mergeBaseState(baselineFile, arm));
  } catch (err) {
    return fail((err as Error).message, EXIT_INCOMPARABLE);
  }
  console.log(JSON.stringify({ baseline: baselineFile, ...check }, null, 2));
  process.exit(check.ok ? 0 : check.verdict === 'INCOMPARABLE' ? EXIT_INCOMPARABLE : EXIT_REGRESSED);
});

program.command('record <runDir>')
  .requiredOption('--reason <text>', 'why the baseline has these numbers (stored in the file)')
  .option('--accept-lower', 'record a baseline that is lower than the current one')
  .action((runDir: string, options: { reason: string; acceptLower?: boolean }) => {
    const arm = selectedArm();
    const baselineFile = baselineFileOf(arm);
    const run = loadRunDir(path.resolve(runDir));
    if (run.manifest.benchmark !== arm.benchmark) throw new Error(`the run is for benchmark ${String(run.manifest.benchmark)}, but --arm ${arm.name} records ${arm.benchmark}`);
    let previous: RenorBenchBaseline | null = null;
    try { previous = readBaseline(baselineFile, arm); } catch { /* first baseline, or an unreadable one being replaced */ }
    let baseline: RenorBenchBaseline;
    try {
      ({ baseline } = planRecord({ run, previous, mergeBase: mergeBaseState(baselineFile, arm), reason: options.reason, acceptLower: options.acceptLower === true, recordedAt: new Date().toISOString() }));
    } catch (err) {
      const plan = (err as { plan?: unknown }).plan;
      if (plan) console.log(JSON.stringify(plan, null, 2));
      throw err;
    }
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`recorded ${baselineFile} (git ${baseline.gitSha}); say why in the PR body: ${baseline.reason}`);
  });

try {
  program.parse(process.argv);
} catch (err) {
  console.error((err as Error).message);
  process.exit(EXIT_INCOMPARABLE);
}
