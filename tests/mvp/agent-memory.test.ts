import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema';
import { indexFactTerms } from '../../src/memory/factTerms';
import { currentLifecycleFacts, dedupeMemories } from '../../src/mvp/agentMemory';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  // Lifecycle entities belong to the synthetic `_mcp_` note, as the lifecycle writes them.
  db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-09-01T00:00:00Z')`).run();
  return db;
}

/** One current lifecycle fact, indexed the way the lifecycle indexes it when it writes the fact. */
function addFactAt(db: Database.Database, id: number, subject: string, predicate: string, object: string, validFrom: string) {
  db.prepare(`INSERT INTO entities (id, type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES (?, 'concept', ?, '[]', '_mcp_', 1.0, ?)`)
    .run(id, subject, validFrom);
  db.prepare(`
    INSERT INTO facts (id, subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, scope)
    VALUES (?, ?, ?, ?, '_mcp_', 1.0, ?, NULL, ?, 'global')
  `).run(id, id, predicate, object, validFrom, validFrom);
  indexFactTerms(db, id, 'global', { subject, predicate, object });
}

function addFact(db: Database.Database, id: number, subject: string, predicate: string, object: string) {
  addFactAt(db, id, subject, predicate, object, `2026-09-${String(id).padStart(2, '0')}T00:00:00Z`);
}

describe('currentLifecycleFacts', () => {
  it('matches whole tokens instead of incidental substrings', () => {
    const db = memoryDb();
    addFact(db, 1, 'Rowan', 'favorite_language', 'Go');
    addFact(db, 2, 'Rowan', 'uses_email', 'Google Mail');

    const results = currentLifecycleFacts(db, 'Go', undefined, 12);

    expect(results).toHaveLength(1);
    expect(results[0]?.object).toBe('Go');
    db.close();
  });

  it('still matches predicate words after underscore expansion', () => {
    const db = memoryDb();
    addFact(db, 1, 'Rowan', 'favorite_language', 'TypeScript');

    const results = currentLifecycleFacts(db, 'What is my favorite language?');

    expect(results).toHaveLength(1);
    expect(results[0]?.predicate).toBe('favorite_language');
    db.close();
  });

  it('matches natural base verbs against third-person predicate keys', () => {
    const db = memoryDb();
    addFact(db, 1, 'Rowan', 'lives_in', 'Port Alder');
    addFact(db, 2, 'Rowan', 'uses_editor', 'Cursor');

    expect(currentLifecycleFacts(db, 'Where do I live?').map(f => f.predicate)).toEqual(['lives_in']);
    expect(currentLifecycleFacts(db, 'Which editor do I use?').map(f => f.predicate)).toEqual(['uses_editor']);
    db.close();
  });

  it('normalizes common third-person verb endings and irregulars', () => {
    const db = memoryDb();
    addFact(db, 1, 'Rowan', 'studies_at', 'Lab');
    addFact(db, 2, 'Rowan', 'watches_show', 'Cosmos');
    addFact(db, 3, 'Rowan', 'passes_test', 'Benchmark');
    addFact(db, 4, 'Rowan', 'goes_to', 'San Francisco');
    addFact(db, 5, 'Rowan', 'does_work', 'Research');
    addFact(db, 6, 'Rowan', 'has_hobby', 'Running');

    expect(currentLifecycleFacts(db, 'Where do I study?').map(f => f.predicate)).toContain('studies_at');
    expect(currentLifecycleFacts(db, 'What do I watch?').map(f => f.predicate)).toContain('watches_show');
    expect(currentLifecycleFacts(db, 'What do I pass?').map(f => f.predicate)).toContain('passes_test');
    expect(currentLifecycleFacts(db, 'Where do I go?').map(f => f.predicate)).toContain('goes_to');
    expect(currentLifecycleFacts(db, 'What do I do?').map(f => f.predicate)).toContain('does_work');
    expect(currentLifecycleFacts(db, 'What do I have?').map(f => f.predicate)).toContain('has_hobby');
    db.close();
  });

  it('does not create arbitrary stems for predicate nouns ending in s', () => {
    const db = memoryDb();
    addFact(db, 1, 'Rowan', 'account_status', 'active');

    expect(currentLifecycleFacts(db, 'statu')).toEqual([]);
    db.close();
  });
});

