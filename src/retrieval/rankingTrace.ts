import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { labelMemoryText } from '../mvp/hiddenSpans';

/**
 * What the ranker added up for each candidate of one read, for the learning log (src/learning, schema version 2).
 *
 * rankWindow (orchestrator.ts) gives every candidate a base score (a cosine for a semantic hit, 0.3 for a graph hit, the fact
 * lane's own score for a fact hit, 0 for a session-expansion statement) and then adds or subtracts named terms. A trace keeps
 * each term as it is applied, so base + the sum of the terms is the score the candidate was ranked by, and a learner can refit
 * the weights from the log.
 *
 * Nothing here changes a score, an order or a reply. A trace is only written to while a read runs inside `withRankingTrace`,
 * and only the learning log's tool wrapper opens that scope (server.ts), and only when the log is on. With the log off no scope
 * is opened and every call here returns at once, so the ranking runs as it always did.
 *
 * Identity. A candidate is keyed by the note path the reply shows, its heading path and the text as the reply shows it
 * (labelled by mvp/hiddenSpans.ts): the chunk id is not in the reply. The note path the reply shows is the path relative to the
 * memory folder when the note is inside it (engine.ts clientPath); the ranker holds the stored path, so a trace made for a memory
 * folder shows the same path the reply does. The key is hashed, so no text is kept in a map longer than the read that made it.
 */

/** The named additive terms rankWindow applies, in the order it applies them. Each is a signed number added to a score. */
export const RANKING_TERMS = [
  'stub', // a speaker's stub line: -0.5 (orchestrator.ts isSpeakerStub)
  'content', // a contentful chunk: up to +0.12 (contentBoost)
  'priority', // a path the caller prioritises: +0.1
  'entity', // the query names the entity this note is the source of: +0.2
  'entity_lane', // the optional entity lane's lexical coverage lift: up to +0.12
  'recency', // time decay: up to +0.1 for a note written today, 0 after 30 days
  'fact', // the note's own entity has a fact the query names: +0.15
  'asof_year', // an explicit past-date query, and the text names its year: +0.08
  'asof_month', // the same, and the text names its month: +0.04
  'historical_intent', // past intent: a historical note sharing two of the query's words: +0.3
  'stale_fact', // present query: the text carries a value the lifecycle has superseded: -0.15
  'past_fact', // past intent: the same text is lifted instead: +0.1
  'current_fact', // the text carries the current value of a superseded predicate: +0.1
] as const;
export type RankingTerm = (typeof RANKING_TERMS)[number];

export function rankingTermIndex(term: RankingTerm): number {
  return RANKING_TERMS.indexOf(term);
}

/** A candidate as rankWindow holds it. The optional fields are what the orchestrator and the reply builder add. */
export interface Scoreable {
  notePath: string;
  headingPath?: string;
  text: string;
  score?: number;
  reason?: string;
}

/** One candidate's record for one read. Numbers, and the identity the reply carries; nothing is persisted from here as text. */
export interface TraceEntry {
  key: string;
  /** The note path as the reply shows it. */
  notePath: string;
  headingPath: string | null;
  /** The lane string (`semantic+content+recency`, `fact`, `session-expand`, ...). */
  reason: string;
  /** The score before any term: score - sum(terms). */
  base: number;
  /** One number per RANKING_TERMS entry; zero where the term did not apply. */
  terms: number[];
  /** 1-based rank of the candidate in the scored pool (score order); null for a candidate the pool did not score. */
  poolRank: number | null;
  /** 1-based position in the order the window presents its candidates, before any budget cut; null when not presented. */
  windowPos: number | null;
  /** Whether the budget kept it; null when the read had no budget step. */
  budgetKept: boolean | null;
}

// The terms and the pool rank travel with a candidate object as symbol-keyed properties: a spread copies them, JSON does not
// show them, and a reply never carries them (the reply copies named fields only).
const TERMS = Symbol('renor.rankingTerms');
const POOL_RANK = Symbol('renor.poolRank');
type Carried = { [TERMS]?: number[]; [POOL_RANK]?: number };

const zeros = (): number[] => new Array<number>(RANKING_TERMS.length).fill(0);

/** A fresh row of zeros for a candidate about to be scored. */
export function newRankingTerms(): number[] {
  return zeros();
}

/** Attaches a candidate's term row (the row rankWindow filled while it scored the candidate). */
export function attachRankingTerms<T extends object>(hit: T, terms: number[]): T {
  (hit as Carried)[TERMS] = terms;
  return hit;
}

/** Adds one term's delta to a candidate that is already scored; the score itself is changed by the caller, as before. */
export function addRankingTerm(hit: object, term: RankingTerm, delta: number): void {
  const carried = hit as Carried;
  const row = carried[TERMS] ?? (carried[TERMS] = zeros());
  row[rankingTermIndex(term)] += delta;
}

