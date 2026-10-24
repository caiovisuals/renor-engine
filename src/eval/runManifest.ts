import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// ─── Product-truth manifest contract (Wave C, Task 6) ─────────────────────────
//
// These fields distinguish RESEARCH execution (gold-derived fields may reach
// runtime; never a Renor product score) from PRODUCT-PUBLIC execution (every
// answer context comes from a public MCP/API/CLI surface, gold-blind).
// The contract is additive and versioned: legacy manifests without these
// fields remain valid research manifests, but can never carry a product label
// (scorer refuses, fail closed). Contract shape per
// docs/evals/productization/inventory-harness.md §4.

/**
 * Bump when the truth-field semantics change. v2 is the first versioned
 * contract (introduces executionKind/watermark/refusal rules).
 */
export const MANIFEST_CONTRACT_VERSION = 2;

export type ExecutionKind = 'research' | 'product-public';
export type PublicEntryPoint = 'mcp' | 'api' | 'cli';
export type CacheArm = 'iteration' | 'promotion';

/**
 * ONLY these dataset fields may reach the product runtime in a
 * product-public execution. Corpus rendering inputs (markdown generation)
 * and the question itself are product-observable; everything else
 * (answer, answer_session_ids, question_type, shouldAbstain) is scorer
 * or offline-analysis input only.
 */
export const PRODUCT_RUNTIME_FIELD_ALLOWLIST = [
  'question_id',
  'question',
  'question_date',
  'haystack_sessions',
  'haystack_dates',
  'haystack_session_ids',
] as const;

/**
 * Research manifests may expose more (benchmark categories, abstention
 * labels drive research-only routing). Recorded honestly so a research
 * manifest can never be relabeled product-public.
 */
export const RESEARCH_RUNTIME_FIELD_ALLOWLIST = [
  ...PRODUCT_RUNTIME_FIELD_ALLOWLIST,
  'category',
  'shouldAbstain',
] as const;

/** Required non-null watermark on every research manifest/report. */
export const RESEARCH_WATERMARK = 'RESEARCH-ONLY' as const;

/** Research sidecar flags: legal only in research runners; refused for product-public execution. */
export const SIDECAR_FLAGS = [
  '--facts-file',
  '--chronicle-file',
  '--prefs-file',
  '--temporal-sidecar',
  '--context-compiler',
  '--completion-run',
] as const;

/**
 * Shipped default-off product feature flags (Wave B components, ADR-0003).
 * The product runner may arm these in the public CLI process ONLY when the
 * operator explicitly sets them in the runner environment — the passthrough
 * never invents a value, and every armed flag is recorded in the manifest's
 * productMode.overrides so a screen arm is self-describing. Each flag's
 * default remains OFF inside product code, except RENOR_SESSION_EXPAND (on at five notes unless set to 0) and
 * RENOR_SESSION_DIVERSITY (searches capped at 2 chunks per note; get_context uncapped by default): see their entries; this list governs EVAL
 * ARMING only.
 */
