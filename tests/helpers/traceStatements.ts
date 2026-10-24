import type Database from '../../src/db/sqlite';

export interface TracedStatement {
  sql: string;
  args: unknown[];
  /** Rows the call returned (`all`: the array's length; `get`: 1 or 0; `run`: 0). */
  rows: number;
  /** `EXPLAIN QUERY PLAN` of the statement under the arguments it ran with. */
  plan: string[];
}

/**
 * Runs `run` and returns its result with every statement it ran, each with the arguments, the rows it
 * returned and its query plan. Lets a test assert how a read was served (an index, no table scan, no
 * sort, how many rows a statement was allowed to read) against the SQL the code actually executed, not
 * a copy of it.
 *
 * It patches the statement class, not `db.prepare`, so a statement the code prepared once and keeps
 * (a cached one) is traced on every run.
 */
export function traceStatements<T>(db: Database.Database, run: () => T): { result: T; plans: TracedStatement[] } {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<string, (...args: unknown[]) => unknown>;
  const original = { all: proto.all, get: proto.get, run: proto.run };
  const calls: Array<{ sql: string; args: unknown[]; rows: number }> = [];
  for (const method of ['all', 'get', 'run'] as const) {
    proto[method] = function (this: { source: string }, ...args: unknown[]) {
      const result = original[method].apply(this, args);
      const rows = method === 'all' ? (result as unknown[]).length : method === 'get' ? (result === undefined ? 0 : 1) : 0;
      calls.push({ sql: this.source, args, rows });
      return result;
    };
  }
  let result: T;
  try {
    result = run();
  } finally {
    Object.assign(proto, original);
  }
  const plans = calls.map(call => ({
    ...call,
    plan: (db.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as Array<{ detail: string }>).map(row => row.detail),
  }));
  return { result, plans };
}

/** Plan lines that read a table or index in full; a scan of a LIMIT-bounded sub-query is not one. */
export const fullScans = (plan: string[]) => plan.filter(line => line.startsWith('SCAN') && !/^SCAN \(subquery-\d+\)$/.test(line));
