/**
 * Gating for the H10 second-pass evidence extraction.
 *
 * Off unless the operator turns it on (owner decision, 18 Oct 2026: a self-hosted engine keeps its notes on the
 * user's machine until the user chooses otherwise). The pass sends the matched notes to the evidence model's
 * provider, so an unset or blank RENOR_EVIDENCE_MODE means off. Hosted Renor sets always in each workspace's unit
 * (scripts/alpha/provision-renor-tenant.sh), and the product benchmark runner sets it for its child process.
 *
 *   off    — default and kill switch. The tool returns hits only, even when forced.
 *   auto   — run only for aggregation/enumeration intent or force: true.
 *   always — run on every query with available source sessions.
 */
export type EvidenceMode = 'off' | 'auto' | 'always';

export function resolveEvidenceMode(env: NodeJS.ProcessEnv = process.env): EvidenceMode {
  const raw = (env.RENOR_EVIDENCE_MODE ?? '').trim().toLowerCase();
  if (raw === '') return 'off';
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return 'off';
  if (raw === 'always' || raw === 'on' || raw === '1' || raw === 'yes' || raw === 'all') return 'always';
  if (raw === 'auto') return 'auto';
  throw new Error(`Invalid RENOR_EVIDENCE_MODE "${raw}": must be off | auto | always`);
}

/**
 * Gold-blind aggregation/enumeration intent. Copied from the eval runner's
 * AGGREGATE_INTENT and widened with count/list cues; never fixture-specific.
 */
export const EVIDENCE_INTENT = /\b(how many|how much|in total|total|altogether|combined|all of the|all the|count|number of|list|enumerate|every)\b/i;

export function hasEvidenceIntent(query: string): boolean {
  return EVIDENCE_INTENT.test(query);
}

export interface EvidenceGateDecision {
  run: boolean;
  reason: 'mode-off' | 'intent' | 'forced' | 'mode-always' | 'run';
}

export function evidenceGate(mode: EvidenceMode, query: string, force = false): EvidenceGateDecision {
  if (mode === 'off') return { run: false, reason: 'mode-off' };
  if (force) return { run: true, reason: 'forced' };
  if (mode === 'always') return { run: true, reason: 'mode-always' };
  if (hasEvidenceIntent(query)) return { run: true, reason: 'intent' };
  return { run: false, reason: 'intent' };
}
