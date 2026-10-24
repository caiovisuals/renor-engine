import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from '../db/sqlite';

/**
 * Content-addressed cache for the H10 second-pass evidence extraction.
 *
 * Key = sha256(EVIDENCE_SCHEMA_VERSION \0 model \0 prompt), where prompt is the
 * exact rendered extractor prompt; a `bounds:` segment precedes the prompt only
 * when RENOR_EVIDENCE_MAX_TOKENS or RENOR_EVIDENCE_REASONING_EFFORT is set. Any
 * question, session-text, selection, or prompt-template change invalidates only
 * the affected entries. The same question over unchanged session content
 * replays for zero model cost.
 *
 * Stores parsed items (the extractor's JSON must parse before an entry is
 * written — fail-fast extraction never caches a malformed response). A failed
 * extraction is remembered apart from the tables, under the same key, for
 * EVIDENCE_FAILURE_TTL_MS (table evidence_failures).
 *
 * Design follows the eval cache (src/eval/evalCache.ts): SQLite + WAL +
 * busy_timeout=10000 + INSERT OR IGNORE.
 */
export const EVIDENCE_SCHEMA_VERSION = 'evidence-v1';

/**
 * How long a failed extraction is remembered: 24 hours.
 *
 * Measured 2026-10-03 (GLM-5.3-Flash on Nebius, dev100): 39% of extraction
 * spend went to replies that reasoned to the provider's 8,192-token cap and
 * returned no content. Only tables were cached, so every repeat of such a
 * search paid for its three attempts again, and waited minutes for them.
 *
 * Only a reply is remembered: the model answered the last attempt, and its
 * answer is not a table (secondPass.ts EvidenceReplyError). An error before any
 * reply (a 429, a 5xx, a timeout, a refused request, no connection) says
 * nothing about the request and is never remembered: the next search asks
 * again. The key is the table's (model, bounds, exact prompt), so anything that
 * could change the outcome by itself (other notes, another question, model or
 * bound) is a new key and is asked at once. What a day gives up is luck, the
 * same request answered better next time, for at most one paid failure per
 * request per day. DELETE FROM evidence_failures forgets them all at once.
 */
export const EVIDENCE_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EvidenceFailureEntry {
  model: string;
  /** The error the failed search reported, as it reported it. */
  error: string;
  /** When the extraction failed, in milliseconds since the epoch. */
  failedAt: number;
}

export interface EvidenceCacheEntry {
  items: Array<{ item: string; action?: string; amount?: string; date?: string }>;
  sessions: Array<{ stem: string; date?: string; chars: number }>;
  model: string;
  question: string;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
}

export interface EvidenceCacheStats {
  entries: number;
  hits: number;
  promptTokens: number;
  completionTokens: number;
}

