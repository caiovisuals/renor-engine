import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The eval run ledger: every LongMemEval run is on record before it spends anything.
 *
 * WHY THIS EXISTS
 *   Full 500-question runs were repeated with configurations that had already been measured, because what
 *   ran lived in disposable worktrees and private reports. The ledger is one JSON line per run, appended to
 *   RENOR_EVAL_RUN_LEDGER (default ~/.local/share/renor/eval-run-ledger.jsonl, next to the eval and embedding
 *   caches, so every worktree on the machine reads and writes the same file). Each line carries the run's
 *   configuration, its fingerprint and where its per-question results are written.
 *
 * THE RULE
 *   A runner calls admitRun() before its first provider call. A run whose exact fingerprint is already on
 *   record is refused, unless the caller states why it must run again (--rerun-reason). The reason is
 *   written into the new record. Continuing a stopped run in its own output directory is the same run, not
 *   a repeat.
 *
 * WHAT SURVIVES THE WORKTREE
 *   The record is appended before the first spend, so a run that is killed is still on record. Per-question
 *   rows are copied into eval-runs/<record id>/ beside the ledger as they are written, and the run's JSON
 *   artifacts plus outcome.json when it ends. A run with no outcome.json was stopped, killed or is still
 *   running.
 *
 * The fingerprint is sha256 over the canonical JSON of the configuration the runner builds: models and
 * endpoints, prompt flags, product settings, the question set, the dataset and the content of the code
 * the run executes. It never contains a credential value.
 */

export const RUN_LEDGER_ENV = 'RENOR_EVAL_RUN_LEDGER';
export const RUN_RECORD_SCHEMA = 'renor-eval-run/v1';

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export function resolveRunLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[RUN_LEDGER_ENV]?.trim();
  if (raw === 'off' || raw === '0') {
    throw new Error(`${RUN_LEDGER_ENV} cannot turn the run ledger off: point it at a scratch file for runs that must not be on the shared record`);
  }
  return raw ? path.resolve(raw) : path.join(env.HOME || os.homedir(), '.local', 'share', 'renor', 'eval-run-ledger.jsonl');
}

/** JSON with object keys sorted at every depth and undefined members dropped, so equal configurations serialize equally. */
export function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort()
        .filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, sorted((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}

export function runFingerprint(config: Record<string, unknown>): string {
  return sha256(canonicalJson(config));
}

/**
 * Content identity of the code a run executes: sha256 over every file under `roots` (paths relative to
 * `engineRoot`), each as `path\0sha256(content)`, sorted by path. The same bytes give the same identity on
 * any commit and in any worktree, so a commit that touches only other files does not make a measured
 * configuration new again; any edit to these files, committed or not, does. A missing root throws.
 */
export function codeIdentity(engineRoot: string, roots: readonly string[]): string {
  const files = new Set<string>();
  const walk = (relative: string): void => {
    const full = path.join(engineRoot, relative);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) walk(path.posix.join(relative, entry));
    } else if (stat.isFile()) {
      files.add(relative);
    }
  };
  for (const root of roots) walk(root.split(path.sep).join('/'));
  return sha256([...files].sort()
    .map(relative => `${relative}\0${sha256(fs.readFileSync(path.join(engineRoot, relative)))}`)
    .join('\n'));
}

/** A question set as configuration: its size and a hash of its sorted ids (selection order does not change what is measured). */
export function questionSet(ids: readonly string[]): { count: number; sha256: string } {
  return { count: ids.length, sha256: sha256([...ids].sort().join('\n')) };
}

/**
 * The namespaces the product reads its settings from (`process.env` in engine/src). Every variable of a product
 * process's environment inside them is configuration, whoever set it: the runner, the operator's shell or a parent
 * process. A setting such as RENOR_NEWEST_FIRST or CHUNK_MAX_TOKENS changes what a run measures even when no runner
 * names it. tests/eval/run-ledger.test.ts scans engine/src and fails on a variable read outside these namespaces that
 * it does not list as non-configuration, so a new setting cannot escape the fingerprint.
 */
export const PRODUCT_ENV_NAMESPACES = /^(RENOR_|MVP_|EMBEDDING_|OPENAI_|OLLAMA_|GOOGLE_|CHUNK_|INDEX_|LLM_|MEMORY_|CONVERSATIONS_|PRIORITY_)|^TZ$/;

