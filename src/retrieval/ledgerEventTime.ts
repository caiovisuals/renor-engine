import type Database from 'better-sqlite3';
import { tableHasColumns } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { LIFECYCLE_NOTE_PATH } from '../memory/lifecycle';
import { ledgerEventIds } from './ledgerLiveness';

/**
 * When the ledger events a hit carries happened.
 *
 * The ledger is ONE note, so the date of the note (when the file was last written) is the same for every event
 * in it, and says nothing about when any of them was saved. Each event has its own time: the lifecycle layer
 * projects every event into `facts` (event id, `valid_from` = the event's time), the same projection a scoped
 * read asks which scope an event belongs to (mvp/readScope.ts). That row, not the header text of a chunk, is
 * what makes an id an event, so a line that only looks like an event header in some other note dates nothing.
 *
 * `valid_from` is the canonical UTC ISO form (ms precision, `Z`) the ledger writer and replay both enforce, so
 * comparing two of them as strings is comparing the times.
 *
 * Nothing is read until a hit carries an event id: text that holds none costs no query, and the one statement
 * is prepared once however many hits ask.
 */
export function createLedgerEventClock(
  db: Database.Database,
): (hit: { text: string; headingPath?: string }) => string | undefined {
  let lookup: Database.Statement | null | undefined; // undefined: not needed yet; null: no projection to ask
  const known = new Map<string, string | undefined>();

  const timeOf = (id: string): string | undefined => {
    const key = id.toUpperCase(); // projected ids are upper-case, and the unique index on facts(event_id) serves the lookup
    if (!known.has(key)) {
      if (lookup === undefined) lookup = prepareLookup(db);
      known.set(key, (lookup?.get(key, LIFECYCLE_NOTE_PATH) as { at: string } | undefined)?.at);
    }
    return known.get(key);
  };

  // A chunk is one event (the chunker splits at every event heading); one that carries several, as a legacy or a
  // hand-merged note can, is as new as the newest of them, the way a note is as new as its last write.
  return hit => {
    let newest: string | undefined;
    for (const id of ledgerEventIds(hit)) {
      const at = timeOf(id);
      if (at !== undefined && (newest === undefined || at > newest)) newest = at;
    }
    return newest;
  };
}

function prepareLookup(db: Database.Database): Database.Statement | null {
  if (!tableHasColumns(db, 'facts', ['event_id', 'source_path'])) return null;
  return prepareOnce(db, 'SELECT valid_from AS at FROM facts WHERE event_id = ? AND source_path = ?');
}