export const PRODUCT_FEATURE_FLAGS = [
  { env: 'RENOR_STRUCTURED_CONTEXT', component: 'C0-composer' },
  { env: 'RENOR_TYPED_FACTS', component: 'C2-facts' },
  { env: 'RENOR_CHRONICLE', component: 'C3-chronicle' },
  { env: 'RENOR_PREFS', component: 'C4-prefs' },
  { env: 'RENOR_QUERY_SCOPED_ROWS', component: 'C5-qscope' },
  // Evidence second-pass gate policy (src/evidence/gate.ts: off|auto|always).
  // It is a shipped default-off product surface (RENOR_SEARCH_EVIDENCE) with a
  // policy knob, and it is forwarded to the product process by the runner — so
  // two arms differing only in this value are genuinely different arms and must
  // not share a provenance record. Measured 2026-09-26: without this entry, the
  // auto and always arms produced byte-identical productMode.overrides.
  { env: 'RENOR_EVIDENCE_MODE', component: 'evidence-gate' },
  { env: 'RENOR_EVIDENCE_SESSIONS', component: 'evidence-coverage' },
  // Session-diversity top-K window (retrieval orchestrator, search default 2 chunks per note, get_context default 0, explicit 0 is off).
  // Forwarded so a capped screen arm's manifest is self-describing, like the other flags. An unset value is the
  // product default, so an arm that must run without the cap sets 0.
  { env: 'RENOR_SESSION_DIVERSITY', component: 'session-diversity' },
  // Session expansion (retrieval orchestrator, default ON at five notes, 0 is off): how many of the window's best
  // notes are expanded, the token budget of what they add, and the longest statement it may add. Each is recorded, so
  // two arms differing only in the budget or the statement limit differ here too. An unset value is the product
  // default, so an arm that must run without the expansion sets 0.
  { env: 'RENOR_SESSION_EXPAND', component: 'session-expand' },
  { env: 'RENOR_SESSION_EXPAND_TOKENS', component: 'session-expand-budget' },
  { env: 'RENOR_SESSION_EXPAND_STATEMENT_TOKENS', component: 'session-expand-statement' },
  { env: 'RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS', component: 'session-expand-document-statement' },
  // The operator's declaration that an OpenAI-compatible endpoint returns a calibrated provider's vectors (retrieval
  // orchestrator calibratedModelKey, default unset): it arms the ranked expansion on the CLI path the way a hosted
  // workspace has it, so an arm that sets it is a different arm from its control and is recorded as one.
  { env: 'RENOR_EMBEDDING_SERVED_BY', component: 'embedding-served-by' },
  // Session router (src/router/sessionRouter.ts, default OFF: off|replace|union) and the two models it calls. The
  // models are recorded because two router arms that differ only in a model are different arms.
  { env: 'RENOR_SESSION_ROUTER', component: 'session-router' },
  { env: 'RENOR_ROUTER_MODEL', component: 'session-router-model' },
  { env: 'RENOR_ROUTER_SUMMARY_MODEL', component: 'session-router-summary-model' },
  // Write-time digests (src/digests/digests.ts, default OFF) and the knobs that change what they hold or show.
  { env: 'RENOR_DIGESTS', component: 'write-time-digests' },
  { env: 'RENOR_DIGEST_MODEL', component: 'write-time-digests-model' },
  { env: 'RENOR_DIGEST_REASONING_EFFORT', component: 'write-time-digests-effort' },
  { env: 'RENOR_DIGEST_TOKENS', component: 'write-time-digests-budget' },
  // P1 strip-excerpt-meta (run-longmemeval-product --strip-excerpt-meta):
  // deterministic strip of the pure-meta header lines inside each excerpt
  // block; content + Session date footers preserved. Default-off; armed only
  // when the operator sets RENOR_STRIP_EXCERPT_META in the runner env.
  { env: 'RENOR_STRIP_EXCERPT_META', component: 'P1-excerpt-meta' },
  { env: 'RENOR_EVIDENCE_ENUMERATE', component: 'evidence-enumeration' },
  // Evidence request bounds (src/evidence/options.ts, default unset = no bound).
  // A bounded arm is a different extractor configuration from an unbounded
  // one, so each armed bound is recorded like the other evidence knobs.
  { env: 'RENOR_EVIDENCE_MAX_TOKENS', component: 'evidence-max-tokens' },
  { env: 'RENOR_EVIDENCE_REASONING_EFFORT', component: 'evidence-reasoning-effort' },
] as const;

/**
 * Resolve the armed subset for a run: the exact flag values that will be
 * passed through to the product process, as `NAME=value` manifest override
 * strings. Deterministic order (declared above); unset flags are omitted so
 * default-off stays default-off and the manifest shows an empty arm list for
 * control runs at the product defaults.
 */
export function productFeatureFlagOverrides(env: Record<string, string | undefined>): string[] {
  return PRODUCT_FEATURE_FLAGS
    .filter(flag => env[flag.env] !== undefined && env[flag.env] !== '')
    .map(flag => `${flag.env}=${env[flag.env]}`);
}

/** Gold-derived dataset fields that must never appear as runtime-visible inputs. */
export const GOLD_RUNTIME_FIELD_NAMES = [
  'answer',
  'answer_session_ids',
  'question_type',
  'shouldAbstain',
] as const;

