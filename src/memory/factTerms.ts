import type Database from 'better-sqlite3';
import { prepareOnce } from '../db/statements';
import { normalizeScope, savedScopeSqlPredicate, scopeSpellings } from '../mvp/scope';

/**
 * The words a lifecycle fact is found by, and the index that finds facts by them.
 *
 * `fact_terms` is an inverted index over the facts table: one row per (word, scope, fact) for every
 * lifecycle fact, current or superseded, written by the transaction that writes the fact. A search
 * reads the rows of the query's words and joins only the facts they name, so a fact is found by its
 * words however old it is, and the work a read does is bounded (below), not a function of the table.
 *
 * How far a read goes down a word's rows. A word is *selective* when at most COMPLETE_POSTINGS rows
 * of the scope read have it (the rows of superseded facts count): its rows are read completely, so
 * every current fact that has it is found, however old, and is counted exactly, however many other
 * selective words the query has. A word with more rows is *common*: its rows are not read, and the
 * facts it finds are those among the RECENT_WINDOW newest current facts of the scope. So a table of
 * at most COMPLETE_POSTINGS facts is always read exactly, and so is any query with a selective word.
 * What is given up, and all of it: a fact that has none of the query's selective words and is older
 * than the newest RECENT_WINDOW facts is not found through common words alone, and an any-words read
 * ranks by at most MAX_COMMON_WORDS common words. Every candidate is ranked by the number of the
 * query's words it has.
 *
 * The work is bounded by the query, not by the table: a word costs at most COMPLETE_POSTINGS + 1
 * rows to classify, and a read collects at most COMPLETE_POSTINGS facts per selective word, so at
 * most (words in the query) x COMPLETE_POSTINGS candidates, plus RECENT_WINDOW; the tools cap a query
 * at 1,000 characters. Nothing is dropped to keep it so.
 *
 * It is derived data, like the rest of index.db: `ensureFactTerms` indexes whatever is missing (a
 * database from before the index, or one a release without it has written to). Rows are never
 * removed: a superseded fact keeps its rows, and the join to `facts` filters it out as current.
 *
 * No code deletes a lifecycle fact (a correction closes it). Code that ever does must delete its
 * rows here too, or the words of an erased fact stay in index.db. The table has no foreign key to
 * `facts` on purpose: deleting a note's facts would then scan this whole table once per fact.
 */

/** The words of `value` in the order they occur, repeats included. */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2);
}

export function words(value: string): string[] {
  return Array.from(new Set(tokens(value)));
}

/**
 * Like `words`, but slugs and snake_case split into their parts, the way the full-text index
 * reads them: `renor-memory-1002` is renor, memory and 1002.
 */
export function atoms(value: string): string[] {
  return Array.from(new Set(atomSequence(value)));
}

/** `atoms` in the order they occur, repeats included: which words are next to each other. */
export function atomSequence(value: string): string[] {
  return tokens(value.replace(/[-_]+/g, ' '));
}

function predicateWords(predicate: string): string[] {
  const out = new Set<string>();
  const irregularBases: Record<string, string> = {
    does: 'do',
    has: 'have',
  };

  for (const word of atoms(predicate)) {
    out.add(word);

    // Relation keys commonly use third-person singular verbs while users ask
    // with the base form. Keep this intentionally bounded so predicate nouns
    // such as "status" do not get arbitrary stems.
    const irregular = irregularBases[word];
    if (irregular) {
      out.add(irregular);
    } else if (/^[a-z]+ies$/.test(word) && word.length >= 5) {
      out.add(`${word.slice(0, -3)}y`);
    } else if (/^[a-z]+(ches|shes|xes|zes|oes|sses)$/.test(word)) {
      out.add(word.slice(0, -2));
    } else if (
      /^[a-z]+s$/.test(word)
      && word.length >= 4
      && !word.endsWith('ss')
      && !word.endsWith('us')
      && !word.endsWith('is')
    ) {
      out.add(word.slice(0, -1));
    }
  }
  return Array.from(out);
}

export interface FactText {
  subject: string;
  predicate: string;
  object: string;
}

// One prepared statement per connection and text (db/statements.ts): a save or a replay runs these once per fact.
export { prepareOnce };

/** The name a read shows for a subject: the entity's, which may be an earlier spelling of an event's. */
export function canonicalSubject(db: Database.Database, entityId: number): string {
  return (prepareOnce(db, 'SELECT canonical_name FROM entities WHERE id = ?').get(entityId) as { canonical_name: string }).canonical_name;
}

