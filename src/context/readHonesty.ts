import Database from 'better-sqlite3';
import { matchForm, normDedupeValue, splitWords } from './rowStore';
import { MAX_DRIFT_VALUES } from '../memory/factConflicts';
import { normalizeScope, savedScopeSqlPredicate } from '../mvp/scope';

/**
 * Read-time honesty (LANE 3): provenance, contradiction, abstention.
 *
 * Three behaviours on the product read path, all gated by ONE flag
 * (RENOR_READ_HONESTY, default OFF — nothing here runs unless an operator
 * arms it):
 *
 *   1. provenance  — every returned item says where it came from and when it
 *                    was last verified, so a consuming agent can decide
 *                    whether to trust or discount it.
 *   2. conflicts   — when two CURRENT facts about the same subject+predicate
 *                    disagree, the read names both values and says which one
 *                    is newer, instead of silently returning both as if they
 *                    were compatible. This is the agent-dogfood D2 want: two
 *                    contradictory statements in one source, where nothing
 *                    surfaced the conflict. A read that names no scope
 *                    compares every scope and names each value with every
 *                    scope it is current in; a scoped read compares its own
 *                    scope only, as get_context's default conflicts do
 *                    (memory/factConflicts.ts).
 *   3. abstention  — when the query's content terms are mostly absent from the
 *                    returned evidence, the read says so explicitly
 *                    ("no good answer on file for this") instead of presenting
 *                    weak hits as if they answered the question. D6: weak hits
 *                    train an agent to trust noise.
 *
 * Everything here is gold-blind and product-observable: the inputs are the
 * query text and rows the product itself stored (notes, chunks, facts,
 * entities). No benchmark category, gold label, `shouldAbstain` or session id
 * is readable from this module's signatures.
 */

/** RENOR_READ_HONESTY (default OFF). Opt in with 1/true/yes/on. */
export const READ_HONESTY_FLAG = 'RENOR_READ_HONESTY';

export function readHonestyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[READ_HONESTY_FLAG] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Default evidence bar: the share of the query's content terms that must be
 * present in the returned evidence before a hit counts as an answer.
 *
 * MEASURED, not invented (scripts/lane3-probe.ts, synthetic 10-note vault,
 * eval-hash embeddings): on-topic questions cover 0.67–1.00 of their content
 * terms, off-topic questions 0.00–0.33. 0.5 sits between the two populations
 * and is deliberately the conservative side — it abstains only when most of
 * what the question is about is nowhere in the returned evidence.
 *
 * Vector similarity alone does NOT separate these populations on that fixture
 * (an off-topic question scored 0.555 while an on-topic one scored 0.364), so
 * a similarity threshold would be the wrong instrument.
 */
export const DEFAULT_EVIDENCE_BAR = 0.5;

export function resolveEvidenceBar(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RENOR_READ_HONESTY_BAR);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return DEFAULT_EVIDENCE_BAR;
}

/**
 * Query words that carry no answer content. Deliberately a stoplist, not a
 * stemmer: the bar must be deterministic and explainable.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'did', 'does', 'how', 'what',
  'when', 'which', 'who', 'why', 'many', 'much', 'about', 'from', 'into',
  'with', 'this', 'that', 'there', 'their', 'have', 'has', 'had', 'you',
  'your', 'our', 'his', 'her', 'its', 'not', 'but', 'any', 'all', 'can',
  'will', 'would', 'should', 'use', 'used', 'take', 'took', 'name', 'start',
  'here', 'near', 'last', 'over', 'under', 'each', 'than', 'then',
]);

/** Content terms of a query: >=3 chars, not a stopword, de-duplicated in order.
 *
 *  DELIBERATELY ASCII (`[^a-z0-9%.]`), even though `rowStore.splitWords` now cuts every
 *  other read-side tokenizer on the Unicode write-side rule. This feeds `evidenceCoverage`
 *  and `assessAbstention`, and those terms are the DENOMINATOR of the abstention bar: every
 *  term must be findable in the evidence or coverage falls and the read abstains. Widening
 *  the cut therefore mints content terms the English-only stoplist cannot cover — measured
 *  here: `Quando são as reuniões?` against the on-file `Eu prefiro reuniões às sextas-feiras`
 *  went from terms `[quando, reuni]` (coverage 0.50, answers) to `[quando, são, reuniões]`
 *  (coverage 0.33, abstains "no good answer on file for this"), because `são` is a Portuguese
 *  function word that no evidence sentence contains. Widening this lane trades a false
 *  abstention for a false answer in every language the stoplist does not cover.
 *
 *  A stoplist per language is the real fix and it is a separate, measured change; the
 *  entity-resolution lane below is what this PR widens. Pinned by
 *  `tests/context/readSideUnicodeTokens.test.ts`, which also asserts the abstention outcome
 *  of Portuguese query/fact pairs is unchanged. */
