/**
 * The committed RenorBench baseline and the no-regression check the agent gate runs against it.
 *
 * The baseline is a compact record of one hash-embedder run (manifest invariants + scored metrics),
 * small enough that a PR that moves it shows exactly which numbers moved. The verdict comes from the
 * repo's own comparator (`compareRuns`, tolerance 0), never from a second opinion about what
 * "worse" means. Latency is not recorded: it is noise and is not a gate metric.
 *
 * This file is part of the frozen evaluator (EVALUATOR_SOURCES): the gate cannot loosen its own exam
 * without moving the evaluator hash, which the check refuses until the baseline is deliberately refreshed.
 *
 * The baseline file is an ordinary tracked file, so no number in it is trusted: `check` re-scores the run and
 * requires the committed summary to EQUAL it, on every path, before anything else. The merge-base (origin/main)
 * baseline is read only to authorise a LOWER baseline: it must record a deliberate lowering that names the exact
 * merge-base baseline it lowers (`lowering.fromBaselineSha256`) and exactly the metrics that fell, written by
 * `record --accept-lower`.
 *
 * There are four arms, told apart by the `benchmark` id of a run and of its baseline file: the chunk arm (the
 * retrieval hits at top-K 10), the product arm (the reply of the shipped `search_memory` tool), the product arm on the
 * v2 suite (a larger vault, with questions that need session expansion, the newest-value rules and the verdict) and the
 * product arm on the documents suite (handbook-style notes: what the expansion delivers from a document). Each has
 * its own baseline file, tracked metrics, scorer and identity fields (RENORBENCH_ARMS); every rule below applies to all of
 * them, with the arm taken from the data, so a check can never judge a run by another arm's metrics.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compareRuns, QUALITY_METRICS, type MetricMap, type QualityMetric, type RunManifest, type RunSummary } from './comparison';
import { scoreRetrieval, type EvalCase, type EvalResult } from './scoring';
import { DOCUMENTS_BENCHMARK, DOCUMENTS_QUALITY_METRICS, scoreDocumentsArm, type DocumentsResult } from './renorbenchDocuments';
import { PRODUCT_BENCHMARK, PRODUCT_QUALITY_METRICS, PRODUCT_V2_BENCHMARK, PRODUCT_V2_QUALITY_METRICS, scoreProductArm, type ProductResult } from './renorbenchProduct';
import { sha256 } from './artifacts';

export const BASELINE_SCHEMA = 1;
/** The chunk arm's benchmark id: what `benchmark` reads in its runs and in its baseline. */
export const BASELINE_BENCHMARK = 'renorbench-v1';
/** The chunk arm's baseline, relative to the engine root. */
export const BASELINE_RELATIVE_PATH = 'docs/evals/baselines/renorbench-v1-hash.json';
/** The product arm's baseline, relative to the engine root. */
export const PRODUCT_BASELINE_RELATIVE_PATH = 'docs/evals/baselines/renorbench-v1-product-hash.json';
/** The product arm's baseline on the v2 suite, relative to the engine root. */
export const PRODUCT_V2_BASELINE_RELATIVE_PATH = 'docs/evals/baselines/renorbench-v2-product-hash.json';
/** The product arm's baseline on the documents suite, relative to the engine root. */
export const DOCUMENTS_BASELINE_RELATIVE_PATH = 'docs/evals/baselines/renorbench-docs-product-hash.json';

export interface RenorBenchArm {
  /** `benchmark` in this arm's run manifests and baseline file: the arm is read from it. */
  benchmark: string;
  /** What `--arm` names it on the command line. */
  name: 'chunk' | 'product' | 'product-v2' | 'documents';
  /** The committed baseline, relative to the engine root. */
  baselineRelativePath: string;
  /** What the gate holds a run to, overall and per category. */
  metrics: QualityMetric[];
  /** Re-score a run from its raw results: a supplied summary is never trusted. */
  score(cases: EvalCase[], results: any[]): RunSummary;
  /** Keys of the runner's own annotations next to the scored summary in summary.json: not part of the score. */
  annotationKeys: string[];
  /**
   * Manifest fields that say how the run was made (what was called, which flags were armed). They are kept in the
   * baseline and must match it, because the same numbers from another configuration would measure something else.
   */
  identityFields: string[];
  /** The command that makes a run of this arm with the free hash embedder. */
  runCommand: string;
}

