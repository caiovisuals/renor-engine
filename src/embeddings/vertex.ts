import fs from 'node:fs';
import crypto from 'node:crypto';
import { recordPhase, recordedPhase } from '../callPhases';
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

/**
 * How a token is kept fresh. Google's lives an hour. A call does not use one with a twelfth of its life left (5 of the 60
 * minutes, the margin it always kept), and the token is renewed in the background when a sixth is left (10 minutes), so the
 * calls keep finding one in hand and none of them waits for the exchange. Shares, not minutes, so a token of any lifetime is
 * treated alike.
 */
const REQUEST_MARGIN_SHARE = 1 / 12;
const RENEW_AHEAD_SHARE = 1 / 6;
/**
 * A token that lives less than this is not renewed in the background: the calls exchange for one when they need it. Google's
 * lives an hour; a service that hands out tokens of seconds would otherwise be asked for one every few seconds for good.
 */
const MIN_RENEWED_LIFETIME_MS = 60_000;
/** A renewal that failed is tried again after this, for as long as the token in hand can still be used. */
const RENEW_RETRY_MS = 60_000;
/** The exchange is one small request, and every call that needs a token waits for it: a stalled one must not hold them all. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
/** The longest wait setTimeout takes (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What the token's life is kept by: the clock it is dated on and the timer its renewal waits on. */
interface TokenClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): { unref(): unknown };
  clearTimeout(timer: { unref(): unknown } | undefined): void;
}

/** The process's own, looked up at each use, so a global clock someone else has replaced is the one it reads. */
const processClock: TokenClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout | undefined),
};

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

