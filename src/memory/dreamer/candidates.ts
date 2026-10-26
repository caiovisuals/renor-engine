import type Database from '../../db/sqlite';
import { normDedupeValue } from '../../context/rowStore';
import { identityKey } from '../../retrieval/queryHelpers';
import { atoms } from '../factTerms';
import { nameOf, related, type Name } from '../factConflicts';

/**
 * The dreamer's candidates (RENOR_CONSOLIDATE): groups of current lifecycle facts that may be one thing under two
 * names, found with no model and no write.
 *
 * Two kinds, and nothing else:
 *   - `name-or-scope`: the same predicate, and subjects the existing drift test relates (factConflicts.ts: one
 *     identity, or one name with one more word before or after it), in any of the owner's scopes, whose values
 *     disagree. "Atlas project / deploy_target / Fly.io" and "Atlas / deploy_target / AWS ECS Fargate";
 *     "Atlas / api_rate_limit / 600" in project:atlas and "Atlas / api_rate_limit / 1200" in global.
 *   - `predicate`: the same subject identity in the same scope under two predicates, one of which names the other's
 *     value ("database = Postgres 16" and "postgres_version = 16").
 *
 * A group is only a question to ask, never an answer: whether its facts are one thing, a replacement, or two
 * things is the adjudicator's to say (adjudicate.ts), and what is written is apply.ts's.
 */

/** A current lifecycle fact, with the event that wrote it. */
export interface DreamerFact {
  /** The facts table id. */
  id: number;
  /** The ledger event that wrote it (always set: a fact with no event has no provenance and is never a candidate). */
  eventId: string;
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  validFrom: string;
}

export type ClusterKind = 'name-or-scope' | 'predicate';

export interface DreamerCluster {
  kind: ClusterKind;
  /** The facts, oldest first (valid_from, then id). */
  facts: DreamerFact[];
}

/** The most facts one adjudication judges; a group with more is reported as too large and left alone. */
export const MAX_CLUSTER_FACTS = 4;

const ORDER = (a: DreamerFact, b: DreamerFact): number =>
  a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.id - b.id;

/** Every current lifecycle fact that has a ledger event, as the reads show it. */
export function currentDreamerFacts(db: Database.Database): DreamerFact[] {
  return db.prepare(
    `SELECT f.id AS id, f.event_id AS eventId, e.canonical_name AS subject, f.predicate AS predicate,
            COALESCE(f.object_text, '') AS object, COALESCE(f.scope, 'global') AS scope, f.valid_from AS validFrom
     FROM facts f JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_' AND f.event_id IS NOT NULL
     ORDER BY f.valid_from, f.id`,
  ).all() as DreamerFact[];
}

/** Union-find over `n` items. */
function disjointSets(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  return { root, join: (a: number, b: number) => { parent[root(a)] = root(b); } };
}

/** The sets the pairs `connected` joins; only sets of two or more, each as the indices of `facts` it holds. */
function components(facts: DreamerFact[], connected: (a: number, b: number) => boolean, buckets: Map<string, number[]>): number[][] {
  const sets = disjointSets(facts.length);
  for (const members of buckets.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (sets.root(members[i]) !== sets.root(members[j]) && connected(members[i], members[j])) sets.join(members[i], members[j]);
      }
    }
  }
  const byRoot = new Map<number, number[]>();
  facts.forEach((_, i) => {
    const r = sets.root(i);
    const members = byRoot.get(r);
    if (members) members.push(i);
    else byRoot.set(r, [i]);
  });
  return [...byRoot.values()].filter(members => members.length > 1);
}

function add(buckets: Map<string, number[]>, key: string, index: number): void {
  const members = buckets.get(key);
  if (members) members.push(index);
  else buckets.set(key, [index]);
}

/** Whether a group's values are not all one value (after the fold the reads use to compare values). */
function disagrees(facts: DreamerFact[]): boolean {
  return new Set(facts.map(fact => normDedupeValue(fact.object))).size > 1;
}