export const CHUNK_ARM: RenorBenchArm = {
  benchmark: BASELINE_BENCHMARK,
  name: 'chunk',
  baselineRelativePath: BASELINE_RELATIVE_PATH,
  metrics: QUALITY_METRICS,
  score: (cases, results) => scoreRetrieval(cases, results as EvalResult[]),
  annotationKeys: ['toolPath'],
  identityFields: [],
  runCommand: 'npm run eval:renor:hash',
};

export const PRODUCT_ARM: RenorBenchArm = {
  benchmark: PRODUCT_BENCHMARK,
  name: 'product',
  baselineRelativePath: PRODUCT_BASELINE_RELATIVE_PATH,
  metrics: PRODUCT_QUALITY_METRICS,
  score: (cases, results) => scoreProductArm(cases, results as ProductResult[]),
  annotationKeys: ['productPath'],
  identityFields: ['entryPoint', 'productMode'],
  runCommand: 'npm run eval:renor:product:hash',
};

export const PRODUCT_V2_ARM: RenorBenchArm = {
  benchmark: PRODUCT_V2_BENCHMARK,
  name: 'product-v2',
  baselineRelativePath: PRODUCT_V2_BASELINE_RELATIVE_PATH,
  metrics: PRODUCT_V2_QUALITY_METRICS,
  score: (cases, results) => scoreProductArm(cases, results as ProductResult[]),
  annotationKeys: ['productPath'],
  identityFields: ['entryPoint', 'productMode'],
  runCommand: 'npm run eval:renor:product:v2:hash',
};

/**
 * The documents suite: handbook-style notes with unique headings, which the other suites have none of. It is scored by
 * whether the probed section reaches the reply, in `search_memory` and in `get_context` at 800 tokens, never by quality: the
 * run is the hash embedder's and reports as infrastructure. `documentsPath` (what a reply costs) is annotated, not scored.
 */
export const DOCUMENTS_ARM: RenorBenchArm = {
  benchmark: DOCUMENTS_BENCHMARK,
  name: 'documents',
  baselineRelativePath: DOCUMENTS_BASELINE_RELATIVE_PATH,
  metrics: DOCUMENTS_QUALITY_METRICS,
  score: (cases, results) => scoreDocumentsArm(cases, results as DocumentsResult[]),
  annotationKeys: ['productPath', 'documentsPath'],
  identityFields: ['entryPoint', 'productMode'],
  runCommand: 'npm run eval:renor:product:docs:hash',
};

export const RENORBENCH_ARMS: readonly RenorBenchArm[] = [CHUNK_ARM, PRODUCT_ARM, PRODUCT_V2_ARM, DOCUMENTS_ARM];

/** The arm a run or baseline belongs to, by its `benchmark` id. An id that names no arm is refused, never guessed. */
export function armFor(benchmark: string | undefined): RenorBenchArm {
  const arm = RENORBENCH_ARMS.find(candidate => candidate.benchmark === benchmark);
  if (!arm) throw new Error(`benchmark ${String(benchmark)} is not a RenorBench arm (expected ${RENORBENCH_ARMS.map(a => a.benchmark).join(' or ')})`);
  return arm;
}

export interface RenorBenchBaseline {
  schema: number;
  benchmark: string;
  /** Why this baseline has these numbers: the deliberate act the gate asks for. */
  reason: string;
  recordedAt: string;
  gitSha: string | null;
  manifest: ArmManifest;
  summary: RunSummary;
  /**
   * Present only when this baseline is deliberately LOWER than the one it replaces. It names that
   * baseline by the sha256 of its bytes, so it excuses one change and goes stale on the next merge.
   */
  lowering?: BaselineLowering;
}

