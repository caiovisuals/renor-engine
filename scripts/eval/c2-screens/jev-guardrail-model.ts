/**
 * SCR-C2-GUARDRAIL JEV adapter — TypeSafe System One ("Jev") behind the C2
 * DecisionModel seam (src/extraction/decision-model.ts) for the sensitivity
 * guardrail task, per the owner decision ("jev for guardrail").
 *
 * Client contract copied from lane/jev-writepath src/extraction/decision-model.ts
 * (JevDecisionModel), where the T3 arm was adjudicated KEEP (100% recall,
 * p95 430ms). This adapter maps Jev's sensitivity task onto THIS worktree's
 * DecisionModel interface:
 *
 *   capture_gate chunk text  → Jev `sensitivity-guardrail`:
 *     block/redact  → capture-gate decision 'sensitive' (blocked: the pipeline
 *                      skips any capture_gate decision ≠ 'fact', so no
 *                      structured rows are written from that chunk)
 *     store         → falls through to the product default local capture gate
 *                      so normal capture behavior is unchanged
 *   dedupe_adjudication → product default local rules (the guardrail arm must
 *                      not change dedupe semantics)
 *
 * Safe default on low confidence: block (LANE-JEV-WRITE-PATH.md §T3).
 * Only planted SYNTHETIC secrets and synthetic benign sentences are sent to
 * the vendor — never corpus text, never real secrets (Lane J §T3 hard rule).
 */
import crypto from 'node:crypto';
import {
  LocalRulesDecisionModel,
  type DecisionModel,
  type DecisionRequest,
  type DecisionResult,
} from '../../../src/extraction/decision-model';

export const SENSITIVITY_LOW_CONFIDENCE_THRESHOLD = 0.6;
export const JEV_INPUT_PRICE_USD_PER_MTOK = 0.042; // docs/evals/COST-MODEL.md lane-Jev arm

const SENSITIVITY_JEV_QUESTION = {
  type: 'choice' as const,
  instructions:
    'Decide how to persist this text. "block" = do not store it at all (it contains a '
    + 'secret credential: API key, token, password, private key, or live account '
    + 'identifier). "redact" = the text is useful but contains personal identifiers '
    + '(phone, email, card, government id) that must be masked before storing. '
    + '"store" = no secrets or personal identifiers; safe to store verbatim.',
  criteria: {
    store: 'No secrets or personal identifiers; safe to store verbatim.',
    block: 'Contains a secret credential; must not be stored at all.',
    redact: 'Useful text containing personal identifiers that must be masked first.',
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn: () => Promise<Response>, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fn();
    if (res.status === 429 || res.status === 529) {
      lastError = new Error(`retryable status ${res.status} (attempt ${attempt + 1}/${maxRetries + 1})`);
      if (attempt === maxRetries) throw lastError;
      await sleep(Math.min(500 * 2 ** attempt, 4000) * (0.75 + Math.random() * 0.5));
      continue;
    }
    return res;
  }
  throw lastError ?? new Error('withRetry exhausted');
}

export interface JevGuardrailOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/** Per-capture-gate-call observation, keyed by chunk text (ids only in reports). */
export interface JevObservation {
  jevDecision: string;
  confidence: number;
  latencyMs: number;
  costUSDCents: number;
  inputTokens: number;
  finalCaptureGateDecision: string;
}

/**
 * Jev-backed DecisionModel: sensitivity guardrail at the capture gate.
 * Local rules decide everything else — the guardrail screen measures ONLY the
 * guardrail arm, never an unshipped extractor swap.
 */
export class JevGuardrailDecisionModel implements DecisionModel {
  private readonly local = new LocalRulesDecisionModel();
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  /** keyed by sha256(text) — no raw text is ever stored here. */
  readonly observations = new Map<string, JevObservation>();
  totalInputTokens = 0;
  totalCostUSDCents = 0;
  errors = 0;

  constructor(opts: JevGuardrailOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = (opts.apiKey ?? env.TYPESAFE_API_KEY ?? '').trim();
    this.baseUrl = (opts.baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
    this.model = opts.model ?? 'jev-latest';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (request.task === 'dedupe_adjudication') return this.local.decide(request);
    const jev = await this.jevSensitivity(request.text);
    this.totalInputTokens += jev.inputTokens;
    this.totalCostUSDCents += jev.costUSDCents;
    if (jev.decision !== 'store') {
      // blocked at the capture gate: the pipeline's capture loop skips any
      // capture_gate decision other than 'fact' → no rows are written.
      const result: DecisionResult = {
        task: 'capture_gate',
        decision: 'sensitive',
        confidence: jev.confidence,
        latencyMs: jev.latencyMs,
        costUSDCents: jev.costUSDCents,
      };
      this.record(request.text, { ...jev, jevDecision: jev.decision, finalCaptureGateDecision: 'sensitive' });
      return result;
    }
    // Not sensitive: product default capture gate decides (normal behavior).
    const local = await this.local.decide(request);
    this.record(request.text, {
      ...jev,
      jevDecision: jev.decision,
      finalCaptureGateDecision: String(local.decision),
      costUSDCents: local.costUSDCents,
    });
    return local;
  }

  private record(text: string, obs: JevObservation): void {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    this.observations.set(hash, obs);
  }

  private async jevSensitivity(text: string): Promise<{ decision: string; confidence: number; latencyMs: number; costUSDCents: number; inputTokens: number }> {
    const started = Date.now();
    if (!this.apiKey) throw new Error('JevGuardrailDecisionModel requires TYPESAFE_API_KEY');
    const body = JSON.stringify({
      model: this.model,
      state: { text },
      questions: { sensitivity: SENSITIVITY_JEV_QUESTION },
    });
    const res = await withRetry(() =>
      this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body,
      }));
    if (!res.ok) throw new Error(`jev systemone failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      answers?: Record<string, { type: string; choice?: string; confidence?: number }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const answer = Object.values(json.answers ?? {})[0];
    if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
      throw new Error('jev response missing choice answer');
    }
    let decision = answer.choice;
    const confidence = Math.max(0, Math.min(1, answer.confidence ?? 0));
    // Safe default on low confidence: block (Lane J §T3).
    if (confidence < SENSITIVITY_LOW_CONFIDENCE_THRESHOLD && decision === 'store') decision = 'block';
    const inputTokens = json.usage?.input_tokens ?? 0;
    return {
      decision,
      confidence,
      latencyMs: Date.now() - started,
      costUSDCents: (inputTokens * JEV_INPUT_PRICE_USD_PER_MTOK) / 1_000_000 * 100,
      inputTokens,
    };
  }
}