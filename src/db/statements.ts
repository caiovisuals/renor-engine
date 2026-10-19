import type Database from 'better-sqlite3';

/**
 * One prepared statement per connection and SQL text, for the statements a read or a save runs again on every request.
 *
 * Preparing a statement costs a parse and a plan, and a `get_context` runs a few dozen small ones: preparing them again
 * on every call was about 2 ms of its 20 (profiled with scripts/bench/mcp-latency.ts --cpu-profile). A prepared
 * statement is reused as it is, and SQLite prepares it again by itself when the schema changes, so a migration that runs
 * after the first use is seen. The result of a statement does not depend on how long ago it was prepared.
 *
 * What is shared is the statement, so what a caller leaves on it is shared too:
 *  - Do not leave a mode on it (`.pluck()`, `.raw()`, `.expand()`, `.safeIntegers()`, `.bind()`) unless every caller of
 *    that text asks for the same mode. Give a statement that is read another way its own text.
 *  - Do not cache a statement that is iterated (`.iterate()`): an open iteration holds it, and a second use fails.
 *  - Do not cache SQL whose text varies with its input (an `IN (?, ?, ...)` list of any length): each text is kept.
 * The cache stops growing at MAX_PREPARED texts per connection; past it a statement is prepared and not kept.
 */
const MAX_PREPARED = 256;

const prepared = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepareOnce(db: Database.Database, sql: string): Database.Statement {
  let byText = prepared.get(db);
  if (!byText) prepared.set(db, byText = new Map());
  let statement = byText.get(sql);
  if (statement) return statement;
  statement = db.prepare(sql);
  if (byText.size < MAX_PREPARED) byText.set(sql, statement);
  return statement;
}

/**
 * The most values a list is padded to a power of two for. A longer list is prepared as it is and not kept: the padding would
 * double it, and a list that long is not the usual one (SQLite takes 32,766 values in a statement).
 */
const MAX_PADDED_LIST = 256;

/** The number of values a list of `count` is padded to: the next power of two, and at least four. */
function paddedSize(count: number): number {
  return count <= 4 ? 4 : 2 ** (32 - Math.clz32(count - 1));
}

/**
 * A statement over an `IN (?, ?, ...)` list whose length follows the question (the notes a read hit, the entities of those
 * notes). The text of such a statement changes with the length, so `prepareOnce` would keep one for every length and fill its
 * room (see the third rule above), and preparing it on every call was about a tenth of a `get_context`'s statement time (ten
 * statements prepared again on each call). Here the list is made a power of two long, at least four, and the values are padded
 * with `paddedList`: a NULL in an IN list matches no row, so the rows are the rows of the list itself. A connection prepares
 * one statement for each size, a few in all, and the next call finds them ready. `build` makes the SQL from the placeholders.
 * A list over MAX_PADDED_LIST is prepared as it is, for this call only. Use it where the list is the whole of an IN: not
 * under NOT IN, where a NULL in the list would make the whole test unknown.
 */
export function listStatement(db: Database.Database, count: number, build: (placeholders: string) => string): Database.Statement {
  if (count > MAX_PADDED_LIST) return db.prepare(build('?,'.repeat(count - 1) + '?'));
  return prepareOnce(db, build('?,'.repeat(paddedSize(count) - 1) + '?'));
}

/** The values of a list as `listStatement` binds them: padded with NULL to the size it was prepared for. */
export function paddedList<T>(values: readonly T[]): Array<T | null> {
  const padded: Array<T | null> = values.slice();
  if (values.length > MAX_PADDED_LIST) return padded;
  for (let size = paddedSize(values.length); padded.length < size;) padded.push(null);
  return padded;
}

/**
 * One transaction wrapper per connection and body, for a transaction a replay runs once per ledger event.
 *
 * `db.transaction(fn)` builds the wrapper's four variants (default, deferred, immediate, exclusive) every time it is called, which
 * is about 0.05 ms: the ledger replay at startup called it twice per event, about 35 ms of the 190 ms replay of a 1,000-fact
 * workspace. The wrapper does not depend on what the body closes over, so the body takes the connection and its inputs as
 * arguments, is a module-level function, and is wrapped once. What runs in the transaction, and when it commits or rolls back, is
 * unchanged; a call inside another transaction is a savepoint, as before.
 */
const transactions = new WeakMap<Database.Database, Map<unknown, unknown>>();

export function transactionOnce<A extends unknown[], R>(db: Database.Database, body: (db: Database.Database, ...args: A) => R): (...args: A) => R {
  let byBody = transactions.get(db);
  if (!byBody) transactions.set(db, byBody = new Map());
  let tx = byBody.get(body) as ((...args: A) => R) | undefined;
  if (!tx) {
    tx = db.transaction((...args: A) => body(db, ...args));
    byBody.set(body, tx);
  }
  return tx;
}
