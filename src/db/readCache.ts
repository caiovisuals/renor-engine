import type Database from 'better-sqlite3';
import { prepareOnce } from './statements';

/**
 * Two things a read asks of the database again and again and that change rarely: the shape of a table, and a value
 * derived from every row of one (the ledger's closed events). A `get_context` asked for each of them six times.
 */

const withColumns = new WeakMap<Database.Database, Map<string, true>>();

/**
 * Whether `table` has every one of `columns` (the reads that predate a column ask, so an old index still answers).
 * Only a yes is kept for the connection: a table that lacks a column may get it from a migration, and a column that
 * is there is never dropped, so a no is asked again each time and a yes never is. The names are the code's own, never
 * a caller's.
 */
export function tableHasColumns(db: Database.Database, table: string, columns: readonly string[]): boolean {
  const key = `${table}(${columns.join(',')})`;
  let known = withColumns.get(db);
  if (known?.has(key)) return true;
  const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
  if (!columns.every(c => present.has(c))) return false;
  if (!known) withColumns.set(db, known = new Map());
  known.set(key, true);
  return true;
}

interface Kept { stamp: string; value: unknown }
const kept = new WeakMap<Database.Database, Map<string, Kept>>();
/** Values kept per connection. A key may carry what a caller sent (a scope), so the oldest goes when the room is used. */
const MAX_KEPT = 64;

/**
 * What the database has been through: changes this connection committed (`total_changes()`, which counts every row an
 * INSERT, UPDATE or DELETE touched, triggers and virtual tables included) and changes any other connection committed
 * (`PRAGMA data_version`, which a connection's own writes do not move). Both only ever go up, so two equal stamps are
 * the same data. Null inside a transaction: it can still be rolled back, and its changes would be counted for good.
 */
function stampOf(db: Database.Database): string | null {
  if (db.inTransaction) return null;
  const version = prepareOnce(db, 'PRAGMA data_version').pluck().get();
  const changes = prepareOnce(db, 'SELECT total_changes()').pluck().get();
  return `${version}:${changes}`;
}

/**
 * `compute()` for the database as it is now, read once and kept until anything is written to it, by this connection or
 * another. The same answer a fresh `compute()` gives: nothing is kept across a write, and nothing at all inside a
 * transaction. `compute` must read only the database, and what it returns is shared: callers must not change it.
 */
export function readUntilWrite<T>(db: Database.Database, key: string, compute: () => T): T {
  const stamp = stampOf(db);
  if (stamp === null) return compute();
  let byKey = kept.get(db);
  if (!byKey) kept.set(db, byKey = new Map());
  const held = byKey.get(key);
  if (held && held.stamp === stamp) return held.value as T;
  const value = compute();
  if (!byKey.has(key) && byKey.size >= MAX_KEPT) byKey.delete(byKey.keys().next().value as string);
  byKey.set(key, { stamp, value });
  return value;
}