/** Every word a fact is found by: its subject and object, and its predicate with common verb forms. */
export function factVocabulary(fact: FactText): Set<string> {
  return new Set([...atoms(`${fact.subject} ${fact.object}`), ...predicateWords(fact.predicate)]);
}

/**
 * Indexes one fact. The empty term is a marker, not a word (a query word is never empty): it says
 * the fact has been indexed, so one whose text has no words is not indexed again and again.
 */
export function indexFactTerms(db: Database.Database, factId: number, scope: string, fact: FactText): void {
  prepareOnce(db, `INSERT OR IGNORE INTO fact_terms (term, scope, fact_id) SELECT value, ?, ? FROM json_each(?)`)
    .run(scope, factId, JSON.stringify(['', ...factVocabulary(fact)]));
}

/** Removes what indexFactTerms wrote for one fact (a retired fact: memory/lifecycle.ts). */
export function unindexFactTerms(db: Database.Database, factId: number, scope: string, fact: FactText): void {
  prepareOnce(db, `DELETE FROM fact_terms WHERE scope = ? AND fact_id = ? AND term IN (SELECT value FROM json_each(?))`)
    .run(scope, factId, JSON.stringify(['', ...factVocabulary(fact)]));
}

/** Indexes every lifecycle fact that is not indexed yet, in one transaction; returns how many. */
export function ensureFactTerms(db: Database.Database): number {
  const unindexed = db.prepare(
    `SELECT f.id AS id, f.scope AS scope, e.canonical_name AS subject, f.predicate AS predicate, f.object_text AS object
     FROM facts f JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.source_path = '_mcp_'
       AND NOT EXISTS (SELECT 1 FROM fact_terms t WHERE t.term = '' AND t.scope = f.scope AND t.fact_id = f.id)`,
  ).all() as Array<{ id: number; scope: string; subject: string; predicate: string; object: string | null }>;
  if (unindexed.length === 0) return 0;
  db.transaction(() => {
    for (const fact of unindexed) indexFactTerms(db, fact.id, fact.scope, { ...fact, object: fact.object ?? '' });
  })();
  return unindexed.length;
}

export interface CurrentFact {
  eventId: string | null;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string;
  scope: string;
  /** Who saved it. Absent on facts written before connection keys carried a name. */
  author?: string | null;
}

/** A current fact and how many of the query's words it is found by. */
export interface FactMatch extends CurrentFact {
  shared: number;
}

const FACT_COLUMNS = `f.event_id AS eventId, e.canonical_name AS subject, f.predicate AS predicate,
            f.object_text AS object, f.valid_from AS validFrom, f.scope AS scope, f.author AS author`;

/** A word with at most this many rows (in the scope read) is selective: its rows are read completely. */
export const COMPLETE_POSTINGS = 1_000;
/** A common word is matched among this many of the newest current facts of the scope. */
export const RECENT_WINDOW = 500;
/** An any-words read ranks by at most this many common words (the first in the query); selective words all count. */
export const MAX_COMMON_WORDS = 8;

/** A query word and what is known of its rows: all of them when it is selective, none when it is common. */
interface Word {
  term: string;
  ids: number[];
  common: boolean;
}

/**
 * The query's words that some fact has, selective ones first and the rarest of them first. Reads at
 * most COMPLETE_POSTINGS + 1 rows of a word, which is enough to know it is common. With `needAll`,
 * a word no fact has ends the read: nothing can have every word.
 */
function readWords(db: Database.Database, terms: readonly string[], scope: string | undefined, needAll: boolean): Word[] | null {
  const inScope = scope === undefined ? undefined : savedScopeSqlPredicate(normalizeScope(scope), 'scope');
  const read = prepareOnce(db, `SELECT fact_id FROM fact_terms WHERE term = ? ${inScope === undefined ? '' : `AND ${inScope.sql}`} LIMIT ?`).pluck();
  const found: Word[] = [];
  for (const term of terms) {
    const ids = read.all(term, ...(inScope?.params ?? []), COMPLETE_POSTINGS + 1) as number[];
    if (ids.length === 0) {
      if (needAll) return null;
      continue;
    }
    const common = ids.length > COMPLETE_POSTINGS;
    found.push({ term, ids: common ? [] : ids, common });
  }
  return found.sort((a, b) => Number(a.common) - Number(b.common) || a.ids.length - b.ids.length);
}

