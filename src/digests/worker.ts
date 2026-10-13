import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types';
import type { EvidenceChat, EvidenceChatRequest, EvidenceChatResponse } from '../evidence/secondPass';
import { billedOutputTokens, listRouterNotes } from '../router/sessionRouter';
import { DigestCache } from './digestCache';
import { buildNoteDigests, type DigestBuildStats, type DigestOptions } from './digests';

/**
 * The production path of write-time digests (RENOR_DIGESTS, see digests.ts): a background worker that writes the
 * digest of every note that has none, after a save, without ever being on the save's path.
 *
 *   - `notify()` (called after a save's index pass) only sets a timer and returns: a save never waits for a model.
 *   - Saves are batched: the sweep runs DIGEST_DEBOUNCE_MS after the last save, and no sooner than
 *     DIGEST_MIN_INTERVAL_MS after the previous sweep ended, so a burst of saves, or one note appended to all day, is
 *     digested once per interval and not once per save. One sweep runs at a time.
 *   - A sweep that left notes undigested because the provider failed is tried again after a wait that doubles from
 *     DIGEST_RETRY_BASE_MS to DIGEST_RETRY_MAX_MS (with jitter), up to DIGEST_MAX_FAILED_SWEEPS in a row; then the
 *     worker stops until the next start (a save tries once more) rather than calling a provider that keeps refusing.
 *     The transport inside a call retries on its own too (createOllamaChat, RENOR_DIGEST_RETRIES).
 *   - Cost guard, per workspace: every call is counted at the list price in the workspace's own digest cache
 *     (`digest_spend`), a call that could take the UTC day past RENOR_DIGEST_MAX_USD_PER_DAY is not made (its worst case
 *     is counted: the prompt plus the whole output allowance), and the worker is `paused-budget` until the day after the
 *     one that refused the call (a sweep that ends past midnight does not move that). Notes without a digest wait; nothing
 *     is lost and search reads the digests that exist. Only this worker is held to the guard: `renor index` and
 *     `renor rebuild` are commands someone runs and are not capped (README, "Cost guard").
 *   - A digest of text a note no longer holds (edited, forgotten, file gone) is removed at the start of every sweep. A note
 *     is edited once the index has seen it (a save, an import, `renor index`): a file changed behind the index's back keeps
 *     its digest, as search keeps its old chunks, until then.
 *   - The only provider is the digest slot (RENOR_DIGEST_BASE_URL + RENOR_DIGEST_API_KEY). With it unset the worker is
 *     `stopped` and nothing is sent: it never falls back to the evidence provider, which the privacy copy does not name.
 *   - The sweep is held in the on-demand idle monitor while it runs, so a workspace does not exit in the middle of a call.
 *     Waits for a retry are not held: the workspace may sleep, and its next start sweeps again.
 *
 * Nothing here runs unless RENOR_DIGESTS is on, and it is off by default.
 */

export const DIGEST_DEBOUNCE_MS = 15_000;
export const DIGEST_MIN_INTERVAL_MS = 60_000;
export const DIGEST_RETRY_BASE_MS = 30_000;
export const DIGEST_RETRY_MAX_MS = 300_000;
export const DIGEST_MAX_FAILED_SWEEPS = 8;
/** How many days of spend rows are kept. */
const SPEND_DAYS_KEPT = 14;

export type DigestWorkerState = 'idle' | 'scheduled' | 'running' | 'retrying' | 'paused-budget' | 'stopped';

export interface DigestWorkerStatus {
  state: DigestWorkerState;
  /** Why the worker is stopped or retrying (no provider, a provider error); never a key or note text. */
  reason?: string;
  consecutiveFailures: number;
  spentTodayUsd: number;
  maxUsdPerDay: number;
  /** The last sweep that ran: when it ended, and what it did. */
  lastSweep?: { endedAt: string; digested: number; failed: number; gone: number; calls: number; pruned: number };
}

export interface DigestWorkerDeps {
  db: Database.Database;
  /** The workspace: where notes live and the ledger's path relative to it (the ledger is never digested). */
  config: { memoryDir: string; ledgerRelPath?: string };
  options: DigestOptions;
  /** The workspace's embedding provider; without one a digest has no vectors to be read by, so the worker does not start. */
  provider: EmbeddingProvider | null;
  /** On-demand mode: holds the engine awake for one unit of work. */
  track?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Test seams. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  log?: (line: string) => void;
}

/** Raised, inside the model client, when a call would take the day past its budget. */
export class DigestBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestBudgetError';
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Roughly three characters a token for the prompt: the worst case a guard must hold, not a measurement. */
function promptTokensOf(request: EvidenceChatRequest): number {
  return Math.ceil(request.messages.reduce((sum, m) => sum + m.content.length, 0) / 3);
}

/**
 * The cost guard around the digest model client: refuses a call whose worst case would take the day past the budget, and
 * records what each call cost. A call that threw is counted at its prompt alone (what is known to have been sent).
 */