export class EvidenceCache {
  private db: Database.Database;
  private readonly lookupStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly touchStmt: Database.Statement;
  private readonly failureLookupStmt: Database.Statement;
  private readonly failureTouchStmt: Database.Statement;
  private readonly failureSweepStmt: Database.Statement;
  private readonly failurePutStmt: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_cache (
        cache_key TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        model TEXT NOT NULL,
        question TEXT NOT NULL,
        sessions_json TEXT NOT NULL,
        items_json TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        hits INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Cache lookups are content-addressed by the cache_key primary key. Older
    // evidence-v1 databases created a secondary question index that no runtime
    // query uses; remove it so inserts do not maintain a redundant B-tree.
    this.db.exec('DROP INDEX IF EXISTS idx_evidence_cache_question');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_failures (
        cache_key TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        error TEXT NOT NULL,
        failed_at_ms INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.lookupStmt = this.db.prepare(
      'SELECT items_json, sessions_json, model, question, prompt_tokens, completion_tokens, created_at, hits FROM evidence_cache WHERE cache_key = ?'
    );
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO evidence_cache
       (cache_key, schema_version, model, question, sessions_json, items_json,
        prompt_tokens, completion_tokens, created_at, last_used_at, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    this.touchStmt = this.db.prepare(
      'UPDATE evidence_cache SET hits = hits + 1, last_used_at = ? WHERE cache_key = ?'
    );
    this.failureLookupStmt = this.db.prepare(
      'SELECT model, error, failed_at_ms FROM evidence_failures WHERE cache_key = ? AND failed_at_ms > ?'
    );
    this.failureTouchStmt = this.db.prepare('UPDATE evidence_failures SET hits = hits + 1 WHERE cache_key = ?');
    this.failureSweepStmt = this.db.prepare('DELETE FROM evidence_failures WHERE failed_at_ms <= ?');
    this.failurePutStmt = this.db.prepare(
      'INSERT OR REPLACE INTO evidence_failures (cache_key, model, error, failed_at_ms, hits) VALUES (?, ?, ?, ?, 0)'
    );
  }

  /**
   * SHA-256 key over schema version, model, any request bounds, and the exact
   * rendered prompt. With no bound set it is the legacy key, so every existing
   * entry still replays; a bound adds one segment, so a bounded arm and an
   * unbounded arm never share an entry.
   */
  static computeKey(
    model: string,
    prompt: string,
    bounds: { maxTokens?: number; reasoningEffort?: string } = {},
  ): string {
    const bound = [
      ...(bounds.maxTokens !== undefined ? [`max_tokens=${bounds.maxTokens}`] : []),
      ...(bounds.reasoningEffort !== undefined ? [`reasoning_effort=${bounds.reasoningEffort}`] : []),
    ].join(';');
    return crypto.createHash('sha256')
      .update(`${EVIDENCE_SCHEMA_VERSION}\0${model}\0${bound ? `bounds:${bound}\0` : ''}${prompt}`)
      .digest('hex');
  }

  /** Lookup. Returns null on miss. Touches hit counters on a hit. */
  get(cacheKey: string): EvidenceCacheEntry | null {
    const row = this.lookupStmt.get(cacheKey) as {
      items_json: string; sessions_json: string; model: string; question: string;
      prompt_tokens: number; completion_tokens: number; created_at: string;
    } | undefined;
    if (!row) return null;
    this.touchStmt.run(new Date().toISOString(), cacheKey);
    return {
      items: JSON.parse(row.items_json),
      sessions: JSON.parse(row.sessions_json),
      model: row.model,
      question: row.question,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      createdAt: row.created_at,
    };
  }

  /** Store a freshly extracted, already-parsed entry. Existing keys are never overwritten. */
  put(cacheKey: string, entry: EvidenceCacheEntry): void {
    this.insertStmt.run(
      cacheKey,
      EVIDENCE_SCHEMA_VERSION,
      entry.model,
      entry.question,
      JSON.stringify(entry.sessions),
      JSON.stringify(entry.items),
      entry.promptTokens,
      entry.completionTokens,
      entry.createdAt,
      entry.createdAt,
    );
  }

  /** The failure remembered under `cacheKey` less than EVIDENCE_FAILURE_TTL_MS ago, or null. Touches its hit counter. */
  getFailure(cacheKey: string): EvidenceFailureEntry | null {
    const row = this.failureLookupStmt.get(cacheKey, Date.now() - EVIDENCE_FAILURE_TTL_MS) as {
      model: string; error: string; failed_at_ms: number;
    } | undefined;
    if (!row) return null;
    this.failureTouchStmt.run(cacheKey);
    return { model: row.model, error: row.error, failedAt: row.failed_at_ms };
  }

  /** Remember a failed extraction, replacing any earlier one under the key; expired failures are dropped. */
  putFailure(cacheKey: string, entry: EvidenceFailureEntry): void {
    this.failureSweepStmt.run(entry.failedAt - EVIDENCE_FAILURE_TTL_MS);
    this.failurePutStmt.run(cacheKey, entry.model, entry.error, entry.failedAt);
  }

  stats(): EvidenceCacheStats {
    const row = this.db.prepare(
      'SELECT COUNT(*) as entries, COALESCE(SUM(hits), 0) as hits, COALESCE(SUM(prompt_tokens), 0) as promptTokens, COALESCE(SUM(completion_tokens), 0) as completionTokens FROM evidence_cache'
    ).get() as { entries: number; hits: number; promptTokens: number; completionTokens: number };
    return row;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Drop every cached extraction that read one of `stems` (note paths): a permanent deletion takes the text these rows
 * extracted from a deleted memory (memorymap/memoryMap.ts, purgeRetired). Nothing to do when the cache file or its table
 * does not exist. The cache is keyed by the exact prompt, so a dropped row is only asked again when a later search reads
 * the same files.
 */
export function dropEvidenceForStems(cachePath: string, stems: string[]): void {
  if (stems.length === 0 || !fs.existsSync(cachePath)) return;
  const db = new Database(cachePath);
  try {
    db.pragma('busy_timeout = 10000');
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evidence_cache'`).get()) return;
    const drop = db.prepare(
      `DELETE FROM evidence_cache WHERE json_valid(sessions_json) AND EXISTS (
         SELECT 1 FROM json_each(sessions_json) s WHERE json_extract(s.value, '$.stem') = ?)`,
    );
    db.transaction(() => { for (const stem of stems) drop.run(stem); })();
  } finally {
    db.close();
  }
}
