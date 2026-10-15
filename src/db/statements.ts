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
