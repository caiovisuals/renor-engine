import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { KNOWN_FAILURES } from './knownFailures';

/**
 * The breaker suite's bookkeeping.
 *
 * Each attack returns an exact pass/fail verdict. `runAttack` maps that verdict against the
 * known-failure baseline:
 *
 *   pass  + not known  -> pass
 *   pass  + known      -> FIXED (the test FAILS, naming the stale marker to delete)
 *   fail  + known      -> known-failure (green; the gate is not blocked by a break already recorded)
 *   fail  + not known  -> REGRESSION (the test fails, naming the attack)
 *
 * This is the whole point: every gate run attacks Renor for free, a break already on file is
 * visible without blocking every PR, and a NEW break — or a fix that silently regresses — turns
 * the gate red. A known failure that starts passing is NOT a quiet green: the stale marker would
 * hide a later regression behind itself, so the suite fails until the entry is deleted.
 */

export interface AttackResult {
  ok: boolean;
  detail: string;
  evidence?: unknown;
  /** The stable shape of a failure, compared against the known failure's signature: a change is a regression further. */
  signature?: unknown;
}

export type AttackStatus = 'pass' | 'known-failure' | 'fixed' | 'regression';

export interface AttackOutcome {
  id: string;
  status: AttackStatus;
  detail: string;
  ms: number;
}

const outcomes: AttackOutcome[] = [];
const wallStartedAt = Date.now();
const cpuStartedAt = process.cpuUsage();

/** Run one attack and record its verdict; fail the test only on a regression. */
export async function runAttack(id: string, fn: () => Promise<AttackResult>): Promise<void> {
  const known = KNOWN_FAILURES[id];
  const started = Date.now();
  let result: AttackResult;
  try {
    result = await fn();
  } catch (err) {
    result = { ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ms = Date.now() - started;

  if (result.ok) {
    if (known) {
      outcomes.push({ id, status: 'fixed', detail: result.detail, ms });
      expect.fail(`[breaker] ${id} passes now — delete it from knownFailures.ts (the known-failure marker is stale and would hide a later regression)`);
    }
    outcomes.push({ id, status: 'pass', detail: result.detail, ms });
    return;
  }

  if (known) {
    const same = JSON.stringify(result.signature) === JSON.stringify(known.signature);
    if (same) {
      outcomes.push({ id, status: 'known-failure', detail: result.detail, ms });
      return;
    }
    // The failure's evidence changed: it regressed further than the record. Re-record it only after
    // reading what moved; do not let a worse break hide behind a stale signature.
    const detail = `${result.detail} (known-failure evidence moved: ${JSON.stringify(known.signature)} -> ${JSON.stringify(result.signature)})`;
    outcomes.push({ id, status: 'regression', detail, ms });
    expect.fail(`[breaker regression] ${id}: ${detail}`);
  }

  outcomes.push({ id, status: 'regression', detail: result.detail, ms });
  expect.fail(`[breaker regression] ${id}: ${result.detail}`);
}

export interface BreakerSummary {
  attacks: number;
  passed: number;
  knownFailures: number;
  fixed: number;
  regressions: number;
  wallSeconds: number;
  cpuSeconds: number;
  outcomes: AttackOutcome[];
}

export function breakerSummary(): BreakerSummary {
  const cpu = process.cpuUsage(cpuStartedAt);
  const count = (status: AttackStatus) => outcomes.filter(outcome => outcome.status === status).length;
  return {
    attacks: outcomes.length,
    passed: count('pass'),
    knownFailures: count('known-failure'),
    fixed: count('fixed'),
    regressions: count('regression'),
    wallSeconds: Number(((Date.now() - wallStartedAt) / 1000).toFixed(3)),
    cpuSeconds: Number(((cpu.user + cpu.system) / 1_000_000).toFixed(3)),
    outcomes,
  };
}

/**
 * Publish the run's summary. vitest suppresses a passing test's console output, so the report is
 * ALSO written to `<cwd>/.gate/breaker-report.json` (gitignored, the gate's own directory): a green
 * run leaves a readable record of what the attacks found. Both are best-effort — a report that
 * cannot be written must never fail the suite.
 */
export function printBreakerReport(): void {
  const summary = breakerSummary();
  console.log(`BREAKER_REPORT ${JSON.stringify(summary)}`);
  try {
    const reportPath = path.join(process.cwd(), '.gate', 'breaker-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  } catch { /* the report is a courtesy, never a verdict */ }
}
