import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import {
  insertStructuredRows,
  deleteStructuredRowsForSource,
  deleteStructuredRowsForSourceKind,
  readCurrentRowsForNotes,
  dedupeKeyFor,
  normDedupeValue,
  type NewStructuredRow,
} from '../../src/context/rowStore';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

const DB_PATH = tmpPath('test-structured-rows.db');
const DB_PATH_LEGACY = tmpPath('test-structured-rows-legacy.db');

afterEach(() => {
  for (const p of [DB_PATH, DB_PATH_LEGACY]) if (fs.existsSync(p)) fs.unlinkSync(p);
});

function freshDb(): ReturnType<typeof openDb> {
  const db = openDb(DB_PATH); // FK pragma ON — required for cascade fixtures
  runMigrations(db);
  db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES ('notes/a.md', 'A', 'note', 'ha', '2024-12-31', '{"session_date": "2024-03-01"}')`
  ).run();
  db.prepare(
    `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
     VALUES (1, 'notes/a.md', '', 'text', 1, 1, 1, 'c1'), (2, 'notes/a.md', '', 'text2', 2, 2, 1, 'c2')`
  ).run();
  return db;
}

function factRow(overrides: Partial<NewStructuredRow> = {}): NewStructuredRow {
  return {
    rowKind: 'fact',
    sourcePath: 'notes/a.md',
    sourceChunkId: 1,
    sourceHash: 'hash-1',
    extractionVersion: 'extractor-v1',
    validFrom: '2024-03-01', // from note content dates; NULL = unknown
    payload: { value: '3:45', object: 'marathon time' },
    ...overrides,
  };
}

describe('structured-row store (ADR-0003 §4)', () => {
  it('dedupe keys are normalized and deterministic (fact / event / preference)', () => {
    expect(dedupeKeyFor(factRow({ payload: { value: '3:45', object: '  Marathon Time!' } })))
      .toBe(dedupeKeyFor(factRow({ payload: { value: '3:45', object: 'marathon time' } })));
    expect(normDedupeValue('  Café  LATE ')).toBe(normDedupeValue('cafe late'));
  });

  it('deletes rows with their source note via the FK cascade (openDb — PRAGMA caveat)', () => {
    const db = freshDb();
    try {
      insertStructuredRows(db, [factRow()]);
      expect(readCurrentRowsForNotes(db, ['notes/a.md']).length).toBe(1);
      db.prepare('DELETE FROM notes WHERE path = ?').run('notes/a.md');
      expect(db.prepare('SELECT COUNT(*) as c FROM structured_rows').get() as any).toMatchObject({ c: 0 });
      expect(readCurrentRowsForNotes(db, ['notes/a.md'])).toEqual([]);
    } finally { db.close(); }
  });

  it('deletes one lane and leaves sibling rows for the same source', () => {
    const db = freshDb();
    try {
      insertStructuredRows(db, [
        factRow(),
        factRow({
          rowKind: 'event',
          payload: { when: 'Tuesday', event: 'ran 5km' },
        }),
        factRow({
          rowKind: 'preference',
          payload: { statement: 'I prefer oat milk.', kind: 'like' },
        }),
      ]);
      deleteStructuredRowsForSourceKind(db, 'notes/a.md', 'event');
      const kinds = (db.prepare(
        `SELECT row_kind FROM structured_rows WHERE source_path = ? ORDER BY row_kind`,
      ).all('notes/a.md') as Array<{ row_kind: string }>).map(row => row.row_kind);
      expect(kinds).toEqual(['fact', 'preference']);
    } finally { db.close(); }
  });

  it('supports the edit path: delete by source, re-extract, bump provenance', () => {
    const db = freshDb();
    try {
      insertStructuredRows(db, [factRow({ sourceHash: 'hash-old' })]);
      deleteStructuredRowsForSource(db, 'notes/a.md');
      insertStructuredRows(db, [factRow({ sourceChunkId: 2, sourceHash: 'hash-new', validFrom: '2024-03-02' })]);
      const rows = readCurrentRowsForNotes(db, ['notes/a.md']);
      expect(rows.length).toBe(1);
      expect(rows[0].sourceHash).toBe('hash-new');
      expect(rows[0].sourceChunkId).toBe(2);
    } finally { db.close(); }
  });

  it('supersedes only on identity collision (same dedupe identity) with known dates on both sides — N18 blanket newest-wins rejected', () => {
    const db = freshDb();
    try {
      insertStructuredRows(db, [factRow({ payload: { value: '3:45', object: 'marathon time' } })]);
      // Different identity: coexists.
      insertStructuredRows(db, [factRow({ payload: { value: '1:50', object: 'half marathon time' } })]);
      // Same identity (value+object), newer content date: the older duplicate is superseded.
      insertStructuredRows(db, [factRow({ sourceChunkId: 2, payload: { value: '3:45', object: 'marathon time' }, validFrom: '2024-06-01' })]);
      const rows = readCurrentRowsForNotes(db, ['notes/a.md']).filter((r) => r.rowKind === 'fact');
      expect(rows.map((r) => (r.payload as any).value).sort()).toEqual(['1:50', '3:45']);
      const current = rows.filter((r) => (r.payload as any).value === '3:45');
      expect(current.length).toBe(1);
      expect(current[0].sourceChunkId).toBe(2); // the newer extraction survived
      const superseded = db.prepare('SELECT valid_to, source_chunk_id FROM structured_rows WHERE source_chunk_id = 1').get() as any;
      expect(superseded.valid_to).toBe('2024-06-01');
    } finally { db.close(); }
  });

  it('NULL-date identity collisions never supersede in v1 — both rows stay current', () => {
    const db = freshDb();
    try {
      // A REAL identity collision: both rows carry the same (row_kind, scope,
      // dedupe_key) and differ only in their content date — one unknown (NULL),
      // one known. The fixture deliberately crosses source notes, because
      // migration v11's partial UNIQUE index rejects a same-source second
      // insert before the supersession guard is ever consulted, so a
      // same-source fixture would prove the index and never the guard.
      insertStructuredRows(db, [factRow({ validFrom: null, payload: { value: '3:45', object: 'marathon time' } })]);
      db.prepare(
        `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
         VALUES ('notes/b.md', 'B', 'note', 'hb', '2024-12-31', '{}')`
      ).run();
      db.prepare(
        `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
         VALUES (10, 'notes/b.md', '', 'text', 1, 1, 1, 'c10')`
      ).run();
      // Newer extraction with a KNOWN date, same identity, different source:
      // the unknown-date row must NOT be superseded.
      insertStructuredRows(db, [
        factRow({
          sourcePath: 'notes/b.md',
          sourceChunkId: 10,
          sourceHash: 'hash-b',
          validFrom: '2024-06-01',
          payload: { value: '3:45', object: 'marathon time' },
        }),
      ]);
      const key = dedupeKeyFor(factRow({ payload: { value: '3:45', object: 'marathon time' } }));
      const collision = db.prepare(
        'SELECT source_path, valid_from, valid_to FROM structured_rows WHERE dedupe_key = ? ORDER BY id'
      ).all(key) as any[];
      expect(collision).toHaveLength(2); // one identity, two sources: the index permits both
      for (const row of collision) expect(row.valid_to).toBeNull(); // unknown on either side → never superseded
      expect(collision.find((row) => row.valid_from === null)!.source_path).toBe('notes/a.md');
      expect(readCurrentRowsForNotes(db, ['notes/a.md', 'notes/b.md'])).toHaveLength(2);
    } finally { db.close(); }
  });

  it('migration v11 partial UNIQUE index: same-identity same-source double-insert is re-checked and skipped, cross-note coexistence preserved', () => {
    const db = freshDb();
    try {
      // Same identity, same source, NULL dates (no supersession): the second
      // insert loses to the v11 UNIQUE index and is re-checked/skipped, not
      // double-inserted, and the call does not throw.
      expect(() =>
        insertStructuredRows(db, [
          factRow({ validFrom: null, payload: { value: '3:45', object: 'marathon time' } }),
          factRow({ validFrom: null, sourceChunkId: 2, payload: { value: '3:45', object: 'marathon time' } }),
        ]),
      ).not.toThrow();
      const current = readCurrentRowsForNotes(db, ['notes/a.md']);
      expect(current).toHaveLength(1);
      expect(current[0].sourceChunkId).toBe(1); // the winning insert survived
      // Cross-note same identity: different source_path coexists (NULL dates).
      db.prepare(
        `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
         VALUES ('notes/b.md', 'B', 'note', 'hb', '2024-03-01', '{}')`
      ).run();
      db.prepare(
        `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
         VALUES (10, 'notes/b.md', '', 'text', 1, 1, 1, 'c10')`
      ).run();
      expect(() =>
        insertStructuredRows(db, [
          factRow({ sourcePath: 'notes/b.md', sourceChunkId: 10, validFrom: null, payload: { value: '3:45', object: 'marathon time' } }),
        ]),
      ).not.toThrow();
      expect(
        db.prepare('SELECT COUNT(*) AS c FROM structured_rows WHERE dedupe_key = ? AND valid_to IS NULL')
          .get(dedupeKeyFor(factRow({ payload: { value: '3:45', object: 'marathon time' } }))) as any,
      ).toMatchObject({ c: 2 });
    } finally { db.close(); }
  });
});

describe('structured-row migration v9', () => {
  it('purges pre-existing orphaned legacy facts (legacy facts table has no FK) and keeps live ones', () => {
    // Simulate a pre-v9 install: openDb sets the FK pragma, but the LEGACY
    // facts table (v1 schema) carries no REFERENCES — insert an orphan the way
    // the watcher's unlink handler leaves them (src/watcher/watcher.ts:59-65).
    const db = openDb(DB_PATH_LEGACY);
    try {
      db.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        CREATE TABLE notes (
          path TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT,
          note_hash TEXT NOT NULL, modified_at TEXT NOT NULL,
          frontmatter_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          predicate TEXT NOT NULL,
          source_path TEXT NOT NULL,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          scope TEXT NOT NULL DEFAULT 'global',
          updated_at TEXT NOT NULL
        );
        INSERT INTO schema_version (version) VALUES (8);
      `);
      db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at) VALUES ('live.md', 'L', 'note', 'h', '2024-01-01')`).run();
      db.prepare(`INSERT INTO facts (predicate, source_path, valid_from, updated_at) VALUES ('p', 'live.md', '2024-01-01', '2024-01-01')`).run();
      db.prepare(`INSERT INTO facts (predicate, source_path, valid_from, updated_at) VALUES ('p', 'ghost.md', '2024-01-01', '2024-01-01')`).run();

      runMigrations(db);

      const remaining = (db.prepare('SELECT source_path FROM facts').all() as any[]).map((r) => r.source_path);
      expect(remaining).toEqual(['live.md']);
      // The structured_rows table exists and carries the FK.
      const fk = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'structured_rows'").get() as any;
      expect(fk.sql).toContain('REFERENCES notes(path) ON DELETE CASCADE');
    } finally { db.close(); }
  });

  it('is idempotent on an already-migrated DB', () => {
    const db = freshDb();
    try {
      expect(() => runMigrations(db)).not.toThrow();
    } finally { db.close(); }
  });
});