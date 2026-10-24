/**
 * The engine's SQLite driver: Node's built-in `node:sqlite`, behind the part of the better-sqlite3 API the engine uses.
 *
 * Why not better-sqlite3: it is a native addon that builds itself in an npm install script. `npx -y renor-engine` then
 * breaks for anyone whose npm does not run dependency scripts (`ignore-scripts=true`, newer npm defaults), and on a Node
 * with no prebuilt binary the install falls back to compiling C++ for over a minute while the MCP client gives up. Node
 * ships SQLite itself (FTS5 included) and loads sqlite-vec, whose prebuilt binary is a plain optional dependency, so the
 * engine installs with no script at all.
 *
 * Behaviour kept from better-sqlite3, because the engine and its tests rely on it:
 *  - rows are plain objects and BLOBs come back as Buffer; `pluck()`, `raw()` and `safeIntegers()` work as before;
 *  - `transaction(fn)` begins (or, nested, takes a savepoint), commits, and rolls back on a throw;
 *  - errors carry the SQLite code name (`SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CORRUPT`, ...) in `code`;
 *  - a 5 s busy timeout, a 16 MB page cache, and `synchronous = NORMAL` on a connection that opens a database already in
 *    WAL mode (better-sqlite3's compiled defaults; see matchWalSynchronous);
 * Extension loading is allowed through the C API only (`loadExtension`, for sqlite-vec); SQL's `load_extension()` stays
 * refused, as it was.
 */
import fs from 'fs';
import type * as NodeSqlite from 'node:sqlite';

/** The first Node with every `node:sqlite` feature used here (extension loading, `isTransaction`, `setReturnArrays`, `backup`). */
export const MIN_NODE = '22.16.0';

/** Why this Node cannot run the engine, or null when it can. */
export function nodeSupportProblem(version: string = process.versions.node): string | null {
  const [major, minor] = version.split('.').map(Number);
  if (major >= 24 || (major === 22 && minor >= 16)) return null;
  return `Renor needs Node ${MIN_NODE} or newer (it uses Node's built-in SQLite); this is Node ${version}.`;
}

/**
 * Why the engine cannot store anything here, as one line with its fix, or null when it can: this Node has no usable
 * built-in SQLite, or sqlite-vec's prebuilt binary for this platform is missing or does not load. The CLI says this and
 * exits before it starts, so an MCP client shows the reason instead of a connection that silently failed.
 */
export function sqliteRuntimeProblem(): string | null {
  const node = nodeSupportProblem();
  if (node) return `${node} Fix: install Node 22 LTS or newer (https://nodejs.org), then run the command again.`;
  try {
    const db = new SqliteDatabase(':memory:');
    try {
      (require('sqlite-vec') as { load: (db: SqliteDatabase) => void }).load(db);
    } finally {
      db.close();
    }
  } catch (err) {
    const reason = (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(/\.?\s*$/, '.');
    return `the vector search extension (sqlite-vec) did not load on ${process.platform}-${process.arch}: ${reason} `
      + 'Fix: let npm install optional dependencies (remove omit=optional or --no-optional from your npm settings), '
      + 'then run `npx -y renor-engine@latest mcp` again.';
  }
  return null;
}

let sqlite: typeof NodeSqlite | undefined;
function nodeSqlite(): typeof NodeSqlite {
  if (sqlite) return sqlite;
  const problem = nodeSupportProblem();
  if (problem) throw new Error(`${problem} Install Node 22 LTS or newer from https://nodejs.org and run the command again.`);
  // Node 22 prints "SQLite is an experimental feature" once on load; to an MCP client that is noise on stderr, not news.
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes('SQLite is an experimental feature')) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = require('node:sqlite') as typeof NodeSqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
}

