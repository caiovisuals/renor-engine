import Database from '../db/sqlite';
import { readUntilWrite } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import { savedScopeSqlPredicate, scopeSqlPredicate, type NormalizedScope } from '../mvp/scope';

export interface EntityRow { id: number; type: string; canonicalName: string; aliases: string[]; sourceNote: string; confidence: number }

/**
 * An extra boolean SQL predicate over the entities row, bound positionally from
 * `params`. Callers pass a scope restriction here rather than filtering the
 * result afterwards: `lookupEntity` returns one row, so an out-of-scope match
 * chosen first would shadow an in-scope one, and a post-filter would have to
 * reveal that it had found something in order to hide it.
 */
export interface EntityRowFilter { sql: string; params: unknown[] }

/** The note that owns the lifecycle entities, the subjects remembered facts are about (mirrors lifecycle.ts). */
const LIFECYCLE_NOTE_PATH = '_mcp_';

/**
 * The entities that belong to `scope`, as a filter for `lookupEntity` and for counting entities. A lifecycle subject
 * belongs to every scope one of its facts was saved in (under any spelling of it: savedScopeSqlPredicate), current or
 * superseded, the rule retrieve_memory judges a subject's existence by: its source note is the reserved name `_mcp_`,
 * not a path, and says nothing about scope (read as a path it would be global, so a global lookup would name subjects
 * saved only in a named scope, and a named scope would find none of its own). Every other entity belongs to the scope
 * its source note's path names.
 */
export function entityScopeFilter(scope: NormalizedScope): { sql: string; params: string[] } {
  const saved = savedScopeSqlPredicate(scope, 'f.scope');
  const path = scopeSqlPredicate(scope, 'entities.source_note');
  return {
    sql: `CASE WHEN entities.source_note = ? THEN EXISTS (SELECT 1 FROM facts f WHERE f.subject_entity_id = entities.id AND ${saved.sql}) ELSE ${path.sql} END`,
    params: [LIFECYCLE_NOTE_PATH, ...saved.params, ...path.params],
  };
}

/**
 * The entities of every scope, as a filter for `lookupEntity` and for counting entities: a lifecycle subject only while
 * it has a fact that is not retired (memory/lifecycle.ts moves a retired fact out of `facts`), the rule
 * entityScopeFilter applies within one scope; every other entity.
 */
export function liveEntityFilter(): { sql: string; params: string[] } {
  return {
    sql: `CASE WHEN entities.source_note = ? THEN EXISTS (SELECT 1 FROM facts f WHERE f.subject_entity_id = entities.id) ELSE 1 END`,
    params: [LIFECYCLE_NOTE_PATH],
  };
}

/**
 * Of entities that match a name equally well, which one answers: a remembered fact's subject first, then by source
 * note path, then the oldest. Left to SQLite, the first row read answers, which is the note indexing happened to
 * write first, and concurrent indexing writes notes in no fixed order.
 */
function tieOrder(table = ''): string {
  return `(${table}source_note = '${LIFECYCLE_NOTE_PATH}') DESC, ${table}source_note, ${table}id`;
}

/**
 * `names` and `notes` hold one bit for each UTF-16 unit: set when the unit is in some canonical name (`names`) or source path
 * (`notes`) once SQLite's `lower` has folded its capitals. Null when that cannot be said, and then no query is ruled out by it.
 */
interface NameBounds { name: number; alias: number; note: number; names: Uint32Array | null; notes: Uint32Array | null }

/**
 * The units that occur in `column` of any entity, folded the way SQLite's `lower` folds (A to Z only: a build with ICU would
 * fold more, and `lowerIsAscii` says whether this one does). Null when a value is not text.
 */
function unitsOf(db: Database.Database, column: 'canonical_name' | 'source_note'): Uint32Array | null {
  const units = new Uint32Array(0x10000 / 32);
  for (const value of prepareOnce(db, `SELECT ${column} FROM entities`).pluck().all() as unknown[]) {
    if (value === null) continue; // instr(NULL, x) is NULL: such a row never matches
    if (typeof value !== 'string') return null;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      const folded = unit >= 65 && unit <= 90 ? unit + 32 : unit;
      units[folded >> 5] |= 1 << (folded & 31);
    }
  }
  return units;
}

/** Whether `lower` leaves everything but A to Z alone, which is what `unitsOf` assumes. */
function lowerIsAscii(db: Database.Database): boolean {
  const probe = 'ÀÉÎÕÜÇΩДЖİß';
  return prepareOnce(db, 'SELECT lower(?)').pluck().get(`${probe}ABC`) === `${probe}abc`;
}

/**
 * The longest canonical name, alias and source path, in SQLite characters (one code point, not a JavaScript UTF-16
 * unit), and the units that occur in the names and in the paths. Read once until the next write. An alias list that cannot
 * be read counts as unbounded, so that query still runs.
 */
