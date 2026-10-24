import fs from 'node:fs';
import Database from '../db/sqlite';
import { openDb } from '../db/client';
import { isOllamaCloudEndpoint } from './keyPool';

/**
 * The evidence extractor as a per-workspace opt-in (owner decision, 13 Oct 2026).
 *
 * A workspace runs the extractor on Ollama Cloud only when its own env file says so:
 *
 *   RENOR_EVIDENCE_OPTIN=ollama        the switch; unset or blank is off, and then nothing here applies
 *   RENOR_EVIDENCE_KEY_FILE=<path>     the fleet key, by its path (a file, so the env file never holds the secret)
 *   RENOR_EVIDENCE_DAILY_CAP=<n>       HTTP requests to the model per UTC day for this workspace (default 50)
 *
 * With the switch on, the key comes from the key file and nowhere else (no OLLAMA_* name, no
 * RENOR_EVIDENCE_API_KEY), the endpoint is Ollama Cloud and the model is gemma4:31b; a base URL naming another
 * issuer is refused rather than sent the Ollama key. The operator turns it on and off with
 * scripts/alpha/set-tenant-evidence.sh. Values are never logged: only the key file's path and the reason a
 * setting was refused.
 */
export const EVIDENCE_OPTIN_VALUE = 'ollama';

/**
 * HTTP requests to the model a workspace may make per UTC day (a retry of a 429 or 5xx is one more). Sized for the shared account, not for the user: gemma4:31b
 * reads about 9,300 tokens and writes about 190 per call (provider-terms report, 2026-10-03), so 50 calls are
 * about 0.47M tokens, about 0.07 USD at list price, and 350 calls a week. Ollama publishes its limits as
 * usage, not as calls, and does not state the weekly figure, so this stays well under any plausible share and
 * is a setting (RENOR_EVIDENCE_DAILY_CAP, set per workspace by the ops command). A search answered from the
 * cache costs none of it.
 */
export const EVIDENCE_DAILY_CAP_DEFAULT = 50;
export const EVIDENCE_DAILY_CAP_MAX = 10_000;

export interface EvidenceOptin {
  keyFile: string;
  dailyCap: number;
}

/** null when the workspace has not opted in. A value that does not parse throws, like an invalid RENOR_EVIDENCE_MODE. */
export function resolveEvidenceOptin(env: NodeJS.ProcessEnv = process.env): EvidenceOptin | null {
  const raw = (env.RENOR_EVIDENCE_OPTIN ?? '').trim().toLowerCase();
  if (raw === '') return null;
  if (raw !== EVIDENCE_OPTIN_VALUE) {
    throw new Error(`Invalid RENOR_EVIDENCE_OPTIN "${raw}": must be ${EVIDENCE_OPTIN_VALUE} (or unset)`);
  }
  const keyFile = (env.RENOR_EVIDENCE_KEY_FILE ?? '').trim();
  const capText = (env.RENOR_EVIDENCE_DAILY_CAP ?? '').trim();
  let dailyCap = EVIDENCE_DAILY_CAP_DEFAULT;
  if (capText !== '') {
    const value = Number(capText);
    if (!/^[0-9]+$/.test(capText) || !Number.isSafeInteger(value) || value > EVIDENCE_DAILY_CAP_MAX) {
      throw new Error(`Invalid RENOR_EVIDENCE_DAILY_CAP "${capText}": must be a whole number from 0 to ${EVIDENCE_DAILY_CAP_MAX}`);
    }
    dailyCap = value;
  }
  return { keyFile, dailyCap };
}

/**
 * The key in the key file: one line, trimmed. Null (with one stderr line naming the path, never the content) when
 * the setting names no file, the file is not a regular file, or it holds nothing usable.
 */
export function readOptinKey(keyFile: string): string | null {
  if (!keyFile.startsWith('/')) {
    process.stderr.write('[evidence] opt-in is on but RENOR_EVIDENCE_KEY_FILE is not an absolute path: the extractor stays off\n');
    return null;
  }
  try {
    if (!fs.statSync(keyFile).isFile()) throw new Error('not a regular file');
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (key === '' || /\s/.test(key)) throw new Error('empty or not a single token');
    return key;
  } catch (err) {
    process.stderr.write(`[evidence] opt-in is on but the key file ${keyFile} cannot be used (${err instanceof Error ? err.message.replace(keyFile, 'it') : 'unreadable'}): the extractor stays off\n`);
    return null;
  }
}

/** Opt-in sends the Ollama key, so it only ever goes to Ollama Cloud. */
export function optinEndpointAllowed(baseUrl: string | undefined): boolean {
  if (isOllamaCloudEndpoint(baseUrl)) return true;
  process.stderr.write('[evidence] opt-in is on but RENOR_EVIDENCE_BASE_URL is not Ollama Cloud: the extractor stays off\n');
  return false;
}

/** The workspace used its allowance for today (or its allowance could not be read, which is treated the same). */
export class EvidenceCapError extends Error {
  constructor(message = 'the daily allowance of evidence-model calls is used') {
    super(message);
    this.name = 'EvidenceCapError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 14;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Model calls counted per UTC day in the workspace's own evidence-cache file, so a restart does not hand back
 * the day's allowance. `take` reserves one call before each HTTP attempt and is atomic across processes (one write
 * transaction), so a concurrent search can never overshoot by more than a call already in flight and refused.
 */
export class EvidenceDailyBudget {
  private readonly db: Database.Database;
  private readonly takeStmt: Database.Statement;
  private readonly usedStmt: Database.Statement;
  private readonly sweepStmt: Database.Statement;

  constructor(dbPath: string, readonly limit: number, private readonly now: () => number = Date.now) {
    this.db = openDb(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 10000');
    this.db.exec('CREATE TABLE IF NOT EXISTS evidence_daily_calls (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    this.takeStmt = this.db.prepare(
      `INSERT INTO evidence_daily_calls (day, calls) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?`,
    );
    this.usedStmt = this.db.prepare('SELECT calls FROM evidence_daily_calls WHERE day = ?');
    this.sweepStmt = this.db.prepare('DELETE FROM evidence_daily_calls WHERE day < ?');
  }

  /** Reserve one call for today; false when the day's allowance is spent. */
  take(): boolean {
    const now = this.now();
    const day = utcDay(now);
    if (this.limit <= 0) return false;
    return this.db.transaction(() => {
      this.sweepStmt.run(utcDay(now - KEEP_DAYS * DAY_MS));
      return this.takeStmt.run(day, this.limit).changes > 0;
    }).immediate();
  }

  used(): number {
    return (this.usedStmt.get(utcDay(this.now())) as { calls: number } | undefined)?.calls ?? 0;
  }
}

/**
 * A `beforeAttempt` for createOllamaChat that reserves one call per HTTP attempt, retries included, and throws
 * EvidenceCapError when none is left. A budget that cannot be opened refuses every attempt: a shared provider
 * limit is not worth risking on a counter that is not there.
 */
export function dailyBudgetGate(open: () => EvidenceDailyBudget): () => void {
  let budget: EvidenceDailyBudget | null | undefined;
  return () => {
    if (budget === undefined) {
      try {
        budget = open();
      } catch (err) {
        process.stderr.write(`[evidence] the daily call counter cannot be opened (${err instanceof Error ? err.message : String(err)}): the extractor stays off\n`);
        budget = null;
      }
    }
    if (!budget) throw new EvidenceCapError('the daily call counter is unavailable');
    if (!budget.take()) throw new EvidenceCapError();
  };
}
