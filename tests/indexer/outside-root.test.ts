import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { removeRowsOutsideRoot } from '../../src/indexer/outsideRoot';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

/**
 * The rows an index keeps for files outside the folder it is opened on (a folder moved or restored elsewhere). A note
 * is named by its absolute path, so these rows are the old copy of each note: they are removed with what the note made,
 * and nothing else. Synthetic folders in the OS temp directory; no model, no network.
 */

const dirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-root-'));
  dirs.push(dir);
  return dir;
}

function writeNote(folder: string, file: string, text: string): void {
  fs.mkdirSync(path.join(folder, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(folder, file), text);
}

function open(dbPath: string): Database.Database {
  const db = openDb(dbPath);
  dbs.push(db);
  runMigrations(db);
  return db;
}

function counts(db: Database.Database) {
  const count = (sql: string) => db.prepare(sql).pluck().get() as number;
  return {
    notes: count('SELECT COUNT(*) FROM notes'),
    chunks: count('SELECT COUNT(*) FROM chunks'),
    facts: count('SELECT COUNT(*) FROM facts'),
    fact_terms: count('SELECT COUNT(*) FROM fact_terms'),
    events: count('SELECT COUNT(*) FROM write_events'),
    entities: count('SELECT COUNT(*) FROM entities'),
  };
}

describe('removeRowsOutsideRoot', () => {
  it('removes nothing from an index whose notes are all under the folder', async () => {
    const memory = path.join(scratch(), 'memory');
    fs.mkdirSync(path.join(memory, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(memory, 'Notes', 'a.md'), '# A\n\nThe mango juice stand closes at six.\n');
    const db = open(path.join(memory, '.memory-index', 'index.db'));
    await indexVault(db, memory);
    const before = counts(db);
    expect(before.notes).toBe(1);

    const removed = removeRowsOutsideRoot(db, memory);

    expect(removed.total).toBe(0);
    expect(counts(db)).toEqual(before);
  });

  it('removes a note indexed under another folder, with what it made, and keeps the engine\'s own rows', async () => {
    const root = scratch();
    const old = path.join(root, 'old', 'memory');
    const memory = path.join(root, 'new', 'memory');
    fs.mkdirSync(path.join(old, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(old, 'Notes', 'a.md'), '# A\n\nThe mango juice stand closes at six.\n');
    const db = open(path.join(root, 'index.db'));
    await indexVault(db, old);
    // The engine's own `_mcp_` row (it owns the lifecycle facts' subjects), a lifecycle fact, and a fact and a write
    // event made from the old note.
    db.prepare("INSERT INTO notes (path, title, kind, note_hash, modified_at) VALUES ('_mcp_', '_mcp_', 'lifecycle', 'x', '2026-10-01')").run();
    const oldNote = path.join(old, 'Notes', 'a.md');
    db.prepare("INSERT INTO facts (predicate, object_text, source_path, valid_from, updated_at) VALUES ('owns', 'a dog', '_mcp_', '2026-10-01', '2026-10-01')").run();
    const noteFact = db.prepare("INSERT INTO facts (predicate, object_text, source_path, valid_from, updated_at) VALUES ('opens', 'at six', ?, '2026-10-01', '2026-10-01')").run(oldNote).lastInsertRowid;
    db.prepare("INSERT INTO fact_terms (term, scope, fact_id) VALUES ('opens', 'global', ?)").run(noteFact);
    db.prepare("INSERT INTO write_events (note_path, action, summary, created_at) VALUES (?, 'note', 'a', '2026-10-01')").run(oldNote);
    db.prepare("INSERT INTO write_events (note_path, action, summary, created_at) VALUES ('_memory_ledger_', 'retire', 'b', '2026-10-01')").run();
    const before = counts(db);
    expect(before.notes).toBe(2);
    expect(before.entities).toBeGreaterThan(0);

    const removed = removeRowsOutsideRoot(db, memory);

    expect(removed).toMatchObject({ notes: 1, facts: 1, events: 1, relations: 0, vectors: 0 });
    expect(removed.total).toBe(3);
    expect(db.prepare('SELECT path FROM notes ORDER BY path').pluck().all()).toEqual(['_mcp_']);
    expect(counts(db)).toEqual({ notes: 1, chunks: 0, facts: 1, fact_terms: 0, events: 1, entities: 0 });
    expect(db.prepare("SELECT source_path FROM facts").pluck().all()).toEqual(['_mcp_']);
    expect(db.prepare("SELECT note_path FROM write_events").pluck().all()).toEqual(['_memory_ledger_']);
  });

  it('treats a folder that only shares a name prefix with the root as outside it', async () => {
    const root = scratch();
    const memory = path.join(root, 'memory');
    const sibling = path.join(root, 'memory-old');
    fs.mkdirSync(path.join(sibling, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(sibling, 'Notes', 'a.md'), '# A\n\nThe mango juice stand closes at six.\n');
    const db = open(path.join(root, 'index.db'));
    await indexVault(db, sibling);

    const removed = removeRowsOutsideRoot(db, memory);

    expect(removed.notes).toBe(1);
  });

  it('removes the vectors of the chunks it removed and keeps those of the notes under the folder', async () => {
    const root = scratch();
    const old = path.join(root, 'old');
    const memory = path.join(root, 'new');
    writeNote(old, 'Notes/a.md', '# A\n\nThe mango juice stand closes at six.\n');
    writeNote(memory, 'Notes/b.md', '# B\n\nThe dentist appointment is on Tuesday.\n');
    const db = open(path.join(root, 'index.db'));
    const provider = new EvalHashEmbeddingProvider();
    const vectorIndex = new VectorIndex(db, provider.dimensions);
    vectorIndex.initTable();
    await indexVault(db, old, { embeddingProvider: provider, vectorIndex });
    await indexVault(db, memory, { embeddingProvider: provider, vectorIndex });
    const chunks = db.prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number;
    expect(chunks).toBe(2);
    expect(db.prepare('SELECT COUNT(*) FROM chunk_embeddings').pluck().get()).toBe(2);

    const removed = removeRowsOutsideRoot(db, memory);

    expect(removed).toMatchObject({ notes: 1, vectors: 1 });
    expect(db.prepare('SELECT COUNT(*) FROM chunks').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM chunk_embeddings').pluck().get()).toBe(1);
    expect(db.prepare('SELECT rowid FROM chunk_embeddings').pluck().all()).toEqual(
      db.prepare('SELECT id FROM chunks').pluck().all(),
    );
  });
});