function termsOf(hit: object): number[] | undefined {
  return (hit as Carried)[TERMS];
}

function poolRankOf(hit: object): number | null {
  return (hit as Carried)[POOL_RANK] ?? null;
}

/**
 * The note path the reply shows for a stored path: relative to the memory folder when the note is inside it, else its file name.
 * This is engine.ts `clientPath` without its cache, repeated here so the ranker does not import the engine (which imports it).
 * A path that is not absolute is already in the form the reply shows (a candidate the engine's search has listed), so it is
 * returned as it is; with no memory folder every path is.
 */
export function clientNotePath(memoryDir: string | undefined, stored: string): string {
  if (memoryDir === undefined || !path.isAbsolute(stored)) return stored;
  const resolved = path.resolve(stored);
  const root = path.resolve(memoryDir);
  return resolved === root || resolved.startsWith(root + path.sep) ? path.relative(root, resolved) || stored : path.basename(stored);
}

/**
 * The key of a candidate, given the note path as the reply shows it. Hashed, over the path, the heading path and the text as the
 * reply labels it (mvp/hiddenSpans.ts), so a candidate the ranker holds and the same candidate in a reply have one key.
 */
export function traceKey(shownNotePath: string, headingPath: string | null | undefined, text: string): string {
  const labelled = labelMemoryText({ text }).text;
  return createHash('sha256').update(JSON.stringify([shownNotePath, headingPath ?? '', labelled])).digest('hex');
}

export class RankingTrace {
  private readonly entries = new Map<string, TraceEntry>();

  /** `memoryDir`: the memory folder the reply's note paths are relative to. Without one, the stored paths are the shown ones. */
  constructor(readonly memoryDir?: string) {}

  /** Records a candidate as the ranker holds it now. Its terms are the ones addRankingTerm and attachRankingTerms put on it. */
  touch(hit: Scoreable): TraceEntry {
    const notePath = clientNotePath(this.memoryDir, hit.notePath);
    const key = traceKey(notePath, hit.headingPath, hit.text);
    const known = this.entries.get(key);
    if (known) return known;
    const terms = termsOf(hit) ?? zeros();
    const score = hit.score ?? 0;
    const entry: TraceEntry = {
      key,
      notePath,
      headingPath: hit.headingPath ?? null,
      reason: hit.reason ?? '',
      base: score - terms.reduce((sum, term) => sum + term, 0),
      terms: [...terms],
      poolRank: poolRankOf(hit),
      windowPos: null,
      budgetKept: null,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** Records a candidate's place in the scored pool (1 is the best score). */
  pool(hit: Scoreable, rank: number): void {
    (hit as Carried)[POOL_RANK] = rank;
    this.touch(hit);
  }

  /** Records the candidates in the order the reply's window presents them, 1-based, before any budget cut. */
  presented(hits: readonly Scoreable[]): void {
    hits.forEach((hit, index) => {
      this.touch(hit).windowPos = index + 1;
    });
  }

  /**
   * Records which candidates the budget kept. `considered` are the candidates it weighed and `kept` the ones it kept; a candidate
   * considered and not kept is false. A ledger memory is listed with its note path and heading blanked (agentMemory.ts), so it
   * cannot be told from the candidate the ranker scored: it gets no entry rather than a second, unmatched one.
   */
  budgeted(considered: readonly Scoreable[], kept: readonly Scoreable[]): void {
    const keptKeys = new Set(kept.filter(hit => hit.notePath !== '').map(hit => this.keyOfHit(hit)));
    for (const hit of considered) {
      if (hit.notePath === '') continue;
      const key = this.keyOfHit(hit);
      const entry = this.entries.get(key) ?? this.touch(hit);
      entry.budgetKept = keptKeys.has(key);
    }
  }

  /** The entry under a key from `traceKey`, when the trace has one. */
  byKey(key: string): TraceEntry | undefined {
    return this.entries.get(key);
  }

  /** Finds a unique chunk by fields that reply decoration preserves even when it changes the displayed text. */
  byLocation(notePath: string, headingPath: string | null | undefined): TraceEntry | undefined {
    const matches = [...this.entries.values()].filter(entry => entry.notePath === notePath && entry.headingPath === (headingPath ?? null));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Every candidate of the read, in the order it was first recorded. */
  all(): TraceEntry[] {
    return [...this.entries.values()];
  }

  private keyOfHit(hit: Scoreable): string {
    return traceKey(clientNotePath(this.memoryDir, hit.notePath), hit.headingPath, hit.text);
  }
}

const scope = new AsyncLocalStorage<RankingTrace>();

/** The trace of the read in progress, when one is being collected. */
export function currentRankingTrace(): RankingTrace | undefined {
  return scope.getStore();
}

/** Runs `work` with `trace` collecting the terms of every read it makes. */
export function withRankingTrace<T>(trace: RankingTrace, work: () => T): T {
  return scope.run(trace, work);
}