/**
 * Inside those namespaces: the eval runners' own variables, and a spend cap, which can stop a run but not change its
 * result. Settings that look operational but can change a result stay configuration: index concurrency and embedding
 * batch size can change tie order, and the extractor timeout decides whether an armed extraction lands. A repeat that
 * differs only in one of them is therefore not refused, which is the safe direction.
 */
const NOT_PRODUCT_CONFIGURATION = /^RENOR_QA_|^RENOR_EVAL_RUN_LEDGER$|^RENOR_EVAL_MAX_EMBED_TOKENS$/;

/**
 * Names whose values never enter a run record: credentials (`*_KEY`, `*_KEYS`, `*_KEY_<n>`, tokens, secrets,
 * passwords, credential and key files), cloud project ids, and cache locations (where a cache lives is not what is
 * measured). Their presence is recorded. Only these shapes: an ordinary setting that merely contains such a word
 * keeps its value, so two runs that differ in it never share a fingerprint.
 */
export const PRESENCE_ONLY_ENV = /_(KEYS?|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(_\d+)?$|_KEY_FILE$|_PROJECT$|_CACHE$/;

/** The configuration a product process's environment carries: its product-namespace variables, credentials and caches by presence only. */
export function productEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined
      && PRODUCT_ENV_NAMESPACES.test(entry[0]) && !NOT_PRODUCT_CONFIGURATION.test(entry[0]))
    .map(([name, value]) => [name, PRESENCE_ONLY_ENV.test(name) ? 'set' : value]));
}

export interface RunRecord {
  schema: typeof RUN_RECORD_SCHEMA;
  id: string;
  recordedAt: string;
  runner: string;
  fingerprint: string;
  /** Exactly what was fingerprinted. */
  config: Record<string, unknown>;
  gitSha: string;
  gitDirty: boolean;
  outputDir: string;
  /** The per-question results file the run writes inside outputDir. */
  perQuestionResults: string;
  /** Where the per-question rows, the run's JSON artifacts and outcome.json are copied; outlives outputDir. */
  archiveDir: string;
  /** Earlier records of this same run (same fingerprint, same output directory) that this invocation continues. */
  resumes: string[];
  /** Set when the caller ran a configuration that was already on record: why, and which records it repeats. */
  rerun: { reason: string; priorRecordIds: string[] } | null;
}

export interface RunOutcome {
  /** complete: every selected question has a clean result; incomplete: some do not; never written for a killed run. */
  status: 'complete' | 'incomplete';
  finishedAt: string;
  casesTotal: number;
  casesCompleted: number;
  correct?: number;
  answerErrors?: number;
  judgeParseFailures?: number;
  liveModelCalls?: number;
  metrics?: object;
}

export class RunRefusedError extends Error {}

/** Every record on the ledger. A torn last line (an append in progress) is skipped; any other unreadable line fails closed. */
export function readRunLedger(ledgerPath: string): RunRecord[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n');
  const records: RunRecord[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let record: Partial<RunRecord>;
    try {
      record = JSON.parse(line) as Partial<RunRecord>;
    } catch {
      if (index === lines.length - 1) return;
      throw new Error(`Run ledger ${ledgerPath} line ${index + 1} is not JSON: cannot tell whether this run repeats one on record`);
    }
    if (typeof record.fingerprint !== 'string' || typeof record.outputDir !== 'string') {
      throw new Error(`Run ledger ${ledgerPath} line ${index + 1} has no fingerprint or outputDir: cannot tell whether this run repeats one on record`);
    }
    records.push(record as RunRecord);
  });
  return records;
}

export interface RunAdmission {
  ledgerPath: string;
  runner: string;
  fingerprint: string;
  config: Record<string, unknown>;
  outputDir: string;
  resumes: RunRecord[];
  priors: RunRecord[];
  rerunReason: string | null;
}

/**
 * Decide, before any provider call, whether this run may start. `resuming` is true when the output
 * directory already holds this run's checkpoint. Throws RunRefusedError when the exact fingerprint is
 * already on record for another output directory and no reason was given.
 */
export function admitRun(args: {
  ledgerPath: string;
  runner: string;
  config: Record<string, unknown>;
  outputDir: string;
  resuming: boolean;
  rerunReason?: string;
}): RunAdmission {
  const reason = args.rerunReason?.trim() ?? '';
  if (args.rerunReason !== undefined && !reason) {
    throw new RunRefusedError('Refused: --rerun-reason is empty. Say why this configuration must run again; the reason is recorded with the run.');
  }
  const outputDir = path.resolve(args.outputDir);
  const fingerprint = runFingerprint(args.config);
  const matches = readRunLedger(args.ledgerPath).filter(record => record.fingerprint === fingerprint);
  const resumes = args.resuming ? matches.filter(record => record.outputDir === outputDir) : [];
  const priors = resumes.length > 0 ? [] : matches;
  if (priors.length > 0 && !reason) {
    throw new RunRefusedError(refusalMessage(args.ledgerPath, fingerprint, priors));
  }
  return {
    ledgerPath: args.ledgerPath,
    runner: args.runner,
    fingerprint,
    config: args.config,
    outputDir,
    resumes,
    priors,
    rerunReason: reason || null,
  };
}

