import path from 'node:path';
import { createOllamaChat } from './ollamaChat';
import { ollamaKeysForEndpoint } from './keyPool';
import { EvidenceCache } from './evidenceCache';
import { EvidenceDailyBudget, optinEndpointAllowed, readOptinKey, resolveEvidenceOptin, dailyBudgetGate } from './optin';
import { resolveEvidenceMode, type EvidenceMode } from './gate';
import type { EvidenceBackground } from './background';
import {
  EVIDENCE_MODEL_DEFAULT,
  EVIDENCE_REASONING_EFFORTS,
  MAX_EVIDENCE_SESSIONS,
  EVIDENCE_SESSION_CHAR_CAP,
  EvidenceExtractor,
  type EvidenceChat,
  type EvidenceReasoningEffort,
  type EvidenceRequestBounds,
} from './secondPass';

/**
 * Product wiring for the evidence tool: env -> options. The chat client is
 * built only when keys exist; otherwise the tool degrades to hits-only with an
 * explicit reason instead of failing the MCP call.
 */
export interface EvidenceToolOptions {
  mode: EvidenceMode;
  model: string;
  maxSessions: number;
  charCap: number;
  cachePath?: string;
  chat?: EvidenceChat;
  /** Present only for a workspace that opted in (optin.ts): its model calls per UTC day. */
  dailyCap?: number;
  /** Present only when RENOR_EVIDENCE_MAX_TOKENS or RENOR_EVIDENCE_REASONING_EFFORT is set. */
  bounds?: EvidenceRequestBounds;
  /**
   * Bounded wait (RENOR_EVIDENCE_ASYNC, default off; see background.ts). Absent, a search waits for the extractor.
   * Only the MVP read tools set it: this resolver never does.
   */
  background?: EvidenceBackground;
}

/**
 * RENOR_EVIDENCE_MAX_TOKENS (a positive integer) and
 * RENOR_EVIDENCE_REASONING_EFFORT (none | minimal | low | medium | high).
 * Unset or blank means no bound, which is the shipped request. A value that
 * does not parse throws, like an invalid RENOR_EVIDENCE_MODE: an operator who
 * set a bound must not get an unbounded extractor because of a typo.
 */