/** SQLite's primary result codes, by number. */
const PRIMARY_CODES = (
  'OK ERROR INTERNAL PERM ABORT BUSY LOCKED NOMEM READONLY INTERRUPT IOERR CORRUPT NOTFOUND FULL CANTOPEN PROTOCOL EMPTY '
  + 'SCHEMA TOOBIG CONSTRAINT MISMATCH MISUSE NOLFS AUTH FORMAT RANGE NOTADB NOTICE WARNING'
).split(' ');
/** The extended result codes worth telling apart; any other extended code is named by its primary code. */
const EXTENDED_CODES = new Map<number, string>((
  '261 BUSY_RECOVERY,517 BUSY_SNAPSHOT,773 BUSY_TIMEOUT,262 LOCKED_SHAREDCACHE,267 CORRUPT_VTAB,523 CORRUPT_SEQUENCE,'
  + '779 CORRUPT_INDEX,264 READONLY_RECOVERY,520 READONLY_CANTLOCK,776 READONLY_ROLLBACK,1032 READONLY_DBMOVED,'
  + '275 CONSTRAINT_CHECK,531 CONSTRAINT_COMMITHOOK,787 CONSTRAINT_FOREIGNKEY,1043 CONSTRAINT_FUNCTION,'
  + '1299 CONSTRAINT_NOTNULL,1555 CONSTRAINT_PRIMARYKEY,1811 CONSTRAINT_TRIGGER,2067 CONSTRAINT_UNIQUE,'
  + '2323 CONSTRAINT_VTAB,2579 CONSTRAINT_ROWID,3091 CONSTRAINT_DATATYPE'
).split(',').map(pair => [Number(pair.split(' ')[0]), pair.split(' ')[1]]));

/** Gives a `node:sqlite` error better-sqlite3's `code` (`SQLITE_<NAME>`); every other error passes through unchanged. */
function withSqliteCode(err: unknown): unknown {
  const e = err as { code?: unknown; errcode?: unknown };
  if (e && e.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number') {
    const name = EXTENDED_CODES.get(e.errcode) ?? PRIMARY_CODES[e.errcode & 0xff] ?? 'ERROR';
    try { e.code = `SQLITE_${name}`; } catch { /* a frozen error keeps its code */ }
  }
  return err;
}

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    throw withSqliteCode(err);
  }
}

