import type { EmbeddingIdentity, EmbeddingProvider } from './types';
import path from 'path';
import os from 'os';

// Models that require asymmetric query/passage prefixes
const E5_PREFIX_MODELS = ['multilingual-e5', 'e5-'];

function needsE5Prefix(modelName: string): boolean {
  return E5_PREFIX_MODELS.some(p => modelName.toLowerCase().includes(p));
}

// Dimension map for known models
const MODEL_DIMENSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/multilingual-e5-small': 384,
  'Xenova/multilingual-e5-base': 768,
  'Xenova/multilingual-e5-large': 1024,
  'intfloat/multilingual-e5-base': 768,
};

export class LocalEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity: EmbeddingIdentity;
  private modelName: string;
  private extractor: any = null;
  private initPromise: Promise<any> | null = null;

  constructor(modelName?: string) {
    this.modelName = modelName ?? 'Xenova/multilingual-e5-base';
    this.dimensions = MODEL_DIMENSIONS[this.modelName] ?? 768;
    this.identity = { kind: 'local', model: this.modelName };
  }

  private getExtractor(): Promise<any> {
    if (this.extractor) return Promise.resolve(this.extractor);
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers' as any);
      env.cacheDir = path.join(os.homedir(), '.cache', 'osm-memory', 'models');
      this.extractor = await pipeline('feature-extraction', this.modelName);
      return this.extractor;
    })();
    return this.initPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const prefixed = needsE5Prefix(this.modelName)
      ? texts.map(t => `passage: ${t}`)
      : texts;
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }

  async embedQuery(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const prefixed = needsE5Prefix(this.modelName) ? `query: ${text}` : text;
    const output = await extractor([prefixed], { pooling: 'mean', normalize: true });
    return (output.tolist() as number[][])[0];
  }
}
