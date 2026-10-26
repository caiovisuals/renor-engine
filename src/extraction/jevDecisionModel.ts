/**
 * Jev (TypeSafe System One) behind the DecisionModel seam, for the save path of ONE opted-in workspace.
 *
 * Off unless the workspace's own env file says so (owner decision, 21 Oct 2026: "your own workspace only, now"):
 *
 *   RENOR_JEV_OPTIN=<workspace slug>   must equal MVP_INSTANCE_ID, so an env file copied to another workspace stays off
 *   RENOR_JEV_KEY_FILE=<path>          the TypeSafe key, by its path (a file, so the env file never holds the secret)
 *
 * Both are needed, and so is MVP_MEMORY_DIR (every decision is recorded there, so a decision that cannot be recorded is not made).
 * Anything else, or a setting that does not parse, is off with one stderr line naming the setting, never a value.
 *
 * What it does, once per text about to be stored, in one request (the two questions are independent):
 *
 *   sensitivity   a credential or a personal identifier. The scanner (secretGuard.ts) has already answered and a scanner
 *                 `sensitive` stays final; this adds a second opinion. `store` is allowed only at P(store) >= 0.7, the rule
 *                 that caught 243/243 planted items at 2/200 false blocks (LEDGER block F). A block refuses the save, as the
 *                 scanner does, and nothing is redacted.
 *   capture gate  whether the text is worth saving. RECORDED ONLY: it never drops a save, because a wrong "not worth it"
 *                 loses a memory silently and the scout measured 93% recall, not 100%.
 *
 * What it never does: it reads nothing, so no read path reaches it; it sends no text that is already stored; it never owns a
 * dedupe or supersede verdict (dedupe_adjudication is the local rules, byte for byte: Jev made 16/55 wrong supersedes on real
 * pairs); and it never blocks or loses a save for any reason of its own: a timeout, an error, a bad reply or a cool-down all
 * fall back to today's local rules (the scanner has already run). Every call is recorded as numbers and labels, never text.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultDecisionModel,
  type CaptureGateDecision,
  type DecisionModel,
  type DecisionRequest,
  type DecisionResult,
} from './decision-model';

export const JEV_BASE_URL = 'https://api.typesafe.ai';
export const JEV_MODEL = 'jev-latest';
/** P(store) below this blocks (LEDGER block F: 243/243 planted items caught at 2/200 false blocks). */
export const JEV_STORE_MIN = 0.7;
/** A save never waits longer than this for Jev (the scout measured p95 about 0.3 s). */
export const JEV_TIMEOUT_MS = 1500;
/** After a failed call, saves skip Jev for this long, so an outage costs one timeout, not one per save. */
export const JEV_COOLDOWN_MS = 30_000;
/** $0.042 per million input tokens (COST-MODEL lane-Jev arm; output is free). */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

