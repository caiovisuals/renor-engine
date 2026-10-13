import type Database from 'better-sqlite3';
import { normDedupeValue } from '../context/rowStore';
import { identityKey, identityNames } from '../retrieval/queryHelpers';
import { prepareOnce } from './factTerms';
import { normalizeScope, savedScopeSqlPredicate } from '../mvp/scope';
import { authorMarker, type AuthorMarker } from './sourceName';

/**
 * Multi-agent drift: current lifecycle facts that may be one thing, named, never merged.
 *
 * A correction closes only the current fact of the same subject (one identity: case and Unicode form folded),
 * predicate and scope (any spelling of it, scopeSpellings). When several agents write, the same thing gets saved under another name (Codex writes
 * "Atlas project", Claude Code writes "Atlas") or in another scope (a correction saved without the project's scope
 * goes to global), and then both values stay current. This module supersedes nothing across subjects or scopes.
 * It names what may be one thing, so the agent or the user can decide:
 *
 *   - `possibleDuplicates`, on a fact save's receipt: the other current facts related to the one just written;
 *   - `conflicts`, on a read: groups of related current facts whose values disagree, for the facts the read returns.
 *
 * Two facts are related when they have the same predicate and their subjects are one identity (`identityKey`), or
 * one name is the other with one more word before or after it: "Atlas" and "Atlas project", "staging database" and
 * "Atlas staging database". A name longer by more words ("Atlas service shipments") or a possessive ("Ravi's
 * manager", "user's mother") names another thing. Values are compared after `normDedupeValue`, so "Sao Paulo" and
 * "São Paulo" do not disagree.
 *
 * Scope stays an isolation boundary. A call made in a scope sees that scope's facts only, as its reads do
 * (`scopeFilterFor`), so it is never told what another scope holds. A call without a scope sees every scope, so it
 * is the one told that a subject and predicate have another current value elsewhere.
 *
 * Cost: one pass over the current lifecycle facts that reads the subject names of those with an asked predicate, then
 * the facts whose name passes a word test in full. Measured with 12 asked facts, 6 of them sharing their predicate with
 * a quarter of the facts (host load about 45): 0.4 ms at 150 current facts, 2.4 ms at 2,000, 17 ms at 20,000. Nothing
 * is written and nothing is embedded.
 */

/** The most values a conflict, or a receipt's duplicates, lists: the newest first, with the total when there are more. */
export const MAX_DRIFT_VALUES = 8;

/** One current lifecycle fact, as the reads show it. */
export interface DriftValue extends AuthorMarker {
  subject: string;
  object: string;
  scope: string;
  validFrom: string;
}

/** Related current facts whose values disagree. */
export interface DriftConflict {
  predicate: string;
  /** The facts, newest first. */
  values: DriftValue[];
  /** How many related facts there are, when `values` lists only the newest MAX_DRIFT_VALUES. */
  total?: number;
}

interface Row extends DriftValue {
  id: number;
  predicate: string;
  author?: string | null;
}

/** A subject name as relatedness reads it: its words (null when it contains nothing) and, once asked, its identity key. */
interface Name {
  subject: string;
  words: string[] | null;
  key?: string;
}

/** A folded word that ends in an apostrophe and s ("ravi's", "ravi’s") or in s and an apostrophe ("users'"). */
const POSSESSIVE = /[\p{L}\p{N}](?:['’]s|s['’])(?=\s|$)/u;

/** The fold identityKey applies before its alias table: NFC, trimmed, lower-cased. */
function fold(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().normalize('NFC');
}

/** What separates two words of a folded name. A word keeps its hyphens and underscores: "atl-412" is one word. */
const NOT_A_WORD = /[^\p{L}\p{N}\p{M}_-]+/u;

/** The words of a subject name, by name: a read reads the name of every current fact with an asked predicate, and the names are the same read after read. */
const wordsOfName = new Map<string, string[] | null>();
const MAX_WORDS_OF_NAME = 8192;

function wordsOf(subject: string): string[] | null {
  let words = wordsOfName.get(subject);
  if (words === undefined) {
    const folded = fold(subject);
    const split = POSSESSIVE.test(folded) ? [] : folded.split(NOT_A_WORD).filter(Boolean);
    words = split.length > 0 ? split : null;
    if (wordsOfName.size >= MAX_WORDS_OF_NAME) wordsOfName.clear();
    wordsOfName.set(subject, words);
  }
  return words;
}

function nameOf(subject: string, names: Map<string, Name>): Name {
  let name = names.get(subject);
  if (!name) {
    name = { subject, words: wordsOf(subject) };
    names.set(subject, name);
  }
  return name;
}

/** Whether `longer` is `shorter` plus one word at its start or its end. */
function oneWordLonger(longer: string[], shorter: string[]): boolean {
  if (longer.length !== shorter.length + 1) return false;
  const same = (offset: number) => shorter.every((word, i) => longer[i + offset] === word);
  return same(0) || same(1);
}

function related(a: Name, b: Name): boolean {
  if ((a.key ??= identityKey(a.subject)) === (b.key ??= identityKey(b.subject))) return true;
  if (!a.words || !b.words) return false;
  return oneWordLonger(a.words, b.words) || oneWordLonger(b.words, a.words);
}