export interface BaselineLowering {
  reason: string;
  /** sha256 of the merge-base baseline file this baseline lowers. */
  fromBaselineSha256: string;
  /** Tracked metrics that were lower than the merge-base when this was recorded. */
  movedMetrics: string[];
}

export interface MetricMove {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

/** LOWERED: the run is below the merge-base baseline and the baseline file records why (ok, never silent). */
export type BaselineVerdict = 'EQUAL' | 'IMPROVED' | 'LOWERED' | 'REGRESSED' | 'INCOMPARABLE';

export interface BaselineCheck {
  ok: boolean;
  verdict: BaselineVerdict;
  /** Set when the verdict is INCOMPARABLE, or the baseline could not be read. */
  problem: string | null;
  regressed: MetricMove[];
  improved: MetricMove[];
  categoryRegressions: string[];
  /** Every tracked quality metric, baseline next to candidate. */
  metrics: MetricMove[];
  /** Set when the run is below the merge-base baseline and the baseline records a deliberate lowering. */
  lowering?: { reason: string; moved: MetricMove[] };
  /** What the baseline looked like on the merge-base, when it was consulted. */
  mergeBase?: { state: 'file' | 'new'; sha256: string | null; comparable: boolean; note: string | null };
}

/** A run manifest as a baseline keeps it, plus the fields that say how the product arm's run was made. */
export type ArmManifest = RunManifest & { entryPoint?: unknown; productMode?: unknown };

export interface LoadedRun {
  manifest: ArmManifest & { gitSha?: string; caseSnapshotSha256?: string; resultsSha256?: string };
  summary: RunSummary;
}

/** The command that re-records the baseline of `arm`, as the messages below quote it. */
function recordCommand(arm: RenorBenchArm): string {
  return `npm run eval:renorbench:baseline -- ${arm.name === 'chunk' ? '' : `--arm ${arm.name} `}record <run dir> --reason "<why>"`;
}

function refreshHint(arm: RenorBenchArm): string {
  const changed = arm.name === 'chunk' ? 'the evaluator, chunking or fixtures' : 'the evaluator, chunking, fixtures or how the arm is run';
  return `If you changed ${changed} on purpose, refresh the baseline with \`${recordCommand(arm)}\` and say why in the PR body.`;
}

function parseJsonl<T>(bytes: Buffer): T[] {
  return bytes.toString().trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

/**
 * Load a run directory and re-score it from its raw results: a supplied summary is never trusted. The arm that
 * scores it is the one its manifest names. The runner's own annotation (`toolPath`, `productPath`) next to the
 * scored summary is not part of it.
 */
export function loadRunDir(dir: string): LoadedRun {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as LoadedRun['manifest'];
  const arm = armFor(manifest.benchmark);
  const casesBytes = fs.readFileSync(path.join(dir, 'cases.jsonl'));
  if (!manifest.caseSnapshotSha256 || sha256(casesBytes) !== manifest.caseSnapshotSha256) {
    throw new Error(`cases.jsonl does not match the manifest hash: ${dir}`);
  }
  const resultsBytes = fs.readFileSync(path.join(dir, 'results.jsonl'));
  if (manifest.resultsSha256 && sha256(resultsBytes) !== manifest.resultsSha256) {
    throw new Error(`results.jsonl does not match the manifest hash: ${dir}`);
  }
  const summary = arm.score(parseJsonl<EvalCase>(casesBytes), parseJsonl<unknown>(resultsBytes));
  const supplied = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  for (const key of arm.annotationKeys) delete supplied[key];
  if (JSON.stringify(summary) !== JSON.stringify(supplied)) {
    throw new Error(`summary.json does not match the re-scored results (tampered or stale): ${dir}`);
  }
  return { manifest, summary };
}

function withoutLatency(map: MetricMap): MetricMap {
  return Object.fromEntries(Object.entries(map).filter(([key]) => !/LatencyMs$/.test(key)));
}

export function buildBaseline(input: { run: LoadedRun; reason: string; recordedAt: string; lowering?: BaselineLowering }): RenorBenchBaseline {
  const { manifest, summary } = input.run;
  const arm = armFor(manifest.benchmark);
  return {
    schema: BASELINE_SCHEMA,
    benchmark: arm.benchmark,
    reason: input.reason,
    recordedAt: input.recordedAt,
    gitSha: manifest.gitSha ?? null,
    manifest: {
      benchmark: manifest.benchmark,
      casesSha256: manifest.casesSha256,
      fixtureSha256: manifest.fixtureSha256,
      topK: manifest.topK,
      provider: manifest.provider,
      qualityEligible: manifest.qualityEligible,
      evaluatorSha256: manifest.evaluatorSha256,
      chunking: manifest.chunking,
      gitDirty: manifest.gitDirty,
      ...Object.fromEntries(arm.identityFields.filter(key => (manifest as Record<string, unknown>)[key] !== undefined).map(key => [key, (manifest as Record<string, unknown>)[key]])),
    },
    summary: {
      overall: withoutLatency(summary.overall),
      byCategory: Object.fromEntries(Object.entries(summary.byCategory ?? {}).map(([name, map]) => [name, withoutLatency(map)])),
    },
    ...(input.lowering ? { lowering: input.lowering } : {}),
  };
}

/**
 * Read the committed baseline. Throws an Error whose message names what is wrong with it. With `arm`, a file that is
 * another arm's baseline is refused, so a path that holds the wrong one can never judge a run.
 */
export function readBaseline(file: string, arm?: RenorBenchArm): RenorBenchBaseline {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`baseline ${file} is missing or unreadable (${(err as NodeJS.ErrnoException).code ?? 'read error'})`);
  }
  return parseBaseline(text, file, arm);
}

