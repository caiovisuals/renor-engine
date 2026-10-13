import type Database from 'better-sqlite3';
import { ensureFactTerms } from '../../src/memory/factTerms';

export interface SeedFact {
  subject: string;
  predicate: string;
  object: string;
  scope?: string;
}

/** Milliseconds past 2099-01-01: each seeded fact is newer than every earlier one, and than any fact a test saves. */
let clock = 0;
const at = (ms: number) => new Date(Date.UTC(2099, 0, 1, 0, 0, 0, ms)).toISOString();

/**
 * Adds `count` current lifecycle facts built by `make(i)`, each newer than the ones before (they are
 * dated 2099, so also newer than anything a test saves with `remember`): the way a heavy user's table
 * looks to a fact saved long ago. The caller keeps (subject, predicate, scope) unique.
 *
 * They are written straight into the facts table, ledger-less, so a test can build a table of
 * thousands in about a second; then `ensureFactTerms` indexes them, which is also how a database
 * from before the term index is repaired.
 */
export function seedFacts(db: Database.Database, count: number, make: (i: number) => SeedFact): void {
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?)`).run(at(0));
    const entity = db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`,
    );
    const fact = db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, scope)
       VALUES (?, ?, ?, '_mcp_', 1.0, ?, NULL, ?, ?)`,
    );
    const entityIds = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const { subject, predicate, object, scope } = make(i);
      const when = at(++clock);
      let subjectId = entityIds.get(subject);
      if (subjectId === undefined) entityIds.set(subject, subjectId = (entity.get(subject, when) as { id: number }).id);
      fact.run(subjectId, predicate, object, when, when, scope ?? 'global');
    }
  })();
  ensureFactTerms(db);
}

/**
 * `count` unrelated current facts, every one of them having the words `seeded`, `value` and `attr`:
 * a hundred predicates under each seeded subject, one value per fact.
 */
export function seedNewerFacts(db: Database.Database, count: number): void {
  seedFacts(db, count, i => ({
    subject: `Seeded group ${Math.floor(i / 100)}`,
    predicate: `attr_${i % 100}`,
    object: `seeded value ${i}`,
  }));
}
