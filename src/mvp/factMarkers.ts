import type Database from 'better-sqlite3';
import { listStatement, paddedList } from '../db/statements';
import { authorMarker, isImportSource, isReservedSource, type AuthorMarker } from '../memory/sourceName';
import { ledgerEventIds } from '../retrieval/ledgerLiveness';
import { DAILY_FILE_RE, parseEntryHeader } from '../memory/dailyNote';

/**
 * The author of each saved fact among these ledger events, by event id. Ids are lower-case in and out (ledgerEventIds);
 * an event with no fact is absent from the map, so a memory that is not a fact is never marked.
 */
export function factAuthorsByEvent(db: Database.Database, eventIds: readonly string[]): Map<string, string | null> {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return new Map();
  const rows = listStatement(
    db, ids.length, marks => `SELECT event_id AS eventId, author FROM facts WHERE event_id IN (${marks})`,
  ).all(...paddedList(ids.map(id => id.toUpperCase()))) as Array<{ eventId: string; author: string | null }>;
  return new Map(rows.map(row => [row.eventId.toLowerCase(), row.author]));
}

/**
 * The marker of a memory that is one or more ledger events. A chunk normally holds one event; when it holds several
 * facts of several authors, none is named, and an import or a reserved source among them is still marked untrusted.
 */
export function eventMarker(eventIds: readonly string[], authors: ReadonlyMap<string, string | null>, reader?: string): AuthorMarker {
  const saved = eventIds.filter(id => authors.has(id)).map(id => authors.get(id) ?? '');
  if (saved.length === 0) return {};
  const named = [...new Set(saved)];
  if (named.length === 1) return authorMarker(named[0], reader);
  return saved.some(author => isImportSource(author) || isReservedSource(author)) ? { untrusted: true } : {};
}

/**
 * Marks, in place, each search hit that is a saved fact: a ledger event by its author, and a fact an identity question
 * read by the author the retrieval carried (`author`, taken off so the reply holds the marker and not the raw name).
 * A hit that is none of those is left as it was, so the owner's own results are unchanged.
 */
export function markFactHits(
  db: Database.Database,
  hits: Array<{ notePath?: string; headingPath?: string; text: string; author?: string | null }>,
  reader: string | undefined,
  isLedger: (notePath: string) => boolean,
): void {
  const authors = factAuthorsByEvent(db, hits.filter(hit => isLedger(hit.notePath ?? '')).flatMap(hit => ledgerEventIds(hit)));
  for (const hit of hits) {
    if ('author' in hit) {
      Object.assign(hit, authorMarker(hit.author, reader));
      delete hit.author;
    } else if (isLedger(hit.notePath ?? '')) {
      Object.assign(hit, eventMarker(ledgerEventIds(hit), authors, reader));
    }
  }
}

/**
 * Whether a chunk of a daily log holds an entry whose header claims a reserved source (`- [09:00:00] (system) ...`): an entry
 * saved before the reserved-identity rule, or written into the file by hand. The search reads (get_context, search_memory,
 * search_text) mark such a chunk `untrusted`, as memory_map and read_memory mark the entry. A chunk is the unit a reply
 * carries, so the mark is on the whole chunk; text is never changed.
 */
export function claimsReservedEntrySource(notePath: unknown, text: unknown): boolean {
  if (typeof notePath !== 'string' || typeof text !== 'string' || !DAILY_FILE_RE.test(notePath)) return false;
  return text.split('\n').some(line => {
    const header = parseEntryHeader(line);
    return header !== null && isReservedSource(header.source);
  });
}