export interface ManifestTruthFields {
  manifestContractVersion: number;
  executionKind: ExecutionKind;
  publicEntryPoint: 'mcp' | 'api' | 'cli' | null;
  entryPointDetail: { transport: string; command: string } | null;
  runtimeVisibleFieldAllowlist: string[];
  goldIsolated: boolean;
  goldIsolationBasis?: string;
  productMode: { defaults: string; overrides: string[] } | null;
  composition: { arms: string[]; live: number; cacheHits: number; mergedFrom: string[] | null } | null;
  coverage: {
    casesTotal: number;
    casesCompleted: number;
    answerErrors: number;
    judgeParseFailures: number;
    /** Explicit failed-run record: incomplete coverage is then scoreable as a failure record. */
    failedRunRecorded: boolean;
  };
  cache: {
    enabled: boolean;
    arm: CacheArm | null;
    scope: string | null;
    reads: number;
    hits: number;
    writes: number;
    dbPath: string | null;
  } | null;
  provenance: {
    gitSha: string;
    gitDirty: boolean;
    evaluatorSha256: string | null;
    datasetSha256: string | null;
    packageLockSha256: string | null;
  } | null;
  models: {
    answerRequested: string | null;
    answerEchoes: string[];
    judgeRequested: string | null;
    judgeEchoes: string[];
  } | null;
  watermark: typeof RESEARCH_WATERMARK | null;
}

/**
 * Research-preset truth fields for the existing runners. Research runs keep
 * working unchanged; their manifests are explicitly watermarked and declare
 * the (wider) research allowlist, so a research manifest can never be
 * relabeled product-public by the scorer.
 */
export function researchTruthFields(args: {
  coverage: { casesTotal: number; casesCompleted: number; answerErrors: number; judgeParseFailures: number };
  composition?: ManifestTruthFields['composition'];
  cache?: ManifestTruthFields['cache'];
}): ManifestTruthFields {
  return {
    manifestContractVersion: MANIFEST_CONTRACT_VERSION,
    executionKind: 'research',
    publicEntryPoint: null,
    entryPointDetail: null,
    runtimeVisibleFieldAllowlist: [...RESEARCH_RUNTIME_FIELD_ALLOWLIST],
    goldIsolated: false,
    goldIsolationBasis: 'research execution: gold-derived routing is legal and recorded, never product-labeled',
    productMode: null,
    composition: args.composition ?? null,
    coverage: { ...args.coverage, failedRunRecorded: false },
    cache: args.cache ?? null,
    provenance: null,
    models: null,
    watermark: RESEARCH_WATERMARK,
  };
}

/** Structural type check without throwing; returns all contract violations. */
export function validateTruthFields(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['truth fields missing or not an object'];
  const f = raw as Partial<ManifestTruthFields>;
  if (f.manifestContractVersion !== MANIFEST_CONTRACT_VERSION) {
    errors.push(`manifestContractVersion must be ${MANIFEST_CONTRACT_VERSION} (got ${String(f.manifestContractVersion)})`);
  }
  if (f.executionKind !== 'research' && f.executionKind !== 'product-public') {
    errors.push(`executionKind must be "research" or "product-public" (got ${String(f.executionKind)})`);
  }
  if (f.executionKind === 'research') {
    if (f.watermark !== RESEARCH_WATERMARK) errors.push(`research manifests must carry watermark "${RESEARCH_WATERMARK}"`);
    if (f.publicEntryPoint != null) errors.push('research manifests must have publicEntryPoint null');
  }
  if (f.executionKind === 'product-public') {
    if (f.watermark != null) errors.push('product-public manifests must not carry the RESEARCH-ONLY watermark');
    if (f.publicEntryPoint !== 'mcp' && f.publicEntryPoint !== 'api' && f.publicEntryPoint !== 'cli') {
      errors.push(`product-public manifests must record publicEntryPoint mcp|api|cli (got ${String(f.publicEntryPoint)})`);
    }
    if (!f.entryPointDetail || typeof f.entryPointDetail.transport !== 'string' || !f.entryPointDetail.transport
      || typeof f.entryPointDetail.command !== 'string' || !f.entryPointDetail.command) {
      errors.push('product-public manifests must record entryPointDetail {transport, command}');
    }
    if (f.goldIsolated !== true) errors.push('product-public manifests must assert goldIsolated true');
    if (!f.productMode) errors.push('product-public manifests must record productMode');
  }
  if (Array.isArray(f.runtimeVisibleFieldAllowlist)) {
    const expected = f.executionKind === 'product-public'
      ? [...PRODUCT_RUNTIME_FIELD_ALLOWLIST]
      : [...RESEARCH_RUNTIME_FIELD_ALLOWLIST];
    const actual = [...f.runtimeVisibleFieldAllowlist].sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      errors.push(`runtimeVisibleFieldAllowlist mismatch: got ${JSON.stringify(f.runtimeVisibleFieldAllowlist)}`);
    }
  } else {
    errors.push('runtimeVisibleFieldAllowlist missing');
  }
  if (!f.coverage || typeof f.coverage !== 'object') errors.push('coverage block missing');
  if (f.watermark !== RESEARCH_WATERMARK && f.watermark != null) {
    errors.push(`watermark must be "${RESEARCH_WATERMARK}" or null (got ${String(f.watermark)})`);
  }
  return errors;
}

