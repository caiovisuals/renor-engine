import type Database from './sqlite';

/**
 * The handoff note's tables (memory/handoff.ts): the notes, and the one-row high-water mark of the clock they expire
 * by. They are not a migration: a workspace with RENOR_HANDOFF_NOTE off never gets them, so its schema and its bytes
 * stay those of a workspace without this code. They are created on the first write, read or expiry sweep, all of which
 * run only with the flag on, and by index salvage only when the damaged index had the notes.
 */
export const HANDOFF_TABLE = 'handoff_notes';

const DDL = `CREATE TABLE IF NOT EXISTS handoff_notes (
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  note TEXT NOT NULL,
  writer TEXT NOT NULL,
  written_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (repo, branch)
);
CREATE TABLE IF NOT EXISTS handoff_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_water INTEGER NOT NULL
)`;

export function ensureHandoffTable(db: Database.Database): void {
  db.exec(DDL);
}

export function hasHandoffTable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(HANDOFF_TABLE) !== undefined;
}
