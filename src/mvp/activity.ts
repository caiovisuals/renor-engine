import type { IdleMonitor } from './idle';

/**
 * What the release asks an engine before it restarts it: is work running that a restart would cut, and when did the last
 * of it end.
 *
 * Always on, unlike the on-demand IdleMonitor. It counts every unit of work a restart could cut and nothing else:
 *   - an MCP request (POST or DELETE /mcp) from its start until its HTTP response has finished or closed, which is later
 *     than its tool handler returning (a streamed response can still be in delivery), and ends when the client aborts;
 *   - every tool call until it returns, even one whose client has gone;
 *   - the flights the monitor tracks (evidence extraction, digests);
 *   - the process-owned jobs a call starts and does not await (the embedding rebuild, the background index) while they
 *     are working. A job that is only waiting out a delay before its next attempt is not work in progress: it holds
 *     nothing, and it is resumed from the index at the next start (an embedding outage must not hold a release forever).
 * An open MCP stream (GET /mcp) is not work, so a connected agent that is not calling anything leaves it at zero. It holds
 * a count and a time, never a tool name, an argument or a tenant.
 *
 * With an IdleMonitor (RENOR_ON_DEMAND) tracked work is handed on to it unchanged, so the idle clock sees exactly what it
 * saw before this existed.
 */

/** Marks the body of GET /internal/activity as this report, so a reader never mistakes another answer for it. */
export const ACTIVITY_REPORT_VERSION = 'activity/v1';
export const ACTIVITY_PATH = '/internal/activity';

/** A job the process owns and a call may have started: `done` settles when it ends, `waiting` is true while it only waits to retry. */
export interface BackgroundJob {
  done: Promise<unknown>;
  waiting(): boolean;
}

export interface ActivityReport {
  renor: typeof ACTIVITY_REPORT_VERSION;
  /** Units of work running now (requests, tool calls, flights and background jobs; one piece of work can count more than once). */
  inFlight: number;
  /** Whole milliseconds since the last one ended; null when none has ended since this process started. */
  lastEndedAgoMs: number | null;
}

export class ActivityGauge {
  private inFlight = 0;
  private lastEnded: number | null = null;
  private readonly watched = new WeakSet<Promise<unknown>>();

  constructor(
    private readonly inner: Pick<IdleMonitor, 'track'> | null = null,
    private readonly now: () => number = Date.now,
    /** The background jobs running now (the embedding rebuild, the background index); asked at every report. */
    private readonly background: () => Array<BackgroundJob | null> = () => [],
  ) {}

  /** Counts one unit of work from now until the returned function is called (once; further calls do nothing). */
  begin(): () => void {
    this.inFlight++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight--;
      this.lastEnded = this.now();
    };
  }

  /** Counts a request until its response has finished or closed (an abort included). */
  request(res: { once(event: 'close', listener: () => void): unknown }): void {
    const end = this.begin();
    res.once('close', end);
  }

  /** Same contract as IdleMonitor.track, so it stands in for the monitor wherever work is tracked. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const end = this.begin();
    try {
      return await (this.inner ? this.inner.track(work) : work());
    } finally {
      end();
    }
  }

  report(): ActivityReport {
    let jobs = 0;
    for (const job of this.background()) {
      if (!job) continue;
      // The moment a job ends is when the last work ended, whoever asks and whenever.
      if (!this.watched.has(job.done)) {
        this.watched.add(job.done);
        void job.done.then(() => { this.lastEnded = this.now(); }, () => { this.lastEnded = this.now(); });
      }
      if (!job.waiting()) jobs++;
    }
    return {
      renor: ACTIVITY_REPORT_VERSION,
      inFlight: this.inFlight + jobs,
      lastEndedAgoMs: this.lastEnded === null ? null : Math.max(0, Math.floor(this.now() - this.lastEnded)),
    };
  }
}