/**
 * Refuse research sidecar flags for product-public execution. Any argv
 * containing a research sidecar flag is rejected — sidecar facts, chronicles,
 * preferences, temporal tables, compiler candidates, and completion runs are
 * research-only context channels.
 */
export function assertNoSidecarFlags(argv: readonly string[]): void {
  const found = SIDECAR_FLAGS.filter(flag => argv.includes(flag));
  if (found.length > 0) {
    throw new Error(`Refused for product-public execution: research sidecar flag(s) ${found.join(', ')}. ` +
      'Sidecar context channels are research-only; product mechanisms must land in src/ behind public surfaces.');
  }
}

/**
 * Structural gold-isolation marshal check: the exact runtime inputs handed to
 * the public surface (query text, process argv, spawn env) must not contain
 * gold field names or gold field values. Content parity under gold mutation
 * is proven by tests/eval/product-path-contract.test.ts (poisoned fixture).
 */
export function assertGoldIsolatedRuntimeInputs(args: {
  query: string;
  argv: readonly string[];
  env: Record<string, string>;
  goldValues?: string[];
}): void {
  const marshaled = [
    args.query,
    args.argv.join('\0'),
    Object.entries(args.env).map(([key, value]) => `${key}=${value}`).join('\0'),
  ].join('\0');
  for (const field of GOLD_RUNTIME_FIELD_NAMES) {
    // Gold field NAMES must not appear as structured keys; allow ordinary
    // prose coincidences in the query by checking argv/env strictly and the
    // query only for key-like occurrences.
    if (args.argv.join(' ').toLowerCase().includes(field.toLowerCase())
      || Object.keys(args.env).some(key => key.toLowerCase().includes(field.toLowerCase()))) {
      throw new Error(`Gold field name "${field}" appeared in runtime argv/env — gold fields must never reach the product process`);
    }
    if (field === 'answer' || field === 'shouldAbstain') continue; // prose overlap: covered by parity fixture
    if (args.query.includes(field)) {
      throw new Error(`Gold field name "${field}" appeared in the runtime query`);
    }
  }
  if (marshaled.includes('"shouldAbstain"') || marshaled.includes('"question_type"') || marshaled.includes('"answer_session_ids"')) {
    throw new Error('Gold field JSON keys appeared in marshaled runtime inputs');
  }
}

/**
 * Scorer fail-closed eligibility for a product label. Collects ALL refusal
 * reasons and throws one combined error. A product score requires:
 * product-public execution, clean provenance, complete coverage (unless an
 * explicit failed-run record), zero promotion-arm cache reads/hits, and
 * complete model echoes.
 *
 * Returns a coverage note when the run is an explicitly recorded failed run.
 */
