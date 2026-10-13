import type OpenAI from 'openai';
import { EmbeddingIdentity, EmbeddingProvider } from './types';

/**
 * Generic OpenAI-compatible embeddings provider.
 * Works with OpenAI, Voyage AI (voyageai.com, OpenAI-shaped /v1/embeddings),
 * and any compatible gateway. Configured via EMBEDDING_BASE_URL and
 * EMBEDDING_DIMS (defaults preserve upstream OpenAI behavior).
 *
 * The `openai` SDK is required in the constructor rather than imported: it costs
 * ~70 ms to load, it is reached on every cold start of dist/mvp/cli.js through
 * this module, and a workspace only ever constructs this class when its
 * embedding provider IS openai. A workspace on Vertex (every provisioned
 * workspace) or on no provider never constructs it, so for those the SDK was
 * ~70 ms of a wake that could not use it. The import above is `import type`, so
 * it is erased at compile time and contributes nothing at load — the type stays
 * checked, the module is not loaded.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly identity: EmbeddingIdentity;
  /** The dims the user explicitly configured (EMBEDDING_DIMS); null = SDK/gateway default. */
  private readonly configuredDims: number | null;
  private clients: OpenAI[] = [];
  private cooldown = new Map<number, number>();
  private rr = 0;
  private model: string;

  constructor(apiKeys: string | string[], model?: string, baseURL?: string, dimensions?: number) {
    const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys];
    if (keys.length === 0) throw new Error('at least one API key required');
    this.model = model ?? 'text-embedding-3-small';
    this.identity = { kind: 'openai', model: this.model };
    this.configuredDims = dimensions ?? null;
    this.dimensions = dimensions ?? 1536;
    // CommonJS loader, deferred: this is the only line that actually pulls the SDK.
    const OpenAICtor = require('openai').default as typeof OpenAI;
    this.clients = keys.map(apiKey => new OpenAICtor({ apiKey, baseURL }));
  }

  /** next healthy client index (round-robin over non-cooling keys) */
  private nextClient(): number {
    const now = Date.now();
    for (let t = 0; t < this.clients.length; t++) {
      const i = (this.rr + t) % this.clients.length;
      if ((this.cooldown.get(i) ?? 0) <= now) { this.rr = i + 1; return i; }
    }
    return -1; // all cooling
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const rawBatchSize = process.env.EMBEDDING_BATCH_SIZE;
    const batchSize = rawBatchSize === undefined ? 32 : Number(rawBatchSize);
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error('EMBEDDING_BATCH_SIZE must be a positive integer');
    }
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      results.push(...(await this.embedWithRetry(batch)));
    }
    return results;
  }

  /** Retries on 429/5xx with exponential backoff; on 429 rotates to the next healthy key first. */
  private async embedWithRetry(batch: string[], attempt = 0): Promise<number[][]> {
    const ci = this.nextClient();
    if (ci === -1) {
      const waitMs = Math.max(2000, 1000 * 2 ** Math.min(attempt, 8));
      await new Promise(r => setTimeout(r, waitMs));
      return this.embedWithRetry(batch, attempt + 1);
    }
    try {
      // Product defect fix (P1, disclosed): when EMBEDDING_DIMS is configured it
      // sizes the vector index table — it MUST also be sent to the gateway, or
      // gateways whose omission default differs (e.g. Google: 3072) return
      // mismatched vectors and indexing fails. Unconfigured callers keep the
      // previous behavior (SDK/gateway default).
      const res = await this.clients[ci].embeddings.create(
        this.configuredDims !== null
          ? { model: this.model, input: batch, dimensions: this.configuredDims }
          : { model: this.model, input: batch },
      );
      return res.data.map(d => d.embedding);
    } catch (e: any) {
      const status = e?.status;
      if (status === 429 && attempt < 40) {
        this.cooldown.set(ci, Date.now() + 60_000);
        return this.embedWithRetry(batch, attempt + 1); // immediate retry on another key
      }
      if (status === 401 || status === 403) {
        this.cooldown.set(ci, Number.MAX_SAFE_INTEGER); // dead key — never use again this run
        if (attempt < 40) return this.embedWithRetry(batch, attempt + 1);
        throw e;
      }
      if (status >= 500 && status < 600 && attempt < 10) {
        const waitMs = Math.max(Number(e?.headers?.get?.('retry-after')) * 1000 || 0, 1000 * 2 ** attempt, 2000);
        await new Promise(r => setTimeout(r, waitMs));
        return this.embedWithRetry(batch, attempt + 1);
      }
      throw e;
    }
  }
}
