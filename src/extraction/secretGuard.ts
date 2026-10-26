/**
 * The write-path secret guard: tier 0 of the sensitivity guardrail
 * (docs/evals/results/SECRET-GUARD-TIER0-20261003.md).
 *
 * Behind RENOR_SECRET_GUARD, default ON (secretGuardEnabled). Every path that writes text into memory screens
 * it with the deterministic scanner first, before anything is written:
 *
 *   save     `remember` (both modes), `save_memory`, the daily-note writer, the conversation logger:
 *            the whole save is refused. Nothing is stored, redacted or altered, so a save that
 *            succeeds is still a save that stored every character it was given.
 *   import   a note or fact in an import plan is left out with its reason, and a plan that still holds
 *            one is refused whole (src/importing/secretScreen.ts).
 *   retire   a memory whose text is flagged is not retired, because retiring copies its text into the
 *            retired-memory journal; restore is refused the same way, because it puts the text back
 *            into live memory (src/memorymap/memoryMap.ts).
 *
 * With it off (RENOR_SECRET_GUARD=0, false, no or off), nothing here runs on any of those paths.
 *
 * The guard is a DecisionModel, so the write path asks the same `capture_gate` question the indexer
 * asks and refuses on `sensitive`. A model's second opinion, if one is ever approved, composes behind
 * the scanner here, and a scanner `sensitive` stays final.
 *
 * It decides whether text may be STORED. It cannot stop text from reaching the server, and it does not
 * look at what is already stored.
 */
import { defaultDecisionModel, type DecisionModel, type DecisionRequest, type DecisionResult } from './decision-model';
import { scanSecrets, type SecretFinding } from './secretScanner';

/**
 * RENOR_SECRET_GUARD (default ON, decided 2026-10-12). Off only when set to 0, false, no or off (any case). Unset, empty
 * and any other value keep it on: a value the guard does not recognise must not switch the screen off.
 */
export function secretGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_SECRET_GUARD ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/** A capture_gate `sensitive` verdict that also says what kind of thing was found (a fixed label, never input text). */
type SensitiveDecision = Extract<DecisionResult, { task: 'capture_gate' }> & { finding: SecretFinding };

/**
 * Answers the capture gate from the scanner alone: text it flags is `sensitive`, and everything else
 * (all other text, and every dedupe question) is the inner model's, so the guard changes no other decision.
 */
export class SecretGuardDecisionModel implements DecisionModel {
  constructor(private readonly inner: DecisionModel = defaultDecisionModel()) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (request.task !== 'capture_gate') return this.inner.decide(request);
    const started = Date.now();
    const finding = scanSecrets(request.text);
    if (finding === null) return this.inner.decide(request);
    const verdict: SensitiveDecision = {
      task: 'capture_gate',
      decision: 'sensitive',
      confidence: 1,
      latencyMs: Date.now() - started,
      costUSDCents: 0,
      finding,
    };
    return verdict;
  }
}

type Refusal = SecretFinding['class'] | 'sensitive' | 'unavailable';

/** What was being attempted when the guard refused. A save writes new text; retire and restore move text that is already stored. */
export type GuardAction = 'save' | 'retire' | 'restore';

const APPEARS_TO_CONTAIN: Record<Exclude<Refusal, 'unavailable'>, string> = {
  credential: 'a credential (an API key, token, password, PIN or private key)',
  identifier: 'a personal identifier (a payment card, government ID or phone number)',
  sensitive: 'a credential or personal identifier',
};

/**
 * What the caller is told. It names the field and the kind of thing found from fixed text, never the
 * text itself, and says what to do next. Kept under the 400 characters the MCP error reply keeps.
 */
function refusalMessage(field: string, reason: Refusal, action: GuardAction): string {
  const lead = action === 'save' ? 'Nothing was saved' : 'Nothing was changed';
  if (reason === 'unavailable') {
    return `${lead}: the secret guard (RENOR_SECRET_GUARD) is on but could not check the ${field}, so it refuses by default. `
      + 'Try again, and tell the user if it keeps happening.';
  }
  if (action === 'retire') {
    return `${lead}: the ${field} appears to contain ${APPEARS_TO_CONTAIN[reason]}, and the secret guard (RENOR_SECRET_GUARD) is on, `
      + 'so this memory was not retired: retiring copies its text into the retired-memory journal. It stays as it is. '
      + 'Remove it with the data-deletion procedure, or ask the owner to switch the guard off first.';
  }
  if (action === 'restore') {
    return `${lead}: the ${field} appears to contain ${APPEARS_TO_CONTAIN[reason]}, and the secret guard (RENOR_SECRET_GUARD) is on, `
      + 'so this memory was not restored: restoring would put its text back into live memory. It stays retired.';
  }
  return `${lead}: the ${field} appears to contain ${APPEARS_TO_CONTAIN[reason]}, and the secret guard (RENOR_SECRET_GUARD) is on, `
    + 'so Renor does not store it. Save what it is for instead (for example "the staging API key is in 1Password"), '
    + 'or reword the text without the value, then save again.';
}

