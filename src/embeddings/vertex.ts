import fs from 'node:fs';
import crypto from 'node:crypto';
import { EmbeddingUnavailableError, type EmbedOptions, type EmbeddingIdentity, type EmbeddingProvider } from './types';

/**
 * Vertex AI text embeddings (gemini-embedding-001) through the native predict endpoint.
 *
 * Auth: service-account JSON key (GOOGLE_APPLICATION_CREDENTIALS or
 * RENOR_EVAL_VERTEX_KEY_FILE). The key never appears in logs or manifests; only
 * short-lived access tokens are sent to Google.
 *
 * Cost guard: input token statistics are summed from responses and the
 * provider throws once RENOR_EVAL_MAX_EMBED_TOKENS is exceeded, so a benchmark
 * run cannot silently burn credits.
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface VertexUsage {
  requests: number;
  inputTokens: number;
  maxInputTokens: number;
}

const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** Quota (429) and transient (500/503) answers are retried: 8 attempts, waiting 10 s, 20 s ... up to 120 s between them. */
const DEFAULT_MAX_ATTEMPTS = 8;
const defaultRetryWaitMs = (attempt: number): number => Math.min(120_000, 5_000 * 2 ** attempt) + Math.random() * 2_000;

/** The endpoint is built from the location; a test points it at a local stub instead. */
function endpointBase(baseUrl: string | undefined, location: string): string {
  if (baseUrl === undefined) return `https://${location}-aiplatform.googleapis.com`;
  const url = new URL(baseUrl);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Vertex baseUrl must be https, or http on loopback');
  return url.origin;
}