/** Same predicate, related subjects (factConflicts.ts), values that disagree. */
function nameOrScope(facts: DreamerFact[], names: Map<string, Name>): DreamerCluster[] {
  const byPredicate = new Map<string, DreamerFact[]>();
  for (const fact of facts) {
    const group = byPredicate.get(fact.predicate);
    if (group) group.push(fact);
    else byPredicate.set(fact.predicate, [fact]);
  }
  const out: DreamerCluster[] = [];
  for (const group of byPredicate.values()) {
    if (group.length < 2) continue;
    // A related name has the other's first word first, or its last word last, or is one identity: so only facts that
    // share one of those are compared.
    const buckets = new Map<string, number[]>();
    group.forEach((fact, i) => {
      const name = nameOf(fact.subject, names);
      add(buckets, `k:${name.key ??= identityKey(fact.subject)}`, i);
      if (name.words) {
        add(buckets, `f:${name.words[0]}`, i);
        add(buckets, `l:${name.words[name.words.length - 1]}`, i);
      }
    });
    for (const members of components(group, (a, b) => related(nameOf(group[a].subject, names), nameOf(group[b].subject, names)), buckets)) {
      const cluster = members.map(i => group[i]).sort(ORDER);
      if (disagrees(cluster)) out.push({ kind: 'name-or-scope', facts: cluster });
    }
  }
  return out;
}

/** The shortest predicate word that can echo a value: two-letter words ("on", "id") appear in too many values. */
const MIN_ECHO_WORD = 3;

/**
 * One subject in one scope under two predicates, where a word of one predicate is a word of the other fact's value.
 * An agent that writes `database = Postgres 16 (AWS RDS)` and another that writes `postgres_version = 16` have used a
 * second predicate for the same thing, and the second one's name repeats the first one's value ("postgres").
 *
 * Not "two predicates that share a word". Tried on a week of an agent's saves, that rule misses this pair (`database` and
 * `postgres_version` share none) and returns two that are not drift, because a generic word is shared:
 * `commit_message_style` / `answer_style`, and `release_cadence` / `current_release`.
 */
function predicateDrift(facts: DreamerFact[]): DreamerCluster[] {
  const bySubject = new Map<string, DreamerFact[]>();
  for (const fact of facts) {
    const key = `${identityKey(fact.subject)}\u0000${fact.scope}`;
    const group = bySubject.get(key);
    if (group) group.push(fact);
    else bySubject.set(key, [fact]);
  }
  const out: DreamerCluster[] = [];
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    const predicateWords = group.map(fact => atoms(fact.predicate).filter(word => word.length >= MIN_ECHO_WORD));
    const valueWords = group.map(fact => new Set(atoms(fact.object)));
    const everyone = new Map<string, number[]>([['*', group.map((_, i) => i)]]);
    const echoes = (a: number, b: number) => predicateWords[a].some(word => valueWords[b].has(word));
    const drift = (a: number, b: number) => group[a].predicate !== group[b].predicate && (echoes(a, b) || echoes(b, a));
    for (const members of components(group, drift, everyone)) {
      const cluster = members.map(i => group[i]).sort(ORDER);
      if (disagrees(cluster)) out.push({ kind: 'predicate', facts: cluster });
    }
  }
  return out;
}

/**
 * The groups of current facts that may be one thing, newest first (by the newest fact each holds). Which of them were
 * already judged is the dreamer's to know (a group is identified by its facts' ledger events), not this module's.
 */
export function findCandidateClusters(db: Database.Database): DreamerCluster[] {
  const facts = currentDreamerFacts(db);
  const names = new Map<string, Name>();
  const clusters = [...nameOrScope(facts, names), ...predicateDrift(facts)];
  return clusters.sort((a, b) => {
    const newest = (c: DreamerCluster) => c.facts[c.facts.length - 1];
    const x = newest(a);
    const y = newest(b);
    return x.validFrom < y.validFrom ? 1 : x.validFrom > y.validFrom ? -1 : y.id - x.id;
  });
}