export function resolveEvidenceBounds(env: NodeJS.ProcessEnv = process.env): EvidenceRequestBounds {
  const bounds: EvidenceRequestBounds = {};
  const maxTokens = (env.RENOR_EVIDENCE_MAX_TOKENS ?? '').trim();
  if (maxTokens !== '') {
    const value = Number(maxTokens);
    if (!/^[1-9][0-9]*$/.test(maxTokens) || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid RENOR_EVIDENCE_MAX_TOKENS "${maxTokens}": must be a positive integer`);
    }
    bounds.maxTokens = value;
  }
  const effort = (env.RENOR_EVIDENCE_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (effort !== '') {
    if (!(EVIDENCE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
      throw new Error(`Invalid RENOR_EVIDENCE_REASONING_EFFORT "${effort}": must be ${EVIDENCE_REASONING_EFFORTS.join(' | ')}`);
    }
    bounds.reasoningEffort = effort as EvidenceReasoningEffort;
  }
  return bounds;
}

/**
 * The OpenAI-compatible provider the query-time model passes call: RENOR_EVIDENCE_BASE_URL (unset or blank: the
 * transport's Ollama Cloud default) and the key pool. Shared by the evidence pass and the session router
 * (src/router/sessionRouter.ts), so the two can never disagree about which keys exist, and the URL returned is the
 * one the Ollama keys were judged against. Values are never logged.
 */
export function resolveEvidenceProvider(env: NodeJS.ProcessEnv = process.env): { baseUrl?: string; keys: string[] } {
  // Blank is the default endpoint (Ollama Cloud), like an unset variable.
  const baseUrl = env.RENOR_EVIDENCE_BASE_URL?.trim() || undefined;
  const keys = [
    ...(env.RENOR_EVIDENCE_API_KEYS ?? '').split(','),
    env.RENOR_EVIDENCE_API_KEY ?? '',
    // The Ollama pool is collected by the shared helper, never re-listed here:
    // this module used to name `OLLAMA_CLOUD_KEY_1..3` while the write-path
    // extractor named six, so with the first three keys at their monthly
    // ceiling the evidence layer vanished for 77 of 500 cases with no signal in
    // the manifest (issue #222). One list, two readers. And only for an Ollama
    // Cloud endpoint: another provider never receives an Ollama key.
    ...ollamaKeysForEndpoint(baseUrl, env).keys,
  ].map(k => k.trim()).filter(Boolean);
  return { baseUrl, keys };
}

export function resolveEvidenceToolOptions(
  config: { dbPath: string },
  env: NodeJS.ProcessEnv = process.env,
): EvidenceToolOptions {
  const mode = resolveEvidenceMode(env);
  const model = env.RENOR_EVIDENCE_MODEL?.trim() || EVIDENCE_MODEL_DEFAULT;
  const cachePath = env.RENOR_EVIDENCE_CACHE?.trim()
    || path.join(path.dirname(config.dbPath), 'evidence-cache.db');
  const bounds = resolveEvidenceBounds(env);
  // A workspace that opted in (RENOR_EVIDENCE_OPTIN, see optin.ts) reaches Ollama Cloud with the key file's key
  // alone, on gemma4:31b, and spends a daily allowance of calls. Unset, this is the resolver it always was.
  const optin = resolveEvidenceOptin(env);
  const { baseUrl, keys } = resolveEvidenceProvider(env);
  // Coverage knob (RENOR_EVIDENCE_SESSIONS). Default 20 matches the
  // promotion-grade full-500 arm. One model call per uncached search,
  // regardless of session count; explicit values remain bounded.
  // A value that floors below 1 is treated as UNSET, not as "0 sessions". A
  // fractional setting is finite and positive, so a bare `> 0` test let it
  // through and `Math.floor` turned it into 0 — and 0 is not a silent no-op:
  // `loadEvidenceSessionsFromVault` rejects it (`maxSessions must be > 0`),
  // which the `evidence` MCP tool surfaces as a thrown error and the search path
  // swallows as `extractor-error`. Floor first, then require >= 1.
  const requested = Number(env.RENOR_EVIDENCE_SESSIONS ?? '');
  const requestedSessions = Number.isFinite(requested) ? Math.floor(requested) : Number.NaN;
  const maxSessions = Number.isFinite(requestedSessions) && requestedSessions >= 1
    ? Math.min(requestedSessions, 50)
    : MAX_EVIDENCE_SESSIONS;
  let chat: EvidenceChat | undefined;
  if (optin) {
    const optinKey = optinEndpointAllowed(baseUrl) ? readOptinKey(optin.keyFile) : null;
    if (optinKey) {
      const dailyCap = optin.dailyCap;
      // The allowance is spent per HTTP attempt (a retried 429 or 5xx is another request to the provider), so it
      // sits inside the transport rather than around it.
      chat = createOllamaChat({
        keys: [optinKey],
        beforeAttempt: dailyBudgetGate(() => new EvidenceDailyBudget(cachePath, dailyCap)),
      });
    }
  } else if (keys.length > 0) {
    chat = createOllamaChat({ baseUrl, keys });
  }
  return {
    mode,
    // The opt-in is the gemma4:31b decision: a stray RENOR_EVIDENCE_MODEL does not change what the privacy page names.
    model: optin ? EVIDENCE_MODEL_DEFAULT : model,
    maxSessions,
    charCap: EVIDENCE_SESSION_CHAR_CAP,
    cachePath,
    ...(chat ? { chat } : {}),
    ...(optin ? { dailyCap: optin.dailyCap } : {}),
    ...(bounds.maxTokens !== undefined || bounds.reasoningEffort !== undefined ? { bounds } : {}),
  };
}

export function createEvidenceExtractor(evidence: EvidenceToolOptions): EvidenceExtractor | null {
  if (!evidence.chat) return null;
  let cache: EvidenceCache | null = null;
  if (evidence.cachePath) {
    try {
      cache = new EvidenceCache(evidence.cachePath);
    } catch (err) {
      process.stderr.write(`[evidence] cache unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return new EvidenceExtractor({ chat: evidence.chat, cache, model: evidence.model, bounds: evidence.bounds });
}
