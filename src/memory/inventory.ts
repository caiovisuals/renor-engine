import type Database from '../db/sqlite';
import { LIFECYCLE_NOTE_PATH, resolveLedgerPath } from './lifecycle';
import { liveEntityFilter } from '../retrieval/entityLookup';

/**
 * What a workspace holds, counted the way the person who owns it would count it.
 *
 * The index is also the engine's own bookkeeping, and three of its rows are not something anyone said: the synthetic
 * `_mcp_` note that owns the subjects of lifecycle facts, the ledger file that records them, and the entity the index
 * registers for that file. Counting them, and the `updated` header the engine writes into each daily note and the
 * indexer used to make a fact of (dailyNote.ts), made two notes and one fact read as three notes, two facts and three
 * entities (new-user re-check, finding N5), and the dashboard sums the three numbers to decide whether a workspace
 * holds anything at all. The header is not a fact any more (the indexer does not make it, and removes the rows an
 * earlier build made), so facts are counted as they are.
 *
 * The engine's notes are told apart by identity, as the memory map does: the reserved `_mcp_` path and the ledger path
 * this workspace is configured with. Never by a name or by front matter, which a user's own note can carry too.
 *
 * Counted as before, on purpose: `chunks` (index size: the ledger is indexed, so it has chunks), `relations`, a daily
 * log as one note per day however many things were saved into it, and every value of a fact, superseded ones included.
 */

export interface InventoryVault {
  memoryDir: string;
  ledgerRelPath: string;
}

export interface Inventory {
  notes: number;
  chunks: number;
  entities: number;
  facts: number;
  relations: number;
}

/**
 * The ledger file as the index stores its path (the vault walk joins from the same resolved directory), or null when
 * the configured path cannot name a file. Null excludes nothing: the SQL below reads it as `IS NOT NULL`.
 */
export function ledgerNotePath(vault: InventoryVault): string | null {
  try {
    return resolveLedgerPath(vault.memoryDir, vault.ledgerRelPath);
  } catch {
    return null;
  }
}

function scalar(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

/**
 * Entities without the one the index registers for the ledger file. The subjects of lifecycle facts (source note
 * `_mcp_`), while one of their facts is not retired, and the entity of every other note count. `filter` narrows the count to one scope (entityScopeFilter), so a
 * count handed to a caller who may read only that scope is never workspace-wide. lookup_entity reports this same count
 * when it finds nothing, so it cannot name a different number of entities than memory_status.
 */
export function countEntities(db: Database.Database, vault: InventoryVault, filter?: { sql: string; params: string[] }): number {
  const where = ['source_note IS NOT ?'];
  const params: unknown[] = [ledgerNotePath(vault)];
  // Without a scope, every scope's (liveEntityFilter): the count lookup_entity reports with no scope.
  const narrowed = filter ?? liveEntityFilter();
  where.push(narrowed.sql);
  params.push(...narrowed.params);
  return scalar(db, `SELECT COUNT(*) AS c FROM entities WHERE ${where.join(' AND ')}`, ...params);
}

export function countInventory(db: Database.Database, vault: InventoryVault): Inventory {
  // A table that cannot be read counts as empty, as memory_status always has.
  const orZero = (count: () => number): number => {
    try {
      return count();
    } catch {
      return 0;
    }
  };
  return {
    notes: orZero(() => scalar(
      db, 'SELECT COUNT(*) AS c FROM notes WHERE path IS NOT ? AND path IS NOT ?', LIFECYCLE_NOTE_PATH, ledgerNotePath(vault),
    )),
    chunks: orZero(() => scalar(db, 'SELECT COUNT(*) AS c FROM chunks')),
    entities: orZero(() => countEntities(db, vault)),
    facts: orZero(() => scalar(db, 'SELECT COUNT(*) AS c FROM facts')),
    relations: orZero(() => scalar(db, 'SELECT COUNT(*) AS c FROM relations')),
  };
}
