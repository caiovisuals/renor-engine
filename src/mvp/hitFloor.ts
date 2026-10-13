import { SESSION_EXPAND_REASON } from '../retrieval/orchestrator';

/**
 * MCP search_memory removes note hits below a raw-cosine floor after the facts lane fills the page.
 * The default is 0.63 only for Vertex gemini-embedding-001 at 768 dimensions; every other model defaults off.
 * Operator setting RENOR_SEARCH_HIT_FLOOR overrides either default; 0 restores the old response.
 * Facts, evidence, digests, ledger events and graph hits have no own cosine and stay. Session expansion
 * stays only while a matched hit from its note survives. Nothing is added, reordered or backfilled.
 * get_context, HTTP API and CLI searches do not use this floor.
 */
export const SEARCH_HIT_FLOOR_DEFAULT = 0.63;
export const SEARCH_HIT_FLOOR_MODEL_KEY = 'vertex:gemini-embedding-001:768';
export const SEARCH_HIT_FLOOR_ENV = 'RENOR_SEARCH_HIT_FLOOR';

/** A cosine threshold never transfers between models or dimensions. Invalid settings use this model's default. */
export function searchHitFloor(modelKey: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const defaultFloor = modelKey === SEARCH_HIT_FLOOR_MODEL_KEY ? SEARCH_HIT_FLOOR_DEFAULT : 0;
  const value = env[SEARCH_HIT_FLOOR_ENV];
  if (value === undefined || value.trim() === '') return defaultFloor;
  const floor = Number(value);
  return Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : defaultFloor;
}

/** What a hit must carry to be judged: where it is, why it is on the page, and its own similarity when it has one. */
export interface FloorableHit {
  notePath: string;
  reason?: string;
  similarity?: number;
}

/**
 * `hits` without the ones found by meaning whose similarity is below `floor`, and without the statements the session
 * expansion added to a note none of whose matched hits is left. `withheld` counts every hit taken out. Order is kept.
 */
export function applyHitFloor<T extends FloorableHit>(hits: readonly T[], floor: number): { hits: T[]; withheld: number } {
  const below = new Set(hits.filter(hit => typeof hit.similarity === 'number' && hit.similarity < floor));
  const matched = new Set(hits.filter(hit => hit.reason !== SESSION_EXPAND_REASON && !below.has(hit)).map(hit => hit.notePath));
  const kept = hits.filter(hit => !below.has(hit) && (hit.reason !== SESSION_EXPAND_REASON || matched.has(hit.notePath)));
  return { hits: kept, withheld: hits.length - kept.length };
}