/** `work`, or the signal's reason as soon as it aborts: the caller stops waiting and `work` goes on for the others. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
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
  /** Where its requests go: the global `fetch`, looked up at each call, unless the caller gave it another (see `request`). */
  private readonly request: typeof fetch;
  private readonly tokenClock: TokenClock;
  private accessToken: string | null = null;
  /** Epoch ms until which a call may use the token in hand (REQUEST_MARGIN_SHARE), and when it is renewed in the background. */
  private tokenUsableUntil = 0;
  private tokenRenewAt = 0;
  /** The exchange in flight: a caller that needs a token while one is being fetched waits for it instead of making another. */
  private exchange: Promise<string> | null = null;
  private renewTimer: { unref(): unknown } | undefined;
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
    /** The `fetch` its token and predict requests use. The service gives it one whose pool keeps a connection across a pause (src/net/poolFetch.ts). */
    request?: typeof fetch;
    /** The clock and timer the access token's life is kept by. Unset: the process's own. A test hands in one it moves by hand, so an hour passes in no time and nothing else in the process feels it. */
    tokenClock?: TokenClock;
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
    this.request = options?.request ?? ((input, init) => globalThis.fetch(input, init));
    this.tokenClock = options?.tokenClock ?? processClock;
    this.usage = { requests: 0, inputTokens: 0, maxInputTokens };
  }

  /**
   * The token a call uses: the one in hand while it is usable, otherwise the exchange (one at a time, shared by every caller
   * waiting for it). A caller that gives up (its signal aborts) stops waiting; the exchange goes on and the next call finds
   * its token. The background renewal (armRenewal) keeps this from happening on a call at all while the provider is in use.
   */
  private getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && this.tokenClock.now() < this.tokenUsableUntil) return Promise.resolve(this.accessToken);
    if (signal?.aborted) return Promise.reject(signal.reason); // as before: a call already stopped starts no exchange
    return signal ? untilAborted(this.fetchToken(), signal) : this.fetchToken();
  }

  private fetchToken(): Promise<string> {
    this.exchange ??= this.exchangeToken().finally(() => { this.exchange = null; });
    return this.exchange;
  }

  /**
   * Starts the first access-token exchange now, in the background, so the first call after a start does not wait for it. The
   * renewal (armRenewal) keeps the token fresh from then on. A failure is not reported here: the next call tries the exchange
   * again, as it always did, and a call that finds an exchange in flight waits only for what is left of it.
   */
  warmToken(): void {
    if (this.accessToken || this.exchange) return;
    this.fetchToken().catch(() => undefined);
  }

  /**
   * The token is renewed at RENEW_AHEAD_SHARE of its life left, whether or not a call is waiting for it, and the renewal
   * arms the next one. A timer that cannot wait that long (setTimeout's limit) wakes early and waits again. The timer is
   * unref'd: it never keeps a process alive. A provider that is no longer used goes on renewing while its process lives,
   * one small request about every 50 minutes.
   */
  private armRenewal(at: number, lifetimeMs: number): void {
    this.tokenClock.clearTimeout(this.renewTimer);
    if (!Number.isFinite(at) || !(lifetimeMs >= MIN_RENEWED_LIFETIME_MS)) return;
    this.tokenRenewAt = at;
    this.waitToRenew(at - this.tokenClock.now());
  }

  private waitToRenew(ms: number): void {
    this.renewTimer = this.tokenClock.setTimeout(() => void this.renew(), Math.min(Math.max(0, ms), MAX_TIMER_MS));
    this.renewTimer.unref();
  }

  private async renew(): Promise<void> {
    const early = this.tokenRenewAt - this.tokenClock.now();
    if (early > 0) return this.waitToRenew(early);
    try {
      await this.fetchToken();
    } catch {
      // A call exchanges for a token when it must, and reports why if it cannot. Meanwhile, try again while the token in
      // hand can still be used, so a service that was away for a moment is not found out by a call.
      if (this.tokenClock.now() < this.tokenUsableUntil) this.waitToRenew(RENEW_RETRY_MS);
    }
  }

  /** OAuth2 JWT-bearer grant: SA key -> short-lived access token. */
  private async exchangeToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000); // the assertion is dated by the real clock, which is what Google reads
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
    const response = await this.request(this.key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      // Not a caller's signal: the exchange is shared, and one caller giving up must not end it for the others.
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Vertex token exchange failed: ${response.status}`);
    const data = await response.json() as { access_token: string; expires_in: number };
    const lifetimeMs = data.expires_in * 1000;
    const issuedAt = this.tokenClock.now();
    this.accessToken = data.access_token;
    this.tokenUsableUntil = issuedAt + lifetimeMs * (1 - REQUEST_MARGIN_SHARE);
    this.armRenewal(issuedAt + lifetimeMs * (1 - RENEW_AHEAD_SHARE), lifetimeMs);
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
    const waitedForToken = performance.now();
    const token = await this.getAccessToken(call.signal);
    recordPhase('token', performance.now() - waitedForToken);
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
    // The request itself, as the log's `call` phase has it: from sending to the last byte read, less the time spent opening a
    // connection for it (which the pool reports as `connect`).
    let sentAt = 0;
    let connectedBefore = 0;
    const spent = () => performance.now() - sentAt - (recordedPhase('connect') - connectedBefore);
    for (;;) {
      sentAt = performance.now();
      connectedBefore = recordedPhase('connect');
      response = await this.request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: call.signal,
      });
      if (response.ok || ![429, 500, 503].includes(response.status)) break;
      recordPhase('call', spent());
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
      recordPhase('call', spent());
      // The status travels with the error (the message is unchanged): a 400 names an input the service refuses.
      throw Object.assign(new Error(`Vertex predict failed (${response.status}): ${bodyText.slice(0, 400)}`), { status: response.status });
    }
    const data = await response.json() as {
      predictions?: Array<{ embeddings?: { values?: number[]; statistics?: { token_count?: number } } }>;
    };
    recordPhase('call', spent());
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
    const started = performance.now();
    try {
      for (let i = 0; i < texts.length; i += this.maxInstancesPerRequest) {
        const batch = texts.slice(i, i + this.maxInstancesPerRequest).map(text => ({ text, taskType }));
        out.push(...await this.predict(batch, call));
      }
    } finally {
      recordPhase('embed', performance.now() - started);
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