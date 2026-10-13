import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai';

// The provider keeps a round-robin pool of OpenAI clients (`clients[]`, one per
// API key) — it has no singular `client` property. Tests must mock every
// client's `embeddings.create` so no live network call is ever attempted.
function mockAllClients(p: OpenAIEmbeddingProvider, impl: (body: any) => any) {
  const clients = (p as any).clients as any[];
  expect(clients.length).toBeGreaterThan(0);
  const fns = clients.map((c: any) => {
    const fn = vi.fn().mockImplementation(impl);
    c.embeddings.create = fn;
    return fn;
  });
  return { fns, callCount: () => fns.reduce((n: number, f: any) => n + f.mock.calls.length, 0) };
}

describe('OpenAIEmbeddingProvider', () => {
  afterEach(() => {
    delete process.env.EMBEDDING_BATCH_SIZE;
  });

  it('calls API with correct model and returns embeddings', async () => {
    const p = new OpenAIEmbeddingProvider('test-key');
    const { fns } = mockAllClients(p, () =>
      Promise.resolve({ data: [{ embedding: new Array(1536).fill(0.1) }] })
    );
    const result = await p.embed(['hello']);
    expect(result[0]).toHaveLength(1536);
    expect(fns[0]).toHaveBeenCalledWith({ model: 'text-embedding-3-small', input: ['hello'] });
  });

  it('batches requests at the default bound of 32 texts', async () => {
    const p = new OpenAIEmbeddingProvider('test-key');
    let maxBatch = 0;
    const { callCount } = mockAllClients(p, ({ input }: any) => {
      maxBatch = Math.max(maxBatch, input.length);
      return Promise.resolve({ data: input.map(() => ({ embedding: new Array(1536).fill(0) })) });
    });
    await p.embed(new Array(250).fill('text'));
    expect(callCount()).toBe(8);
    expect(maxBatch).toBeLessThanOrEqual(32);
  });

  it('honors EMBEDDING_BATCH_SIZE override', async () => {
    process.env.EMBEDDING_BATCH_SIZE = '100';
    const p = new OpenAIEmbeddingProvider('test-key');
    let maxBatch = 0;
    const { callCount } = mockAllClients(p, ({ input }: any) => {
      maxBatch = Math.max(maxBatch, input.length);
      return Promise.resolve({ data: input.map(() => ({ embedding: new Array(1536).fill(0) })) });
    });
    await p.embed(new Array(250).fill('text'));
    expect(callCount()).toBe(3);
    expect(maxBatch).toBeLessThanOrEqual(100);
  });

  it.each(['-1', '1.5', 'not-a-number'])(
    'rejects invalid EMBEDDING_BATCH_SIZE=%s before making an API call',
    async value => {
      process.env.EMBEDDING_BATCH_SIZE = value;
      const p = new OpenAIEmbeddingProvider('test-key');
      const { callCount } = mockAllClients(p, () =>
        Promise.resolve({ data: [{ embedding: new Array(1536).fill(0) }] })
      );

      await expect(p.embed(['text'])).rejects.toThrow('EMBEDDING_BATCH_SIZE must be a positive integer');
      expect(callCount()).toBe(0);
    },
  );

  it('rounds over every configured key (multi-client pool)', async () => {
    const p = new OpenAIEmbeddingProvider(['key-a', 'key-b']);
    const { fns, callCount } = mockAllClients(p, ({ input }: any) =>
      Promise.resolve({ data: input.map(() => ({ embedding: new Array(1536).fill(0) })) })
    );
    await p.embed(new Array(70).fill('text'));
    expect(callCount()).toBe(3);
    expect(fns[0].mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fns[1].mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