function describePrior(record: RunRecord): string {
  const outcomePath = path.join(record.archiveDir ?? '', 'outcome.json');
  if (record.archiveDir && fs.existsSync(outcomePath)) {
    try {
      const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8')) as RunOutcome;
      const score = typeof outcome.correct === 'number' ? `${outcome.correct} correct, ` : '';
      return `${outcome.status}: ${score}${outcome.casesCompleted}/${outcome.casesTotal} questions; results ${record.archiveDir}`;
    } catch { /* an unreadable outcome reads as no outcome */ }
  }
  const archived = record.archiveDir ? path.join(record.archiveDir, path.basename(record.perQuestionResults ?? '')) : '';
  const rows = archived && fs.existsSync(archived)
    ? fs.readFileSync(archived, 'utf8').split('\n').filter(Boolean).length
    : 0;
  return `no outcome recorded (stopped, killed or still running); ${rows} per-question row(s) in ${archived || record.perQuestionResults}`;
}

function refusalMessage(ledgerPath: string, fingerprint: string, priors: RunRecord[]): string {
  const shown = priors.slice(-5).map(record =>
    `  - ${record.recordedAt}  ${record.outputDir}\n    ${describePrior(record)}${record.rerun ? `\n    (itself a re-run: ${record.rerun.reason})` : ''}`);
  return [
    `Refused: this exact configuration (fingerprint ${fingerprint.slice(0, 16)}) has already run ${priors.length} time(s) on this machine:`,
    ...shown,
    'Running it again pays for a result that is already on record. Read the results above. To finish a stopped run, pass its',
    '--output directory again. If a repeat is the point (a fresh answer draw, results that were lost), pass --rerun-reason "<why>":',
    'the reason is recorded with the new run.',
    `Ledger: ${ledgerPath}`,
  ].join('\n');
}

/** Append the run's record. Call it once the run will spend (it has questions to answer), after the output directory is claimed. */
export function recordRun(admission: RunAdmission, details: { gitSha: string; gitDirty: boolean; perQuestionResults: string }): RunRecord {
  const recordedAt = new Date().toISOString();
  const id = `${recordedAt.replace(/[-:]/g, '').slice(0, 15)}-${admission.fingerprint.slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}`;
  const archiveDir = path.join(path.dirname(admission.ledgerPath), 'eval-runs', id);
  fs.mkdirSync(archiveDir, { recursive: true });
  const record: RunRecord = {
    schema: RUN_RECORD_SCHEMA,
    id,
    recordedAt,
    runner: admission.runner,
    fingerprint: admission.fingerprint,
    config: admission.config,
    gitSha: details.gitSha,
    gitDirty: details.gitDirty,
    outputDir: admission.outputDir,
    perQuestionResults: path.resolve(details.perQuestionResults),
    archiveDir,
    resumes: admission.resumes.map(prior => prior.id),
    rerun: admission.rerunReason ? { reason: admission.rerunReason, priorRecordIds: admission.priors.map(prior => prior.id) } : null,
  };
  fs.appendFileSync(admission.ledgerPath, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/** Copy one per-question row into the run's archive as it is written, so a run that is killed still leaves its results. */
export function archiveRow(record: RunRecord, line: string): void {
  fs.appendFileSync(path.join(record.archiveDir, path.basename(record.perQuestionResults)), line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

/** When the run ends: copy its JSON artifacts from the output directory into the archive, then write outcome.json. */
export function saveRunOutcome(record: RunRecord, outcome: RunOutcome): void {
  for (const name of fs.readdirSync(record.outputDir)) {
    const from = path.join(record.outputDir, name);
    if (!/\.(json|jsonl|sha256)$/.test(name) || !fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(record.archiveDir, name), fs.constants.COPYFILE_FICLONE);
  }
  fs.writeFileSync(path.join(record.archiveDir, 'outcome.json'), JSON.stringify({ recordId: record.id, ...outcome }, null, 2) + '\n', 'utf8');
}
