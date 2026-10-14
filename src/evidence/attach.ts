import type { RetrievalHit } from '../retrieval/orchestrator';
import { evidenceGate, type EvidenceGateDecision, type EvidenceMode } from './gate';
import {
  EvidenceExtractor,
  EvidenceReplyError,
  loadEvidenceSessionsFromVault,
  type EvidenceItem,
  type EvidenceResult,
  type EvidenceSessionInput,
} from './secondPass';
import type { EvidenceToolOptions } from './options';
import { waitAtMost } from './background';
import { EvidenceCapError } from './optin';

/**
 * Attach H10-v4 second-pass evidence onto the default product search path.
 *
 * Kill switch: RENOR_SEARCH_EVIDENCE (default ON since the 2026-09-22 owner
 * ship decision — the evidence second pass measured +28 net on LongMemEval-S
 * product runs: 389/500 evidence vs 361/500 baseline, p≈1e-8, official clean
 * re-validation; the kill switch RENOR_SEARCH_EVIDENCE=0 restores the pre-ship
 * behavior byte-for-byte). When off, search returns
 * the same hits array as before this change. When on, the default search /
 * get_context / search_memory path runs the same extractor as the dedicated
 * `evidence` tool (full source-note hydration, 20-note backfill, 6k cap,
 * content-addressed cache) and, on a successful extraction, prepends one
 * synthetic hit so array-only clients still see the table.
 *
 * Retrieval ranking and stored chunk text are never rewritten.
 */
export const EVIDENCE_HIT_PATH = '_renor/evidence';

export function searchEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_SEARCH_EVIDENCE ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === '';
}

export type ProductEvidenceStatus = 'ok' | 'skipped';

/**
 * The evidence second pass, said in one word.
 *
 * `reason` is a machine code, and on its own it lies to a reader: a bare
 * `skipped` + `extractor-unavailable` on every call looks like a broken
 * deployment, while a deliberate kill switch was invisible (the attachment was
 * dropped from the payload), so "off" and "unavailable" were indistinguishable.
 * `state` is that distinction; `note` is the same thing in a sentence.
 */
export type ProductEvidenceState = 'ok' | 'off' | 'unavailable' | 'not-applied' | 'failed' | 'pending' | 'busy' | 'capped';

export interface ProductEvidenceAttachment {
  status: ProductEvidenceStatus;
  reason?: 'flag-off' | 'mode-off' | 'intent' | 'forced' | 'mode-always' | 'run' | 'no-sessions' | 'extractor-unavailable' | 'extractor-parse-error' | 'extractor-error' | 'pending' | 'queue-full' | 'daily-cap';
  fromCache?: boolean;
  model?: string;
  items?: EvidenceItem[];
  sessions?: EvidenceResult['sessions'];
  usage?: EvidenceResult['usage'];
  latencyMs?: number;
  error?: string;
}

/**
 * One sentence per skip reason, saying whether anything is actually missing. The reader is the
 * user's agent, which can change no setting: the variable or key behind a state stays in `reason`
 * and the engine's docs, not in the sentence.
 */
const EVIDENCE_NOTES: Record<string, string> = {
  'flag-off':
    'Evidence second pass is switched off for this deployment. Nothing is missing: the hits below are the whole result.',
  'mode-off':
    'Evidence second pass is switched off for this deployment. Nothing is missing: the hits below are the whole result.',
  'extractor-unavailable':
    'This deployment has no evidence model configured, so no dated item table is prepended. Nothing is broken and nothing is missing: the hits below are the whole result.',
  'intent':
    'The evidence gate did not select this query, so no dated item table was prepended. Nothing is missing: the hits below are the whole result.',
  'no-sessions':
    'The ranked hits carried no dated source session to extract items from. Nothing is missing: the hits below are the whole result.',
  'extractor-parse-error':
    'The evidence model answered in a shape the parser rejects, so no dated item table was prepended. Retrieval is unaffected: the hits below are the whole result.',
  'extractor-error':
    'The evidence model call failed, so no dated item table was prepended. Retrieval is unaffected: the hits below are the whole result.',
  // The two below exist only with bounded-wait evidence on (RENOR_EVIDENCE_ASYNC): the table is missing from this
  // response, not from the product. get_context quotes them too, so they name no position in the payload.
  'pending':
    'The evidence model did not finish within the time this deployment waits for it, so this response has no dated item table. Retrieval is unaffected. The extraction continues in the background; when it succeeds its table is cached, and the same request over the same notes returns it.',
  'queue-full':
    'The evidence model already has as many extractions waiting as this deployment allows, so none was started for this request and this response has no dated item table. Retrieval is unaffected. The same request starts one once the queue drains.',
  // Only a workspace that opted in to the Ollama extractor has a daily allowance of model calls.
  'daily-cap':
    'This workspace has used its daily allowance of evidence-model calls, so this response has no dated item table. Retrieval is unaffected: the hits below are the whole result. The allowance starts again at 00:00 UTC.',
};

