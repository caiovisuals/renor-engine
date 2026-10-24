import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from '../db/sqlite';

/**
 * Content-addressed cache for the session router (RENOR_SESSION_ROUTER, src/router/sessionRouter.ts): the
 * per-note summaries the router reads, and the router's own answers.
 *
 *   summary key = sha256(schema \0 'summary' \0 model \0 sha256(summary prompt template) \0 note_hash)
 *   route key   = sha256(schema \0 'route'   \0 model \0 exact rendered routing prompt)
 *
 * A note's summary is keyed by the hash of the note's file (the index's `note_hash`), so an edited note gets a new
 * summary and an unchanged one is never paid for twice; a changed prompt template invalidates every summary.
 * A routing answer is keyed by the exact prompt, which already holds the question and every node it was shown.
 * Only answers that parsed are stored (as in the evidence cache, a malformed response is never cached), so a
 * replay is always a usable answer.
 *
 * Design follows src/evidence/evidenceCache.ts: SQLite + WAL + busy_timeout=10000 + INSERT OR IGNORE.
 */
export const ROUTER_CACHE_SCHEMA_VERSION = 'session-router-v1';

export interface CachedSummary {
  title: string;
  summary: string;
  model: string;
}

export interface CachedRoute {
  nodeIds: string[];
  thinking: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Latency of the live call that produced this answer (a replay itself costs no model time). */
  latencyMs: number;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export class RouterCache {
  private readonly db: Database.Database;
  private readonly getSummaryStmt: Database.Statement;
  private readonly putSummaryStmt: Database.Statement;
  private readonly getRouteStmt: Database.Statement;
  private readonly putRouteStmt: Database.Statement;
  private readonly touchRouteStmt: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_summaries (
        cache_key TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        model TEXT NOT NULL,
        note_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_answers (
        cache_key TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        model TEXT NOT NULL,
        node_ids_json TEXT NOT NULL,
        thinking TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.getSummaryStmt = this.db.prepare('SELECT title, summary, model FROM note_summaries WHERE cache_key = ?');
    this.putSummaryStmt = this.db.prepare(
      `INSERT OR IGNORE INTO note_summaries (cache_key, schema_version, model, note_hash, title, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getRouteStmt = this.db.prepare(
      'SELECT node_ids_json, thinking, model, prompt_tokens, completion_tokens, latency_ms FROM router_answers WHERE cache_key = ?',
    );
    this.putRouteStmt = this.db.prepare(
      `INSERT OR IGNORE INTO router_answers
       (cache_key, schema_version, model, node_ids_json, thinking, prompt_tokens, completion_tokens, latency_ms, created_at, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    this.touchRouteStmt = this.db.prepare('UPDATE router_answers SET hits = hits + 1 WHERE cache_key = ?');
  }

  static summaryKey(model: string, promptTemplate: string, noteHash: string): string {
    return sha256(`${ROUTER_CACHE_SCHEMA_VERSION}\0summary\0${model}\0${sha256(promptTemplate)}\0${noteHash}`);
  }

  static routeKey(model: string, prompt: string): string {
    return sha256(`${ROUTER_CACHE_SCHEMA_VERSION}\0route\0${model}\0${prompt}`);
  }

  getSummary(key: string): CachedSummary | null {
    const row = this.getSummaryStmt.get(key) as CachedSummary | undefined;
    return row ?? null;
  }

  putSummary(key: string, noteHash: string, entry: CachedSummary): void {
    this.putSummaryStmt.run(key, ROUTER_CACHE_SCHEMA_VERSION, entry.model, noteHash, entry.title, entry.summary, new Date().toISOString());
  }

  getRoute(key: string): CachedRoute | null {
    const row = this.getRouteStmt.get(key) as {
      node_ids_json: string; thinking: string; model: string;
      prompt_tokens: number; completion_tokens: number; latency_ms: number;
    } | undefined;
    if (!row) return null;
    this.touchRouteStmt.run(key);
    return {
      nodeIds: JSON.parse(row.node_ids_json) as string[],
      thinking: row.thinking,
      model: row.model,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      latencyMs: row.latency_ms,
    };
  }

  putRoute(key: string, entry: CachedRoute): void {
    this.putRouteStmt.run(
      key, ROUTER_CACHE_SCHEMA_VERSION, entry.model, JSON.stringify(entry.nodeIds), entry.thinking,
      entry.promptTokens, entry.completionTokens, entry.latencyMs, new Date().toISOString(),
    );
  }

  close(): void {
    this.db.close();
  }
}