export function contentTerms(query: string): string[] {
  return Array.from(
    new Set(
      (query ?? '')
        .toLowerCase()
        .split(/[^a-z0-9%.]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  );
}

/** The same rule as `contentTerms`, cut on the Unicode write-side class instead. Used ONLY
 *  by `querySubjects`, whose terms SELECT entity names rather than score evidence coverage:
 *  a name and the query that names it are cut by the same rule, so a subject in any script
 *  resolves. Widening is safe here precisely because nothing divides by the term count.
 *  Kept as a separate function rather than a flag so the abstention lane above cannot be
 *  widened by accident. */
function subjectTerms(query: string): string[] {
  return Array.from(
    new Set(
      splitWords(query, true).filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  );
}

/**
 * Length-2 trailing trim ("powered" -> "power", "flights" -> "flight").
 * A prefix test, not a linguistic stemmer — measured to cover the plural and
 * participle forms in the fixture without matching unrelated words.
 */
export function termStem(term: string): string {
  return term.slice(0, Math.max(4, term.length - 2));
}

/** Fraction of the query's content terms that appear in the returned evidence. */
export function evidenceCoverage(query: string, texts: string[]): number {
  const terms = contentTerms(query);
  if (terms.length === 0) return 1; // nothing contentful to require
  const haystack = texts.join('\n').toLowerCase();
  const covered = terms.filter((t) => haystack.includes(termStem(t))).length;
  return covered / terms.length;
}

export interface Provenance {
  /** Where the item came from: a note path, or the canonical markdown ledger. */
  source: string;
  /** Last date the system recorded this item as current. null = unknown, never invented. */
  lastVerified: string | null;
  kind: 'ledger' | 'note';
}

/** Provenance of a lifecycle fact: the ledger is the source of truth, valid_from is its verification date. */
export function factProvenance(validFrom: string | null | undefined, ledgerRelPath: string): Provenance {
  return { source: ledgerRelPath, lastVerified: validFrom ?? null, kind: 'ledger' };
}

/** Provenance of a note-backed item: the note is the source, its session/note date is the verification date. */
export function noteProvenance(notePath: string, lastVerified?: string | null): Provenance {
  return { source: notePath, lastVerified: lastVerified ?? null, kind: 'note' };
}

export interface ConflictSide {
  value: string;
  source: string;
  lastVerified: string | null;
  /** The scope the value is current in: only when the values are current in different scopes. */
  scope?: string;
}

export interface FactConflict {
  subject: string;
  predicate: string;
  /** Every disagreeing value, newest first (only the values named, when `total` says some are not). */
  values: string[];
  newer: ConflictSide;
  /** The newest of the disagreeing values that is NOT `newer`. */
  older: ConflictSide;
  /**
   * When the values are current in different scopes, the sides after newer and older: each value in each scope it
   * is current in, with that scope (newer and older carry theirs). First the other values, newest first, then the
   * other scopes that hold one of the values, newest first; with newer and older, at most MAX_DRIFT_VALUES sides, as
   * get_context's default conflicts list at most that many values. Absent when newer and older are all it names.
   */
  alsoCurrent?: ConflictSide[];
  /** When not every side is named (more than MAX_DRIFT_VALUES, or get_context's reply budget): how many there are. */
  total?: number;
  /** Human-readable statement naming both sides — the D2 ask. */
  statement: string;
}

interface CurrentFactRow {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  sourcePath: string;
  scope: string;
  validFrom: string | null;
}

function instantOf(value: string | null, fallbackId: number): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY + fallbackId / 1e6;
}

/** One question: a subject and a predicate, compared as the structured-row store compares values. */
export function questionKey(subject: string, predicate: string): string {
  return `${normDedupeValue(subject)}\u0000${normDedupeValue(predicate)}`;
}

/** Whether a conflict's values are current in different scopes: its sides then carry their scope. */
export function acrossScopes(conflict: FactConflict): boolean {
  return conflict.newer.scope !== undefined;
}

function newestFirst(a: CurrentFactRow, b: CurrentFactRow): number {
  return instantOf(b.validFrom, b.id) - instantOf(a.validFrom, a.id);
}

/** Where a side's value is on file: its source, its scope (when the values span scopes) and its date. */
function where(side: ConflictSide): string {
  return `${side.source}${side.scope ? `, scope ${side.scope}` : ''}${side.lastVerified ? `, ${side.lastVerified}` : ', date unknown'}`;
}

/**
 * Current facts for a subject set, all source paths included.
 *
 * Reads `valid_to IS NULL` rows across the WHOLE table, not just the
 * `_mcp_` lifecycle stream: the contradiction that matters is cross-source
 * (a note asserting one value while another note or the ledger asserts
 * another). Restricting to one writer would hide exactly the conflict this
 * behaviour exists to surface.
 *
 * `scope` is the read's scope: a scoped read sees that scope's facts only
 * (under any spelling of it, savedScopeSqlPredicate), so it is never told what
 * another scope holds; null (a read that names no scope) sees every scope.
 */
export function currentFactsForSubjects(
  db: Database.Database,
  subjects: string[],
  scope: string | null = null,
): CurrentFactRow[] {
  const names = Array.from(new Set(subjects.map((s) => (s ?? '').trim()).filter(Boolean)));
  if (names.length === 0) return [];
  const placeholders = names.map(() => '?').join(', ');
  const inScope = scope === null ? null : savedScopeSqlPredicate(normalizeScope(scope), 'f.scope'); // any spelling of it
  const rows = db
    .prepare(
      `SELECT f.id AS id, e.canonical_name AS subject, f.predicate AS predicate,
              f.object_text AS object, f.source_path AS sourcePath,
              COALESCE(f.scope, 'global') AS scope, f.valid_from AS validFrom
       FROM facts f
       JOIN entities e ON e.id = f.subject_entity_id
       WHERE f.valid_to IS NULL
         AND e.canonical_name COLLATE NOCASE IN (${placeholders})${inScope ? `
         AND ${inScope.sql}` : ''}
       ORDER BY f.valid_from DESC, f.id DESC`,
    )
    .all(...names, ...(inScope?.params ?? [])) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    subject: r.subject as string,
    predicate: r.predicate as string,
    object: (r.object as string | null) ?? '',
    sourcePath: r.sourcePath as string,
    scope: (r.scope as string | null) ?? 'global',
    validFrom: (r.validFrom as string | null) ?? null,
  }));
}

