import crypto from 'crypto';
import type { EmbeddingIdentity, EmbeddingProvider } from '../../src/embeddings/types';

/**
 * Synthetic dense vectors for the latency bench (`--embeddings dense`). Each text maps to a unit vector of `dimensions`
 * Gaussian coordinates, drawn from a generator seeded by the text's SHA-256: deterministic, no model, no network, no spend.
 *
 * It exists because the lexical hash stub (src/eval/hashEmbedding.ts) makes sparse vectors, which tie exactly at the edge of
 * most searches, so a search over them measures a different path from the one a hosted workspace takes (dense Vertex
 * vectors). The identity kind is not `eval-hash`, so the reader treats the order by meaning as it does for dense vectors.
 */
export class DenseHashEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity: EmbeddingIdentity;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
    this.identity = { kind: 'bench-dense', model: `sha256-gaussian-v1-${dimensions}` };
  }

  private vector(text: string): number[] {
    const digest = crypto.createHash('sha256').update(text).digest();
    let state = digest.readUInt32LE(0) ^ digest.readUInt32LE(8) ^ digest.readUInt32LE(16) ^ digest.readUInt32LE(24);
    // mulberry32: a uniform generator in (0, 1) from the 32-bit state
    const uniform = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
    };
    const out = new Array<number>(this.dimensions);
    let sum = 0;
    for (let i = 0; i < this.dimensions; i++) {
      // Box-Muller: one standard normal per two uniforms
      const g = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
      out[i] = g;
      sum += g * g;
    }
    const norm = Math.sqrt(sum) || 1;
    return out.map(value => value / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}