export function assertProductScoreEligibility(manifest: Record<string, unknown>): { failedRunRecord: boolean } {
  const reasons: string[] = [];
  const truth = manifest as Partial<ManifestTruthFields>;

  if (manifest.manifestContractVersion === undefined) {
    throw new Error('Refusing product label: manifest has no product-truth contract fields (pre-contract run). ' +
      'Score it with --label research; it is watermarked RESEARCH-ONLY.');
  }
  for (const error of validateTruthFields(manifest)) reasons.push(error);

  if (truth.executionKind !== 'product-public') {
    reasons.push(`executionKind is "${String(truth.executionKind)}": research runs carry only the ${RESEARCH_WATERMARK} label, never a product label`);
  }

  const provenance = truth.provenance ?? {
    gitSha: manifest.gitSha, gitDirty: manifest.gitDirty, evaluatorSha256: manifest.evaluatorSha256,
  };
  if (!provenance || typeof provenance !== 'object') {
    reasons.push('provenance block missing');
  } else {
    const gitSha = String((provenance as { gitSha?: unknown }).gitSha ?? '');
    if (!gitSha || gitSha === 'unknown') reasons.push('provenance.gitSha missing or unknown');
    if ((provenance as { gitDirty?: unknown }).gitDirty === true) reasons.push('gitDirty: the executed code does not match the recorded SHA');
    if (gitDirtyLike((provenance as { gitDirty?: unknown }).gitDirty)) reasons.push('provenance.gitDirty missing');
    const evaluatorSha = (provenance as { evaluatorSha256?: unknown }).evaluatorSha256;
    if (typeof evaluatorSha !== 'string' || !/^[0-9a-f]{64}$/.test(evaluatorSha)) reasons.push('provenance.evaluatorSha256 missing or malformed');
    const datasetSha = (provenance as { datasetSha256?: unknown }).datasetSha256;
    if (typeof datasetSha !== 'string' || !/^[0-9a-f]{64}$/.test(datasetSha)) reasons.push('provenance.datasetSha256 missing or malformed');
  }

  const coverage = truth.coverage;
  let failedRunRecord = false;
  if (!coverage || typeof coverage !== 'object') {
    reasons.push('coverage block missing');
  } else {
    const c = coverage as ManifestTruthFields['coverage'];
    if (!(c.casesTotal > 0)) reasons.push('coverage.casesTotal must be > 0');
    if (c.casesCompleted !== c.casesTotal) {
      if (c.failedRunRecorded === true) failedRunRecord = true;
      else reasons.push(`incomplete coverage: casesCompleted ${c.casesCompleted} < casesTotal ${c.casesTotal} (record a failed-run record explicitly to score a failed run)`);
    }
    if ((c.answerErrors ?? 0) > 0) {
      if (c.failedRunRecorded === true) failedRunRecord = true;
      else reasons.push(`incomplete coverage: ${c.answerErrors} answer error(s) (record a failed-run record explicitly to score a failed run)`);
    }
    if ((c.judgeParseFailures ?? 0) > 0 && c.failedRunRecorded !== true) {
      reasons.push(`incomplete coverage: ${c.judgeParseFailures} judge parse failure(s)`);
    }
  }

  const cache = truth.cache;
  if (!cache || typeof cache !== 'object') {
    reasons.push('cache evidence missing');
  } else {
    const cc = cache as ManifestTruthFields['cache'];
    if (cc?.arm !== 'promotion' && cc?.arm !== 'iteration') {
      reasons.push(`cache.arm must be "promotion" or "iteration" (got ${String(cc?.arm)})`);
    }
    // Plan Task 8 semantics: "fresh isolated write-through caches and ZERO HITS".
    // Validity requires zero HITS (no replayed responses); read ATTEMPTS against
    // the verified-fresh DB are harmless by construction (nothing to hit).
    if (cc?.arm === 'promotion' && ((cc.hits ?? 0) > 0)) {
      reasons.push(`promotion arm used cache HITS (hits=${cc.hits}, reads=${cc.reads}): authoritative promotions require zero cache hits — replayed responses invalidate the run`);
    }
  }

  // Embedding provider: eval-hash/local are transport-smoke only. An
  // authoritative product score must run on a production embedding provider,
  // and the measured embedding configuration must be recorded in the manifest.
  // Embedding provider: eval-hash/local are transport-smoke only, and even a
  // watermarked smoke run can NEVER carry the product label — the watermark
  // lets smoke runs exist, it never authorizes the authoritative label.
  const embeddingProvider = String((manifest as { embeddingProvider?: unknown }).embeddingProvider ?? '');
  const transportSmoke = (manifest as { transportSmoke?: unknown }).transportSmoke === true;
  if (transportSmoke) {
    reasons.push('transportSmoke: transport-smoke runs (non-production embeddings) can never carry a product label — score with --label research');
  } else if (!embeddingProvider) {
    reasons.push('embeddingProvider missing from manifest: the embedding configuration of the measured product instance must be recorded');
  } else if (embeddingProvider === 'eval-hash' || embeddingProvider === 'local') {
    reasons.push(`embeddingProvider is "${embeddingProvider}": non-production embeddings can never carry a product label (--transport-smoke labels smoke runs for research, it does not authorize the product label)`);
  }

  const models = truth.models ?? {
    answerRequested: manifest.answerModelRequested,
    answerEchoes: manifest.answerModelEchoes,
    judgeRequested: manifest.judgeModelRequested,
    judgeEchoes: manifest.judgeModelEchoes,
  };
  if (!models || typeof models !== 'object') {
    reasons.push('model echo evidence missing');
  } else {
    const m = models as ManifestTruthFields['models'];
    if (!m?.answerEchoes || m.answerEchoes.length === 0) reasons.push('missing answer model echo(s): provider responses were not recorded');
    if (!m?.judgeEchoes || m.judgeEchoes.length === 0) reasons.push('missing judge model echo(s): provider responses were not recorded');
    if (typeof m?.answerRequested !== 'string' || !m.answerRequested) reasons.push('missing answer model request id');
    if (typeof m?.judgeRequested !== 'string' || !m.judgeRequested) reasons.push('missing judge model request id');
  }

  if (reasons.length > 0) {
    throw new Error(`Refusing product score (${reasons.length} reason(s)):\n- ${reasons.join('\n- ')}`);
  }
  return { failedRunRecord };
}

