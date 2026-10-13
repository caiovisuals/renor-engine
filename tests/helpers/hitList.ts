/**
 * `search` answers a plain hit list unless RENOR_STRUCTURED_CONTEXT is on (then `{ hits, composedContext }`),
 * and `keyword` answers `{ ok: false, error: 'fts-query', ... }` instead of a list when FTS5 rejects the
 * query. A test that reads the answer as a list is pinning that default shape, so any other shape must fail
 * it here, loudly, rather than surface later as `undefined.length`.
 */
export function hitList<T>(answer: T[] | object): T[] {
  if (!Array.isArray(answer)) throw new Error(`expected a list of hits, got ${JSON.stringify(answer)}`);
  return answer;
}