/**
 * Detect read-time contradictions: >=2 CURRENT facts sharing subject+predicate
 * but carrying different values. Values are compared after the same
 * NFKD/ASCII/lowercase normalization the structured-row store uses, so case
 * and accent differences are not reported as disagreements.
 *
 * Deterministic: within a group, sides are ordered by instant desc then id desc.
 */
export function detectFactConflicts(rows: CurrentFactRow[]): FactConflict[] {
  const groups = new Map<string, CurrentFactRow[]>();
  for (const row of rows) {
    if (!row.object.trim()) continue;
    // Subject and predicate key the group, across scopes: the rows are the
    // read's own (currentFactsForSubjects keeps a scoped read inside its
    // scope), so a read that names no scope is told when one question has
    // different current values in two scopes, as get_context's default
    // conflicts tell it (memory scout finding 13).
    const key = questionKey(row.subject, row.predicate);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const conflicts: FactConflict[] = [];
  for (const bucket of groups.values()) {
    const byValue = new Map<string, CurrentFactRow[]>();
    for (const row of bucket) {
      const vkey = normDedupeValue(row.object);
      const list = byValue.get(vkey);
      if (list) list.push(row);
      else byValue.set(vkey, [row]);
    }
    if (byValue.size < 2) continue; // a single value, however many sources: no disagreement

    // One representative per distinct value: the newest row carrying it.
    const reps = Array.from(byValue.values()).map((rowsForValue) => [...rowsForValue].sort(newestFirst)[0]);
    reps.sort(newestFirst);

    // Values current in different scopes: each value is named in every scope it is current in, with that scope, as
    // get_context's default conflicts list them (memory/factConflicts.ts). Every value once, newest first, then the
    // other scopes that hold one of them; within a scope a value's newest row stands for it, as it does across
    // sources. A conflict inside one scope keeps its shape.
    if (new Set(bucket.map((r) => r.scope)).size > 1) {
      const valueInScope = (r: CurrentFactRow) => `${normDedupeValue(r.object)}\u0000${r.scope}`;
      const named = new Set(reps.map(valueInScope));
      const elsewhere = [...bucket].sort(newestFirst).filter((r) => {
        if (named.has(valueInScope(r))) return false;
        named.add(valueInScope(r));
        return true;
      });
      const sides = [...reps, ...elsewhere].map(
        (r): ConflictSide => ({ value: r.object, source: r.sourcePath, lastVerified: r.validFrom, scope: r.scope }),
      );
      conflicts.push(conflictAcrossScopes(reps[0].subject, reps[0].predicate, sides.slice(0, MAX_DRIFT_VALUES), sides.length));
      continue;
    }

    const sides: ConflictSide[] = reps.map((r) => ({
      value: r.object,
      source: r.sourcePath,
      lastVerified: r.validFrom,
    }));
    if (sides.length < 2) continue;
    const [newer, older] = sides;
    conflicts.push({
      subject: reps[0].subject,
      predicate: reps[0].predicate,
      values: sides.map((s) => s.value),
      newer,
      older,
      statement:
        `Contradiction on ${reps[0].subject} / ${reps[0].predicate}: ` +
        `"${newer.value}" (${where(newer)}) is newer than ` +
        `"${older.value}" (${where(older)}). ` +
        `Both are current in the store — do not treat them as compatible.`,
    });
  }

  // Stable order: subject, then predicate, then newest value.
  conflicts.sort((a, b) => {
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    if (a.predicate !== b.predicate) return a.predicate < b.predicate ? -1 : 1;
    return a.newer.value < b.newer.value ? -1 : a.newer.value > b.newer.value ? 1 : 0;
  });
  return conflicts;
}

/**
 * A contradiction among values current in different scopes, naming each of its `sides` with its scope, in the order
 * `FactConflict.alsoCurrent` describes (so the first two disagree). `total` is how many sides there are when `sides`
 * holds only the first of them (the MAX_DRIFT_VALUES cap, or `fitConflicts`); the statement then counts the rest.
 */
export function conflictAcrossScopes(
  subject: string,
  predicate: string,
  sides: ConflictSide[],
  total = sides.length,
): FactConflict {
  const [newer, older, ...also] = sides;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const side of sides) {
    if (seen.has(normDedupeValue(side.value))) continue;
    seen.add(normDedupeValue(side.value));
    values.push(side.value);
  }
  const unnamed = total - sides.length;
  const named = also.map((side) => `"${side.value}" (${where(side)})`).join(', ');
  const rest = `${named}${unnamed > 0 ? `${named ? ' and ' : ''}${unnamed} more` : ''}`;
  return {
    subject,
    predicate,
    values,
    newer,
    older,
    ...(also.length > 0 ? { alsoCurrent: also } : {}),
    ...(unnamed > 0 ? { total } : {}),
    statement:
      `Contradiction on ${subject} / ${predicate}: ` +
      `"${newer.value}" (${where(newer)}) is newer than ` +
      `"${older.value}" (${where(older)})${rest ? `; also current: ${rest}` : ''}. ` +
      `${total === 2 ? 'Both are' : `All ${total} are`} current in the store — do not treat them as compatible.`,
  };
}

