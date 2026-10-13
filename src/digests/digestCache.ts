import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Content-addressed store for per-note digests (RENOR_DIGESTS, src/digests/digests.ts).
 *
 *   digest key = sha256(schema \0 model \0 reasoning effort \0 sha256(prompt template) \0 input version \0 note_hash)
 *
 * A note's digest is keyed by the hash of the note's file (the index's `note_hash`), so an unchanged note is never
 * digested twice, an edited note gets a new digest, and a changed prompt, model or input rule re-digests every note.
 * An empty digest (the note states nothing about the user's life) is stored too, so it is not asked for again.
 *
 * The item vectors live beside the digest, one set per embedding space (provider, model, dimensions): a digest
 * outlives a change of embedding model, only its vectors are rebuilt. A vector from another space is never read.
 *
 * Design follows src/router/routerCache.ts: SQLite + WAL + busy_timeout=10000 + INSERT OR IGNORE.
 */
export const DIGEST_CACHE_SCHEMA_VERSION = 'note-digest-v1';

/** One thing the user said, as the digest keeps it. Rendered like an evidence-table row (src/evidence/secondPass.ts). */
export interface DigestItem {
  item: string;
  action: string;
  amount: string;
  date: string;
  /** The turn or section the statement comes from (provenance), e.g. "Turn 3"; "" when the model did not say. */
  source: string;
}

export interface CachedDigest {
  items: DigestItem[];
  model: string;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export class DigestCache {
  private readonly db: Database.Database;
  private readonly getDigestStmt: Database.Statement;
  private readonly putDigestStmt: Database.Statement;
  private readonly getVectorsStmt: Database.Statement;
  private readonly putVectorsStmt: Database.Statement;

  constructor(dbPath: string, opts: { readonly?: boolean } = {}) {
    if (!opts.readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, opts.readonly ? { readonly: true, fileMustExist: true } : undefined);
    if (!opts.readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_digests (
          cache_key TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          model TEXT NOT NULL,
          note_hash TEXT NOT NULL,
          items_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS digest_vectors (
          cache_key TEXT NOT NULL,
          space TEXT NOT NULL,
          dims INTEGER NOT NULL,
          vectors BLOB NOT NULL,
          PRIMARY KEY (cache_key, space)
        );
        -- What the background worker (src/digests/worker.ts) spent per UTC day: the per-workspace cost guard reads it.
        CREATE TABLE IF NOT EXISTS digest_spend (
          day TEXT PRIMARY KEY,
          calls INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          micro_usd INTEGER NOT NULL DEFAULT 0
        );
      `);
    }
    this.db.pragma('busy_timeout = 10000');
    this.getDigestStmt = this.db.prepare('SELECT items_json, model FROM note_digests WHERE cache_key = ?');
    this.putDigestStmt = this.db.prepare(
      `INSERT OR IGNORE INTO note_digests (cache_key, schema_version, model, note_hash, items_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.getVectorsStmt = this.db.prepare('SELECT dims, vectors FROM digest_vectors WHERE cache_key = ? AND space = ?');
    this.putVectorsStmt = this.db.prepare(
      'INSERT OR IGNORE INTO digest_vectors (cache_key, space, dims, vectors) VALUES (?, ?, ?, ?)',
    );
  }

  static digestKey(model: string, effort: string, promptTemplate: string, inputVersion: string, noteHash: string): string {
    return sha256([DIGEST_CACHE_SCHEMA_VERSION, model, effort, sha256(promptTemplate), inputVersion, noteHash].join('\0'));
  }

  getDigest(key: string): CachedDigest | null {
    const row = this.getDigestStmt.get(key) as { items_json: string; model: string } | undefined;
    if (!row) return null;
    return { items: JSON.parse(row.items_json) as DigestItem[], model: row.model };
  }

  putDigest(key: string, noteHash: string, entry: CachedDigest): void {
    this.putDigestStmt.run(
      key, DIGEST_CACHE_SCHEMA_VERSION, entry.model, noteHash, JSON.stringify(entry.items), new Date().toISOString(),
    );
  }

  /** The item vectors of one digest in one embedding space, or null when they are absent or do not match the items. */
  getVectors(key: string, space: string, count: number): number[][] | null {
    const row = this.getVectorsStmt.get(key, space) as { dims: number; vectors: Buffer } | undefined;
    if (!row || row.dims <= 0 || row.vectors.length !== count * row.dims * 4) return null;
    const floats = new Float32Array(row.vectors.buffer.slice(row.vectors.byteOffset, row.vectors.byteOffset + row.vectors.length));
    const out: number[][] = [];
    for (let i = 0; i < count; i++) out.push(Array.from(floats.subarray(i * row.dims, (i + 1) * row.dims)));
    return out;
  }

  putVectors(key: string, space: string, vectors: number[][]): void {
    if (vectors.length === 0) return;
    const dims = vectors[0].length;
    const floats = new Float32Array(vectors.length * dims);
    vectors.forEach((vector, i) => floats.set(vector, i * dims));
    this.putVectorsStmt.run(key, space, dims, Buffer.from(floats.buffer));
  }

  /**
   * Keep only the digests of the notes whose file hash is in `noteHashes`, and the vectors that go with them: a digest
   * of text a note no longer holds (it was edited, forgotten, or its file is gone) is derived from content the user
   * removed, so it is not kept. Only the workspace's own cache calls this: an eval cache is shared by many vaults.
   * Returns how many digests it removed.
   */
  retainOnly(noteHashes: ReadonlySet<string>): number {
    const rows = this.db.prepare('SELECT cache_key, note_hash FROM note_digests').all() as Array<{ cache_key: string; note_hash: string }>;
    const stale = rows.filter(row => !noteHashes.has(row.note_hash));
    if (stale.length === 0) return 0;
    const dropDigest = this.db.prepare('DELETE FROM note_digests WHERE cache_key = ?');
    const dropVectors = this.db.prepare('DELETE FROM digest_vectors WHERE cache_key = ?');
    this.db.transaction(() => {
      for (const row of stale) {
        dropVectors.run(row.cache_key);
        dropDigest.run(row.cache_key);
      }
    })();
    return stale.length;
  }

  /** What the worker has spent on `day` (a UTC `YYYY-MM-DD`), in USD. */
  spentUsd(day: string): number {
    const row = this.db.prepare('SELECT micro_usd FROM digest_spend WHERE day = ?').get(day) as { micro_usd: number } | undefined;
    return (row?.micro_usd ?? 0) / 1e6;
  }

  addSpend(day: string, promptTokens: number, completionTokens: number, usd: number): void {
    this.db.prepare(
      `INSERT INTO digest_spend (day, calls, prompt_tokens, completion_tokens, micro_usd) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1, prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens, micro_usd = micro_usd + excluded.micro_usd`,
    ).run(day, Math.max(0, Math.round(promptTokens)), Math.max(0, Math.round(completionTokens)), Math.max(0, Math.round(usd * 1e6)));
  }

  /** Spend rows older than the newest `keepDays` days are dropped, so the table does not grow without bound. */
  pruneSpend(keepDays: number): void {
    this.db.prepare('DELETE FROM digest_spend WHERE day NOT IN (SELECT day FROM digest_spend ORDER BY day DESC LIMIT ?)').run(keepDays);
  }

  close(): void {
    this.db.close();
  }
}