/**
 * The current lifecycle facts, in one scope or (null) every scope, newest first, that have the predicate of an asked
 * fact and a subject that may be related to its subject; `related` then decides. A related name has the asked name's
 * first word first, or its last word last: it is the same words, or one more, or one fewer at its start or end. So
 * one pass reads the subject name of every current fact with an asked predicate, and only the facts whose name passes
 * that test are read in full. A possessive asked name is related by identity alone, so it is looked for whole; an
 * alias is looked for by each of its spellings. The partial index of current lifecycle facts holds the predicate, so
 * superseded facts are never visited: `INDEXED BY` states it, because the planner would otherwise take the
 * source_path index, which holds every lifecycle fact ever saved.
 */
function candidates(
  db: Database.Database,
  asked: ReadonlyArray<{ subject: string; predicate: string }>,
  scope: string | null,
  names: Map<string, Name>,
): Row[] {
  const firsts = new Set<string>();
  const lasts = new Set<string>();
  const wholes = new Set<string>();
  for (const { subject } of asked) {
    for (const spelling of identityNames(subject)) {
      const { words } = nameOf(spelling, names);
      if (words) {
        firsts.add(words[0]);
        lasts.add(words[words.length - 1]);
      } else {
        wholes.add(fold(spelling));
      }
    }
  }
  const inScope = scope === null ? null : savedScopeSqlPredicate(normalizeScope(scope), 'f.scope'); // any spelling of it
  const named = prepareOnce(
    db,
    `SELECT f.id, e.canonical_name
     FROM facts f INDEXED BY idx_facts_current
     JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_'
       AND f.predicate IN (SELECT value FROM json_each(?))${inScope ? `
       AND ${inScope.sql}` : ''}`,
  ).raw().all(JSON.stringify([...new Set(asked.map(fact => fact.predicate))]), ...(inScope?.params ?? [])) as Array<[number, string]>;
  const ids = named.filter(([, subject]) => {
    const { words } = nameOf(subject, names);
    return words ? firsts.has(words[0]) || lasts.has(words[words.length - 1]) : wholes.has(fold(subject));
  }).map(([id]) => id);
  if (ids.length === 0) return [];
  return prepareOnce(
    db,
    `SELECT f.id AS id, e.canonical_name AS subject, f.predicate AS predicate, COALESCE(f.object_text, '') AS object,
            f.scope AS scope, f.valid_from AS validFrom, f.author AS author
     FROM json_each(?) c
     CROSS JOIN facts f ON f.id = c.value
     JOIN entities e ON e.id = f.subject_entity_id
     ORDER BY f.valid_from DESC, f.id DESC`,
  ).all(JSON.stringify(ids)) as Row[];
}

/** A value as a read shows it: who saved it, when it is another agent's or an import's (memory/sourceName.ts). */
function shown(row: Row, reader?: string): DriftValue {
  return { subject: row.subject, object: row.object, scope: row.scope, validFrom: row.validFrom, ...authorMarker(row.author, reader) };
}

/**
 * The receipt of a fact save: the other current facts with its predicate whose subject is related to the one written,
 * newest first. `factId` is the fact the save left current (it is not its own duplicate); `scope` is the save's scope
 * filter (null when the call named no scope).
 */
export function possibleDuplicates(
  db: Database.Database,
  written: { subject: string; predicate: string },
  factId: number | null,
  scope: string | null,
  reader?: string,
): { values: DriftValue[]; total: number } {
  const names = new Map<string, Name>();
  const asked = nameOf(written.subject, names);
  const found = candidates(db, [written], scope, names)
    .filter(row => row.id !== factId && related(asked, nameOf(row.subject, names)));
  return { values: found.slice(0, MAX_DRIFT_VALUES).map(row => shown(row, reader)), total: found.length };
}

/**
 * The conflicts behind the current lifecycle facts a read returns: for each of them, the current facts related to it
 * (its own row included); every group that holds two different values is one conflict. Groups that share a fact are
 * one conflict. Conflicts come in the order of the first fact that names them. `scope` is the read's scope filter
 * (null when the read named no scope).
 */
export function namedConflicts(
  db: Database.Database,
  facts: ReadonlyArray<{ subject: string; predicate: string }>,
  scope: string | null,
  reader?: string,
): DriftConflict[] {
  if (facts.length === 0) return [];
  const names = new Map<string, Name>();
  const rows = candidates(db, facts, scope, names);
  if (rows.length < 2) return [];
  const parent = rows.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const matched = new Set<number>(); // rows related to a fact the read returned; only these are ever joined
  const firstOfEach: number[] = []; // one row of each returned fact's group, in the order the read returned the facts
  for (const fact of facts) {
    const asked = nameOf(fact.subject, names);
    let first = -1;
    rows.forEach((row, i) => {
      if (row.predicate !== fact.predicate || !related(asked, nameOf(row.subject, names))) return;
      matched.add(i);
      if (first < 0) first = i;
      else parent[root(i)] = root(first);
    });
    if (first >= 0) firstOfEach.push(first);
  }

  const groups = new Map<number, Row[]>();
  for (const i of [...matched].sort((a, b) => a - b)) { // row order: newest first
    const group = groups.get(root(i));
    if (group) group.push(rows[i]);
    else groups.set(root(i), [rows[i]]);
  }
  const conflicts: DriftConflict[] = [];
  for (const r of new Set(firstOfEach.map(root))) {
    const group = groups.get(r)!;
    if (new Set(group.map(row => normDedupeValue(row.object))).size < 2) continue;
    conflicts.push({
      predicate: group[0].predicate,
      values: group.slice(0, MAX_DRIFT_VALUES).map(row => shown(row, reader)),
      ...(group.length > MAX_DRIFT_VALUES ? { total: group.length } : {}),
    });
  }
  return conflicts;
}