export function guardedDigestChat(args: {
  chat: EvidenceChat;
  cache: DigestCache;
  day: () => string;
  options: Pick<DigestOptions, 'maxUsdPerDay' | 'priceInPerM' | 'priceOutPerM'>;
  /** Called with the UTC day whose budget refused the call, so what resumes is computed from that day. */
  onBudget: (day: string) => void;
}): EvidenceChat {
  const { chat, cache, options } = args;
  const usd = (promptTokens: number, outputTokens: number) => (promptTokens * options.priceInPerM + outputTokens * options.priceOutPerM) / 1e6;
  return async (request: EvidenceChatRequest): Promise<EvidenceChatResponse> => {
    const day = args.day();
    const promptEstimate = promptTokensOf(request);
    const worst = usd(promptEstimate, request.max_tokens ?? 8_000);
    if (cache.spentUsd(day) + worst > options.maxUsdPerDay) {
      args.onBudget(day);
      throw new DigestBudgetError(`the digest budget for ${day} (${options.maxUsdPerDay} USD) would be passed`);
    }
    let response: EvidenceChatResponse;
    try {
      response = await chat(request);
    } catch (err) {
      cache.addSpend(day, promptEstimate, 0, usd(promptEstimate, 0));
      throw err;
    }
    const prompt = response.promptTokens ?? promptEstimate;
    const output = billedOutputTokens(response);
    cache.addSpend(day, prompt, output, usd(prompt, output));
    return response;
  };
}

export class DigestWorker {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private state: DigestWorkerState = 'idle';
  private reason: string | undefined;
  private timer: unknown = null;
  private timerAt = 0;
  private running: Promise<void> | null = null;
  private dirty = false;
  private closed = false;
  private failures = 0;
  private lastEnd = 0;
  private budgetHit = false;
  /** The UTC day whose budget refused a call in the sweep in flight: the pause is counted from it, not from when the sweep ends. */
  private budgetDay: string | undefined;
  private last: DigestWorkerStatus['lastSweep'];