function entityNameBounds(db: Database.Database): NameBounds {
  return readUntilWrite(db, 'entityLookupBounds', () => {
    const row = prepareOnce(
      db,
      `SELECT COALESCE(MAX(length(canonical_name)), 0) AS name, COALESCE(MAX(length(source_note)), 0) AS note FROM entities`,
    ).get() as { name: number; note: number };
    let alias = Number.POSITIVE_INFINITY;
    try {
      alias = prepareOnce(
        db,
        `SELECT COALESCE(MAX(length(alias.value)), 0) AS n FROM entities AS e, json_each(e.aliases_json) AS alias`,
      ).pluck().get() as number;
    } catch { /* malformed aliases: do not skip the alias query */ }
    const folded = lowerIsAscii(db);
    return {
      name: Number(row.name),
      alias: Number(alias),
      note: Number(row.note),
      names: folded ? unitsOf(db, 'canonical_name') : null,
      notes: folded ? unitsOf(db, 'source_note') : null,
    };
  });
}

/**
 * False when `name` cannot be a substring of any value whose units are `units`: it has a unit (capitals folded) that none
 * of them has. A name with a half of a pair, or a NUL, is left to SQLite.
 */
function mayBeWithin(units: Uint32Array | null, name: string): boolean {
  if (units === null) return true;
  for (let i = 0; i < name.length; i++) {
    const unit = name.charCodeAt(i);
    if (unit === 0 || (unit >= 0xd800 && unit <= 0xdfff)) return true;
    const folded = unit >= 65 && unit <= 90 ? unit + 32 : unit;
    if ((units[folded >> 5] & (1 << (folded & 31))) === 0) return false;
  }
  return true;
}

/**
 * Resolve an entity by name or alias, then by substring of a canonical name,
 * then by substring of its source note path.
 *
 * `filter`, when given, is applied inside every candidate query — the scope has
 * to constrain the search, not the answer, or the search still reads the rows
 * the caller may not see.
 */
export function lookupEntity(db: Database.Database, name: string, filter?: EntityRowFilter): EntityRow | null {
  const where = filter ? ` AND (${filter.sql})` : '';
  const params = filter ? filter.params : [];
  // `lower` and NOCASE keep a string's length, and `instr` cannot match a needle longer than the haystack. The length
  // is SQLite's: a JavaScript `.length` counts one code point above U+FFFF as two and would skip a real name.
  const bounds = entityNameBounds(db);
  const qlen = (prepareOnce(db, 'SELECT length(?) AS n').get(name) as { n: number | null }).n;
  const fits = (max: number) => qlen === null || qlen <= max;
  if (!fits(bounds.name) && !fits(bounds.alias) && !fits(bounds.note)) return null;

  if (fits(bounds.name)) {
    const byName = prepareOnce(db, `SELECT * FROM entities WHERE canonical_name = ? COLLATE NOCASE${where} ORDER BY ${tieOrder()} LIMIT 1`)
      .get(name, ...params) as EntityDbRow | undefined;
    if (byName) return toRow(byName);
  }

  // Unaliased, as in the other three queries, so a filter can name the row's own columns as `entities.<column>`.
  if (fits(bounds.alias)) {
    const byAlias = prepareOnce(
      db,
      `SELECT entities.* FROM entities, json_each(entities.aliases_json) AS alias
       WHERE lower(alias.value) = lower(?)${where}
       ORDER BY ${tieOrder('entities.')}
       LIMIT 1`,
    )
      .get(name, ...params) as EntityDbRow | undefined;
    if (byAlias) return toRow(byAlias);
  }

  // Partial match: canonical_name contains the search term (e.g. "User" → "USER.md — About User")
  if (fits(bounds.name) && mayBeWithin(bounds.names, name)) {
    const byPartial = prepareOnce(
      db,
      `SELECT * FROM entities WHERE instr(lower(canonical_name), lower(?)) > 0${where} ORDER BY length(canonical_name) ASC, ${tieOrder()} LIMIT 1`,
    )
      .get(name, ...params) as EntityDbRow | undefined;
    if (byPartial) return toRow(byPartial);
  }

  // Path match: source note path contains the search term (e.g. "Cora" → notes in .../Cora/...)
  if (fits(bounds.note) && mayBeWithin(bounds.notes, name)) {
    const byPath = prepareOnce(
      db,
      `SELECT * FROM entities WHERE instr(lower(source_note), lower(?)) > 0${where} ORDER BY length(canonical_name) ASC, ${tieOrder()} LIMIT 1`,
    )
      .get(name, ...params) as EntityDbRow | undefined;
    if (byPath) return toRow(byPath);
  }

  return null;
}

/** An `entities` table row, as SQLite returns it. */
interface EntityDbRow { id: number; type: string; canonical_name: string; aliases_json: string | null; source_note: string; confidence: number }

function toRow(r: EntityDbRow): EntityRow {
  return { id: r.id, type: r.type, canonicalName: r.canonical_name, aliases: JSON.parse(r.aliases_json ?? '[]'), sourceNote: r.source_note, confidence: r.confidence };
}