const SENSITIVITY_QUESTION = {
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

const CAPTURE_QUESTION = {
  type: 'choice' as const,
  instructions: 'What durable information about the user or their world does this user message state?',
  criteria: {
    none: 'Nothing durable: questions, small talk, opinions, transient requests.',
    fact: 'A stable attribute or circumstance.',
    event: 'Something that happened or is scheduled.',
    preference: 'A liking, dislike, habit or standing choice.',
    commitment: 'A plan or promise for future action.',
    sensitive: 'A credential or private identifier.',
  },
};

/** One call to Jev, as numbers and labels. No text, no hash of text. */
export interface JevDecisionRecord {
  v: 1;
  at: string;
  workspace: string;
  task: 'save_screen';
  /** applied: Jev answered. fallback: the local rules decided alone, and `reason` says why. */
  outcome: 'applied' | 'fallback';
  reason?: 'timeout' | 'cooldown' | 'http' | 'bad_reply' | 'error';
  /** The HTTP status, when the reason is `http`. */
  status?: number;
  sensitivity?: { choice: string; pStore: number; confidence: number; blocked: boolean };
  capture?: { choice: string; pDurable: number; confidence: number };
  latencyMs: number;
  inputTokens: number;
  costUSDCents: number;
  chars: number;
}

export interface JevOptions {
  workspace: string;
  apiKey: string;
  /** Called for every call, applied or not. Must not throw into the caller (the model guards it anyway). */
  record: (entry: JevDecisionRecord) => void;
  /** Whether the record can be written right now. Asked before any text is sent: false means Jev is not asked at all. */
  canRecord: () => boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cooldownMs?: number;
  now?: () => number;
  /** What decides when Jev does not: today's local rules. */
  local?: DecisionModel;
}

type ChoiceAnswer = { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> };

function asChoice(answer: unknown): ChoiceAnswer | null {
  const a = answer as Partial<ChoiceAnswer> | undefined;
  return a && a.type === 'choice' && typeof a.choice === 'string' ? (a as ChoiceAnswer) : null;
}

function probability(answer: ChoiceAnswer, label: string): number {
  const p = answer.probabilities?.[label];
  if (typeof p === 'number' && p >= 0 && p <= 1) return p;
  // No distribution in the reply: the chosen label gets its confidence, every other label gets nothing.
  return answer.choice === label ? Math.max(0, Math.min(1, answer.confidence ?? 0)) : 0;
}

class JevFallback extends Error {
  constructor(readonly reason: NonNullable<JevDecisionRecord['reason']>, readonly status?: number) {
    super(reason);
  }
}

export class JevDecisionModel implements DecisionModel {
  private readonly local: DecisionModel;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private coolUntil = 0;

  constructor(private readonly opts: JevOptions) {
    this.local = opts.local ?? defaultDecisionModel();
    this.baseUrl = (opts.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
    this.cooldownMs = opts.cooldownMs ?? JEV_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Never throws. Dedupe and note classification are the local rules, whatever Jev would say. */
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    // Resolve the local decision before branching so every fallback below has the concrete
    // DecisionResult promised by this adapter, rather than its nested asynchronous form.
    const fallback = await this.local.decide(request);
    if (request.task !== 'capture_gate') return fallback;
    const text = request.text;
    if (!text.trim()) return fallback;

    const started = this.now();
    if (started < this.coolUntil) {
      this.record({ outcome: 'fallback', reason: 'cooldown', latencyMs: 0, inputTokens: 0, chars: text.length });
      return fallback;
    }
    // A decision that cannot be recorded is not made: no text leaves the machine without its local record.
    if (!this.canRecord()) return fallback;
    try {
      const call = await this.call(text);
      const sensitivity = asChoice(call.answers.sensitivity);
      const capture = asChoice(call.answers.capture_gate);
      if (!sensitivity) throw new JevFallback('bad_reply');
      const pStore = probability(sensitivity, 'store');
      const blocked = pStore < JEV_STORE_MIN;
      const inputTokens = call.inputTokens;
      const costUSDCents = (inputTokens * JEV_INPUT_USD_PER_MTOK) / 1_000_000 * 100;
      const latencyMs = this.now() - started;
      this.record({
        outcome: 'applied', latencyMs, inputTokens, costUSDCents, chars: text.length,
        sensitivity: { choice: sensitivity.choice, pStore, confidence: sensitivity.confidence ?? 0, blocked },
        ...(capture ? { capture: { choice: capture.choice, pDurable: 1 - probability(capture, 'none'), confidence: capture.confidence ?? 0 } } : {}),
      });
      if (!blocked) return fallback;
      // Refused like a scanner hit: the guard reads `sensitive` and refuses the save. `redact` is a refusal too (nothing is altered).
      const verdict: DecisionResult = { task: 'capture_gate', decision: 'sensitive' as CaptureGateDecision, confidence: 1 - pStore, latencyMs, costUSDCents };
      return verdict;
    } catch (err) {
      this.coolUntil = this.now() + this.cooldownMs;
      const known = err instanceof JevFallback ? err : null;
      this.record({
        outcome: 'fallback', reason: known?.reason ?? 'error', ...(known?.status !== undefined ? { status: known.status } : {}),
        latencyMs: this.now() - started, inputTokens: 0, chars: text.length,
      });
      return fallback;
    }
  }

  private async call(text: string): Promise<{ answers: Record<string, unknown>; inputTokens: number }> {
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ model: JEV_MODEL, state: text, questions: { sensitivity: SENSITIVITY_QUESTION, capture_gate: CAPTURE_QUESTION } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new JevFallback(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error');
    }
    if (!res.ok) throw new JevFallback('http', res.status);
    let json: { answers?: Record<string, unknown>; usage?: { input_tokens?: number } };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new JevFallback(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'bad_reply');
    }
    if (!json || typeof json.answers !== 'object' || json.answers === null) throw new JevFallback('bad_reply');
    return { answers: json.answers, inputTokens: Number.isFinite(json.usage?.input_tokens) ? Number(json.usage?.input_tokens) : 0 };
  }

  private canRecord(): boolean {
    try {
      return this.opts.canRecord() === true;
    } catch {
      return false;
    }
  }

  private record(partial: Omit<JevDecisionRecord, 'v' | 'at' | 'workspace' | 'task' | 'costUSDCents'> & { costUSDCents?: number }): void {
    try {
      this.opts.record({
        v: 1, at: new Date(this.now()).toISOString(), workspace: this.opts.workspace, task: 'save_screen', costUSDCents: 0, ...partial,
      });
    } catch { /* a log that cannot be written never costs a save */ }
  }
}

export interface JevOptin {
  workspace: string;
  keyFile: string;
  memoryDir: string;
}

const toldOff = new Set<string>();

/** null when the workspace has not opted in or the setting cannot be honoured; says why on stderr, never a value. */
export function resolveJevOptin(env: NodeJS.ProcessEnv = process.env): JevOptin | null {
  const workspace = (env.RENOR_JEV_OPTIN ?? '').trim().toLowerCase();
  if (workspace === '') return null;
  const off = (why: string): null => {
    if (!toldOff.has(why)) {
      toldOff.add(why);
      process.stderr.write(`[jev] RENOR_JEV_OPTIN is set but ${why}: the save screen stays off\n`);
    }
    return null;
  };
  if ((env.MVP_INSTANCE_ID ?? '').trim().toLowerCase() !== workspace) return off('it does not name this workspace (MVP_INSTANCE_ID)');
  const keyFile = (env.RENOR_JEV_KEY_FILE ?? '').trim();
  if (!path.isAbsolute(keyFile)) return off('RENOR_JEV_KEY_FILE is not an absolute path');
  const memoryDir = (env.MVP_MEMORY_DIR ?? '').trim();
  if (!path.isAbsolute(memoryDir)) return off('MVP_MEMORY_DIR is not an absolute path, so decisions could not be recorded');
  return { workspace, keyFile, memoryDir };
}

/** The key in the file: one token. Null (with one stderr line naming the path, never the content) when it cannot be used. */
export function readJevKey(keyFile: string): string | null {
  try {
    const st = fs.statSync(keyFile);
    if (!st.isFile()) throw new Error('not a regular file');
    // A service credential readable by anyone but its owner is not used (the contract: mode 0600, the tenant's account only).
    if ((st.mode & 0o077) !== 0) throw new Error('readable or writable by group or others; chmod 600 it');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('not owned by this account');
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (key === '' || /\s/.test(key)) throw new Error('empty or not a single token');
    return key;
  } catch (err) {
    process.stderr.write(`[jev] the key file ${keyFile} cannot be used (${err instanceof Error ? err.message.replace(keyFile, 'it') : 'unreadable'}): the save screen stays off\n`);
    return null;
  }
}

/** Where a workspace's Jev decisions are kept: beside its index, which the walker, the watcher and release packing already skip. */
export function jevDecisionLogPath(memoryDir: string): string {
  return path.join(path.resolve(memoryDir), '.memory-index', 'jev-decisions.jsonl');
}

/**
 * One JSON line per call, owner-only. `ready` opens the log for append before any text is sent, so a log that cannot be
 * written turns the screen off for that save (Jev is not asked; the local rules decide). Told once on stderr; never reaches the save.
 */
export function jevDecisionLog(memoryDir: string): { ready: () => boolean; write: (entry: JevDecisionRecord) => void } {
  const file = jevDecisionLogPath(memoryDir);
  let told = false;
  const tell = (err: unknown): void => {
    if (told) return;
    told = true;
    process.stderr.write(`[jev] a decision could not be recorded (${err instanceof Error ? err.name : 'error'}): Jev is not asked, saves go on\n`);
  };
  return {
    ready: () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.closeSync(fs.openSync(file, 'a', 0o600));
        return true;
      } catch (err) {
        tell(err);
        return false;
      }
    },
    write: entry => {
      try {
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      } catch (err) {
        tell(err);
      }
    },
  };
}

let cached: { signature: string; model: JevDecisionModel | null } | undefined;

/**
 * The model the save path uses, or null (the common case) when this workspace has not opted in. One instance per process, so
 * its cool-down is shared by every save; rebuilt only when the settings change.
 */
export function saveDecisionModel(env: NodeJS.ProcessEnv = process.env): DecisionModel | null {
  const optin = resolveJevOptin(env);
  if (!optin) return null;
  const signature = `${optin.workspace}\0${optin.keyFile}\0${optin.memoryDir}`;
  if (cached?.signature === signature) return cached.model;
  const key = readJevKey(optin.keyFile);
  const log = jevDecisionLog(optin.memoryDir);
  const model = key ? new JevDecisionModel({ workspace: optin.workspace, apiKey: key, record: log.write, canRecord: log.ready }) : null;
  cached = { signature, model };
  return model;
}
