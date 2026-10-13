import { describe, it, expect, afterEach } from 'vitest';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { EmbeddingUnavailableError } from '../../src/embeddings/types';
import { startVertexStub, type VertexStub } from '../helpers/vertexStub';

/**
 * The Vertex provider against a local stub of the service (no Google call): a call with a budget reports a refusing or
 * silent service within it instead of sitting in the retry loop, and a call without one keeps retrying as it always did.
 */

let stub: VertexStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function provider(retry?: { maxAttempts?: number; waitMs?: (attempt: number) => number }): Promise<VertexEmbeddingProvider> {
  stub = await startVertexStub();
  return new VertexEmbeddingProvider({ keyFile: stub.keyFile, project: 'stub-project', location: 'europe-west4', baseUrl: stub.baseUrl, retry });
}

describe('VertexEmbeddingProvider with a budget', () => {
  it('reports a 429 at once when the retry would be later than the budget, with one request and no waiting', async () => {
    const vertex = await provider(); // the product's waits: 10 s before the first retry
    stub!.mode = 'throttle';
    const started = Date.now();
    await expect(vertex.embedQuery('q', { budgetMs: 5_000 })).rejects.toThrow(EmbeddingUnavailableError);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(stub!.counts.requests).toBe(1);
  });

  it('retries inside the budget when the wait fits, and succeeds when the service recovers', async () => {
    const vertex = await provider({ waitMs: () => 50 });
    stub!.mode = 'throttle';
    setTimeout(() => { stub!.mode = 'ok'; }, 120);
    const vector = await vertex.embedQuery('q', { budgetMs: 5_000 });
    expect(vector).toHaveLength(768);
    expect(stub!.counts.requests).toBeGreaterThan(1);
    expect(stub!.taskTypes).toEqual(['RETRIEVAL_QUERY']);
  });

  it('is stopped by its signal in the middle of a request the service never answers', async () => {
    const vertex = await provider();
    stub!.mode = 'hang';
    const controller = new AbortController();
    setTimeout(() => controller.abort(new EmbeddingUnavailableError('budget')), 80);
    const started = Date.now();
    await expect(vertex.embed(['a'], { signal: controller.signal })).rejects.toThrow('budget');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('is stopped by its signal while it waits to retry, so a shutdown does not wait out a backoff', async () => {
    const vertex = await provider({ waitMs: () => 60_000 });
    stub!.mode = 'throttle';
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('shutting down')), 80);
    const started = Date.now();
    await expect(vertex.embed(['a'], { signal: controller.signal })).rejects.toThrow('shutting down');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('VertexEmbeddingProvider without a budget', () => {
  it('keeps retrying through a refusal and returns the vectors once the service recovers', async () => {
    const vertex = await provider({ waitMs: () => 40 });
    stub!.mode = 'throttle';
    setTimeout(() => { stub!.mode = 'ok'; }, 200);
    const vectors = await vertex.embed(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(stub!.counts.requests).toBeGreaterThan(2);
  });

  it('gives up after its attempts with the same words as before, as an unavailable service', async () => {
    const vertex = await provider({ maxAttempts: 3, waitMs: () => 5 });
    stub!.mode = 'unavailable';
    await expect(vertex.embed(['a'])).rejects.toThrow('Vertex predict failed after 3 attempts (HTTP 503)');
    await expect(vertex.embed(['a'])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(stub!.counts.requests).toBe(6);
  });
});
