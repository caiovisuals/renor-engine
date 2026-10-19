import { EmbeddingUnavailableError, type EmbedOptions, type EmbeddingIdentity, type EmbeddingProvider } from './types';

/** Texts per request to the service: one predict call takes this many (the Vertex provider splits at the same size). */
export const COALESCE_REQUEST_TEXTS = 32;
/** Requests in flight at once: the same as the rebuild's concurrency, so the service sees no more of them than before. */
export const COALESCE_REQUESTS_IN_FLIGHT = 4;
/** How long a request waits for more callers when the queue is short and a request slot is free. */
const GATHER_MS = 2;

interface Caller {
  texts: string[];
  options?: EmbedOptions;
  resolve: (vectors: number[][]) => void;
  reject: (err: unknown) => void;
  done: boolean;
}

/**
 * Batches the document embeddings of concurrent callers into shared requests.
 *
 * An index pass embeds one note at a time, a request of three or four texts, so a pass over N notes waited on about N
 * round trips. This provider takes the texts of every caller that is waiting, in arrival order, and sends them as one
 * request of up to COALESCE_REQUEST_TEXTS texts, with at most COALESCE_REQUESTS_IN_FLIGHT requests out at once. Each caller
 * gets back exactly the vectors of its own texts, in its own order, so what it stores is what it would have stored alone.
 *
 * Failures stay per caller. A caller that stops waiting (its budget ran out, or its signal aborted) is dropped from the queue,
 * or from the request if it is already out, and the request is aborted once no caller of it still waits. When a request
 * fails for a reason other than the service being unavailable (a text it refuses, say), each of its callers is sent again
 * alone, as it would have been without batching, so one refused text fails one note and no other.
 *
 * Queries do not wait for a batch: `embedQuery` goes straight to the provider.
 */
export class CoalescingEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity?: EmbeddingIdentity;
  private readonly inner: EmbeddingProvider;
  private queue: Caller[] = [];
  private inFlight = 0;
  private gatherTimer: NodeJS.Timeout | undefined;
  private gatherDone = false;

  constructor(inner: EmbeddingProvider) {
    this.inner = inner;
    this.dimensions = inner.dimensions;
    this.identity = inner.identity;
  }

  embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    // An abort that came first is never heard as an event, so it is checked here.
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise<number[][]>((resolve, reject) => {
      const caller: Caller = { texts, options, resolve, reject, done: false };
      options?.signal?.addEventListener('abort', () => this.abandon(caller, options.signal!.reason), { once: true });
      this.queue.push(caller);
      this.schedule();
    });
  }

  embedQuery(text: string, options?: EmbedOptions): Promise<number[]> {
    return this.inner.embedQuery
      ? this.inner.embedQuery(text, options)
      : this.inner.embed([text], options).then(vectors => vectors[0]);
  }

  describe(): Record<string, unknown> {
    return (this.inner as { describe?: () => Record<string, unknown> }).describe?.() ?? {};
  }

  /** A caller that stopped waiting: out of the queue if it has not gone yet, otherwise its request runs on for the others. */
  private abandon(caller: Caller, reason: unknown): void {
    if (caller.done) return;
    caller.done = true;
    this.queue = this.queue.filter(c => c !== caller);
    caller.reject(reason);
    this.schedule();
  }

  private schedule(): void {
    while (this.inFlight < COALESCE_REQUESTS_IN_FLIGHT && this.queue.length > 0) {
      const queued = this.queue.reduce((sum, c) => sum + c.texts.length, 0);
      if (queued < COALESCE_REQUEST_TEXTS && !this.gatherDone) {
        this.gatherTimer ??= setTimeout(() => {
          this.gatherTimer = undefined;
          this.gatherDone = true;
          this.schedule();
        }, GATHER_MS);
        return;
      }
      const batch: Caller[] = [];
      let size = 0;
      // A request is either all interactive (each caller may abort it) or all patient: a patient caller would keep an
      // interactive caller's request alive after that caller gave up, and its retries would reach a refusing service.
      while (this.queue.length > 0 && (batch.length === 0 || (sameKind(this.queue[0], batch[0])
        && size + this.queue[0].texts.length <= COALESCE_REQUEST_TEXTS))) {
        const caller = this.queue.shift()!;
        batch.push(caller);
        size += caller.texts.length;
      }
      this.gatherDone = false;
      this.inFlight += 1;
      this.send(batch);
    }
  }

  private send(batch: Caller[]): void {
    const texts = batch.flatMap(c => c.texts);
    const controller = new AbortController();
    const budgets = batch.map(c => c.options?.budgetMs);
    const budgetMs = budgets.some(b => b === undefined) ? undefined : Math.max(...(budgets as number[]));
    // A caller without a signal waits as long as the service takes: the request then runs to its end.
    let waiting = batch.length;
    const patient = batch.some(c => c.options?.signal === undefined);
    for (const caller of batch) {
      const signal = caller.options?.signal;
      if (!signal) continue;
      signal.addEventListener('abort', () => {
        waiting -= 1;
        if (waiting === 0 && !patient) controller.abort(signal.reason);
      }, { once: true });
    }
    const request = this.inner.embed(texts, { budgetMs, signal: controller.signal });
    request.then(
      (vectors) => {
        this.inFlight -= 1;
        let offset = 0;
        for (const caller of batch) {
          const own = vectors.slice(offset, offset + caller.texts.length);
          offset += caller.texts.length;
          if (caller.done) continue;
          caller.done = true;
          if (own.length === caller.texts.length) caller.resolve(own);
          else caller.reject(new Error(`the embedding provider returned ${own.length} vectors for ${caller.texts.length} texts`));
        }
        this.schedule();
      },
      (err: unknown) => {
        this.inFlight -= 1;
        this.schedule();
        if (isUnavailable(err) || controller.signal.aborted) {
          for (const caller of batch) {
            if (caller.done) continue;
            caller.done = true;
            caller.reject(err);
          }
          return;
        }
        // A 400 names an input the service refuses: each caller goes again alone, so the others are not failed by it.
        // Any other refusal is the service's answer to the request, and every caller of it gets that answer (no re-sends).
        if (!refusesAnInput(err)) {
          for (const caller of batch) {
            if (caller.done) continue;
            caller.done = true;
            caller.reject(err);
          }
          return;
        }
        for (const caller of batch) {
          if (caller.done) continue;
          this.inner.embed(caller.texts, caller.options).then(
            (vectors) => { if (!caller.done) { caller.done = true; caller.resolve(vectors); } },
            (own: unknown) => { if (!caller.done) { caller.done = true; caller.reject(own); } },
          );
        }
      },
    );
  }
}

/** The service did not answer (or the call was cut off): every caller of the request meets the same answer, as each would alone. */
function isUnavailable(err: unknown): boolean {
  return err instanceof EmbeddingUnavailableError || (err instanceof Error && err.name === 'AbortError');
}

/** The service refused an input (HTTP 400), not the request as a whole: the callers of the request are sent again one by one. */
function refusesAnInput(err: unknown): boolean {
  return err instanceof Error && (err as Error & { status?: number }).status === 400;
}

function sameKind(a: { options?: EmbedOptions }, b: { options?: EmbedOptions }): boolean {
  return (a.options?.signal !== undefined) === (b.options?.signal !== undefined);
}
