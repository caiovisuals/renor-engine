import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { tmpPath } from './tmpPath';

/**
 * An empty index database at the newest schema, for a test that needs one and is not about the migrations.
 *
 * Migrating a new file runs 25 migrations as 25 transactions: 8 ms and about a megabyte of writes (each commit puts the
 * pages it touched in the write-ahead log). A copy of a file that was migrated once costs 1 ms and 0.3 MB, and is the same
 * schema. A test that builds a database for every comparison (tests/indexer/pipeline-append.test.ts builds one for each
 * of its 80 steps, to hold what a fresh index of the same bytes would) pays that every time.
 *
 * The template is made by this process, from the code under test, the first time one is asked for: a migration added later
 * is in it, and a test about the migrations (tests/db/**) still calls `runMigrations` itself.
 */
let template: string | undefined;

function migratedTemplate(): string {
  if (template) return template;
  const file = tmpPath('migrated-template/index.db');
  const db = openDb(file);
  runMigrations(db);
  // The last connection to close checkpoints the log and removes it: what is left is one file.
  db.close();
  template = file;
  return file;
}

/** `openDb` on a copy of the migrated template at `file`; `runMigrations` then finds nothing to apply, and runs so that the schema is checked, not assumed. */
export function openMigratedDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(migratedTemplate(), file);
  const db = openDb(file);
  runMigrations(db);
  return db;
}
