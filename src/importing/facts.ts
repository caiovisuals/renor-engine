import crypto from 'crypto';
import { normalizeScope, type NormalizedScope } from '../mvp/scope';

/**
 * Identity and validation rules for carried facts.
 *
 * A carried fact becomes a canonical ledger event, because the engine's lifecycle
 * layer (and therefore the dashboard's fact list and graph) reads only facts whose
 * `source_path` is the lifecycle sentinel — facts derived from notes are invisible
 * to those readers.
 *
 * Two hard requirements come from `engine/src/memory/lifecycle.ts`:
 *  - event `id` and `at` decide replay idempotency (`applied_ledger_events`), so a
 *    re-run must produce a byte-identical event or replay either duplicates it or
 *    fails with "reused with a conflicting payload" — and replay runs at service
 *    STARTUP, so a mutated payload would break the workspace's readiness gate;
 *  - `at` must be the canonical instant form and ids must match `^mem_[A-Za-z0-9]+$`.
 *
 * Scope and field limits are therefore imported from the engine rather than mirrored
 * here: a validator that drifts looser fails at boot, and one that drifts stricter
 * silently loses memory.
 */

export const EVENT_ID_RE = /^mem_[A-Za-z0-9]+$/;

/** Field limits as enforced by `lifecycle.ts` `validateField`. */
const FIELD_LIMITS: Record<string, number> = { subject: 512, predicate: 256, object: 8192, source: 256 };

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The instant forms the engine's own normalizer accepts: an explicit zone, or date-only. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deterministic event id for a carried fact.
 *
 * It is a function of **everything replay compares** — source label, subject,
 * predicate, scope, object and `at` — because the id's only job is to make a re-run a
 * no-op. A narrower key would mint the same id for a different payload when the source
 * changed between runs, which replay rejects as corruption.
 */
export function deterministicEventId(input: {
  label: string;
  subject: string;
  predicate: string;
  scope: string;
  object: string;
  at: string;
}): string {
  const digest = crypto
    .createHash('sha256')
    .update([
      'renor-memory-import/v1',
      input.label,
      input.subject,
      input.predicate,
      input.scope,
      input.object,
      input.at,
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 40);
  return `mem_imp${digest}`;
}

/**
 * Canonical instant, or null when the input cannot be one. Mirrors the engine's
 * accepted inputs (an ISO instant with an explicit timezone, or date-only) and rejects
 * timezone-less datetimes, which the engine treats as ambiguous.
 */
export function toCanonicalInstant(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (CANONICAL_TS.test(trimmed) || ZONED_INSTANT.test(trimmed) || DATE_ONLY.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    const year = parsed.getUTCFullYear();
    if (year < 1970 || year > 2999) return null;
    return parsed.toISOString();
  }
  return null;
}

/** `normalizeScope` from the engine, or null when it rejects the value. */
export function tryNormalizeScope(raw: string): NormalizedScope | null {
  try {
    return normalizeScope(raw);
  } catch {
    return null;
  }
}

export interface FactValidation {
  ok: boolean;
  reason?: string;
  scope?: string;
  at?: string;
}

/**
 * Validate a fact once, before anything is written, and normalize its scope and
 * instant. A rejection is counted by reason rather than surfacing at the destination's
 * readiness gate.
 */
export function validateCarriedFact(fact: {
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  validFrom: string;
}): FactValidation {
  if (!fact.subject.trim()) return { ok: false, reason: 'empty subject' };
  if (!fact.predicate.trim()) return { ok: false, reason: 'empty predicate' };
  if (!fact.object.trim()) return { ok: false, reason: 'empty object' };
  if (CONTROL_CHARS.test(fact.subject) || CONTROL_CHARS.test(fact.predicate)
      || CONTROL_CHARS.test(fact.object) || CONTROL_CHARS.test(fact.scope)) {
    return { ok: false, reason: 'control character in a lifecycle field' };
  }
  if (fact.subject.length > FIELD_LIMITS.subject) return { ok: false, reason: 'subject exceeds 512 characters' };
  if (fact.predicate.length > FIELD_LIMITS.predicate) return { ok: false, reason: 'predicate exceeds 256 characters' };
  if (fact.object.length > FIELD_LIMITS.object) return { ok: false, reason: 'object exceeds 8192 characters' };

  const scope = tryNormalizeScope(fact.scope);
  if (scope === null) return { ok: false, reason: 'scope is not a valid scope, scope:<slug> or project:<slug>' };

  const at = toCanonicalInstant(fact.validFrom);
  if (at === null) {
    return { ok: false, reason: 'valid_from is not an ISO instant with an explicit timezone' };
  }
  return { ok: true, scope, at };
}