/**
 * The rows `read` returns for each spelling of `scope` (scopeSpellings), merged newest first and cut to `limit`.
 * `read` takes a spelling and a limit and returns at most that many rows of a partial index, newest first, so the
 * merge never sorts more than one `limit` per spelling, and a scope with one spelling (global) is returned as read.
 */
function newestOfSpellings<T extends { id: number; validFrom: string }>(read: Database.Statement, scope: string, limit: number): T[] {
  const spellings = scopeSpellings(normalizeScope(scope));
  const rows = spellings.flatMap(spelling => read.all(spelling, limit) as T[]);
  if (spellings.length === 1) return rows;
  return rows
    .sort((a, b) => (a.validFrom === b.validFrom ? b.id - a.id : a.validFrom < b.validFrom ? 1 : -1))
    .slice(0, limit);
}

/** The ids of the newest current facts of the scope: `RECENT_WINDOW` rows of a partial index per spelling, in order. */
function recentFactIds(db: Database.Database, scope: string | undefined): number[] {
  const read = prepareOnce(
    db,
    `SELECT f.id AS id, f.valid_from AS validFrom FROM facts f INDEXED BY ${scope === undefined ? 'idx_facts_lifecycle_recent' : 'idx_facts_lifecycle_scope_recent'}
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' ${scope === undefined ? '' : 'AND f.scope = ?'}
     ORDER BY f.valid_from DESC, f.id DESC LIMIT ?`,
  );
  const rows = scope === undefined
    ? read.all(RECENT_WINDOW) as Array<{ id: number; validFrom: string }>
    : newestOfSpellings<{ id: number; validFrom: string }>(read, scope, RECENT_WINDOW);
  return rows.map(row => row.id);
}

/**
 * The current facts found by `terms`, best first: more of the words, then newest. `scope` is one
 * scope when given (a normalized scope, read under every spelling of it: scopeSpellings) and every
 * scope when omitted. Only current lifecycle facts count.
 *
 * `any` ranks the facts that have at least one word; `all` needs every word. How much of a word's
 * rows is read, and what that gives up, is in the header of this file.
 */
export function findCurrentFacts(
  db: Database.Database,
  args: { terms: readonly string[]; scope?: string; match: 'all' | 'any'; limit: number },
): FactMatch[] {
  const { scope, match, limit } = args;
  const terms = [...new Set(args.terms)].filter(term => term !== ''); // '' is the marker row, never a word
  if (terms.length === 0 || limit < 1) return [];
  const words = readWords(db, terms, scope, match === 'all');
  if (!words || words.length === 0) return [];
  const scoped = scope === undefined ? undefined : savedScopeSqlPredicate(normalizeScope(scope), 'f.scope');
  const inScope = scoped === undefined ? '' : `AND ${scoped.sql}`;
  const scopeArgs = scoped?.params ?? [];

  if (match === 'any') {
    // Every selective word is read completely; only the common words are matched through the newest
    // facts, and at most MAX_COMMON_WORDS of them are probed.
    const probed = words.filter(word => word.common).slice(0, MAX_COMMON_WORDS);
    // Fact id -> how many selective words it has, counted from the rows already read.
    const candidates = new Map<number, number>();
    for (const word of words) if (!word.common) for (const id of word.ids) candidates.set(id, (candidates.get(id) ?? 0) + 1);
    if (probed.length > 0) for (const id of recentFactIds(db, scope)) if (!candidates.has(id)) candidates.set(id, 0);
    // The candidates are ranked on their id, date and count alone; only the `limit` best are joined to
    // their entity and read in full. A window fact that has none of the probed words scores 0 and is dropped.
    return prepareOnce(
      db,
      `WITH scored AS MATERIALIZED (
         SELECT f.id AS id, f.valid_from AS validFrom,
                json_extract(c.value, '$[1]')${probed.length === 0 ? '' : `
                  + (SELECT COUNT(*) FROM fact_terms p
                     WHERE p.term IN (${probed.map(() => '?').join(', ')}) AND p.scope = f.scope AND p.fact_id = f.id)`} AS shared
         FROM json_each(?) c
         CROSS JOIN facts f ON f.id = json_extract(c.value, '$[0]')
         WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' ${inScope}
       ), best AS (
         SELECT id, validFrom, shared FROM scored WHERE shared > 0
         ORDER BY shared DESC, validFrom DESC, id DESC
         LIMIT ?
       )
       SELECT ${FACT_COLUMNS}, b.shared AS shared
       FROM best b
       JOIN facts f ON f.id = b.id
       JOIN entities e ON e.id = f.subject_entity_id
       ORDER BY b.shared DESC, b.validFrom DESC, b.id DESC`,
    ).all(...probed.map(word => word.term), JSON.stringify([...candidates]), ...scopeArgs, limit) as FactMatch[];
  }

  // `all`: every fact that has every word has the rarest selective word, so its rows are the
  // candidates and the other words are probed, one candidate at a time. With no selective word, the
  // candidates are the newest facts and every word is probed.
  const driver = words.find(word => !word.common);
  const candidates = driver ? driver.ids : recentFactIds(db, scope);
  const probed = words.filter(word => word !== driver).map(word => word.term);
  return prepareOnce(
    db,
    `SELECT ${FACT_COLUMNS}, ${terms.length} AS shared
     FROM json_each(?) c
     CROSS JOIN facts f ON f.id = c.value
     JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' ${inScope}
       ${probed.map(() => 'AND EXISTS (SELECT 1 FROM fact_terms p WHERE p.term = ? AND p.scope = f.scope AND p.fact_id = f.id)').join('\n       ')}
     ORDER BY f.valid_from DESC, f.id DESC
     LIMIT ?`,
  ).all(JSON.stringify(candidates), ...scopeArgs, ...probed, limit) as FactMatch[];
}

