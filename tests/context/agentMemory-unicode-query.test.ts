import Database from '../../src/db/sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/schema';
import { indexFactTerms } from '../../src/memory/factTerms';
import { currentLifecycleFacts } from '../../src/mvp/agentMemory';

function dbWithFacts(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-09-01')`).run();
  db.prepare(`INSERT INTO entities (id, type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES (1, 'concept', 'Rowan', '[]', '_mcp_', 1.0, '2026-09-01')`).run();
  const insert = db.prepare(
    `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, scope)
     VALUES (1, ?, ?, '_mcp_', 1.0, ?, NULL, ?, 'global') RETURNING id`,
  );
  for (const [predicate, object, validFrom] of [
    ['lives_in', '東京', '2026-09-01'],
    ['visited', '大阪', '2026-08-01'],
    ['speaks', 'Portuguese', '2026-07-01'],
  ]) {
    const { id } = insert.get(predicate, object, validFrom, validFrom) as { id: number };
    indexFactTerms(db, id, 'global', { subject: 'Rowan', predicate, object });
  }
  return db;
}

describe('currentLifecycleFacts Unicode query matching', () => {
  it('matches lifecycle facts whose identity-bearing query terms are non-Latin', () => {
    const db = dbWithFacts();
    try {
      expect(currentLifecycleFacts(db, '東京', undefined, 12).map((fact) => fact.object)).toEqual(['東京']);
      expect(currentLifecycleFacts(db, '大阪', undefined, 12).map((fact) => fact.object)).toEqual(['大阪']);
    } finally {
      db.close();
    }
  });

  it('preserves existing Latin matching', () => {
    const db = dbWithFacts();
    try {
      expect(currentLifecycleFacts(db, 'Portuguese', undefined, 12).map((fact) => fact.object)).toEqual(['Portuguese']);
    } finally {
      db.close();
    }
  });
});
