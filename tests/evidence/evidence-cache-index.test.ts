import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../src/db/sqlite';
import { EvidenceCache } from '../../src/evidence/evidenceCache';

describe('EvidenceCache indexes', () => {
  it('removes the legacy unused question index while preserving cache-key lookup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-cache-index-'));
    const dbPath = path.join(dir, 'evidence-cache.db');

    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE evidence_cache (
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
        );
        CREATE INDEX idx_evidence_cache_question ON evidence_cache(question);
      `);
      legacy.close();

      const cache = new EvidenceCache(dbPath);
      const key = EvidenceCache.computeKey('gemma4:31b', 'prompt');
      cache.put(key, {
        items: [{ item: 'a' }],
        sessions: [{ stem: '/v/a.md', chars: 10 }],
        model: 'gemma4:31b',
        question: 'q',
        promptTokens: 10,
        completionTokens: 2,
        createdAt: '2026-09-20T00:00:00.000Z',
      });
      expect(cache.get(key)?.items).toEqual([{ item: 'a' }]);
      cache.close();

      const inspect = new Database(dbPath, { readonly: true });
      const indexes = inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence_cache'").all() as Array<{ name: string }>;
      inspect.close();
      expect(indexes.map(row => row.name)).not.toContain('idx_evidence_cache_question');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
