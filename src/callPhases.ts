import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where the time of one read call went, for the engine's log (telemetry.ts `phases` on a `get_context` or `search_memory` line).
 * Milliseconds, a number per phase and nothing else: no text of the call, its query or its result ever goes through here.
 *
 *   embed     the embedding provider's whole call for the query (token, requests, waits between retries); absent when the
 *             query's vector came from the query cache, so a missing `embed` says that no call to the service was made
 *   token     of embed: waiting for an access token (about 0 when one was in hand)
 *   connect   of embed: opening a connection to the service (TCP, TLS, address lookup); absent when a connection was reused
 *   call      of embed: the requests themselves once connected (send, the service's own time, receive)
 *   retrieve  the matches and facts: from the start of the call to the point they are in hand, less embed
 *   reply     the answer built from them: from that point to the end of the call
 *
 * A call's phases are collected in an `AsyncLocalStorage` scope that the tool wrapper opens (server.ts), so the provider that
 * measures the embedding needs no argument for it, and a call made outside a scope (a CLI, an eval, a test) records nothing.
 * Requests made together add up, so the phases of such a call can sum to more than its wall time.
 */
export const PHASE_NAMES = ['embed', 'token', 'connect', 'call', 'retrieve', 'reply'] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];
export type PhaseReport = Partial<Record<PhaseName, number>>;

/** The tools that report their phases: the two reads whose latency the product is judged on. */
const PHASED_TOOLS: readonly string[] = ['get_context', 'search_memory'];
export function isPhasedTool(tool: string): boolean {
  return PHASED_TOOLS.includes(tool);
}

const scope = new AsyncLocalStorage<CallPhases>();

export class CallPhases {
  private readonly totals = new Map<PhaseName, number>();
  private readonly startedAt = performance.now();
  private retrievedAt: number | undefined;
  private embedAtRetrieved = 0;

  /** Runs `work` with this as the call whose phases are recorded. */
  run<T>(work: () => T): T {
    return scope.run(this, work);
  }

  add(phase: PhaseName, ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.totals.set(phase, (this.totals.get(phase) ?? 0) + ms);
  }

  total(phase: PhaseName): number {
    return this.totals.get(phase) ?? 0;
  }

  /** The matches and facts are in hand: what is left of the call is the answer being built. The first mark counts. */
  markRetrieved(): void {
    if (this.retrievedAt !== undefined) return;
    this.retrievedAt = performance.now();
    this.embedAtRetrieved = this.total('embed');
  }

  /** What the call recorded, rounded to a tenth of a millisecond; `retrieve` and `reply` only for a call that reached the mark. */
  report(): PhaseReport {
    const out: PhaseReport = {};
    for (const [phase, ms] of this.totals) out[phase] = ms;
    if (this.retrievedAt !== undefined) {
      out.retrieve = Math.max(0, this.retrievedAt - this.startedAt - this.embedAtRetrieved);
      out.reply = Math.max(0, performance.now() - this.retrievedAt);
    }
    for (const phase of PHASE_NAMES) if (out[phase] !== undefined) out[phase] = Math.round(out[phase]! * 10) / 10;
    return out;
  }
}

/** Adds to the current call's phase, if a call is being recorded. */
export function recordPhase(phase: PhaseName, ms: number): void {
  scope.getStore()?.add(phase, ms);
}

/** What the current call has recorded so far for a phase (0 when no call is being recorded). */
export function recordedPhase(phase: PhaseName): number {
  return scope.getStore()?.total(phase) ?? 0;
}

/** The matches and facts of the current call are in hand (see CallPhases.markRetrieved). */
export function markRetrieved(): void {
  scope.getStore()?.markRetrieved();
}