const EVIDENCE_NOTE_DEFAULT =
  'The evidence second pass ran and extracted no items. Nothing is missing: the hits below are the whole result.';

const EVIDENCE_NOTE_OK =
  'The evidence second pass extracted items; the dated item table is prepended as the first hit above.';

function evidenceState(evidence: ProductEvidenceAttachment): ProductEvidenceState {
  if (evidence.status === 'ok') return 'ok';
  if (evidence.reason === 'flag-off' || evidence.reason === 'mode-off') return 'off';
  if (evidence.reason === 'extractor-unavailable') return 'unavailable';
  if (evidence.reason === 'extractor-parse-error' || evidence.reason === 'extractor-error') return 'failed';
  if (evidence.reason === 'pending') return 'pending';
  if (evidence.reason === 'queue-full') return 'busy';
  if (evidence.reason === 'daily-cap') return 'capped';
  return 'not-applied';
}

/**
 * The same attachment, plus `state` and `note`. Nothing existing is renamed,
 * dropped or revalued — only the two fields a reader needs to tell an intended
 * configuration from a fault.
 */
export function productEvidenceReport(
  evidence: ProductEvidenceAttachment,
): ProductEvidenceAttachment & { state: ProductEvidenceState; note: string } {
  return {
    ...evidence,
    state: evidenceState(evidence),
    note: evidence.status === 'ok'
      ? EVIDENCE_NOTE_OK
      : ((evidence.reason !== undefined ? EVIDENCE_NOTES[evidence.reason] : undefined) ?? EVIDENCE_NOTE_DEFAULT),
  };
}

export interface CollectEvidenceArgs {
  transformBody?: (body: string) => string;
  query: string;
  hits: Array<{ notePath: string; text: string; session_date?: string }>;
  vaultPath: string;
  options: Pick<EvidenceToolOptions, 'mode' | 'maxSessions' | 'charCap' | 'cachePath' | 'background'>;
  extractor: EvidenceExtractor | null;
  force?: boolean;
  parseRetries?: number;
}

export async function collectEvidence(args: CollectEvidenceArgs): Promise<ProductEvidenceAttachment> {
  const decision = evidenceGate(args.options.mode, args.query, args.force === true);
  if (!decision.run) {
    return { status: 'skipped', reason: decision.reason };
  }
  const sessions = await loadEvidenceSessionsFromVault(args.hits, args.vaultPath, {
    transformBody: args.transformBody,
    maxSessions: args.options.maxSessions,
    charCap: args.options.charCap,
    // Body-relevance selection input (RENOR_EVIDENCE_BODY_RANK); ignored when
    // the flag is off.
    query: args.query,
  });
  if (sessions.length === 0) {
    return { status: 'skipped', reason: 'no-sessions' };
  }
  if (!args.extractor) {
    return { status: 'skipped', reason: 'extractor-unavailable' };
  }
  const extractor = args.extractor;
  // The cached table at once, else the failure this very request met within EVIDENCE_FAILURE_TTL_MS: it is said again
  // (fromCache) instead of being paid for again. A table wins over a failure remembered for the same key.
  const key = extractor.cacheKey(args.query, sessions);
  const cached = extractor.replay(key);
  if (cached) return evidenceOk(decision.reason, cached);
  const failed = extractor.replayFailure(key);
  if (failed) return { status: 'skipped', reason: 'extractor-parse-error', fromCache: true, model: failed.model, error: failed.error };
  const extract = () => extractEvidence(extractor, key, args.query, sessions, decision.reason, args.parseRetries);
  const background = args.options.background;
  if (!background) return extract();
  // Bounded wait (RENOR_EVIDENCE_ASYNC): this prompt's one extraction, waited for at most background.waitMs. The
  // flight is keyed by cache file too, so it always fills the cache this search reads.
  const flight = background.flights.join(`${args.options.cachePath ?? ''}\0${key}`, extract);
  if (!flight) return { status: 'skipped', reason: 'queue-full' };
  background.hold?.(flight);
  const settled = await waitAtMost(flight, background.waitMs);
  if (!settled) return { status: 'skipped', reason: 'pending' };
  // A joined flight may have been started by a search whose gate gave another reason.
  return settled.value.status === 'ok' ? { ...settled.value, reason: decision.reason } : settled.value;
}