/** Every bigint in a row (or rows) as the nearest double, as better-sqlite3 read an integer beyond 2^53. */
function roundBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(roundBigInts) as T;
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) out[key] = roundBigInts((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

function asBuffer(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value;
}

/** better-sqlite3 takes named parameters as an object in any position and positional ones also as arrays. */
function bindArgs(params: unknown[]): unknown[] {
  let named: unknown;
  const positional: unknown[] = [];
  for (const p of params) {
    if (Array.isArray(p)) positional.push(...p);
    else if (p !== null && typeof p === 'object' && !ArrayBuffer.isView(p)) named = p;
    else positional.push(p);
  }
  return named === undefined ? positional : [named, ...positional];
}

/** SQL that can change a table's columns, after which this connection's prepared statements are prepared again. */
const SCHEMA_CHANGE = /\b(ALTER|CREATE|DROP)\b/i;

const WRITE_OPCODES = new Set(['JournalMode', 'Vacuum', 'VCreate', 'VDestroy', 'VUpdate', 'ParseSchema']);

/** Any function: `never[]` parameters accept every argument list, and Parameters<F> still reads the real ones. */
type VariableArgFunction = (...params: never[]) => unknown;
/** What prepare() returns: better-sqlite3 takes a single named-parameter object as the only bind parameter. */
type PreparedStatement<BindParameters, Result> = BindParameters extends unknown[] ? Statement<BindParameters, Result> : Statement<[BindParameters], Result>;
type Mode = 'object' | 'pluck' | 'raw';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface ColumnDefinition {
  name: string;
  column: string | null;
  table: string | null;
  database: string | null;
  type: string | null;
}

export interface Options {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Milliseconds to wait on a locked database before SQLITE_BUSY (default 5000, as better-sqlite3). */
  timeout?: number;
}

export interface Transaction<F extends VariableArgFunction> {
  (...params: Parameters<F>): ReturnType<F>;
  default(...params: Parameters<F>): ReturnType<F>;
  deferred(...params: Parameters<F>): ReturnType<F>;
  immediate(...params: Parameters<F>): ReturnType<F>;
  exclusive(...params: Parameters<F>): ReturnType<F>;
}

export class Statement<BindParameters extends unknown[] = unknown[], Result = unknown> {
  private mode: Mode = 'object';
  private bigInts = false;
  private readonly changesSchema: boolean;
  private generation: number;

  constructor(readonly database: SqliteDatabase, private stmt: NodeSqlite.StatementSync, readonly source: string) {
    this.changesSchema = SCHEMA_CHANGE.test(source);
    this.generation = database.schemaGeneration;
  }

  run(...params: BindParameters): RunResult {
    const result = guarded(() => this.current().run(...(bindArgs(params) as [])));
    if (this.changesSchema) this.database.schemaChanged();
    // `changes` is a number even under safeIntegers(), as in better-sqlite3; only lastInsertRowid becomes a bigint.
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get(...params: BindParameters): Result | undefined {
    const row = this.lossy(() => this.current().get(...(bindArgs(params) as [])));
    return row === undefined ? undefined : this.shape(row) as Result;
  }

  all(...params: BindParameters): Result[] {
    return this.lossy(() => this.current().all(...(bindArgs(params) as []))).map(row => this.shape(row) as Result);
  }

  /**
   * Errors raised while stepping get the same `SQLITE_*` code as the other calls. An integer beyond 2^53 still throws
   * RangeError here (better-sqlite3 returned it rounded); use safeIntegers(), or get()/all(), which round as before.
   */
  *iterate(...params: BindParameters): IterableIterator<Result> {
    const rows = guarded(() => this.current().iterate(...(bindArgs(params) as [])));
    try {
      for (;;) {
        const step = guarded(() => rows.next());
        if (step.done) return;
        yield this.shape(step.value) as Result;
      }
    } finally {
      rows.return?.();
    }
  }

  pluck(toggleState = true): this {
    return this.setMode(toggleState ? 'pluck' : this.mode === 'pluck' ? 'object' : this.mode);
  }

  raw(toggleState = true): this {
    return this.setMode(toggleState ? 'raw' : this.mode === 'raw' ? 'object' : this.mode);
  }

  safeIntegers(toggleState = true): this {
    this.bigInts = toggleState;
    this.stmt.setReadBigInts(toggleState);
    return this;
  }

  /**
   * Whether the statement writes nothing, as SQLite's sqlite3_stmt_readonly() decides it: its program opens no write
   * transaction and changes no journal mode, virtual table or file. Read from the statement's EXPLAIN on demand.
   */
  get readonly(): boolean {
    const program = guarded(() => this.database.prepareNative(`EXPLAIN ${this.source}`).all()) as Array<{ opcode: string; p2: number }>;
    return !program.some(op => (op.opcode === 'Transaction' && op.p2 > 0) || WRITE_OPCODES.has(op.opcode));
  }

  columns(): ColumnDefinition[] {
    return this.current().columns() as ColumnDefinition[];
  }

  /**
   * better-sqlite3 returned an integer beyond 2^53 rounded to the nearest double; node:sqlite throws RangeError
   * (ERR_OUT_OF_RANGE) instead. A statement that writes nothing is read again as bigints and rounded the same way; a
   * statement that writes is never run twice, so its RangeError stands.
   */
  private lossy<T>(read: () => T): T {
    try {
      return guarded(read);
    } catch (err) {
      if (this.bigInts || (err as { code?: unknown }).code !== 'ERR_OUT_OF_RANGE' || !this.readonly) throw err;
      this.stmt.setReadBigInts(true);
      try {
        return roundBigInts(guarded(read));
      } finally {
        this.stmt.setReadBigInts(false);
      }
    }
  }

  /**
   * The native statement, prepared again after this connection changed the schema. SQLite re-prepares a statement by
   * itself, but `node:sqlite` reads the result's columns before that happens, so the first run after an ALTER TABLE
   * would return the old columns; better-sqlite3 did not.
   */
  private current(): NodeSqlite.StatementSync {
    if (this.generation !== this.database.schemaGeneration) {
      this.stmt = this.database.prepareNative(this.source);
      this.stmt.setReturnArrays(this.mode !== 'object');
      this.stmt.setReadBigInts(this.bigInts);
      this.generation = this.database.schemaGeneration;
    }
    return this.stmt;
  }

  private setMode(mode: Mode): this {
    this.mode = mode;
    this.stmt.setReturnArrays(mode !== 'object');
    return this;
  }

  private shape(row: unknown): unknown {
    if (this.mode === 'pluck') return asBuffer((row as unknown[])[0]);
    if (this.mode === 'raw') return (row as unknown[]).map(asBuffer);
    const out: Record<string, unknown> = {};
    for (const key in row as Record<string, unknown>) out[key] = asBuffer((row as Record<string, unknown>)[key]);
    return out;
  }
}

class SqliteDatabase {
  readonly name: string;
  readonly readonly: boolean;
  readonly memory: boolean;
  private readonly db: NodeSqlite.DatabaseSync;
  private closed = false;
  private readonly extensions = new Set<string>();
  /** @internal Bumped whenever this connection may have changed the schema; see Statement's `current()`. */
  schemaGeneration = 0;

  constructor(filename = '', options: Options = {}) {
    this.name = filename;
    this.readonly = options.readonly === true;
    this.memory = filename === ':memory:' || filename === '';
    if (options.fileMustExist && !this.memory && !fs.existsSync(filename)) {
      throw Object.assign(new Error(`unable to open database file: ${filename}`), { code: 'SQLITE_CANTOPEN' });
    }
    const { DatabaseSync } = nodeSqlite();
    this.db = guarded(() => new DatabaseSync(filename, { readOnly: this.readonly, allowExtension: true }));
    try {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.timeout ?? 5000))}`);
      this.db.exec('PRAGMA cache_size = -16000');
      this.matchWalSynchronous();
    } catch (err) {
      this.db.close();
      throw withSqliteCode(err);
    }
  }

  get open(): boolean {
    return !this.closed;
  }

  get inTransaction(): boolean {
    return !this.closed && this.db.isTransaction;
  }

  prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
    source: string,
  ): PreparedStatement<BindParameters, Result> {
    return new Statement(this, guarded(() => this.db.prepare(source)), source) as unknown as PreparedStatement<BindParameters, Result>;
  }

  /** @internal The `node:sqlite` statement itself, for Statement's own bookkeeping. */
  prepareNative(source: string): NodeSqlite.StatementSync {
    return this.db.prepare(source);
  }

  exec(source: string): this {
    guarded(() => this.db.exec(source));
    if (SCHEMA_CHANGE.test(source)) this.schemaChanged();
    return this;
  }

  /** @internal */
  schemaChanged(): void {
    this.schemaGeneration++;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const stmt = guarded(() => this.db.prepare(`PRAGMA ${source}`));
    if (options.simple) {
      stmt.setReturnArrays(true);
      const row = guarded(() => stmt.get()) as unknown[] | undefined;
      return row === undefined ? undefined : asBuffer(row[0]);
    }
    return guarded(() => stmt.all()).map(row => ({ ...row }));
  }

  transaction<F extends VariableArgFunction>(fn: F): Transaction<F> {
    const wrap = (begin: string) => {
      const db = this;
      return function sqliteTransaction(this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const nested = db.inTransaction;
        db.exec(nested ? 'SAVEPOINT "_renor_tx"' : begin);
        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new TypeError('Transaction function cannot return a promise');
          }
          db.exec(nested ? 'RELEASE "_renor_tx"' : 'COMMIT');
          return result;
        } catch (err) {
          if (db.inTransaction) {
            if (nested) db.exec('ROLLBACK TO "_renor_tx"; RELEASE "_renor_tx"');
            else db.exec('ROLLBACK');
          }
          throw err;
        }
      };
    };
    const tx = wrap('BEGIN') as Transaction<F>;
    tx.default = tx;
    tx.deferred = wrap('BEGIN DEFERRED');
    tx.immediate = wrap('BEGIN IMMEDIATE');
    tx.exclusive = wrap('BEGIN EXCLUSIVE');
    return tx;
  }

  /**
   * Loads an extension once per connection: a second load only registers the same functions again, and that fails
   * ("error during initialization") inside a transaction that has deleted rows behind a virtual table, where
   * src/indexer/outsideRoot.ts loads sqlite-vec.
   */
  loadExtension(path: string): this {
    if (this.extensions.has(path)) return this;
    guarded(() => this.db.loadExtension(path));
    this.extensions.add(path);
    return this;
  }

  backup(destinationFile: string): Promise<number> {
    return nodeSqlite().backup(this.db, destinationFile);
  }

  close(): this {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
    return this;
  }

  /**
   * better-sqlite3 was built with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, Node's SQLite with 2. SQLite applies that default
   * only to a connection that opens a database already in WAL mode, read-only or not: such a connection gets
   * synchronous = NORMAL (1) here as it did there. A connection that switches a database to WAL itself (a fresh index
   * in openDb) keeps FULL (2), as it did there.
   */
  private matchWalSynchronous(): void {
    const mode = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode === 'wal') this.db.exec('PRAGMA synchronous = NORMAL');
  }
}

declare namespace Database {
  type Database = SqliteDatabase;
  type Statement<BindParameters extends unknown[] | {} = unknown[], Result = unknown> = BindParameters extends unknown[]
    ? import('./sqlite').Statement<BindParameters, Result>
    : import('./sqlite').Statement<[BindParameters], Result>;
  type RunResult = import('./sqlite').RunResult;
  type Options = import('./sqlite').Options;
  type ColumnDefinition = import('./sqlite').ColumnDefinition;
  type Transaction<F extends VariableArgFunction = VariableArgFunction> = import('./sqlite').Transaction<F>;
}

const Database = SqliteDatabase;
export default Database;