export function parseBaseline(text: string, file: string, expected?: RenorBenchArm): RenorBenchBaseline {
  let parsed: Partial<RenorBenchBaseline>;
  try {
    parsed = JSON.parse(text) as Partial<RenorBenchBaseline>;
  } catch {
    throw new Error(`baseline ${file} is not valid JSON`);
  }
  if (parsed.schema !== BASELINE_SCHEMA) throw new Error(`baseline ${file} has schema ${String(parsed.schema)}, expected ${BASELINE_SCHEMA}`);
  const arm = RENORBENCH_ARMS.find(candidate => candidate.benchmark === parsed.benchmark);
  if (!arm || (expected && arm !== expected)) {
    throw new Error(`baseline ${file} is for benchmark ${String(parsed.benchmark)}, expected ${(expected ?? CHUNK_ARM).benchmark}`);
  }
  if (!parsed.manifest || !parsed.summary?.overall) throw new Error(`baseline ${file} has no manifest or no summary.overall`);
  const missing = arm.metrics.map(metric => metric.key)
    .filter(key => typeof parsed.summary!.overall[key] !== 'number');
  if (missing.length > 0) throw new Error(`baseline ${file} lacks tracked metric(s): ${missing.join(', ')}`);
  if (parsed.lowering !== undefined) {
    const l = parsed.lowering as Partial<BaselineLowering> | null;
    if (!l || typeof l.reason !== 'string' || l.reason.trim().length < 12 || typeof l.fromBaselineSha256 !== 'string' || l.fromBaselineSha256.length === 0
      || !Array.isArray(l.movedMetrics) || !l.movedMetrics.every((m) => typeof m === 'string')) {
      throw new Error(`baseline ${file} has a malformed "lowering" (needs a reason of at least 12 characters, fromBaselineSha256 and movedMetrics, a list of metric names)`);
    }
  }
  return parsed as RenorBenchBaseline;
}

