/**
 * Vertex embeddings from the instance's own service account, for the benchmark sweep VM (GOAL-better-all-benchmarks).
 *
 * The product's VertexEmbeddingProvider signs a service-account key file. The sweep VM gets no key: it is created with
 * the renor-embed service account (roles/aiplatform.user only), so this provider takes an access token from the
 * instance metadata server and calls the same `:predict` endpoint with the same request body, batching (32 texts a
 * request), retries on 429/500/503, and usage accounting (Vertex's own token_count). Vectors are the same model and
 * dimensions, so the rows it writes through CachingEmbeddingProvider land under the keys every runner reads.
 * Product code is not changed; this file is benchmark tooling only.
 */
import { EMBED_DIMENSIONS } from './benchmark-embed-inventory';
import type { MeteredProvider } from './benchmark-embed-prewarm';

export const METADATA_BASE_URL = 'http://metadata.google.internal';
const MODEL = 'gemini-embedding-001';
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 8;
const defaultRetryWaitMs = (attempt: number): number => Math.min(120_000, 5_000 * 2 ** attempt) + Math.random() * 2_000;

export interface MetadataVertexOptions {
  project: string;
  location: string;
  /** Vertex input tokens this process may be billed for; the provider refuses past it. */
  maxInputTokens: number;
  maxInstancesPerRequest?: number;
  /** Test seams: loopback stand-ins for the metadata server and the Vertex endpoint. */
  metadataBaseUrl?: string;
  baseUrl?: string;
  retry?: { maxAttempts?: number; waitMs?: (attempt: number) => number };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class MetadataVertexEmbeddingProvider implements MeteredProvider {
  readonly dimensions = EMBED_DIMENSIONS;
  readonly identity = { kind: 'vertex', model: MODEL };
  readonly usage: { requests: number; inputTokens: number; maxInputTokens: number };
  private readonly project: string;
  private readonly location: string;
  private readonly base: string;
  private readonly metadataBase: string;
  private readonly maxInstancesPerRequest: number;
  private readonly maxAttempts: number;
  private readonly retryWaitMs: (attempt: number) => number;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: MetadataVertexOptions) {
    if (!/^[a-z0-9-]+$/.test(options.project)) throw new Error('a Vertex project id is required');
    if (!/^[a-z0-9-]+$/.test(options.location)) throw new Error('a Vertex location is required');
    if (!Number.isInteger(options.maxInputTokens) || options.maxInputTokens < 1000) throw new Error('maxInputTokens must be an integer of at least 1000');
    this.project = options.project;
    this.location = options.location;
    this.base = options.baseUrl ?? `https://${options.location}-aiplatform.googleapis.com`;
    this.metadataBase = options.metadataBaseUrl ?? METADATA_BASE_URL;
    this.maxInstancesPerRequest = options.maxInstancesPerRequest ?? 32;
    this.maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryWaitMs = options.retry?.waitMs ?? defaultRetryWaitMs;
    this.usage = { requests: 0, inputTokens: 0, maxInputTokens: options.maxInputTokens };
  }

  /** The instance's default service account token, from the metadata server, kept until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_MARGIN_MS) return this.token;
    const response = await fetch(`${this.metadataBase}/computeMetadata/v1/instance/service-accounts/default/token`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!response.ok) throw new Error(`metadata token request failed (HTTP ${response.status})`);
    const data = await response.json() as { access_token: string; expires_in: number };
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }

  private async predict(batch: Array<{ text: string; taskType: string }>): Promise<number[][]> {
    const token = await this.accessToken();
    const url = `${this.base}/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${MODEL}:predict`;
    const body = JSON.stringify({
      instances: batch.map(({ text, taskType }) => ({ content: text, task_type: taskType })),
      parameters: { outputDimensionality: EMBED_DIMENSIONS, autoTruncate: true },
    });
    let attempt = 0;
    let response: Response;
    for (;;) {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      });
      if (response.ok || ![429, 500, 503].includes(response.status)) break;
      attempt += 1;
      if (attempt >= this.maxAttempts) throw new Error(`Vertex predict failed after ${attempt} attempts (HTTP ${response.status})`);
      await sleep(this.retryWaitMs(attempt));
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vertex predict failed (${response.status}): ${text.slice(0, 400)}`);
    }
    const data = await response.json() as {
      predictions?: Array<{ embeddings?: { values?: number[]; statistics?: { token_count?: number } } }>;
    };
    const predictions = data.predictions ?? [];
    if (predictions.length !== batch.length
      || predictions.some(p => !Array.isArray(p.embeddings?.values) || p.embeddings!.values!.length !== EMBED_DIMENSIONS)) {
      throw new Error('Vertex predict returned malformed or incomplete embeddings');
    }
    this.usage.requests += 1;
    for (const p of predictions) this.usage.inputTokens += p.embeddings?.statistics?.token_count ?? 0;
    if (this.usage.inputTokens > this.usage.maxInputTokens) {
      throw new Error(`Embedding cost guard tripped: ${this.usage.inputTokens} input tokens exceeds the ${this.usage.maxInputTokens} cap`);
    }
    return predictions.map(p => p.embeddings!.values!);
  }

  private async embedAll(texts: string[], taskType: string): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxInstancesPerRequest) {
      out.push(...await this.predict(texts.slice(i, i + this.maxInstancesPerRequest).map(text => ({ text, taskType }))));
    }
    return out;
  }

  /** Documents: RETRIEVAL_DOCUMENT, as the product indexes them. */
  async embed(texts: string[]): Promise<number[][]> {
    return this.embedAll(texts, 'RETRIEVAL_DOCUMENT');
  }

  /** Queries: RETRIEVAL_QUERY, as the product searches with them. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedAll([text], 'RETRIEVAL_QUERY');
    return vector;
  }
}
