/**
 * DecisionModel adapter (Lane Jev write-path plan §3): the single seam for
 * extraction-time typed decisions — capture-gate classification and dedupe
 * adjudication. The ledger never depends on a vendor: the default TODAY is the
 * deterministic local-rules implementation (`LocalRulesDecisionModel`, zero
 * model calls, zero cost); a model-backed adapter (gemma4:31b, jev, ...) plugs
 * in later by implementing this interface. No vendor is hardcoded anywhere in
 * the write path.
 *
 * Contract shape (docs/evals/LANE-JEV-WRITE-PATH.md §3):
 *   decide(task, input) -> { decision: TypedEnum, confidence, latencyMs, costUSDCents }
 *
 * Privacy mode is part of the interface: the local implementation never sends
 * text off-host, and costUSDCents is 0 for every local decision.
 */

/** v1 numeric fact candidate (facts lane payload, ADR-0003 §4). */
export interface FactCandidate {
  value: string;
  unit?: string;
  verb?: string;
  object: string;
  event?: string;
}

import { scanSecrets } from './secretScanner';
import {
  normDedupeValue,
  type EventPayload,
  type PreferencePayload,
  type RowKind,
  type StructuredRowPayload,
} from '../context/rowStore';

/** T1 capture gate: durability classification of a text span. */
export type CaptureGateDecision = 'none' | 'fact' | 'event' | 'preference' | 'commitment' | 'sensitive';

/** T2 dedupe adjudication of a candidate against an existing current row. */
export type DedupeDecision = 'identical' | 'updated' | 'distinct';

export interface CaptureGateRequest {
  task: 'capture_gate';
  /** The text span to classify (chunk text at index time). */
  text: string;
}

export interface DedupeRequest {
  task: 'dedupe_adjudication';
  /**
   * Lane the candidate belongs to. Defaults to 'fact' for v1 fact-lane
   * callers; the harmonized write path passes the generating lane so the
   * adjudicator compares the lane's own payload identity (fact value/object,
   * event when/event, pref statement).
   */
  rowKind?: RowKind;
  candidate: StructuredRowPayload;
  /** Current row with the same dedupe identity, or null when none exists. */
  existing: StructuredRowPayload | null;
}

/** Labels for a saved note. `noise` is the prompt's noise. `sensitive` is never stored. */
export type NoteClass = 'decision' | 'preference' | 'fact' | 'result' | 'request' | 'noise' | 'sensitive';

export interface ClassifyCaptureRequest {
  task: 'classify_capture';
  /** The saved note, in the words the agent wrote. */
  text: string;
}

export type DecisionRequest = CaptureGateRequest | DedupeRequest | ClassifyCaptureRequest;

export type DecisionResult =
  | { task: 'capture_gate'; decision: CaptureGateDecision; confidence: number; latencyMs: number; costUSDCents: number }
  | { task: 'dedupe_adjudication'; decision: DedupeDecision; confidence: number; latencyMs: number; costUSDCents: number }
  | { task: 'classify_capture'; decision: NoteClass; confidence: number; latencyMs: number; costUSDCents: number };