/**
 * The conflicts cut to `budget`: a number of characters of their JSON, or whether a list of them fits (get_context: its
 * whole reply inside max_tokens, as the engine counts tokens). `conflicts` are as detectFactConflicts returns them, and
 * come back unchanged when they fit. Otherwise a conflict across scopes names the two values that disagree (newer,
 * older), then more of its sides while the list fits, first conflict first, and `total` counts them all; a conflict
 * inside one scope is kept as it is. So however many scopes hold a value, the conflicts stay within the budget, except
 * for the two values that make each contradiction: those are always named.
 */
export function fitConflicts(conflicts: FactConflict[], budget: number | ((shown: FactConflict[]) => boolean)): FactConflict[] {
  const fits = typeof budget === 'number' ? (shown: FactConflict[]) => JSON.stringify(shown).length <= budget : budget;
  if (fits(conflicts)) return conflicts;
  const sides = conflicts.map((c) => [c.newer, c.older, ...(c.alsoCurrent ?? [])]);
  const naming = (i: number, n: number): FactConflict => {
    const c = conflicts[i];
    return n >= sides[i].length ? c : conflictAcrossScopes(c.subject, c.predicate, sides[i].slice(0, n), c.total ?? sides[i].length);
  };
  const shown = conflicts.map((c, i) => (c.alsoCurrent ? naming(i, 2) : c));
  for (let i = 0; i < shown.length; i++) {
    if (!conflicts[i].alsoCurrent) continue;
    for (let n = 3; n <= sides[i].length; n++) {
      const next = naming(i, n);
      if (!fits(shown.map((c, j) => (j === i ? next : c)))) break;
      shown[i] = next;
    }
  }
  return shown;
}

