import { describe, it, expect } from 'vitest';
import { applyHitFloor, searchHitFloor } from '../../src/mvp/hitFloor';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';

/** The floor itself (mvp/hitFloor.ts), on hits as the page holds them. The MCP tool that applies it: search-hit-floor.test.ts. */
describe('applyHitFloor', () => {
  const hit = (notePath: string, similarity: number | undefined, reason = 'semantic') => ({ notePath, similarity, reason });

  it('takes out the hits found by meaning below the floor and keeps the rest in order', () => {
    const hits = [hit('a.md', 0.9), hit('b.md', 0.5), hit('c.md', 0.7), hit('d.md', 0.7)];
    expect(applyHitFloor(hits, 0.7)).toEqual({ hits: [hits[0], hits[2], hits[3]], withheld: 1 });
    expect(applyHitFloor(hits, 0)).toEqual({ hits, withheld: 0 });
    expect(applyHitFloor(hits, 1)).toEqual({ hits: [], withheld: 4 });
  });

  it('never judges a hit that has no similarity of its own: a fact, evidence, a digest, a ledger event, a graph hit', () => {
    const hits = [hit('', undefined, 'evidence'), hit('', undefined, 'digest'), hit('', undefined, 'fact'), hit('ledger.md', undefined), hit('g.md', undefined, 'graph'), hit('a.md', 0.2)];
    expect(applyHitFloor(hits, 1)).toEqual({ hits: hits.slice(0, 5), withheld: 1 });
  });

  it('keeps a statement the session expansion added only while a hit that matched its note is left', () => {
    const hits = [
      hit('kept.md', 0.8), hit('kept.md', undefined, SESSION_EXPAND_REASON),
      hit('gone.md', 0.3), hit('gone.md', undefined, SESSION_EXPAND_REASON), hit('gone.md', undefined, SESSION_EXPAND_REASON),
      hit('graph.md', undefined, 'graph'), hit('graph.md', undefined, SESSION_EXPAND_REASON),
    ];
    const { hits: kept, withheld } = applyHitFloor(hits, 0.5);
    expect(kept).toEqual([hits[0], hits[1], hits[5], hits[6]]);
    expect(withheld).toBe(3);
  });

  it('does not touch what it is given', () => {
    const hits = Object.freeze([Object.freeze(hit('a.md', 0.1)), Object.freeze(hit('b.md', 0.9))]);
    expect(() => applyHitFloor(hits, 0.5)).not.toThrow();
    expect(hits).toHaveLength(2);
  });
});


describe('operator setting', () => {
  const calibrated = 'vertex:gemini-embedding-001:768';
  const otherModels = [undefined, 'eval-hash:lexical-hash-v1:256', 'vertex:gemini-embedding-001:3072', 'vertex:other-model:768', 'other:gemini-embedding-001:768'];

  it('defaults to 0.63 only for the calibrated model and dimensions, off for every other namespace', () => {
    expect(searchHitFloor(calibrated, {})).toBe(0.63);
    for (const model of otherModels) expect(searchHitFloor(model, {}), model).toBe(0);
  });

  it('lets an explicit operator setting win for every namespace, including 0 as off', () => {
    for (const model of [calibrated, ...otherModels]) {
      for (const setting of ['0', '0.7', '1']) expect(searchHitFloor(model, { RENOR_SEARCH_HIT_FLOOR: setting })).toBe(Number(setting));
    }
  });

  it('uses the namespace default for empty or invalid settings', () => {
    for (const model of [calibrated, ...otherModels]) {
      for (const setting of ['', 'no', '-1', '1.1', 'NaN', 'Infinity']) {
        expect(searchHitFloor(model, { RENOR_SEARCH_HIT_FLOOR: setting })).toBe(model === calibrated ? 0.63 : 0);
      }
    }
  });

  it('keeps a cosine equal to the floor, regardless of a boosted score', () => {
    const hits = [{ notePath: 'below.md', similarity: 0.629, score: 1.9 }, { notePath: 'equal.md', similarity: 0.63, score: 0.63 }];
    expect(applyHitFloor(hits, 0.63)).toEqual({ hits: [hits[1]], withheld: 1 });
  });
});