export interface DecisionModel {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/**
 * Lexical identity normalization for the dedupe verdict, shared with the
 * rowStore dedupe key — this must be the SAME function the key is built from.
 * It used to be a byte-copy of `normDedupeValue`, which is how it drifted into
 * deleting every non-Latin character independently of the key pipeline; the two
 * are now one import so a key and its adjudication verdict cannot disagree.
 */
const norm = normDedupeValue;

/**
 * v1 numeric-fact capture cues: a number (with optional unit) anchored to a
 * stative or eventive predicate. Conservative and gold-blind — the rules are
 * the current-baseline classification, not a quality claim (the Lane Jev
 * adapter is the seam where a stronger classifier plugs in). Exported so the
 * capture-gate rules and the candidate extractor share one definition.
 */
export const NUMERIC_FACT_RE =
  /\b(\d+:\d{2}(?::\d{2})?|\d+(?:[.,]\d+)?)\s*(km|kg|mi|miles?|minutes?|mins?|hours?|hrs?|days?|weeks?|years?|%|percent|dollars?|usd|\$|€|£|reps?|lbs?|pounds?)?\b/i;
export const STATIVE_CUE_RE =
  /\b(is|are|was|were|has|have|had|weighs?|costs?|paid|earned|runs?|ran|completed|finished|measures?|lasted|took|scored|deadline|birthday|anniversary|scheduled|due)\b/i;

/**
 * Local rules DecisionModel — the default TODAY. Deterministic (same input →
 * same decision), zero network, zero cost. Capture gate: a span is offered to
 * fact extraction only when it carries a numeric value anchored by a cue
 * verb/phrase; everything else gates to `none` in v1 (events/preferences are
 * C3/C4 lanes). Dedupe: exact normalized (value, object) equality is
 * `identical`; same object with a changed value is `updated`; otherwise
 * `distinct`. Supersede is identity-keyed only — never blanket newest-wins
 * (N18 KILL).
 *
 * Harmonization: the same adjudication semantics generalize per lane on the
 * lane's own payload identity — event: same event + same `when` is
 * `identical`, same event with a changed `when` is `updated`; preference:
 * same normalized statement is `identical` (statement IS the identity),
 * anything else `distinct`. The rowKind default keeps the v1 fact-lane
 * callers (and their tests) byte-identical.
 */

const DECISION_RE = /\b(decided|decision|we will|we'll|going with|chose|chosen|the call is|agreed to)\b/i;
const PREFERENCE_RE = /\b(prefer|preference|rather|always use|never use|don't use|do not use|instead of)\b/i;
const RESULT_RE = /\b(passed|failed|shipped|the result|finished|deployed|merged)\b/i;
const REQUEST_RE = /\b(please|can you|could you|would you|need you to|let me know|ask [a-z0-9_-]+ to)\b/i;
const NOISE_LEAD_RE = /^(ok|okay|thanks|thank you|lol|hey|on it|looking|got it|sure|yep|nope)\b/i;
const NOISE_CHATTER_RE = /\b(thanks|thank you|lol)\b/i;
const COPULA_RE = /\b(is|are|was|were)\b/i;

/**
 * Cue order is fixed: a decision, preference or result is named before a question mark can
 * steal it, and a numeric fact (the existing capture gate) is named before a broad "is".
 * Anything else is noise. Sensitive text is refused before any of those.
 */
export function classifyNote(text: string): NoteClass {
  const trimmed = text.trim();
  if (!trimmed) return 'noise';
  if (scanSecrets(trimmed)) return 'sensitive';
  if (DECISION_RE.test(trimmed)) return 'decision';
  if (PREFERENCE_RE.test(trimmed)) return 'preference';
  if (RESULT_RE.test(trimmed)) return 'result';
  if (LocalRulesDecisionModel.captureGate(trimmed) === 'fact') return 'fact';
  if (REQUEST_RE.test(trimmed) || /\?\s*$/.test(trimmed)) return 'request';
  if (NOISE_LEAD_RE.test(trimmed) || NOISE_CHATTER_RE.test(trimmed)) return 'noise';
  const words = trimmed.split(/\s+/).length;
  if (COPULA_RE.test(trimmed) && words >= 4) return 'fact';
  return 'noise';
}

export class LocalRulesDecisionModel implements DecisionModel {
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const start = Date.now();
    let result: DecisionResult;
    if (request.task === 'capture_gate') {
      result = {
        task: 'capture_gate',
        decision: LocalRulesDecisionModel.captureGate(request.text),
        confidence: 1,
        latencyMs: 0,
        costUSDCents: 0,
      };
    } else if (request.task === 'classify_capture') {
      result = {
        task: 'classify_capture',
        decision: LocalRulesDecisionModel.classifyNote(request.text),
        confidence: 1,
        latencyMs: 0,
        costUSDCents: 0,
      };
    } else {
      result = {
        task: 'dedupe_adjudication',
        decision: LocalRulesDecisionModel.adjudicate(
          request.candidate,
          request.existing,
          request.rowKind ?? 'fact',
        ),
        confidence: 1,
        latencyMs: 0,
        costUSDCents: 0,
      };
    }
    // latencyMs is reported (measured wall time), never simulated.
    const latencyMs = Date.now() - start;
    return { ...result, latencyMs } as DecisionResult;
  }

  static captureGate(text: string): CaptureGateDecision {
    if (!text || !text.trim()) return 'none';
    const hasValue = NUMERIC_FACT_RE.test(text);
    const hasCue = STATIVE_CUE_RE.test(text);
    if (hasValue && hasCue) return 'fact';
    return 'none';
  }

  /**
   * Local rules for a saved note. Same constraints as the rest of this class: deterministic,
   * no network, no key, cost 0. This is not a model. It does not invent a subject, predicate
   * or object, and nothing here writes a memory.
   */
  static classifyNote(text: string): NoteClass {
    return classifyNote(text);
  }

  static adjudicate(
    candidate: StructuredRowPayload,
    existing: StructuredRowPayload | null,
    rowKind: RowKind = 'fact',
  ): DedupeDecision {
    if (!existing) return 'distinct';
    if (rowKind === 'event') {
      const c = candidate as EventPayload;
      const e = existing as EventPayload;
      if (norm(c.event) !== norm(e.event)) return 'distinct';
      return norm(c.when) === norm(e.when) ? 'identical' : 'updated';
    }
    if (rowKind === 'preference') {
      const c = candidate as PreferencePayload;
      const e = existing as PreferencePayload;
      return norm(c.statement) === norm(e.statement) ? 'identical' : 'distinct';
    }
    const c = candidate as FactCandidate;
    const e = existing as FactCandidate;
    const sameObject = norm(c.object) === norm(e.object);
    const sameValue = norm(c.value) === norm(e.value);
    if (sameObject && sameValue) return 'identical';
    if (sameObject && !sameValue) return 'updated';
    return 'distinct';
  }
}

/** The write path's default decision point — local rules today, vendor later. */
export function defaultDecisionModel(): DecisionModel {
  return new LocalRulesDecisionModel();
}