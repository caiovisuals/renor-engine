export type GoldRole = 'positive' | 'supporting' | 'forbidden';

export interface GoldTarget {
  match: string;
  relevance?: number;
  notePath?: string;
  role?: GoldRole;
}

export interface RetrievedHit {
  text?: string;
  notePath?: string;
  score?: number;
}

/**
 * Role resolution for a gold target.
 *
 * Explicit `role` always wins. Otherwise RenorBench v0 semantics apply:
 * - relevance >= 2  -> positive (creditable for Hit/Recall/MRR and nDCG)
 * - relevance === 1 -> forbidden (superseded/contradictory value that is NOT
 *   the answer to the query; never creditable, and surfacing it first is an
 *   error tracked by contradictionFirst)
 * - relevance absent -> positive (the target is the only/primary gold)
 *
 * Use explicit `role: 'supporting'` when a low-grade target is genuinely
 * acceptable evidence (nDCG-graded but never counted by binary metrics).
 */
export function roleOf(target: GoldTarget): GoldRole {
  if (target.role) return target.role;
  if (target.relevance === undefined) return 'positive';
  return target.relevance >= 2 ? 'positive' : 'forbidden';
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Matching semantics:
 *
 * - Path-pinned targets (notePath set) require the hit to come from exactly
 *   that note, and credit a needle occurring in the hit text or in the pinned
 *   path itself (session-id style metadata matching, used by LongMemEval).
 * - Text-scoped targets (no notePath) match against the retrieved text ONLY.
 *   A needle appearing merely in a filename never earns textual relevance
 *   credit, and unrelated notes can never satisfy the target.
 */
export function hitMatchesTarget(hit: RetrievedHit, target: GoldTarget): boolean {
  const needle = normalized(target.match);
  if (!needle) return false;
  if (target.notePath !== undefined) {
    if (normalized(hit.notePath) !== normalized(target.notePath)) return false;
    return normalized(hit.text).includes(needle) || normalized(target.notePath).includes(needle);
  }
  return normalized(hit.text).includes(needle);
}

function creditableTargets(targets: GoldTarget[]): GoldTarget[] {
  return targets.filter(target => roleOf(target) === 'positive');
}

export function matchedTargetIndexes(
  hits: RetrievedHit[],
  targets: GoldTarget[],
  k: number
): Set<number> {
  const matched = new Set<number>();
  for (const hit of hits.slice(0, k)) {
    targets.forEach((target, index) => {
      if (hitMatchesTarget(hit, target)) matched.add(index);
    });
  }
  return matched;
}

/**
 * Binary Hit@K: credit only positive evidence. Stale/forbidden or merely
 * supporting gold targets can never produce a Hit.
 */
export function hitAtK(hits: RetrievedHit[], targets: GoldTarget[], k: number): number {
  const positive = creditableTargets(targets);
  if (positive.length === 0) return 0;
  return matchedTargetIndexes(hits, positive, k).size > 0 ? 1 : 0;
}

/**
 * Recall@K over positive evidence only.
 */
export function recallAtK(hits: RetrievedHit[], targets: GoldTarget[], k: number): number {
  const positive = creditableTargets(targets);
  if (positive.length === 0) return 0;
  return matchedTargetIndexes(hits, positive, k).size / positive.length;
}

/**
 * All-required-evidence retrieval (multi-hop): 1 only when every required
 * target is matched within top-K. Single-target lists reduce to Hit@K.
 */
export function recallAllAtK(hits: RetrievedHit[], targets: GoldTarget[], k: number): number {
  const positive = creditableTargets(targets);
  if (positive.length === 0) return 0;
  return matchedTargetIndexes(hits, positive, k).size === positive.length ? 1 : 0;
}

/**
 * True when any forbidden-evidence target is retrieved within top-K.
 * Used for deletion/erasure cases: retrieving deleted or must-not-surface
 * content is a violation regardless of ordering.
 */
export function forbiddenRetrieved(hits: RetrievedHit[], targets: GoldTarget[], k: number): boolean {
  const forbidden = targets.filter(target => roleOf(target) === 'forbidden');
  if (forbidden.length === 0) return false;
  return matchedTargetIndexes(hits, forbidden, k).size > 0;
}

/**
 * Reciprocal rank of the first positive-evidence hit.
 */
export function reciprocalRank(hits: RetrievedHit[], targets: GoldTarget[]): number {
  const positive = creditableTargets(targets);
  if (positive.length === 0) return 0;
  const rank = hits.findIndex(hit => positive.some(target => hitMatchesTarget(hit, target)));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

function dcg(relevances: number[]): number {
  return relevances.reduce((sum, relevance, index) => {
    if (relevance <= 0) return sum;
    return sum + (Math.pow(2, relevance) - 1) / Math.log2(index + 2);
  }, 0);
}

/**
 * Graded nDCG where each gold target can receive credit at most once.
 * This prevents duplicated retrieval rows from inflating the score.
 * Forbidden targets are excluded entirely; supporting targets keep their grade.
 */
export function ndcgAtK(hits: RetrievedHit[], targets: GoldTarget[], k: number): number {
  const graded = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => roleOf(target) !== 'forbidden');
  if (graded.length === 0) return 0;

  const credited = new Set<number>();
  const observed: number[] = [];
  for (const hit of hits.slice(0, k)) {
    let bestIndex = -1;
    let bestRelevance = 0;
    graded.forEach(({ target, index }) => {
      if (credited.has(index) || !hitMatchesTarget(hit, target)) return;
      const relevance = target.relevance ?? 1;
      if (relevance > bestRelevance) {
        bestRelevance = relevance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) credited.add(bestIndex);
    observed.push(bestRelevance);
  }

  const ideal = graded
    .map(({ target }) => target.relevance ?? 1)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(observed) / idealDcg;
}

/**
 * True when the highest-ranked gold-matching hit matches only forbidden
 * targets: an obsolete/contradictory answer was surfaced ahead of the
 * current one. Cases without both positive and forbidden targets never
 * trigger this.
 */
export function contradictionFirst(hits: RetrievedHit[], targets: GoldTarget[]): boolean {
  const hasPositive = targets.some(target => roleOf(target) === 'positive');
  const hasForbidden = targets.some(target => roleOf(target) === 'forbidden');
  if (!hasPositive || !hasForbidden) return false;
  for (const hit of hits) {
    const matched = targets.filter(target => hitMatchesTarget(hit, target));
    if (matched.length === 0) continue;
    return matched.every(target => roleOf(target) === 'forbidden');
  }
  return false;
}