type CompareResult = ReturnType<typeof compareRuns>;

function movesOf(result: CompareResult, tracked: QualityMetric[]): { metrics: MetricMove[]; regressed: MetricMove[]; improved: MetricMove[] } {
  const metrics: MetricMove[] = [];
  const regressed: MetricMove[] = [];
  const improved: MetricMove[] = [];
  for (const { key, higherBetter } of tracked) {
    const move: MetricMove = { metric: key, ...result.quality[key] };
    metrics.push(move);
    if (move.baseline !== null && move.candidate === null) {
      regressed.push(move); // a tracked metric that vanished is not "no change"
    } else if (move.delta !== null && move.delta !== 0) {
      const better = higherBetter === move.delta > 0;
      // More empty answers on abstention cases is not a quality gain: it can fail the gate, never praise it.
      if (better && key === 'abstentionEmptyRate') continue;
      (better ? improved : regressed).push(move);
    }
  }
  return { metrics, regressed, improved };
}

function incomparable(problem: string): BaselineCheck {
  return { ok: false, verdict: 'INCOMPARABLE', problem, regressed: [], improved: [], categoryRegressions: [], metrics: [] };
}

/** The no-regression verdict: any tracked quality metric that drops fails, equal and better pass. */
export function checkAgainstBaseline(baseline: RenorBenchBaseline, candidate: LoadedRun): BaselineCheck {
  const arm = armFor(baseline.benchmark);
  let result;
  try {
    result = compareRuns(baseline, candidate, { regressionGate: true, maxQualityRegression: 0, metrics: arm.metrics });
  } catch (err) {
    return incomparable(`${(err as Error).message} ${refreshHint(arm)}`);
  }
  if (result.verdict === 'DESCRIPTIVE_ONLY') {
    return incomparable(`the run is not comparable with the baseline: ${result.reasons.join(' ')} ${refreshHint(arm)}`);
  }
  // The same numbers from another configuration (a different tool call, an armed product flag, another verdict bar)
  // measure something else: the run is judged only against a baseline made the way it was made.
  const moved = arm.identityFields.filter(key => canonicalJson((baseline.manifest as Record<string, unknown>)[key]) !== canonicalJson((candidate.manifest as Record<string, unknown>)[key]));
  if (moved.length > 0) {
    const show = (manifest: ArmManifest, key: string) => canonicalJson((manifest as Record<string, unknown>)[key]).slice(0, 200);
    return incomparable(`the run was not made the way the baseline was (${moved.map(key => `${key}: ${show(baseline.manifest, key)} (baseline) vs ${show(candidate.manifest, key)} (this run)`).join('; ')}). ${refreshHint(arm)}`);
  }

  const { metrics, regressed, improved } = movesOf(result, arm.metrics);
  const failed = regressed.length > 0 || result.categoryRegressions.length > 0;
  return {
    ok: !failed,
    verdict: failed ? 'REGRESSED' : improved.length > 0 ? 'IMPROVED' : 'EQUAL',
    problem: null,
    regressed,
    improved,
    categoryRegressions: result.categoryRegressions,
    metrics,
  };
}

/** The baseline as the merge-base has it: a file, absent because this PR creates it, or unreadable. */
export type MergeBaseState =
  | { kind: 'file'; baseline: RenorBenchBaseline; sha256: string }
  | { kind: 'new' }
  | { kind: 'unavailable'; problem: string };

export const DEFAULT_BASE_REF = 'origin/main';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Read the baseline file as it was at the merge-base of HEAD and `baseRef`. Fails CLOSED: when git
 * cannot say what the merge-base had, the floor is unknown, and an unknown floor is not a pass. The one
 * exception is a baseline file that does not exist at the merge-base (the PR that introduces it).
 */
