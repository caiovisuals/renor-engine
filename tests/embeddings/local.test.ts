import { describe, it, expect, vi } from 'vitest';

// Mock @xenova/transformers before import
vi.mock('@xenova/transformers', () => {
  const mockPipeline = vi.fn().mockResolvedValue(
    vi.fn().mockImplementation((texts: string[]) => ({
      tolist: () => texts.map(() => Array.from({ length: 384 }, () => Math.random())),
    }))
  );
  return { pipeline: mockPipeline, env: { cacheDir: '' } };
});

import { LocalEmbeddingProvider } from '../../src/embeddings/local';

describe('LocalEmbeddingProvider', () => {
  it('implements EmbeddingProvider interface', () => {
    const provider = new LocalEmbeddingProvider();
    expect(provider.dimensions).toBe(768); // multilingual-e5-base default
    expect(typeof provider.embed).toBe('function');
  });

  it('returns embeddings with correct dimensions', async () => {
    const provider = new LocalEmbeddingProvider();
    const result = await provider.embed(['hello world', 'test']);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(384); // mock returns 384-dim vectors
    expect(result[1]).toHaveLength(384);
  });

  it('handles empty input', async () => {
    const provider = new LocalEmbeddingProvider();
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('accepts custom model name with fallback dimensions', () => {
    const provider = new LocalEmbeddingProvider('Xenova/custom-model');
    expect(provider.dimensions).toBe(768); // unknown model falls back to 768
  });

  it('uses correct dimensions for known models', () => {
    expect(new LocalEmbeddingProvider('Xenova/all-MiniLM-L6-v2').dimensions).toBe(384);
    expect(new LocalEmbeddingProvider('Xenova/multilingual-e5-small').dimensions).toBe(384);
    expect(new LocalEmbeddingProvider('Xenova/multilingual-e5-base').dimensions).toBe(768);
  });
});