  constructor(private readonly deps: DigestWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    });
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout));
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (line => console.log(line));
  }

  /** Boot: digest what earlier saves, an import, or a workspace that slept left without a digest. */
  start(): void {
    this.failures = 0;
    if (!this.runnable()) return;
    this.schedule(DIGEST_DEBOUNCE_MS);
  }

  /** After a save has been indexed. Never throws, never waits: it sets a timer. */
  notify(): void {
    if (this.closed || !this.runnable()) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    // A retry already waiting keeps its (longer) wait: a save does not shorten a backoff. A stopped worker tries once.
    if (this.state === 'retrying' || this.state === 'paused-budget') return;
    this.schedule(DIGEST_DEBOUNCE_MS);
  }

  status(): DigestWorkerStatus {
    const cache = this.openCache();
    let spent = 0;
    try {
      spent = cache?.spentUsd(utcDay(this.now())) ?? 0;
    } finally {
      cache?.close();
    }
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      consecutiveFailures: this.failures,
      spentTodayUsd: Math.round(spent * 1e6) / 1e6,
      maxUsdPerDay: this.deps.options.maxUsdPerDay,
      ...(this.last ? { lastSweep: this.last } : {}),
    };
  }

  /** Resolves when the sweep in flight, if any, has ended (shutdown, tests). Waits for no timer. */
  async whenSwept(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Run a sweep now (no debounce, no interval) and wait for it: boot-time catch-up, tests. */
  async sweepNow(): Promise<void> {
    if (this.closed || !this.runnable()) return;
    this.cancelTimer();
    if (this.running) await this.running;
    this.launch();
    await this.running;
  }

  /** Stop timers and wait for the sweep in flight; after this the worker does nothing. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    if (this.running) await this.running;
  }

  private runnable(): boolean {
    if (!this.deps.provider) {
      this.stop('no embedding provider: digests are read by meaning, so they are not written');
      return false;
    }
    if (!this.deps.options.chat) {
      // The digest slot is the only provider digests use: another provider's key is never borrowed (see resolveDigestProvider).
      this.stop('no digest model is configured: digests need RENOR_DIGEST_BASE_URL and RENOR_DIGEST_API_KEY, and never use the evidence or Ollama provider instead, so nothing is sent');
      return false;
    }
    return true;
  }

  private stop(reason: string): void {
    if (this.state === 'stopped' && this.reason === reason) return;
    this.state = 'stopped';
    this.reason = reason;
    this.log(`[digests] worker stopped: ${reason}`);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(wait: number, state: DigestWorkerState = 'scheduled'): void {
    if (this.closed) return;
    const earliest = this.lastEnd + DIGEST_MIN_INTERVAL_MS - this.now();
    const delay = Math.max(wait, state === 'scheduled' ? earliest : 0);
    const at = this.now() + delay;
    // One timer: a nearer request replaces a later one, a later request leaves the nearer one alone.
    if (this.timer !== null && this.timerAt <= at && this.state === state) return;
    this.cancelTimer();
    this.state = state;
    if (state === 'scheduled') this.reason = undefined;
    this.timerAt = at;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.launch();
    }, delay);
  }

  private launch(): void {
    if (this.closed || this.running) return;
    const track = this.deps.track ?? (work => work());
    this.state = 'running';
    const run = this.sweep().catch((err) => {
      // A sweep that threw (the database closed under it, a disk error) is a failed sweep, said once and retried like any.
      this.failures++;
      this.reason = `sweep failed: ${String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 160)}`;
      this.log(`[digests] ${this.reason}`);
    }).then(() => this.afterSweep());
    this.running = run.finally(() => { this.running = null; });
    void track(() => this.running!).catch(() => undefined);
  }

  private afterSweep(): void {
    this.lastEnd = this.now();
    if (this.closed) return;
    if (this.budgetHit) {
      this.budgetHit = false;
      // The day that is spent is the one that refused the call, whenever the sweep ended: one that runs past UTC midnight
      // after the refusal must not push the resume out a whole day further. A resume time already past waits one second.
      const refusedOn = this.budgetDay ?? utcDay(this.now());
      this.budgetDay = undefined;
      const resume = Date.parse(`${refusedOn}T00:00:00Z`) + 86_400_000 + 60_000;
      this.state = 'paused-budget';
      this.reason = `the daily digest budget (${this.deps.options.maxUsdPerDay} USD) is spent; notes without a digest wait until the next UTC day`;
      this.log(`[digests] ${this.reason}`);
      this.dirty = false;
      this.cancelTimer();
      this.timerAt = resume;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.state = 'idle';
        this.schedule(0);
      }, Math.max(1_000, resume - this.now()));
      return;
    }
    if (this.failures > 0) {
      if (this.failures >= DIGEST_MAX_FAILED_SWEEPS) {
        this.dirty = false;
        this.stop(`the digest model failed ${this.failures} sweeps in a row (${this.reason ?? 'no detail'}); it is tried again at the next start or save`);
        return;
      }
      const wait = Math.min(DIGEST_RETRY_MAX_MS, DIGEST_RETRY_BASE_MS * 2 ** (this.failures - 1)) * (0.8 + 0.4 * this.random());
      this.dirty = false;
      this.log(`[digests] ${this.reason ?? 'a sweep failed'}; trying again in ${Math.round(wait / 1000)} s`);
      this.schedule(wait, 'retrying');
      return;
    }
    this.state = 'idle';
    this.reason = undefined;
    if (this.dirty) {
      this.dirty = false;
      this.schedule(DIGEST_DEBOUNCE_MS);
    }
  }

  private openCache(): DigestCache | null {
    try {
      return new DigestCache(this.deps.options.cachePath);
    } catch (err) {
      this.log(`[digests] the digest cache cannot be opened: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`);
      return null;
    }
  }

  private async sweep(): Promise<void> {
    const { db, config, options, provider } = this.deps;
    const cache = this.openCache();
    if (!cache) throw new Error('the digest cache cannot be opened');
    try {
      const ledger = config.ledgerRelPath;
      // What search can still reach: notes whose file exists, by the hash the INDEX holds. A digest of any other text is
      // removed. A file edited behind the index's back keeps its index hash, so it keeps its digest, as search keeps its
      // old chunks, until the index sees the change (a save, an import, `renor index`).
      const live = listRouterNotes(db, config.memoryDir, ledger).filter(note => fs.existsSync(note.file));
      const pruned = cache.retainOnly(new Set(live.map(note => note.noteHash)));
      cache.pruneSpend(SPEND_DAYS_KEPT);
      this.budgetHit = false;
      this.budgetDay = undefined;
      const guarded: DigestOptions = {
        ...options,
        chat: guardedDigestChat({
          chat: options.chat!,
          cache,
          day: () => utcDay(this.now()),
          options,
          onBudget: (day) => { this.budgetHit = true; this.budgetDay = day; },
        }),
      };
      const stats: DigestBuildStats = await buildNoteDigests({
        db,
        vaultPath: config.memoryDir,
        ledgerRelPath: ledger,
        options: guarded,
        cache,
        provider: provider!,
      });
      if (stats.failed > 0 && !this.budgetHit) {
        this.failures++;
        this.reason = (stats.error ?? 'the digest model left notes without a digest').replace(/\s+/g, ' ').slice(0, 160);
      } else if (stats.failed === 0) {
        this.failures = 0;
        this.reason = undefined;
      }
      this.last = {
        endedAt: new Date(this.now()).toISOString(),
        digested: stats.digested,
        failed: stats.failed,
        gone: stats.gone,
        calls: stats.calls,
        pruned,
      };
      if (stats.digested > 0 || stats.failed > 0 || pruned > 0) {
        this.log(`[digests] swept: ${stats.digested} digested, ${stats.failed} failed, ${stats.cached} already had one, ${pruned} removed, ${stats.calls} call(s)`);
      }
    } finally {
      cache.close();
    }
  }
}