export function readMergeBaseState(baselineFile: string, baseRef = DEFAULT_BASE_REF, arm?: RenorBenchArm): MergeBaseState {
  const dir = fs.existsSync(path.dirname(path.resolve(baselineFile))) ? fs.realpathSync(path.dirname(path.resolve(baselineFile))) : path.dirname(path.resolve(baselineFile));
  const unavailable = (why: string): MergeBaseState => ({
    kind: 'unavailable',
    problem: `cannot read the merge-base baseline (${why}); the floor is unknown, so the check fails closed. `
      + `Fetch ${baseRef} (git fetch origin main; a shallow clone also needs git fetch --unshallow) and rerun, from a git checkout.`,
  });
  let cwd: string;
  let mergeBase: string;
  let spec: string;
  try {
    // Run from the repository root: ls-tree and show would otherwise read a path relative to the cwd.
    cwd = git(dir, ['rev-parse', '--show-toplevel']);
    mergeBase = git(cwd, ['merge-base', 'HEAD', baseRef]);
    spec = path.relative(fs.realpathSync(cwd), path.join(dir, path.basename(baselineFile))).split(path.sep).join('/');
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0];
    return unavailable(`git merge-base HEAD ${baseRef} failed${stderr ? `: ${stderr}` : ''}`);
  }
  let text: string;
  try {
    if (git(cwd, ['ls-tree', mergeBase, '--', spec]) === '') return { kind: 'new' };
    text = execFileSync('git', ['show', `${mergeBase}:${spec}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    return unavailable(`git show ${mergeBase.slice(0, 8)}:${spec} failed: ${(err as Error).message.split('\n')[0]}`);
  }
  try {
    return { kind: 'file', baseline: parseBaseline(text, `${baseRef} merge-base ${mergeBase.slice(0, 8)}:${spec}`, arm), sha256: sha256(Buffer.from(text)) };
  } catch (err) {
    return unavailable((err as Error).message);
  }
}

export interface FloorComparison {
  /** false when the benchmark data differs, so the two scores measure different things. */
  comparable: boolean;
  note: string | null;
  regressed: MetricMove[];
  categoryRegressions: string[];
}

/**
 * Hold a run to a baseline's NUMBERS, whatever else moved. Unlike `checkAgainstBaseline` it tolerates a
 * changed evaluator, chunking or provider: those legitimately move the identity, but a lower score under
 * a new identity is still a lower score. Only different benchmark data (cases / fixture) makes the two
 * incomparable, and then the new baseline's identity is the reviewer's to read.
 */
export function compareToFloor(floor: RenorBenchBaseline, candidate: LoadedRun): FloorComparison {
  const arm = armFor(floor.benchmark);
  let result: CompareResult;
  try {
    result = compareRuns(floor, candidate, { regressionGate: true, allowEvaluatorChange: true, maxQualityRegression: 0, metrics: arm.metrics });
  } catch (err) {
    return { comparable: false, note: (err as Error).message, regressed: [], categoryRegressions: [] };
  }
  return { comparable: true, note: null, regressed: movesOf(result, arm.metrics).regressed, categoryRegressions: result.categoryRegressions };
}

/** Does the committed baseline record a lowering of exactly this merge-base baseline? */
export function recordsLoweringOf(baseline: RenorBenchBaseline, mergeBase: Extract<MergeBaseState, { kind: 'file' }>): boolean {
  return baseline.lowering?.fromBaselineSha256 === mergeBase.sha256;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function flattenSummary(summary: RunSummary): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(summary.overall)) flat.set(`overall.${key}`, value);
  for (const [name, map] of Object.entries(summary.byCategory ?? {})) {
    for (const [key, value] of Object.entries(map)) flat.set(`${name}.${key}`, value);
  }
  return flat;
}

export interface OwnScore {
  same: boolean;
  /** `overall.hitAt5`, `temporal.mrr`, ... whose committed number is not the tree's own. */
  differing: string[];
  detail: string[];
}

/**
 * Is the committed baseline's summary exactly what this tree scores? The check re-scores the live run
 * from its raw results, so this is the one statement that binds the committed numbers to a measurement:
 * a hand-edited number cannot equal it. A real lowering ships the worse code and is re-recorded, so its
 * numbers match by construction.
 */
export function compareToOwnScore(baseline: RenorBenchBaseline, run: LoadedRun): OwnScore {
  const own = flattenSummary(buildBaseline({ run, reason: 'own score', recordedAt: '' }).summary);
  const committed = flattenSummary(baseline.summary);
  const differing: string[] = [];
  const detail: string[] = [];
  for (const key of new Set([...own.keys(), ...committed.keys()])) {
    if (canonicalJson(own.get(key)) === canonicalJson(committed.get(key))) continue;
    differing.push(key);
    detail.push(`${key} ${canonicalJson(committed.get(key))} (baseline) vs ${canonicalJson(own.get(key))} (this tree)`);
  }
  return { same: differing.length === 0, differing, detail };
}

/** At most a handful of names in a one-line message: the full lists stay in `regressed[]`. */
function briefList(names: string[], max = 8): string {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')}, ... (+${names.length - max} more)`;
}

function notOwnScore(check: BaselineCheck, own: OwnScore, arm: RenorBenchArm): BaselineCheck {
  const shown = own.detail.slice(0, 4).join('; ');
  const better = check.improved.length > 0
    ? ` The tree scores better than the baseline on ${briefList(check.improved.map(m => m.metric))}: that is progress, so re-record to ratchet the floor up.`
    : '';
  return {
    ...check,
    ok: false,
    verdict: 'INCOMPARABLE',
    problem: `the committed baseline is not this tree's own score (${own.differing.length} number(s) differ: ${shown}${own.detail.length > 4 ? '; ...' : ''}).${better} `
      + 'The baseline must equal what this tree measures, number for number: re-record it from a clean committed tree '
      + `(\`${recordCommand(arm)}\`); a hand-edited number is refused.`,
  };
}

/**
 * The no-regression verdict the gate uses. Two rules, in this order:
 *
 * 1. The committed baseline must EQUAL this tree's own re-scored run, every stored number, on every path
 *    (new file, floor present, incomparable data, lowered or not). It is checked first and unconditionally,
 *    so a hand-edited number can never become the floor, whatever else the PR changed. Better code is
 *    ratcheted by re-recording in the same PR; worse code ships its lowering the same way.
 * 2. The merge-base floor exists only to authorise a LOWER baseline: when the tree scores below the baseline
 *    the merge-base has, the file must record a deliberate lowering of that exact baseline, naming exactly the
 *    metrics that fell. The verdict is then LOWERED and never promotable. No merge-base, no pass (the file
 *    being new on the merge-base is the one case that needs no floor).
 */
export function checkWithMergeBase(baseline: RenorBenchBaseline, candidate: LoadedRun, mergeBase: MergeBaseState): BaselineCheck {
  const arm = armFor(baseline.benchmark);
  const own = compareToOwnScore(baseline, candidate);
  const check = checkAgainstBaseline(baseline, candidate);
  if (!own.same) return check.ok ? notOwnScore(check, own, arm) : check;
  if (!check.ok) return check;
  if (mergeBase.kind === 'unavailable') return incomparable(mergeBase.problem);
  if (mergeBase.kind === 'new') return { ...check, mergeBase: { state: 'new', sha256: null, comparable: true, note: 'the baseline file is new on the merge-base' } };

  const floor = compareToFloor(mergeBase.baseline, candidate);
  const info = { state: 'file' as const, sha256: mergeBase.sha256, comparable: floor.comparable, note: floor.note };
  const names = [...new Set([...floor.regressed.map(m => m.metric), ...floor.categoryRegressions])];
  if (names.length === 0) return { ...check, mergeBase: info };

  const refuse = (why: string): BaselineCheck => ({
    ...check,
    ok: false,
    verdict: 'REGRESSED',
    problem: `the run is below the baseline the merge-base has (${briefList(names)}): ${why} `
      + `Fix the regression, or record it with \`${recordCommand(arm).replace('<run dir>', '<dir>')} --accept-lower\` and defend it in the PR body.`,
    regressed: floor.regressed,
    categoryRegressions: floor.categoryRegressions,
    mergeBase: info,
  });
  if (!baseline.lowering) return refuse('this baseline does not record a deliberate lowering of it.');
  if (!recordsLoweringOf(baseline, mergeBase)) return refuse('the baseline records a lowering, but of a different baseline than the merge-base has (stale).');
  const recorded = [...new Set(baseline.lowering.movedMetrics)].sort();
  const actual = [...names].sort();
  if (canonicalJson(recorded) !== canonicalJson(actual)) {
    return refuse(`the recorded lowering names [${briefList(recorded)}] but the metrics actually below the floor are [${briefList(actual)}]; a lowering excuses exactly what it names.`);
  }
  return { ...check, ok: true, verdict: 'LOWERED', lowering: { reason: baseline.lowering.reason, moved: floor.regressed }, categoryRegressions: floor.categoryRegressions, mergeBase: info };
}

export interface RecordPlan {
  baseline: RenorBenchBaseline;
  lowered: boolean;
  regressed: MetricMove[];
  categoryRegressions: string[];
}

/**
 * What `record` writes, or why it refuses. Numbers are judged against the merge-base's baseline and the
 * file as it stands, across an evaluator or chunking change: only different benchmark data is incomparable.
 * `lowering.movedMetrics` is derived from the merge-base floor alone, because that is what `check` compares it with.
 */
export function planRecord(input: {
  run: LoadedRun; previous: RenorBenchBaseline | null; mergeBase: MergeBaseState;
  reason: string; acceptLower: boolean; recordedAt: string;
}): RecordPlan {
  const { run, previous, mergeBase, acceptLower } = input;
  if (mergeBase.kind === 'unavailable') throw new Error(mergeBase.problem);
  const reason = input.reason.trim();
  const arm = armFor(run.manifest.benchmark);
  if (run.manifest.provider?.kind !== 'hash') throw new Error(`the baseline is the hash-embedder run: re-run with \`${arm.runCommand}\``);
  if (run.manifest.gitDirty !== false) throw new Error('the run came from a dirty tree: commit first, then record, so the baseline names the code that produced it');
  if (reason.length < 12) throw new Error('--reason must say why (at least 12 characters)');

  const againstMergeBase = mergeBase.kind === 'file' ? compareToFloor(mergeBase.baseline, run) : null;
  const againstFile = previous ? compareToFloor(previous, run) : null;
  const regressed = [...(againstMergeBase?.regressed ?? []), ...(againstFile?.regressed ?? [])];
  const categoryRegressions = [...(againstMergeBase?.categoryRegressions ?? []), ...(againstFile?.categoryRegressions ?? [])];
  const lowered = regressed.length > 0 || categoryRegressions.length > 0;
  if (lowered && !acceptLower) {
    const err = new Error('the new run is LOWER than the baseline (merge-base or committed): fix the regression, or pass --accept-lower and say why in the PR') as Error & { plan?: unknown };
    err.plan = { regressed, categoryRegressions };
    throw err;
  }
  const floorMoved = againstMergeBase
    ? [...new Set([...againstMergeBase.regressed.map(m => m.metric), ...againstMergeBase.categoryRegressions])]
    : [];
  const lowering: BaselineLowering | undefined = mergeBase.kind === 'file' && floorMoved.length > 0
    ? { reason, fromBaselineSha256: mergeBase.sha256, movedMetrics: floorMoved }
    : undefined;
  return { baseline: buildBaseline({ run, reason, recordedAt: input.recordedAt, lowering }), lowered, regressed, categoryRegressions };
}