describe('currentLifecycleFacts reads the whole current set', () => {
  it('scores a fact older than the newest hundred, and still returns the newest when there is no query', () => {
    const db = memoryDb();
    addFactAt(db, 1, 'zebra', 'owner', 'Marta', new Date(Date.UTC(2026, 8, 1, 0, 0, 1)).toISOString());
    for (let id = 2; id <= 150; id++) addFactAt(db, id, `filler ${id}`, 'color', `shade ${id}`, new Date(Date.UTC(2026, 8, 1, 0, 0, id)).toISOString());

    expect(currentLifecycleFacts(db, 'who is the zebra owner?').map(f => f.object)).toEqual(['Marta']);
    const profile = currentLifecycleFacts(db, '', undefined, 20);
    expect(profile).toHaveLength(20);
    expect(profile[0].object).toBe('shade 150');
    db.close();
  });

  it('reads slugs and snake_case by their parts, as the full-text index does', () => {
    const db = memoryDb();
    addFactAt(db, 1, 'zebra-stripe-spec', 'owner', 'Marta', '2026-09-01T00:00:01.000Z');
    addFactAt(db, 2, 'billing_webhook', 'retry_limit', '5', '2026-09-01T00:00:02.000Z');
    addFactAt(db, 3, 'Rowan', 'favorite_editor', 'claude-opus-5', '2026-09-01T00:00:03.000Z');

    expect(currentLifecycleFacts(db, 'stripe spec').map(f => f.object)).toEqual(['Marta']);
    expect(currentLifecycleFacts(db, 'billing webhook').map(f => f.object)).toEqual(['5']);
    expect(currentLifecycleFacts(db, 'which opus model').map(f => f.object)).toEqual(['claude-opus-5']);
    expect(currentLifecycleFacts(db, 'zebra-stripe-spec').map(f => f.object)).toEqual(['Marta']);
    db.close();
  });
});

describe('dedupeMemories', () => {
  it('keeps distinct chunks that share the same first 240 characters', () => {
    const sharedPrefix = 'a'.repeat(240);
    const memories = [
      { notePath: 'Memory/project.md', headingPath: 'Status', text: `${sharedPrefix} first detail`, reason: 'semantic' },
      { notePath: 'Memory/project.md', headingPath: 'Status', text: `${sharedPrefix} second detail`, reason: 'fts' },
    ];

    expect(dedupeMemories(memories)).toHaveLength(2);
  });

  it('still removes exact duplicate memory text', () => {
    const memories = [
      { notePath: 'Memory/project.md', headingPath: 'Status', text: 'Same durable context', reason: 'semantic' },
      { notePath: 'Memory/project.md', headingPath: 'Status', text: 'Same durable context', reason: 'fts' },
    ];

    // One copy, in the position of the first. The keyword copy is not lost without a trace: the one memory says that
    // the question's own words found it too.
    expect(dedupeMemories(memories)).toEqual([{ ...memories[0], reason: 'semantic+fts' }]);
  });

  it('says once, not twice, that the words found a memory, and leaves the input as it was', () => {
    const memories = [
      { notePath: 'Memory/project.md', headingPath: 'Status', text: 'Same durable context', reason: 'semantic+content' },
      { notePath: 'Memory/project.md', headingPath: 'Status', text: 'Same durable context', reason: 'fts' },
      { notePath: 'Memory/project.md', headingPath: 'Status', text: 'Same durable context', reason: 'fts' },
      { notePath: 'Memory/project.md', headingPath: 'Status', text: 'Same durable context', reason: 'note-identity' },
    ];
    const before = JSON.stringify(memories);

    expect(dedupeMemories(memories).map(m => m.reason)).toEqual(['semantic+content+fts+note-identity']);
    expect(JSON.stringify(memories)).toBe(before);
  });

  it('does not call a memory word-matched because another memory was', () => {
    const memories = [
      { notePath: 'Memory/a.md', headingPath: 'A', text: 'First', reason: 'semantic' },
      { notePath: 'Memory/b.md', headingPath: 'B', text: 'Second', reason: 'fts' },
    ];

    expect(dedupeMemories(memories)).toEqual(memories);
  });
});
