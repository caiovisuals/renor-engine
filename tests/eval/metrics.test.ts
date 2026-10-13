import { describe, expect, it } from 'vitest';
import {
  contradictionFirst,
  hitAtK,
  hitMatchesTarget,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  roleOf,
} from '../../src/eval/metrics';

describe('retrieval eval metrics', () => {
  // The exact shape of RenorBench supersession golds: current value is
  // positive (relevance 3), superseded value is forbidden (relevance 1).
  const targets = [
    { match: 'passion fruit juice', relevance: 3 },
    { match: 'mango juice', relevance: 1 }
  ];

  const hits = [
    { text: 'Ava likes tea.' },
    { text: "Ava's favorite drink is passion fruit juice." },
    { text: 'Previously Ava said mango juice.' }
  ];

  it('computes hit and strict multi-target recall separately over positive evidence', () => {
    expect(hitAtK(hits, targets, 2)).toBe(1);
    expect(recallAtK(hits, targets, 2)).toBe(1);
    expect(recallAtK(hits, targets, 3)).toBe(1);
  });

  it('computes reciprocal rank from first positive hit', () => {
    expect(reciprocalRank(hits, targets)).toBe(0.5);
  });

  it('resolves gold roles from relevance grades', () => {
    expect(roleOf({ match: 'x', relevance: 3 })).toBe('positive');
    expect(roleOf({ match: 'x', relevance: 2 })).toBe('positive');
    expect(roleOf({ match: 'x', relevance: 1 })).toBe('forbidden');
    expect(roleOf({ match: 'x' })).toBe('positive');
    expect(roleOf({ match: 'x', relevance: 3, role: 'supporting' })).toBe('supporting');
    expect(roleOf({ match: 'x', relevance: 1, role: 'positive' })).toBe('positive');
  });

  it('P0-A regression: retrieving only the obsolete answer yields zero Hit/MRR/Recall', () => {
    // "Where does Ava live now?" with Seattle(3)/Boston(1): returning only
    // Boston at rank 1 must NOT score a perfect Hit@1/MRR.
    const staleOnly = [{ text: 'Ava lived in Boston.' }];
    expect(hitAtK(staleOnly, targets, 1)).toBe(0);
    expect(recallAtK(staleOnly, targets, 1)).toBe(0);
    expect(reciprocalRank(staleOnly, targets)).toBe(0);
  });

  it('P0-A regression: stale answer at rank 1 is a contradiction-first error, current-first is not', () => {
    const staleFirst = [
      { text: 'Previously Ava said mango juice.' },
      { text: "Ava's favorite drink is passion fruit juice." },
    ];
    const currentFirst = [
      { text: "Ava's favorite drink is passion fruit juice." },
      { text: 'Previously Ava said mango juice.' },
    ];
    expect(contradictionFirst(staleFirst, targets)).toBe(true);
    expect(contradictionFirst(currentFirst, targets)).toBe(false);
    expect(hitAtK(staleFirst, targets, 1)).toBe(0);
    expect(hitAtK(currentFirst, targets, 1)).toBe(1);
  });

  it('P0-F regression: a needle appearing only in a filename earns no textual credit', () => {
    const gold = [{ match: 'ava-current', relevance: 3 }];
    const hit = { text: 'Completely unrelated content.', notePath: 'People/ava-current.md' };
    expect(hitMatchesTarget(hit, gold[0])).toBe(false);
    expect(hitAtK([hit], gold, 1)).toBe(0);
  });

  it('P0-F regression: unrelated noise text cannot satisfy a path-pinned gold', () => {
    // The dev fixture's noise note mentions Seattle without describing where
    // Ava lives; pinning the gold to the current note rejects it.
    const gold = [{ match: 'seattle', relevance: 3, notePath: 'People/ava-current.md' }];
    const noise = { text: 'compared rental prices in Seattle; did not describe where she lived', notePath: 'Noise/adjacent-memories.md' };
    expect(hitAtK([noise], gold, 1)).toBe(0);
  });

  it('can pin a gold target to an expected note path', () => {
    const pathTarget = [{ match: 'cello', notePath: '/People/Ava.md', relevance: 3 }];
    expect(hitAtK([{ text: 'cello', notePath: '/Scratch.md' }], pathTarget, 1)).toBe(0);
    expect(hitAtK([{ text: 'cello', notePath: '/People/Ava.md' }], pathTarget, 1)).toBe(1);
  });

  it('path-pinned session-id targets still match via the pinned path itself', () => {
    const gold = [{ match: 'session_ab-1234', notePath: 'Sessions/session_ab-1234.md', relevance: 1, role: 'positive' as const }];
    const hit = { text: 'irrelevant chunk text', notePath: 'Sessions/session_ab-1234.md' };
    expect(hitAtK([hit], gold, 1)).toBe(1);
  });

  it('rewards placing higher-relevance evidence earlier', () => {
    const good = [
      { text: 'passion fruit juice' },
      { text: 'mango juice' }
    ];
    const reversed = [
      { text: 'mango juice' },
      { text: 'passion fruit juice' }
    ];
    expect(ndcgAtK(good, targets, 2)).toBeCloseTo(1);
    expect(ndcgAtK(reversed, targets, 2)).toBeLessThan(1);
  });

  it('excludes forbidden targets from nDCG credit and ideal ranking', () => {
    const forbiddenOnly = [{ text: 'mango juice' }];
    expect(ndcgAtK(forbiddenOnly, targets, 1)).toBe(0);
  });

  it('duplicated retrieved rows never inflate recall or nDCG', () => {
    const single = [{ text: 'passion fruit juice' }];
    const duplicated = Array.from({ length: 10 }, () => ({ text: 'passion fruit juice' }));
    expect(recallAtK(duplicated, targets, 10)).toBe(recallAtK(single, targets, 1));
    expect(ndcgAtK(duplicated, targets, 10)).toBe(ndcgAtK(single, targets, 1));
  });

  it('supporting targets grade nDCG but never credit binary metrics', () => {
    const mixed = [
      { match: 'primary evidence', relevance: 3 },
      { match: 'context detail', relevance: 2, role: 'supporting' as const },
    ];
    expect(hitAtK([{ text: 'context detail' }], mixed, 1)).toBe(0);
    expect(hitAtK([{ text: 'primary evidence' }], mixed, 1)).toBe(1);
  });
});