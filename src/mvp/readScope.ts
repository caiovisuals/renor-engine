import type Database from 'better-sqlite3';
import { tableHasColumns } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { LIFECYCLE_NOTE_PATH } from '../memory/lifecycle';
import { ledgerEventIds, resolveLedgerHits } from '../retrieval/ledgerLiveness';
import { notePathMatchesScope, savedScopeMatches, savedScopeSqlPredicate, scopeSqlPredicate, type NormalizedScope } from './scope';

/**
 * What belongs to the scope a read asked for.
 *
 * A scope partitions memory: every item belongs to exactly one scope. A note belongs to the scope its path
 * says (`Memory/Scopes/<slug>/…`; any other path is global). A ledger event, and the lifecycle fact projected
 * from it, belongs to the scope it was saved in. The ledger is ONE global file, so its path says nothing about
 * which scope an event in it belongs to; the scope recorded on the event (`facts.scope`, the same value
 * retrieve_memory filters on) is the only truth. A named scope is its slug for both: an event saved in
 * `project:<slug>` belongs to `scope:<slug>` too, as a note in `Memory/Scopes/<slug>/` does (scopeSpellings).
 *
 * A read without a scope sees every scope, `global` sees global memory only, a named scope sees its own only.
 * include_history changes which events of a scope are shown (its superseded ones too), never which scope's.
 * Text of the ledger that is no event (its own header) has no scope of its own and follows the ledger's path: global.
 */

/** What is judged: a chunk-like hit. `chunkId < 0` marks a lifecycle fact offered as a hit (`-chunkId` is its row). */
export interface ScopedHit {
  notePath: string;
  text: string;
  headingPath?: string;
  chunkId?: number;
}

export interface ReadScope {
  /** Whether one hit belongs to the scope. `notePath` is the vault-relative path a note is judged by. */
  has(hit: ScopedHit, notePath: string): boolean;
  /** The hits that belong to the scope. `notePath` gives the vault-relative path a note is judged by. */
  hits<T extends ScopedHit>(hits: T[], notePath: (hit: T) => string): T[];
  /** A note body without the ledger events that were saved in other scopes. */
  body(text: string): string;
  /** The ids of every chunk of the index the scope holds: what `has` answers for each, in one pass over the index. */
  chunkIds(notePath: (stored: string) => string): number[];
}

/** How many chunks naming an event make reading every event's scope at once cheaper than asking about each. */
const PRELOAD_EVENTS_FROM = 64;

