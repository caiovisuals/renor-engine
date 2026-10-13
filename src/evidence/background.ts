import type { ProductEvidenceAttachment } from './attach';

/**
 * Bounded-wait evidence for get_context and search_memory (RENOR_EVIDENCE_ASYNC, default OFF).
 *
 * The evidence second pass runs inside the read tools, so a search waits for the extractor: about 1-4 s with today's
 * model, 5-27 s on average with the better ones measured on 2026-10-03 (p95 up to 76 s). With this flag off nothing
 * here runs and every search waits, as before. With it on, a search waits at most RENOR_EVIDENCE_WAIT_MS:
 *
 *   - a table already in the evidence cache (keyed on model + exact prompt) is returned at once;
 *   - otherwise the extraction starts, and if it does not finish within the wait the response has no table and says
 *     so (`state: "pending"`); the extraction carries on in the background and its table lands in the cache, so the
 *     same query over the same notes returns it;
 *   - one extraction per prompt (single-flight): a search for a prompt already being extracted joins that extraction;
 *   - at most EVIDENCE_BACKGROUND_CONCURRENCY extractions run and EVIDENCE_BACKGROUND_QUEUE wait; a search past that
 *     starts nothing and says so (`state: "busy"`).
 *
 * Only the MVP read tools read the flag (resolveEngineEvidence). The CLI, which is the benchmark's entry point, the
 * HTTP API and the stdio MCP server never do, so no benchmark run can change behaviour because of it.
 */

export const EVIDENCE_WAIT_MS_DEFAULT = 2_000;
export const EVIDENCE_WAIT_MS_MAX = 60_000;
/** Extractions running at once, per process (one process serves one workspace). */
export const EVIDENCE_BACKGROUND_CONCURRENCY = 2;
/** Extractions waiting for a free slot, per process. */
export const EVIDENCE_BACKGROUND_QUEUE = 16;

/** RENOR_EVIDENCE_ASYNC: on only for 1 / true / yes / on; unset and anything else is off. */
export function evidenceAsyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_EVIDENCE_ASYNC ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** RENOR_EVIDENCE_WAIT_MS: whole milliseconds, 0 to 60,000; unset or unreadable is the default. */
export function resolveEvidenceWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RENOR_EVIDENCE_WAIT_MS ?? '').trim();
  const ms = raw === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(ms) || ms < 0) return EVIDENCE_WAIT_MS_DEFAULT;
  return Math.min(Math.floor(ms), EVIDENCE_WAIT_MS_MAX);
}

export interface EvidenceBackground {
  /** The longest a search waits for an extraction that is not cached yet. */
  waitMs: number;
  flights: EvidenceFlights;
  /**
   * Given every extraction a search waits on. An extraction outlives the tool call that started it, so an on-demand
   * engine (RENOR_ON_DEMAND) counts it as work and stays awake until it ends, like a write whose client has gone.
   */
  hold?: (flight: Promise<unknown>) => void;
}

/** The bounded-wait settings when the flag is on, else undefined: a search then waits for the extractor, as before. */
export function resolveEvidenceBackground(env: NodeJS.ProcessEnv = process.env): EvidenceBackground | undefined {
  if (!evidenceAsyncEnabled(env)) return undefined;
  return { waitMs: resolveEvidenceWaitMs(env), flights: sharedEvidenceFlights() };
}

/**
 * The extractions in the air, one per key, with at most `concurrency` running and `queue` waiting.
 *
 * Every search of a process must share one of these: the MVP server builds a fresh tool set (and extractor) for each
 * SSE session, so flights kept per extractor would neither join a second session's identical search nor bound the
 * process's spend.
 */
export class EvidenceFlights {
  readonly concurrency: number;
  readonly queue: number;
  private readonly inFlight = new Map<string, Promise<ProductEvidenceAttachment>>();
  private readonly waiting: Array<() => void> = [];
  private running = 0;
  /**
   * started: extractions begun; joined: searches that shared one; refused: searches turned away by a full queue;
   * failed: extractions that ended without a table.
   */
  readonly counts = { started: 0, joined: 0, refused: 0, failed: 0 };

  constructor(limits: { concurrency?: number; queue?: number } = {}) {
    this.concurrency = Math.max(1, limits.concurrency ?? EVIDENCE_BACKGROUND_CONCURRENCY);
    this.queue = Math.max(0, limits.queue ?? EVIDENCE_BACKGROUND_QUEUE);
  }

  /**
   * The one extraction of `key`: the flight already in the air, or a new one that `run` performs now or once a slot is
   * free. Null when the queue is full, and then nothing is started. The key is deleted when the flight ends, after
   * `run` has written the cache, so a later search finds the table there instead of starting again.
   */
  join(key: string, run: () => Promise<ProductEvidenceAttachment>): Promise<ProductEvidenceAttachment> | null {
    const current = this.inFlight.get(key);
    if (current) {
      this.counts.joined += 1;
      return current;
    }
    if (this.running >= this.concurrency && this.waiting.length >= this.queue) {
      this.counts.refused += 1;
      return null;
    }
    const slot = new Promise<void>(resolve => {
      if (this.running < this.concurrency) {
        this.running += 1;
        resolve();
      } else {
        this.waiting.push(() => {
          this.running += 1;
          resolve();
        });
      }
    });
    const flight = slot.then(run).finally(() => {
      this.inFlight.delete(key);
      this.running -= 1;
      this.waiting.shift()?.();
    });
    // A flight outlives the searches that started it, so its end is observed here: when it fails after they stopped
    // waiting nobody else holds the promise, and a rejection must never surface as an unhandled one; and an operator
    // reading the log is the only one left to learn that it failed. The reason code only: never the query or the
    // provider's message, which may quote the user's notes.
    flight.then(
      outcome => {
        if (outcome.status !== 'ok') this.ended(outcome.reason ?? 'skipped');
      },
      () => this.ended('extractor-error'),
    );
    this.inFlight.set(key, flight);
    this.counts.started += 1;
    return flight;
  }

  private ended(reason: string): void {
    this.counts.failed += 1;
    process.stderr.write(`[evidence] a background extraction ended without a table (${reason})\n`);
  }

  /** Resolves once nothing is running or waiting (tests, benchmarks). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }
}

let shared: EvidenceFlights | undefined;

/** The process's flights, created on first use. */
export function sharedEvidenceFlights(): EvidenceFlights {
  shared ??= new EvidenceFlights();
  return shared;
}

/** `promise`'s value if it settles within `ms`, else undefined. A later rejection is not this caller's to handle. */
export function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve({ value });
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