/**
 * The ledger event that wrote the newest lifecycle fact (current or superseded) of one scope, or of
 * every scope when none is given. A scope's newest fact is the last row of its marker in the term
 * index, one seek per spelling of the scope (scopeSpellings); without a scope it is the last row of
 * the facts table.
 */
export function newestFactEvent(db: Database.Database, scope?: string): string | undefined {
  if (scope === undefined) {
    const row = prepareOnce(db, `SELECT event_id AS eventId FROM facts WHERE source_path = '_mcp_' AND event_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
    return (row as { eventId: string } | undefined)?.eventId;
  }
  const read = prepareOnce(
    db,
    `SELECT t.fact_id AS id, f.event_id AS eventId
     FROM fact_terms t CROSS JOIN facts f ON f.id = t.fact_id
     WHERE t.term = '' AND t.scope = ? AND f.source_path = '_mcp_' AND f.event_id IS NOT NULL
     ORDER BY t.fact_id DESC LIMIT 1`,
  );
  let newest: { id: number; eventId: string } | undefined;
  for (const spelling of scopeSpellings(normalizeScope(scope))) {
    const row = read.get(spelling) as { id: number; eventId: string } | undefined;
    if (row && (!newest || row.id > newest.id)) newest = row;
  }
  return newest?.eventId;
}

/** One current lifecycle fact by its row id; undefined once it is superseded (or was never a lifecycle fact). */
export function currentFactById(db: Database.Database, id: number): CurrentFact | undefined {
  return prepareOnce(
    db,
    `SELECT ${FACT_COLUMNS}
     FROM facts f JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.id = ? AND f.valid_to IS NULL AND f.source_path = '_mcp_'`,
  ).get(id) as CurrentFact | undefined;
}

/**
 * The newest current facts, for a read with no query. The partial indexes (migration 14) keep them
 * in order, so this reads `limit` rows however many facts there are; `INDEXED BY` states that
 * intent, because the planner would otherwise pick the source_path index and sort every fact.
 */
export function recentCurrentFacts(db: Database.Database, scope: string | undefined, limit: number): CurrentFact[] {
  const read = db.prepare(
    `SELECT ${FACT_COLUMNS}, f.id AS id
     FROM facts f INDEXED BY ${scope === undefined ? 'idx_facts_lifecycle_recent' : 'idx_facts_lifecycle_scope_recent'}
     JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' ${scope === undefined ? '' : 'AND f.scope = ?'}
     ORDER BY f.valid_from DESC, f.id DESC
     LIMIT ?`,
  );
  const rows = scope === undefined
    ? read.all(limit) as Array<CurrentFact & { id: number }>
    : newestOfSpellings<CurrentFact & { id: number }>(read, scope, limit);
  return rows.map(({ id: _id, ...fact }) => fact); // the row id only orders the merge
}