export function createReadScope(db: Database.Database, scope: NormalizedScope): ReadScope {
  const projected = tableHasColumns(db, 'facts', ['event_id', 'scope']);
  const eventRow = projected
    ? prepareOnce(db, `SELECT COALESCE(scope, 'global') AS scope FROM facts WHERE event_id = ? AND source_path = ?`)
    : null;
  const factRow = projected
    ? prepareOnce(db, `SELECT COALESCE(scope, 'global') AS scope FROM facts WHERE id = ? AND source_path = ?`)
    : null;
  const own = savedScopeSqlPredicate(scope, `COALESCE(scope, 'global')`);
  const otherScopeRows = projected
    ? prepareOnce(db, `SELECT event_id FROM facts WHERE source_path = ? AND event_id IS NOT NULL AND NOT (${own.sql})`)
    : null;

  // Event ids are stored upper-case, so the unique index on facts(event_id) answers each lookup.
  const events = new Map<string, string | undefined>();
  /** The scope an event was saved in; undefined when the lifecycle layer knows no such event. */
  const eventScope = (id: string): string | undefined => {
    const key = id.toUpperCase();
    if (!events.has(key)) events.set(key, (eventRow?.get(key, LIFECYCLE_NOTE_PATH) as { scope: string } | undefined)?.scope);
    return events.get(key);
  };

  /**
   * Every event's scope in one read, for the pass over the index (`chunkIds`) that asks about the event of each of its
   * thousands of ledger chunks: one statement each was most of a scoped read's cost, growing with every fact saved. What
   * is kept is what `eventScope` would find: the event of that upper-case id, in the lifecycle layer. An id that is not
   * kept (not upper-case, or not an event) is asked about one by one, as before.
   */
  const preloadEvents = (): void => {
    if (!projected) return;
    const rows = prepareOnce(
      db,
      `SELECT event_id AS id, COALESCE(scope, 'global') AS scope FROM facts WHERE source_path = ? AND event_id IS NOT NULL`,
    ).all(LIFECYCLE_NOTE_PATH) as Array<{ id: string; scope: string }>;
    for (const row of rows) if (row.id === row.id.toUpperCase() && !events.has(row.id)) events.set(row.id, row.scope);
  };

  let elsewhere: Set<string> | undefined; // ids (lower-case) of the events saved in other scopes, read on first use

  const has = (hit: ScopedHit, notePath: string): boolean => {
    // A fact has no note path to judge it by: the scope on its row decides, and a fact whose row is gone is dropped.
    if (hit.notePath === LIFECYCLE_NOTE_PATH && typeof hit.chunkId === 'number' && hit.chunkId < 0) {
      const row = factRow?.get(-hit.chunkId, LIFECYCLE_NOTE_PATH) as { scope: string } | undefined;
      return row !== undefined && savedScopeMatches(row.scope, scope);
    }
    // A hit is one chunk, so one event (the chunker splits at every event heading): shown whole, or not at all.
    // Anything that only looks like an event id (an ordinary heading) is no event, and its note path decides.
    const saved = ledgerEventIds(hit).map(eventScope).filter((s): s is string => s !== undefined);
    if (saved.length) return saved.every(s => savedScopeMatches(s, scope));
    return notePathMatchesScope(notePath, scope);
  };

  return {
    has,

    hits(hits, notePath) {
      return hits.filter(hit => has(hit, notePath(hit)));
    },

    body(text) {
      // Only the ledger holds events: any other note is returned as it is, without asking the database anything.
      if (!ledgerEventIds({ text }).length) return text;
      // A body holds every event, so the ids of other scopes' events are read in one query, once per read, rather than
      // looked up event by event (a 3,000-event ledger: body() 19 ms, now 6 ms).
      elsewhere ??= new Set((otherScopeRows?.all(LIFECYCLE_NOTE_PATH, ...own.params) as Array<{ event_id: string }> | undefined ?? [])
        .map(r => r.event_id.toLowerCase()));
      if (!elsewhere.size) return text;
      // The note is cut block by block. Another scope's events go the way closed ones go without history: never
      // shown, and never labelled as history either.
      return resolveLedgerHits([{ text, reason: 'other-scope' }], elsewhere, false)[0]?.text ?? '';
    },

    chunkIds(notePath) {
      // `has` reads a chunk's text only for a line that opens an event (`## MEM_… · `, in any case): every other text is
      // read here as empty, so the pass reads paths and headings, and the text of the few chunks that could hold one. A
      // named scope holds no chunk that names no event outside its own directory (scopeSqlPredicate, the SQL twin of
      // notePathMatchesScope), so only the chunks under it or naming an event are judged; the global scope, every chunk.
      const namesEvent = "text GLOB '*## [Mm][Ee][Mm]_*'";
      const under = scope === 'global' ? null : scopeSqlPredicate(scope, 'note_path');
      const rows = prepareOnce(
        db,
        `SELECT id AS chunkId, note_path AS notePath, heading_path AS headingPath,
                CASE WHEN ${namesEvent} THEN text ELSE '' END AS text
         FROM chunks${under ? ` WHERE ${under.sql} OR ${namesEvent} OR heading_path GLOB '*[Mm][Ee][Mm]_*'` : ''}`,
      ).all(...(under?.params ?? [])) as Array<ScopedHit & { chunkId: number }>;
      // A chunk that names an event is the only one that asks the lifecycle layer anything: a few ask one by one, a
      // ledger's thousands ask all at once.
      const namesOne = (row: ScopedHit) => row.text !== '' || (row.headingPath ?? '').toUpperCase().includes('MEM_');
      if (rows.reduce((n, row) => n + (namesOne(row) ? 1 : 0), 0) > PRELOAD_EVENTS_FROM) preloadEvents();
      const shown = new Map<string, string>(); // a note's chunks share its path (the ledger is one note)
      const pathOf = (stored: string) => {
        let judged = shown.get(stored);
        if (judged === undefined) shown.set(stored, (judged = notePath(stored)));
        return judged;
      };
      return rows.filter(row => has(row, pathOf(row.notePath))).map(row => row.chunkId);
    },
  };
}
