import { EmbeddingUnavailableError, type EmbedOptions, type EmbeddingIdentity, type EmbeddingProvider } from './types';

/**
 * An embedding provider for a service an agent waits on.
 *
 * A call without a budget is passed straight through: patient, the provider's own retries, for a rebuild, a backfill or
 * a benchmark. A call with `budgetMs` is interactive: it ends within the budget, with `EmbeddingUnavailableError`, when
 * the service is slow, refusing or silent. Google's 429s on 2026-10-06 made `remember` wait up to 13 minutes in the
 * provider's retry loop while holding the note's file lock, which every later save and read of that note queued behind.
 *
 * It also remembers that the service just failed. After an interactive call fails because the service is unavailable,
 * interactive calls fail at once for `cooldownMs` without asking it, so a refusing service costs one call a few
 * seconds and every other call nothing; the first call after the cooldown is the probe, and one that succeeds (or a
 * patient call that does) opens the way again. A failure that is not an outage (a text the service refuses) does not
 * close it: it says nothing about the next call.
 */
export class InteractiveEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity?: EmbeddingIdentity;
  private readonly inner: EmbeddingProvider;
  private readonly cooldownMs: number;
  /** Epoch ms before which interactive calls are not made; 0 when the service is believed up. */
  private unavailableUntil = 0;
  /** An interactive call is the probe after a cooldown: the others wait for its verdict instead of piling on. */
  private probing = false;

  constructor(inner: EmbeddingProvider, options: { cooldownMs?: number } = {}) {
    this.inner = inner;
    this.dimensions = inner.dimensions;
    this.identity = inner.identity;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    return this.run(options, o => this.inner.embed(texts, o));
  }

  embedQuery(text: string, options?: EmbedOptions): Promise<number[]> {
    return this.run(options, async o => this.inner.embedQuery ? this.inner.embedQuery(text, o) : (await this.inner.embed([text], o))[0]);
  }

  describe(): Record<string, unknown> {
    return (this.inner as { describe?: () => Record<string, unknown> }).describe?.() ?? {};
  }

  private async run<T>(options: EmbedOptions | undefined, call: (options: EmbedOptions | undefined) => Promise<T>): Promise<T> {
    const budgetMs = options?.budgetMs;
    if (budgetMs === undefined) {
      // Patient: never refused, and what it learns about the service is passed on.
      try {
        const result = await call(options);
        this.unavailableUntil = 0;
        return result;
      } catch (err) {
        if (err instanceof EmbeddingUnavailableError) this.unavailableUntil = Date.now() + this.cooldownMs;
        throw err;
      }
    }

    if (Date.now() < this.unavailableUntil || (this.probing && this.unavailableUntil > 0)) {
      throw new EmbeddingUnavailableError('embedding service unavailable (failed moments ago; not asked again yet)');
    }
    const probe = this.unavailableUntil > 0;
    if (probe) this.probing = true;

    const controller = new AbortController();
    const relay = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', relay, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const unavailable = new EmbeddingUnavailableError(`embedding service did not answer within ${Math.ceil(budgetMs / 1000)} s`);
        // The provider is told to stop (a provider that honours the signal ends its retries and its request); one
        // that does not is left to finish unobserved, and its late answer or failure is dropped.
        controller.abort(unavailable);
        reject(unavailable);
      }, budgetMs);
    });
    try {
      const attempt = call({ ...options, signal: controller.signal });
      attempt.catch(() => undefined); // an attempt that loses the race settles later; nobody reads it
      const result = await Promise.race([attempt, expired]);
      this.unavailableUntil = 0;
      return result;
    } catch (err) {
      // An abort reaches a provider as an AbortError or as the reason it was given; either way it is the budget's.
      const unavailable = controller.signal.aborted && controller.signal.reason instanceof EmbeddingUnavailableError
        ? controller.signal.reason
        : err;
      if (unavailable instanceof EmbeddingUnavailableError) this.unavailableUntil = Date.now() + this.cooldownMs;
      throw unavailable;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', relay);
      if (probe) this.probing = false;
    }
  }
}

/** Long enough that a refusing service is not asked by every call, short enough that a recovered one is used again at once. */
const DEFAULT_COOLDOWN_MS = 15_000;