/** The operation was refused: nothing was written or moved. `reason` is what was found, or `unavailable` when the guard could not decide. */
export class SecretRefusedError extends Error {
  readonly field: string;
  readonly reason: Refusal;
  readonly action: GuardAction;

  constructor(field: string, reason: Refusal, action: GuardAction = 'save') {
    super(refusalMessage(field, reason, action));
    this.name = 'SecretRefusedError';
    this.field = field;
    this.reason = reason;
    this.action = action;
  }
}

export interface WriteText {
  /** What the caller calls this text; shown in the refusal. */
  field: string;
  text: string | undefined;
  /** A name or a label, not content: only the scanner judges it, and no model ever sees it. */
  nameOnly?: boolean;
}

/**
 * One line for whoever runs the service, in the same JSON shape as its access log: what was refused and why,
 * never what it said. It is how an operator sees what the guard is refusing.
 */
function logRefusal(field: string, reason: Refusal, action: GuardAction | 'import', cause?: unknown): void {
  console.warn(JSON.stringify({
    ts: new Date().toISOString(), event: 'secret_guard_refusal', action, field, reason,
    ...(cause instanceof Error ? { error: cause.name } : {}),
  }));
}

function refuse(field: string, reason: Refusal, action: GuardAction, cause?: unknown): never {
  logRefusal(field, reason, action, cause);
  throw new SecretRefusedError(field, reason, action);
}

/** For a text the guard cannot read in full (too large to hold): refuse, as it does when its own check fails. */
export function refuseUnchecked(field: string, action: GuardAction): never {
  return refuse(field, 'unavailable', action);
}

/**
 * Throws SecretRefusedError when the guard is on and any of `texts` is sensitive; resolves otherwise.
 * It fails closed: if the check itself throws, the save is refused. Call it before the first write.
 * `contentModel`, when a save path passes one, only adds a second opinion on the texts that are not `nameOnly`.
 * With the guard off it returns at once, so callers that must not add a step to the unguarded path
 * check `secretGuardEnabled()` first and skip the call.
 */
export async function assertStorable(
  texts: readonly WriteText[],
  action: GuardAction = 'save',
  contentModel: DecisionModel | null = null,
): Promise<void> {
  if (!secretGuardEnabled()) return;
  const model = new SecretGuardDecisionModel();
  // A second opinion on content only (jevDecisionModel.ts, one opted-in workspace's saves): the scanner still answers first
  // and a scanner `sensitive` is final, because SecretGuardDecisionModel asks the inner model only about text it did not flag.
  const withContentModel = contentModel ? new SecretGuardDecisionModel(contentModel) : model;
  for (const { field, text, nameOnly } of texts) {
    if (text === undefined || text === '') continue;
    let verdict: DecisionResult;
    try {
      verdict = await (nameOnly ? model : withContentModel).decide({ task: 'capture_gate', text });
    } catch (cause) {
      refuse(field, 'unavailable', action, cause);
    }
    if (verdict.decision === 'sensitive') {
      refuse(field, (verdict as Partial<SensitiveDecision>).finding?.class ?? 'sensitive', action);
    }
  }
}

/**
 * The first of `texts` that looks like a secret, or null: the same scanner as `assertStorable`, answered at
 * once and without the DecisionModel, for the bulk paths that screen thousands of texts in synchronous code
 * (an import plan) and decide per item. Independent of the switch: callers check `secretGuardEnabled()`.
 * If the scan throws, the exception propagates, so a plan that cannot be screened is not built or applied.
 */
export function findSensitive(texts: readonly WriteText[]): { field: string; reason: SecretFinding['class'] } | null {
  for (const { field, text } of texts) {
    if (text === undefined || text === '') continue;
    const finding = scanSecrets(text);
    if (finding !== null) return { field, reason: finding.class };
  }
  return null;
}

/** One log line for a text a bulk path left out (same shape as a refusal), so an operator sees what the guard skipped. */
export function logSkip(field: string, reason: SecretFinding['class']): void {
  logRefusal(field, reason, 'import');
}
