import type { EmbeddingIdentity, EmbeddingProvider } from '../embeddings/types';

/**
 * Deterministic lexical hash embeddings for eval infrastructure smoke tests.
 *
 * This provider intentionally has no semantic-quality claim. It exists so CI can
 * execute indexing/vector-search/scoring paths without network/model downloads.
 * Any manifest using it must be marked qualityEligible=false.
 */
export class EvalHashEmbeddingProvider implements EmbeddingProvider {
  dimensions = 256;
  readonly identity: EmbeddingIdentity = { kind: 'eval-hash', model: 'lexical-hash-v1' };

  private vector(text: string): number[] {
    const out = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const word of words) {
      let hash = 2166136261;
      for (let i = 0; i < word.length; i++) {
        hash ^= word.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      out[(hash >>> 0) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
    return out.map(value => value / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}