function gitDirtyLike(value: unknown): boolean {
  return value === undefined || value === null || typeof value !== 'boolean';
}

/**
 * Files that define the measurement system (evaluator), as opposed to the
 * system under test (product retrieval code). Any change to these files
 * changes the meaning of every score produced afterwards, so their content
 * hash is recorded in every run manifest and must be identical between a
 * baseline and a candidate for a comparison to count as a clean ablation.
 *
 * Product code (src/retrieval, src/indexer, src/embeddings, src/db, src/mcp)
 * is intentionally NOT listed: it is the candidate being measured.
 */
export const EVALUATOR_SOURCES = [
  'src/eval/hashEmbedding.ts',
  'src/eval/evalCache.ts',
  // Which memory store a case is searched against (a restored index snapshot or a cold build): it decides every page.
  'src/eval/indexSnapshots.ts',
  // How a page dump is hashed and checked before a QA run reads it.
  'src/eval/pageDump.ts',
  // How every runner counts a context's tokens (special-token spellings as text): it decides what fits a token cap.
  'src/eval/textTokens.ts',
  'scripts/eval/run-longmemeval-qa.ts',
  'scripts/eval/score-longmemeval-qa.ts',
  'scripts/eval/run-longmemeval-product.ts',
  'src/eval/metrics.ts',
  'src/eval/scoring.ts',
  'src/eval/comparison.ts',
  'src/eval/renorbenchBaseline.ts',
  'src/eval/renorbenchProduct.ts',
  'src/eval/renorbenchDocuments.ts',
  'src/eval/runManifest.ts',
  'src/eval/artifacts.ts',
  'src/eval/longmemeval.ts',
  'scripts/eval/run-renorbench.ts',
  'scripts/eval/run-renorbench-product.ts',
  'scripts/eval/renorbench-common.ts',
  'scripts/eval/compare-runs.ts',
  'scripts/eval/renorbench-baseline.ts',
  'scripts/eval/score-retrieval.ts',
  'scripts/eval/analyze-failures.ts',
  'scripts/eval/generate-renorbench.ts',
  'scripts/eval/run-longmemeval.ts',
  'scripts/eval/merge-longmemeval-shards.ts',
  'docs/evals/renorbench-v0.schema.json',
] as const;

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Content hash over the evaluator sources. Missing files are a hard error:
 * a silently truncated evaluator hash would weaken the freeze.
 */
export function evaluatorSourceHash(repoRoot: string): string {
  const parts: string[] = [];
  for (const relative of EVALUATOR_SOURCES) {
    const full = path.join(repoRoot, relative);
    if (!fs.existsSync(full)) {
      throw new Error(`Evaluator source missing: ${relative}`);
    }
    parts.push(`${relative}\0${sha256(fs.readFileSync(full))}`);
  }
  return sha256(parts.join('\n'));
}

export interface GitState {
  sha: string;
  dirty: boolean;
  /** Hash of `git status --porcelain` output; null when the tree is clean. */
  statusSha256: string | null;
}

/**
 * Git provenance for a run. `dirty === true` means the executed code does not
 * match the recorded SHA, which invalidates promotion-grade comparisons.
 */
export function gitState(repoRoot: string): GitState {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    const dirty = status.trim().length > 0;
    return { sha, dirty, statusSha256: dirty ? sha256(status) : null };
  } catch {
    return { sha: 'unknown', dirty: true, statusSha256: null };
  }
}

export function datasetSha256File(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

export function packageLockSha256(repoRoot: string): string | null {
  try {
    return sha256(fs.readFileSync(path.join(repoRoot, 'package-lock.json')));
  } catch {
    return null;
  }
}