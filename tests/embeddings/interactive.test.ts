import { describe, it, expect } from 'vitest';
import { InteractiveEmbeddingProvider } from '../../src/embeddings/interactive';
import { EmbeddingUnavailableError, type EmbedOptions, type EmbeddingProvider } from '../../src/embeddings/types';

/**
 * The wrapper that keeps an agent from waiting on an embedding service that is slow or refusing: a call with a budget
 * ends within it, a service that just failed is not asked again at once, and a call without a budget is left alone.
 */

class Scripted implements EmbeddingProvider {
  dimensions = 4;
  readonly identity = { kind: 'scripted', model: 'm' };
  calls: Array<{ texts: string[]; options?: EmbedOptions }> = [];
  mode: 'ok' | 'hang' | 'unavailable' | 'refuse-text' = 'ok';
  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    this.calls.push({ texts, options });
    if (this.mode === 'hang') {
      // A provider that honours the signal ends when it is aborted; the wrapper must not depend on that.
      return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason)));
    }
    if (this.mode === 'unavailable') throw new EmbeddingUnavailableError('HTTP 429');
    if (this.mode === 'refuse-text') throw new Error('this text is refused');
    return texts.map(() => [1, 0, 0, 0]);
  }
}

/** A provider that ignores the signal entirely and never answers. */
class Deaf extends Scripted {
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push({ texts });
    return new Promise(() => undefined);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('InteractiveEmbeddingProvider', () => {
  it('passes a call without a budget straight through, options and all', async () => {
    const inner = new Scripted();
    const provider = new InteractiveEmbeddingProvider(inner);
    expect(provider.dimensions).toBe(4);
    expect(provider.identity).toEqual({ kind: 'scripted', model: 'm' });
    const signal = new AbortController().signal;
    expect(await provider.embed(['a'], { signal })).toEqual([[1, 0, 0, 0]]);
    expect(inner.calls[0].options).toEqual({ signal });
    expect(await provider.embedQuery('q')).toEqual([1, 0, 0, 0]);
    expect(inner.calls).toHaveLength(2);
  });

  it('ends a call with a budget within it when the service never answers, whether or not the provider honours the signal', async () => {
    for (const inner of [new Scripted(), new Deaf()]) {
      inner.mode = 'hang';
      const provider = new InteractiveEmbeddingProvider(inner);
      const started = Date.now();
      await expect(provider.embed(['a'], { budgetMs: 60 })).rejects.toThrow(EmbeddingUnavailableError);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  it('tells the provider its budget and a signal that is aborted when the budget ends', async () => {
    const inner = new Scripted();
    inner.mode = 'hang';
    const provider = new InteractiveEmbeddingProvider(inner, { cooldownMs: 10_000 });
    await expect(provider.embedQuery('q', { budgetMs: 40 })).rejects.toThrow(/did not answer within 1 s/);
    const given = inner.calls[0].options!;
    expect(given.budgetMs).toBe(40);
    expect(given.signal!.aborted).toBe(true);
  });

  it('does not ask a service that just failed again until the cooldown has passed, and then asks it once', async () => {
    const inner = new Scripted();
    inner.mode = 'unavailable';
    const provider = new InteractiveEmbeddingProvider(inner, { cooldownMs: 120 });
    await expect(provider.embed(['a'], { budgetMs: 1_000 })).rejects.toThrow('HTTP 429');
    expect(inner.calls).toHaveLength(1);

    // Within the cooldown: refused at once, the service is not called.
    for (let i = 0; i < 5; i++) await expect(provider.embedQuery('q', { budgetMs: 1_000 })).rejects.toThrow(EmbeddingUnavailableError);
    expect(inner.calls).toHaveLength(1);

    await sleep(160);
    // After it: one call is the probe, and the calls made while it is in flight are refused rather than piled on.
    inner.mode = 'hang';
    const probe = provider.embed(['a'], { budgetMs: 80 });
    probe.catch(() => undefined);
    await expect(provider.embed(['b'], { budgetMs: 1_000 })).rejects.toThrow(/not asked again yet/);
    await expect(probe).rejects.toThrow(EmbeddingUnavailableError);
    expect(inner.calls).toHaveLength(2);

    // A probe that succeeds opens the way again for every call.
    await sleep(160);
    inner.mode = 'ok';
    expect(await provider.embed(['a'], { budgetMs: 1_000 })).toEqual([[1, 0, 0, 0]]);
    expect(await provider.embed(['b'], { budgetMs: 1_000 })).toEqual([[1, 0, 0, 0]]);
    expect(inner.calls).toHaveLength(4);
  });

  it('is not closed by a failure that says nothing of the service (a text it refuses), and keeps the call that failed that way', async () => {
    const inner = new Scripted();
    inner.mode = 'refuse-text';
    const provider = new InteractiveEmbeddingProvider(inner, { cooldownMs: 10_000 });
    await expect(provider.embed(['a'], { budgetMs: 1_000 })).rejects.toThrow('this text is refused');
    inner.mode = 'ok';
    expect(await provider.embed(['b'], { budgetMs: 1_000 })).toEqual([[1, 0, 0, 0]]);
    expect(inner.calls).toHaveLength(2);
  });

  it('is never closed against a patient call, which is how a background job finds out the service is back', async () => {
    const inner = new Scripted();
    inner.mode = 'unavailable';
    const provider = new InteractiveEmbeddingProvider(inner, { cooldownMs: 10_000 });
    await expect(provider.embed(['a'], { budgetMs: 1_000 })).rejects.toThrow(EmbeddingUnavailableError);
    await expect(provider.embed(['a'], { budgetMs: 1_000 })).rejects.toThrow(/not asked again yet/);
    // Patient calls go to the service whatever happened to interactive ones; one that succeeds ends the cooldown.
    inner.mode = 'ok';
    expect(await provider.embed(['a'])).toEqual([[1, 0, 0, 0]]);
    expect(await provider.embed(['b'], { budgetMs: 1_000 })).toEqual([[1, 0, 0, 0]]);
  });

  it('stops an interactive call when the caller aborts, without counting that as the service being down', async () => {
    const inner = new Scripted();
    inner.mode = 'hang';
    const provider = new InteractiveEmbeddingProvider(inner, { cooldownMs: 10_000 });
    const controller = new AbortController();
    const call = provider.embed(['a'], { budgetMs: 5_000, signal: controller.signal });
    controller.abort(new Error('shutting down'));
    await expect(call).rejects.toThrow('shutting down');
    inner.mode = 'ok';
    expect(await provider.embed(['a'], { budgetMs: 1_000 })).toEqual([[1, 0, 0, 0]]);
  });
});