/** Same rule as `subjectTerms`, applied to a canonical name or alias, so a name and the query
 *  that names it are cut identically and a subject in any script resolves. */
function entityTokens(value: string): string[] {
  return splitWords(value).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Gold-blind query -> subject resolution: canonical names (or aliases) that
 * share a content token with the query, plus any canonical name stated whole in
 * the query. Reads only the query text and the product's own entity table.
 */
export function querySubjects(db: Database.Database, query: string, limit = 20): string[] {
  const terms = subjectTerms(query);
  if (terms.length === 0) return [];
  const lowerQuery = ` ${matchForm(query)} `;
  const found = new Set<string>();
  const select = db.prepare(
    `SELECT DISTINCT canonical_name AS name, aliases_json AS aliases
     FROM entities
     WHERE lower(canonical_name) LIKE '%' || ? || '%'
     LIMIT 200`,
  );
  for (const term of terms.slice(0, 8)) {
    const rows = select.all(term) as Array<{ name: string; aliases: string | null }>;
    for (const row of rows) {
      const name = String(row.name);
      const tokens = entityTokens(name);
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(row.aliases ?? '[]');
        if (Array.isArray(parsed)) aliases = parsed.map(String);
      } catch {
        aliases = [];
      }
      const aliasTokens = aliases.flatMap(entityTokens);
      const wholeName = name.length >= 3 && lowerQuery.includes(` ${matchForm(name)} `);
      if (wholeName || tokens.includes(term) || aliasTokens.includes(term)) {
        found.add(name);
      }
      if (found.size >= limit) return Array.from(found);
    }
  }
  return Array.from(found);
}

export interface Abstention {
  status: 'no-answer';
  reason: 'below-evidence-bar' | 'no-evidence';
  /** Literal, greppable statement the consuming agent can surface verbatim. */
  statement: string;
  coverage: number;
  bar: number;
  terms: string[];
  /** How many items the read had to work with before the bar was applied. */
  considered: number;
}

export interface AbstentionInput {
  query: string;
  /** Text of every item the read would otherwise return. */
  texts: string[];
  /** Number of items considered (defaults to texts.length). */
  considered?: number;
  bar?: number;
}

export const NO_ANSWER_STATEMENT = 'no good answer on file for this';

