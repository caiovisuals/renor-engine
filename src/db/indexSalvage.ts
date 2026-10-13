import type Database from 'better-sqlite3';

/**
 * The index is rebuilt from the ledger, but a few of its tables hold state that no ledger event rebuilds: the pending
 * agent requests, the what's-new cursors, and the connection names the workspace has seen (known_agents). When the
 * index is damaged, those rows are read out of the damaged file, read-only, and written into the rebuilt one.
 */
export const INDEX_ONLY_TABLES = ['agent_requests', 'agent_cursors', 'known_agents'] as const;

export interface IndexSalvage {
  /** The rows read from the damaged file, per table, with their rowid (so the order they were in is kept). */
  rows: Record<string, Array<Record<string, unknown>>>;
  /** Tables the damaged file could not be read for, with the reason. Rows read before the failure are still kept. */
  unreadable: Record<string, string>;
}

/** What a damaged index gives when it cannot be opened at all: every table is unreadable, for the same reason. */
export function unreadableSalvage(reason: string): IndexSalvage {
  const salvage: IndexSalvage = { rows: {}, unreadable: {} };
  for (const table of INDEX_ONLY_TABLES) {
    salvage.rows[table] = [];
    salvage.unreadable[table] = reason;
  }
  return salvage;
}

/** Reads what an open (read-only) damaged index still gives. Never throws: a table that does not read says why. */
export function salvageIndexTables(db: Database.Database): IndexSalvage {
  const salvage: IndexSalvage = { rows: {}, unreadable: {} };
  for (const table of INDEX_ONLY_TABLES) {
    const rows: Array<Record<string, unknown>> = [];
    salvage.rows[table] = rows;
    try {
      for (const row of db.prepare(`SELECT rowid AS __rowid, * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>) {
        rows.push(row);
      }
    } catch (err) {
      // An index from before this table existed has nothing to salvage here; that is not a loss.
      if (!/no such table/.test(errorText(err))) salvage.unreadable[table] = errorText(err);
    }
  }
  return salvage;
}

/** Writes the salvaged rows into a freshly migrated index. A row that will not go in is counted, never skipped silently. */
export function restoreIndexTables(db: Database.Database, salvage: IndexSalvage): { restored: Record<string, number>; rejected: Record<string, number> } {
  const restored: Record<string, number> = {};
  const rejected: Record<string, number> = {};
  for (const table of INDEX_ONLY_TABLES) {
    restored[table] = 0;
    rejected[table] = 0;
    for (const row of salvage.rows[table] ?? []) {
      const { __rowid, ...values } = row;
      const cols = ['rowid', ...Object.keys(values)];
      const sql = `INSERT OR IGNORE INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      try {
        const info = db.prepare(sql).run(__rowid, ...Object.keys(values).map(c => values[c]));
        restored[table] += info.changes;
      } catch {
        rejected[table] += 1;
      }
    }
  }
  return { restored, rejected };
}

/** One sentence for the log: what came back from the damaged index, and what did not. */
export function describeSalvage(salvage: IndexSalvage, restored: Record<string, number>, rejected: Record<string, number>): string {
  const kept = INDEX_ONLY_TABLES.map(t => `${t} ${restored[t] ?? 0}`).join(', ');
  const lost = INDEX_ONLY_TABLES
    .map(t => {
      const parts: string[] = [];
      if (rejected[t]) parts.push(`${rejected[t]} row(s) could not be written`);
      if (salvage.unreadable[t]) parts.push(`the damaged file could not be read (${salvage.unreadable[t]}), so rows past the damage are gone and not counted`);
      return parts.length ? `${t}: ${parts.join('; ')}` : '';
    })
    .filter(Boolean);
  return `Kept from the damaged index: ${kept}.${lost.length ? ` NOT RECOVERED: ${lost.join('. ')}.` : ''}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