/** Wait `ms`, or until `signal` aborts, which ends the call that is waiting. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class VertexEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  readonly kind = 'vertex';
  readonly model: string;
  readonly identity: EmbeddingIdentity;
  private readonly project: string;
  private readonly location: string;
  private readonly key: ServiceAccountKey;
  private readonly maxInstancesPerRequest: number;
  private readonly maxInputTokens: number;
  private readonly base: string;
  private readonly maxAttempts: number;
  private readonly retryWaitMs: (attempt: number) => number;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  usage: VertexUsage;

  constructor(options?: {
    keyFile?: string;
    project?: string;
    location?: string;
    model?: string;
    dimensions?: number;
    maxInstancesPerRequest?: number;
    maxInputTokens?: number;
    /** Where the endpoint is served from. Unset: Google's, from the location. A test points it at a local stub. */
    baseUrl?: string;
    /** How a 429/500/503 is retried. Unset: 8 attempts with the waits above. */
    retry?: { maxAttempts?: number; waitMs?: (attempt: number) => number };
  }) {
    const keyFile = options?.keyFile
      ?? process.env.RENOR_EVAL_VERTEX_KEY_FILE
      ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
      ?? '';
    if (!keyFile || !fs.existsSync(keyFile)) {
      throw new Error('Vertex provider requires a service-account key file (GOOGLE_APPLICATION_CREDENTIALS or RENOR_EVAL_VERTEX_KEY_FILE)');
    }
    const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as ServiceAccountKey;
    if (!raw.client_email || !raw.private_key || !raw.token_uri) {
      throw new Error('Service-account key file must contain client_email, private_key, and token_uri');
    }
    this.key = raw;
    this.project = options?.project ?? process.env.RENOR_EVAL_VERTEX_PROJECT ?? '';
    if (!/^[a-z0-9-]+$/.test(this.project)) throw new Error('RENOR_EVAL_VERTEX_PROJECT is required');
    this.location = options?.location ?? process.env.RENOR_EVAL_VERTEX_LOCATION ?? '';
    if (!this.location) throw new Error('RENOR_EVAL_VERTEX_LOCATION is required');
    if (!/^[a-z0-9-]+$/.test(this.location)) throw new Error('Invalid Vertex location');
    this.model = options?.model ?? process.env.RENOR_EVAL_MODEL ?? 'gemini-embedding-001';
    this.identity = { kind: this.kind, model: this.model };
    const dimensions = options?.dimensions ?? Number(process.env.RENOR_EVAL_EMBEDDING_DIMS ?? 768);
    if (!Number.isInteger(dimensions) || ![768, 1536, 3072].includes(dimensions)) {
      throw new Error('gemini-embedding-001 dimensions must be 768, 1536, or 3072');
    }
    this.dimensions = dimensions;
    this.maxInstancesPerRequest = options?.maxInstancesPerRequest ?? 32;
    const maxInputTokens = options?.maxInputTokens
      ?? Number(process.env.RENOR_EVAL_MAX_EMBED_TOKENS ?? 80_000_000);
    if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1_000) {
      throw new Error('RENOR_EVAL_MAX_EMBED_TOKENS must be a positive integer >= 1000');
    }
    this.maxInputTokens = maxInputTokens;
    this.base = endpointBase(options?.baseUrl, this.location);
    this.maxAttempts = options?.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryWaitMs = options?.retry?.waitMs ?? defaultRetryWaitMs;
    this.usage = { requests: 0, inputTokens: 0, maxInputTokens };
  }

  /** OAuth2 JWT-bearer grant: SA key -> short-lived access token. */
  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_MARGIN_MS) return this.accessToken;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: this.key.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: this.key.token_uri,
      iat: now,
      exp: now + 3600,
    }));
    const signature = b64url(crypto.createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(this.key.private_key));
    const response = await fetch(this.key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      signal,
    });
    if (!response.ok) throw new Error(`Vertex token exchange failed: ${response.status}`);
    const data = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  /**
   * `call` says how long this one may take (see EmbedOptions): `deadline` is the epoch ms by which it gives up, and a
   * retry whose wait would end past it is not waited for, so a refusing service is reported at once rather than at the
   * deadline. Without one the retries run their whole course.
   */
  private async predict(
    contents: Array<{ text: string; taskType: string }>,
    call: { deadline: number; signal?: AbortSignal },
  ): Promise<number[][]> {
    const token = await this.getAccessToken(call.signal);
    const url = `${this.base}/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${this.model}:predict`;
    const body = JSON.stringify({
      instances: contents.map(({ text, taskType }) => ({
        content: text,
        task_type: taskType,
      })),
      parameters: { outputDimensionality: this.dimensions, autoTruncate: true },
    });

    // Quota (429) and transient (500/503) errors are expected on new projects:
    // back off with jitter instead of failing the run. Retries cost nothing —
    // 429 responses are not billed.
    const maxAttempts = this.maxAttempts;
    let attempt = 0;
    let response: Response;
    for (;;) {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: call.signal,
      });
      if (response.ok || ![429, 500, 503].includes(response.status)) break;
      attempt += 1;
      if (attempt >= maxAttempts) {
        throw new EmbeddingUnavailableError(`Vertex predict failed after ${attempt} attempts (HTTP ${response.status})`);
      }
      const waitMs = this.retryWaitMs(attempt);
      if (Date.now() + waitMs > call.deadline) {
        throw new EmbeddingUnavailableError(`Vertex predict refused (HTTP ${response.status}); the retry is later than this call may wait`);
      }
      process.stderr.write(`[vertex] HTTP ${response.status} on ${contents.length} inputs; retry ${attempt}/${maxAttempts - 1} in ${Math.round(waitMs / 1000)}s\n`);
      await sleepUnlessAborted(waitMs, call.signal);
    }
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Vertex predict failed (${response.status}): ${bodyText.slice(0, 400)}`);
    }
    const data = await response.json() as {
      predictions?: Array<{ embeddings?: { values?: number[]; statistics?: { token_count?: number } } }>;
    };
    const predictions = data.predictions ?? [];
    if (predictions.length !== contents.length
        || predictions.some(p => !Array.isArray(p.embeddings?.values) || p.embeddings!.values!.length !== this.dimensions)) {
      throw new Error('Vertex predict returned malformed or incomplete embeddings');
    }
    this.usage.requests += 1;
    for (const p of predictions) this.usage.inputTokens += p.embeddings?.statistics?.token_count ?? 0;
    if (this.usage.inputTokens > this.maxInputTokens) {
      throw new Error(
        `Embedding cost guard tripped: ${this.usage.inputTokens} input tokens exceeds the ${this.maxInputTokens} cap (set RENOR_EVAL_MAX_EMBED_TOKENS to raise it)`,
      );
    }
    return predictions.map(p => p.embeddings!.values!);
  }

  private async embedAll(texts: string[], taskType: string, options?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const call = {
      deadline: options?.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs,
      signal: options?.signal,
    };
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxInstancesPerRequest) {
      const batch = texts.slice(i, i + this.maxInstancesPerRequest).map(text => ({ text, taskType }));
      out.push(...await this.predict(batch, call));
    }
    return out;
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    return this.embedAll(texts, 'RETRIEVAL_DOCUMENT', options);
  }

  async embedQuery(text: string, options?: EmbedOptions): Promise<number[]> {
    const [vector] = await this.embedAll([text], 'RETRIEVAL_QUERY', options);
    return vector;
  }

  describe(): Record<string, unknown> {
    // Credentials and project IDs never leave the process through logs.
    return {
      kind: 'vertex',
      model: this.model,
      dimensions: this.dimensions,
      location: this.location,
      taskTypes: { document: 'RETRIEVAL_DOCUMENT', query: 'RETRIEVAL_QUERY' },
      usage: { ...this.usage },
    };
  }
}