/**
 * Honest abstention. Returns null when the evidence clears the bar (the read
 * may answer), or an explicit no-answer record when it does not. An empty
 * evidence set is always a no-answer — there is nothing on file at all.
 */
export function assessAbstention(input: AbstentionInput): Abstention | null {
  const bar = input.bar ?? DEFAULT_EVIDENCE_BAR;
  const considered = input.considered ?? input.texts.length;
  const terms = contentTerms(input.query);
  if (considered === 0) {
    return {
      status: 'no-answer',
      reason: 'no-evidence',
      statement: NO_ANSWER_STATEMENT,
      coverage: 0,
      bar,
      terms,
      considered: 0,
    };
  }
  const coverage = evidenceCoverage(input.query, input.texts);
  if (coverage < bar) {
    return {
      status: 'no-answer',
      reason: 'below-evidence-bar',
      statement: NO_ANSWER_STATEMENT,
      coverage,
      bar,
      terms,
      considered,
    };
  }
  return null;
}

/**
 * Provenance + contradiction + abstention applied to a read result in one
 * place, so every product surface reports the same thing. Pure: no model
 * calls, no I/O beyond the passed database handle.
 */
export interface ReadHonestyOptions {
  db: Database.Database;
  query: string;
  ledgerRelPath: string;
  /** The read's scope: conflicts are judged among its facts only. Omitted: every scope. */
  scope?: string;
  /** Subjects of the facts the read is returning (their own contradictions count too). */
  subjects?: string[];
  /**
   * The facts the read returns (get_context). A contradiction across scopes is then named only for one of them, as
   * get_context's default conflicts are: a subject saved differently in a project for many predicates names what the
   * read shows, not every predicate. Omitted (the CLI and HTTP reads, which return notes): every subject's. A
   * contradiction inside one scope is named either way, as before.
   */
  facts?: ReadonlyArray<{ subject: string; predicate: string }>;
  /** Text of every item the read is returning, for the evidence bar. */
  texts: string[];
  considered?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ReadHonesty {
  conflicts: FactConflict[];
  abstention: Abstention | null;
}

export function applyReadHonesty(options: ReadHonestyOptions): ReadHonesty {
  const bar = resolveEvidenceBar(options.env);
  const subjects = Array.from(
    new Set([...(options.subjects ?? []), ...querySubjects(options.db, options.query)]),
  );
  const returned = options.facts && new Set(options.facts.map((f) => questionKey(f.subject, f.predicate)));
  const conflicts = detectFactConflicts(currentFactsForSubjects(options.db, subjects, options.scope ?? null))
    .filter((c) => !returned || !acrossScopes(c) || returned.has(questionKey(c.subject, c.predicate)));
  const abstention = assessAbstention({
    query: options.query,
    texts: options.texts,
    considered: options.considered,
    bar,
  });

  // A contradiction is itself evidence that something is on file: an agent
  // told "no good answer" while being handed a conflict would be misled in the
  // opposite direction. The conflict is reported, the abstention stands down.
  if (abstention && conflicts.length > 0) return { conflicts, abstention: null };
  return { conflicts, abstention };
}

export interface ReadHonestyForItems {
  conflicts: FactConflict[];
  abstention: Abstention | null;
  provenance: Provenance[];
}

/**
 * Read honesty for a retrieval-style read (the CLI `search` path and any other
 * surface that returns note hits rather than lifecycle facts). Subjects come
 * from the product's own entity table, joined to the query text — never from a
 * caller-supplied list, so this cannot be fed gold labels.
 */
export function readHonestyForItems(options: {
  db: Database.Database;
  query: string;
  items: Array<{ notePath: string; text: string; session_date?: string }>;
  ledgerRelPath: string;
  env?: NodeJS.ProcessEnv;
}): ReadHonestyForItems {
  const honesty = applyReadHonesty({
    db: options.db,
    query: options.query,
    ledgerRelPath: options.ledgerRelPath,
    texts: options.items.map((i) => i.text),
    considered: options.items.length,
    env: options.env,
  });
  return {
    ...honesty,
    provenance: options.items.map((i) => noteProvenance(i.notePath, i.session_date ?? null)),
  };
}
