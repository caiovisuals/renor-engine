import { CALIBRATED_BARS } from '../../src/mvp/contextRelevance';
import type { EmbeddingProvider } from '../../src/embeddings/types';

/**
 * A provider that embeds with the deterministic lexical hash of the eval-hash stub and declares the calibrated hosted
 * identity, so the relevance bar the engine resolves for it is the real one (contextRelevance.ts CALIBRATED_BARS) while
 * nothing leaves the process: no credential, no model, no network. Its cosines are the lexical overlap of two texts,
 * which says nothing about how the hosted model scores; it makes the engine behave as it does on a calibrated model.
 */
export const CALIBRATED_KEY = 'vertex:gemini-embedding-001:768';
export const CALIBRATED_BAR = CALIBRATED_BARS[CALIBRATED_KEY];
const [IDENTITY_KIND, IDENTITY_MODEL, IDENTITY_DIMS] = CALIBRATED_KEY.split(':');

export class CalibratedIdentityProvider implements EmbeddingProvider {
  readonly identity = { kind: IDENTITY_KIND, model: IDENTITY_MODEL };
  dimensions = Number(IDENTITY_DIMS);
  private vector(text: string): number[] {
    const out = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
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
  async embed(texts: string[]): Promise<number[][]> { return texts.map(text => this.vector(text)); }
  async embedQuery(text: string): Promise<number[]> { return this.vector(text); }
}
