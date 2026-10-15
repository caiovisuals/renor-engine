import type { NextFunction, Request, Response } from 'express';
import { ACTIVITY_PATH } from './activity';

/**
 * On-demand idle exit (RENOR_ON_DEMAND=1, see config.ts). Off by default: without the
 * switch no monitor is created and the engine runs until it is stopped, as before.
 *
 * Work holds the engine awake: every HTTP request while it is open (an SSE stream
 * included) and every MCP tool call until it returns, even one whose client has gone,
 * because a write or index job outlives its connection. The idle clock restarts when a
 * request ends below 400, so a scanner's 401/404 or a readiness probe on /version does
 * not keep a sleeping workspace resident (nor does the release's look at /internal/activity).
 *
 * With nothing in flight for the whole idle period the monitor starts draining: every
 * later request is answered 503 with the draining header before it does anything, so
 * the gateway knows the engine is stopping (not broken) and can start it again without
 * ever replaying a request that might have been committed.
 */

/** Response header on a draining engine's 503. The gateway reads it. */
export const DRAINING_HEADER = 'x-renor-draining';

export class IdleMonitor {
  private inFlight = 0;
  private lastActivity: number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private draining = false;
  private resolveIdle!: () => void;
  private readonly idle = new Promise<void>(resolve => { this.resolveIdle = resolve; });

  constructor(private readonly idleMs: number, private readonly now: () => number = Date.now) {
    this.lastActivity = now();
  }

  /** Start the idle clock once the engine listens; resolves when draining begins. */
  start(): Promise<void> {
    this.started = true;
    this.lastActivity = this.now();
    this.arm();
    return this.idle;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Express middleware: counts each request while it is open; refuses while draining. */
  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (this.draining) {
      res.setHeader('Connection', 'close');
      res.setHeader('Retry-After', '1');
      res.setHeader(DRAINING_HEADER, '1');
      res.status(503).json({ error: 'draining' });
      return;
    }
    const probe = req.method === 'GET' && (req.path === '/version' || req.path === ACTIVITY_PATH);
    const end = this.begin();
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      end(!probe && res.statusCode < 400);
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };

  /** Holds the engine awake for one unit of work, such as an MCP tool call. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const end = this.begin();
    try {
      return await work();
    } finally {
      end(true);
    }
  }

  private begin(): (activity: boolean) => void {
    this.inFlight++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return (activity) => {
      this.inFlight--;
      if (activity) this.lastActivity = this.now();
      this.arm();
    };
  }

  private arm(): void {
    if (!this.started || this.draining || this.inFlight > 0) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, this.lastActivity + this.idleMs - this.now());
    this.timer = setTimeout(() => this.check(), wait);
    this.timer.unref();
  }

  private check(): void {
    this.timer = null;
    if (this.draining || this.inFlight > 0) return;
    if (this.now() - this.lastActivity < this.idleMs) {
      this.arm();
      return;
    }
    this.draining = true;
    this.resolveIdle();
  }
}