function evidenceOk(reason: EvidenceGateDecision['reason'], result: EvidenceResult): ProductEvidenceAttachment {
  return {
    status: 'ok',
    reason,
    fromCache: result.fromCache,
    model: result.model,
    items: result.items,
    sessions: result.sessions,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}

/**
 * One extraction, retried on a reply the parser rejects; any other failure is thrown. When the last attempt, too, was
 * answered with a reply that is not a table, that failure is remembered under `key`; an error before any reply never is.
 */
async function extractEvidence(
  extractor: EvidenceExtractor,
  key: string,
  query: string,
  sessions: EvidenceSessionInput[],
  reason: EvidenceGateDecision['reason'],
  parseRetries?: number,
): Promise<ProductEvidenceAttachment> {
  const maxAttempts = Math.max(1, parseRetries ?? 3);
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return evidenceOk(reason, await extractor.extract(query, sessions));
    } catch (err) {
      // The workspace's daily allowance is spent: no call was made, and the search goes on without the table.
      if (err instanceof EvidenceCapError) return { status: 'skipped', reason: 'daily-cap', model: extractor.model };
      lastError = err instanceof Error ? err : new Error(String(err));
      const parseFailure = /JSON|items list|non-empty item|must be an object/i.test(lastError.message);
      if (!parseFailure || attempt === maxAttempts) break;
    }
  }
  const parseFailure = lastError && /JSON|items list|non-empty item|must be an object/i.test(lastError.message);
  if (parseFailure && lastError) {
    const error = lastError.message.slice(0, 200);
    if (lastError instanceof EvidenceReplyError) extractor.rememberFailure(key, error);
    return {
      status: 'skipped',
      reason: 'extractor-parse-error',
      model: extractor.model,
      error,
    };
  }
  throw lastError ?? new Error('evidence extraction failed');
}

/** H10-v4 fact-row mapping used by the frozen QA facts-table renderer. */
export function evidenceItemsToFactRows(
  items: EvidenceItem[],
  event = 'second-pass-v4',
): Array<{ value: string | number; unit: string; verb: string; object: string; event: string; confirm: number; dates: string[] }> {
  return items.map(item => {
    const amount = String(item.amount ?? '').trim();
    const match = amount.match(/^\$?([\d,]+(?:\.\d+)?)\s*(.*)$/);
    let value: string | number = 1;
    let unit = amount;
    if (amount && match) {
      value = match[1].replace(/,/g, '');
      unit = match[2] ?? '';
    }
    return {
      value,
      unit,
      verb: item.action ?? '',
      object: item.item ?? '',
      event,
      confirm: 1,
      dates: [item.date ?? ''],
    };
  });
}

export function renderEvidenceTable(items: EvidenceItem[]): string {
  const lines = items.map(item => {
    const action = item.action?.trim() ? ` | ${item.action.trim()}` : '';
    const amount = item.amount?.trim() ? ` | ${item.amount.trim()}` : '';
    const date = item.date?.trim() ? ` | ${item.date.trim()}` : '';
    return `- ${item.item}${action}${amount}${date}`;
  });
  return [
    'User-asserted items extracted from full source notes (with dates):',
    ...lines,
    'Use this table when relevant; cite only values present here. If the table does not contain the value needed to answer, use the excerpts instead.',
  ].join('\n');
}

export function evidenceItemsToHit(items: EvidenceItem[]): RetrievalHit {
  return {
    notePath: EVIDENCE_HIT_PATH,
    chunkId: -1,
    headingPath: 'Evidence',
    text: renderEvidenceTable(items),
    score: 1,
    reason: 'evidence',
  };
}

export function prependEvidenceHit(hits: RetrievalHit[], attachment: ProductEvidenceAttachment): RetrievalHit[] {
  if (attachment.status !== 'ok' || !attachment.items?.length) return hits;
  if (hits.some(hit => hit.notePath === EVIDENCE_HIT_PATH && hit.reason === 'evidence')) return hits;
  return [evidenceItemsToHit(attachment.items), ...hits];
}

export async function attachSearchEvidence(args: {
  transformBody?: (body: string) => string;
  query: string;
  hits: RetrievalHit[];
  vaultPath: string;
  options: EvidenceToolOptions;
  extractor: EvidenceExtractor | null;
  enabled?: boolean;
  force?: boolean;
}): Promise<{ hits: RetrievalHit[]; evidence: ProductEvidenceAttachment }> {
  if (!(args.enabled ?? searchEvidenceEnabled())) {
    return { hits: args.hits, evidence: { status: 'skipped', reason: 'flag-off' } };
  }
  try {
    const evidence = await collectEvidence({
      transformBody: args.transformBody,
      query: args.query,
      hits: args.hits,
      vaultPath: args.vaultPath,
      options: args.options,
      extractor: args.extractor,
      force: args.force,
    });
    return { hits: prependEvidenceHit(args.hits, evidence), evidence };
  } catch (err) {
    // Evidence is optional augmentation. Provider/network/cache failures must
    // never take down the base search path, but they are said, with the
    // extractor that failed, never left as a silently missing table (#222).
    const message = err instanceof Error ? err.message : String(err);
    return {
      hits: args.hits,
      evidence: {
        status: 'skipped',
        reason: 'extractor-error',
        ...(args.extractor ? { model: args.extractor.model } : {}),
        error: message.slice(0, 200),
      },
    };
  }
}
