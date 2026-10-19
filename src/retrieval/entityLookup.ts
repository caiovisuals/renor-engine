import Database from 'better-sqlite3';
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

interface NameBounds { name: number; alias: number; note: number }

/**
 * The longest canonical name, alias and source path, in SQLite characters (one code point, not a JavaScript UTF-16
 * unit). Read once until the next write. An alias list that cannot be read counts as unbounded, so that query still runs.
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
    return { name: Number(row.name), alias: Number(alias), note: Number(row.note) };
  });
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
      .get(name, ...params) as any;
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
      .get(name, ...params) as any;
    if (byAlias) return toRow(byAlias);
  }

  // Partial match: canonical_name contains the search term (e.g. "User" → "USER.md — About User")
  if (fits(bounds.name)) {
    const byPartial = prepareOnce(
      db,
      `SELECT * FROM entities WHERE instr(lower(canonical_name), lower(?)) > 0${where} ORDER BY length(canonical_name) ASC, ${tieOrder()} LIMIT 1`,
    )
      .get(name, ...params) as any;
    if (byPartial) return toRow(byPartial);
  }

  // Path match: source note path contains the search term (e.g. "Cora" → notes in .../Cora/...)
  if (fits(bounds.note)) {
    const byPath = prepareOnce(
      db,
      `SELECT * FROM entities WHERE instr(lower(source_note), lower(?)) > 0${where} ORDER BY length(canonical_name) ASC, ${tieOrder()} LIMIT 1`,
    )
      .get(name, ...params) as any;
    if (byPath) return toRow(byPath);
  }

  return null;
}

function toRow(r: any): EntityRow {
  return { id: r.id, type: r.type, canonicalName: r.canonical_name, aliases: JSON.parse(r.aliases_json ?? '[]'), sourceNote: r.source_note, confidence: r.confidence };
}