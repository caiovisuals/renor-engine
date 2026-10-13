/**
 * Which provider and model produce a provider's vectors. Anything that stores vectors
 * by this identity (the eval embedding cache) trusts it, so a provider that can be
 * cached declares it itself instead of leaving each caller to type a label for it.
 */
export interface EmbeddingIdentity {
  readonly kind: string;
  readonly model: string;
}

/**
 * How one call is made. Without options a call is patient: the provider retries its own way for as long as that takes,
 * which is right for a benchmark or a background job and wrong for an agent that waits on the answer.
 */
export interface EmbedOptions {
  /**
   * Give up after this many ms in all, and say the service is unavailable (`EmbeddingUnavailableError`) rather than
   * keep retrying: an agent is waiting on this call. A provider that cannot stop its own retries is stopped from outside
   * (see InteractiveEmbeddingProvider).
   */
  budgetMs?: number;
  /** Stop the call and whatever it has in flight (a shutdown). */
  signal?: AbortSignal;
}

/**
 * The embedding service is slow, refusing (429, 500, 503) or silent, as opposed to refusing one text. What a caller
 * does about it is the same whatever the cause: keep what was saved, answer without the service, and ask again later.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingUnavailableError';
  }
}

export interface EmbeddingProvider {
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  embedQuery?(text: string, options?: EmbedOptions): Promise<number[]>;
  dimensions: number;
  readonly identity?: EmbeddingIdentity;
}
