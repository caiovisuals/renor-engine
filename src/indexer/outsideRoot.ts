import type Database from '../db/sqlite';
import path from 'path';

const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };

/**
 * What `removeRowsOutsideRoot` took out of the index, by table. `total` is what a caller acts on: a removal means the
 * notes that were indexed under the old folder are not in the index at their current paths, and must be indexed again.
 */
export interface OutsideRootRemoval {
  notes: number;
  facts: number;
  relations: number;
  events: number;
  vectors: number;
  total: number;
}

/**
 * Remove the index's rows for files outside the folder it is opened on.
 *
 * The index names each note by its absolute path. A workspace folder moved or restored from a backup into another
 * directory therefore leaves every row of the old location behind, and a search serves each note twice: once from
 * the new folder, and once from the old path, which no longer exists. This removes the rows whose path is absolute and
 * not under `memoryDir`: the note, and what the note made (its chunks, entities, structured rows and lane runs go with
 * it by cascade), plus the facts, relations and write events that name it, and the vectors of its chunks.
 *
 * Rows that name no file are kept: the engine's lifecycle facts (source `_mcp_`), the ledger's events and the agents'
 * requests and cursors are not made from a note's path, so the folder's move does not touch them. Rows for notes under
 * the folder are kept as they are, so an unmoved folder removes nothing and its index is not changed.
 *
 * The index is derived from the Markdown, so what is removed is indexed again by the next pass over the folder, at the
 * paths it has now (`engineIndex`). The removal and the mark that the folder is owed a pass (`reindexPending`) are one
 * transaction: a process that ends after it finds the mark on its next start, however long the pass would have taken.
 * The canonical notes and the ledger are never written.
 */
export function removeRowsOutsideRoot(db: Database.Database, memoryDir: string): OutsideRootRemoval {
  const root = path.resolve(memoryDir);
  const params = { root, under: root.endsWith(path.sep) ? root : root + path.sep };
  // Absolute, and neither the folder itself nor below it. `length(@under)` counts characters as `substr` does.
  const outside = (column: string) =>
    `(substr(${column}, 1, 1) = '/' AND ${column} <> @root AND substr(${column}, 1, length(@under)) <> @under)`;

  return db.transaction((): OutsideRootRemoval => {
    const removed = { notes: 0, facts: 0, relations: 0, events: 0, vectors: 0 };
    // Facts first: fact_terms is keyed by fact id and has no cascade, so its rows go with the facts that name the note.
    const factIds = `SELECT id FROM facts WHERE ${outside('source_path')}`;
    db.prepare(`DELETE FROM fact_terms WHERE fact_id IN (${factIds})`).run(params);
    removed.facts = db.prepare(`DELETE FROM facts WHERE ${outside('source_path')}`).run(params).changes;
    removed.relations = db.prepare(`DELETE FROM relations WHERE ${outside('source_note')}`).run(params).changes;
    removed.events = db.prepare(`DELETE FROM write_events WHERE ${outside('note_path')}`).run(params).changes;
    // Notes last: chunks, entities, structured rows and lane runs cascade from them, and chunks_fts and the note
    // identity index follow their triggers.
    removed.notes = db.prepare(`DELETE FROM notes WHERE ${outside('path')}`).run(params).changes;
    // Vectors are keyed by chunk id with no cascade: those of the chunks just removed are orphans now. Only a removed
    // note can leave one, so an index with nothing to remove is not read for them.
    const vectorTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_embeddings'").get();
    if (removed.notes > 0 && vectorTable !== undefined) {
      // The table is a vec0 virtual table: this connection can only read it once the extension is loaded on it.
      sqliteVec.load(db);
      const orphans = db.prepare('SELECT rowid FROM chunk_embeddings WHERE rowid NOT IN (SELECT id FROM chunks)').pluck().all() as number[];
      if (orphans.length > 0) {
        db.prepare('DELETE FROM chunk_embeddings WHERE rowid IN (SELECT value FROM json_each(?))').run(JSON.stringify(orphans));
      }
      removed.vectors = orphans.length;
    }
    const total = removed.notes + removed.facts + removed.relations + removed.events + removed.vectors;
    if (total > 0) {
      db.prepare(`INSERT INTO index_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
        .run(REINDEX_PENDING, params.root);
    }
    return { ...removed, total };
  })();
}

const REINDEX_PENDING = 'reindex_pending';

/**
 * True while the folder is owed an index pass: a removal made it, and no pass has since finished without a failure.
 * A start reads this rather than the count of rows it removed, so a start that is cut short does not leave an index
 * that nothing indexes again.
 */
export function reindexPending(db: Database.Database): boolean {
  return db.prepare('SELECT 1 FROM index_state WHERE key = ?').get(REINDEX_PENDING) !== undefined;
}

/** Clears the mark once the folder has been indexed at its current paths with no failure. */
export function clearReindexPending(db: Database.Database): void {
  db.prepare('DELETE FROM index_state WHERE key = ?').run(REINDEX_PENDING);
}
