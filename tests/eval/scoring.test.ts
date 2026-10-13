import { describe, expect, it } from 'vitest';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';

describe('scoreRetrieval', () => {
  it('aggregates quality, abstention, latency, and context metrics', () => {
    const cases: EvalCase[] = [
      {
        id: 'a',
        category: 'stable_fact',
        query: 'favorite drink?',
        relevant: [{ match: 'passion fruit juice', relevance: 3 }],
        split: 'dev',
      },
      {
        id: 'b',
        category: 'abstention',
        query: 'passport number?',
        relevant: [],
        shouldAbstain: true,
        split: 'dev',
      },
    ];
    const results: EvalResult[] = [
      {
        id: 'a',
        hits: [{ text: 'Ava likes passion fruit juice.' }],
        latencyMs: 10,
        contextTokens: 20,
      },
      {
        id: 'b',
        hits: [],
        latencyMs: 30,
        contextTokens: 0,
      },
    ];

    const scored = scoreRetrieval(cases, results);
    expect(scored.overall.hitAt1).toBe(1);
    expect(scored.overall.recallAt5).toBe(1);
    expect(scored.overall.abstentionEmptyRate).toBe(1);
    expect(scored.overall.meanLatencyMs).toBe(20);
    expect(scored.overall.p50LatencyMs).toBe(10);
    expect(scored.overall.p95LatencyMs).toBe(30);
    expect(scored.overall.meanContextTokens).toBe(10);
  });

  it('rejects missing and unknown result ids', () => {
    const cases: EvalCase[] = [{
      id: 'expected',
      category: 'stable_fact',
      query: 'q',
      relevant: [{ match: 'answer' }],
      split: 'dev',
    }];

    expect(() => scoreRetrieval(cases, [])).toThrow(/Missing result/);
    expect(() => scoreRetrieval(cases, [
      { id: 'expected', hits: [{ text: 'answer' }] },
      { id: 'extra', hits: [] },
    ])).toThrow(/unknown case ids/i);
  });

  it('rejects duplicate case ids', () => {
    const cases: EvalCase[] = [
      { id: 'dup', category: 'stable_fact', query: 'q', relevant: [{ match: 'a' }], split: 'dev' },
      { id: 'dup', category: 'stable_fact', query: 'q2', relevant: [{ match: 'b' }], split: 'dev' },
    ];
    expect(() => scoreRetrieval(cases, [])).toThrow(/Duplicate eval case id/);
  });

  it('rejects duplicate result ids instead of silently collapsing them', () => {
    const cases: EvalCase[] = [
      { id: 'a', category: 'stable_fact', query: 'q', relevant: [{ match: 'answer' }], split: 'dev' },
    ];
    const results: EvalResult[] = [
      { id: 'a', hits: [{ text: 'answer' }] },
      { id: 'a', hits: [] },
    ];
    expect(() => scoreRetrieval(cases, results)).toThrow(/Duplicate result id/);
  });

  it('rejects duplicate gold targets within a case', () => {
    const cases: EvalCase[] = [{
      id: 'a',
      category: 'stable_fact',
      query: 'q',
      relevant: [
        { match: 'seattle', relevance: 3 },
        { match: 'Seattle', relevance: 3 },
      ],
      split: 'dev',
    }];
    expect(() => scoreRetrieval(cases, [{ id: 'a', hits: [] }])).toThrow(/Duplicate gold target/);
  });

  it('rejects answerable cases whose gold has no positive-role target', () => {
    const cases: EvalCase[] = [{
      id: 'a',
      category: 'stable_fact',
      query: 'q',
      relevant: [{ match: 'x', relevance: 1 }],
      split: 'dev',
    }];
    expect(() => scoreRetrieval(cases, [{ id: 'a', hits: [] }])).toThrow(/no positive-role target/);
  });

  it('scores recallAll and forbiddenRetrievalRate for multi-evidence and erasure cases', () => {
    const cases: EvalCase[] = [
      {
        id: 'hop',
        category: 'multi_hop',
        query: 'compose two facts',
        relevant: [
          { match: 'fact a', relevance: 3, notePath: 'A.md' },
          { match: 'fact b', relevance: 3, notePath: 'B.md' },
        ],
        requiredEvidence: [
          { match: 'fact a', relevance: 3, notePath: 'A.md' },
          { match: 'fact b', relevance: 3, notePath: 'B.md' },
        ],
        split: 'dev',
      },
      {
        id: 'erase',
        category: 'deletion_erasure',
        query: 'deleted code?',
        relevant: [],
        shouldAbstain: true,
        forbiddenEvidence: [{ match: '4457', relevance: 1, notePath: 'Erasure/x.md' }],
        split: 'dev',
      },
    ];
    const partialOnlyA: EvalResult[] = [
      { id: 'hop', hits: [{ text: 'fact a', notePath: 'A.md' }] },
      { id: 'erase', hits: [{ text: 'the code 4457', notePath: 'Erasure/x.md' }] },
    ];
    const scored = scoreRetrieval(cases, partialOnlyA);
    // Multi-hop with only one of two required facts: Hit-any passes but recallAll fails.
    expect(scored.overall.recallAllAt10).toBe(0);
    expect(scored.overall.hitAt10).toBe(1);
    // Erasure violation: deleted note resurfaced.
    expect(scored.overall.forbiddenRetrievalRate).toBe(1);

    const complete: EvalResult[] = [
      { id: 'hop', hits: [{ text: 'fact a', notePath: 'A.md' }, { text: 'fact b', notePath: 'B.md' }] },
      { id: 'erase', hits: [] },
    ];
    const rescored = scoreRetrieval(cases, complete);
    expect(rescored.overall.recallAllAt10).toBe(1);
    expect(rescored.overall.forbiddenRetrievalRate).toBe(0);
    expect(rescored.overall.abstentionEmptyRate).toBe(1);
  });

  it('aggregates contradiction-first rate over supersession-sensitive cases only', () => {
    const cases: EvalCase[] = [
      {
        id: 'current',
        category: 'current_vs_historical',
        query: 'Where does Ava live now?',
        relevant: [
          { match: 'seattle', relevance: 3, notePath: 'People/ava.md' },
          { match: 'boston', relevance: 1, notePath: 'History/ava.md' },
        ],
        split: 'dev',
      },
      {
        id: 'historical',
        category: 'current_vs_historical',
        query: 'Where did Ava live before Seattle?',
        relevant: [
          { match: 'boston', relevance: 3, notePath: 'History/ava.md' },
          { match: 'seattle', relevance: 1, notePath: 'People/ava.md' },
        ],
        split: 'dev',
      },
    ];
    const results: EvalResult[] = [
      {
        id: 'current',
        // Stale answer surfaced first: contradiction-first error.
        hits: [
          { text: 'Ava lived in Boston.', notePath: 'History/ava.md' },
          { text: 'Ava now lives in Seattle.', notePath: 'People/ava.md' },
        ],
      },
      {
        id: 'historical',
        hits: [
          { text: 'Before moving, Ava lived in Boston.', notePath: 'History/ava.md' },
          { text: 'Ava now lives in Seattle.', notePath: 'People/ava.md' },
        ],
      },
    ];

    const scored = scoreRetrieval(cases, results);
    expect(scored.overall.supersessionSensitiveCases).toBe(2);
    expect(scored.overall.contradictionFirstRate).toBe(0.5);
    expect(scored.byCategory.current_vs_historical.contradictionFirstRate).toBe(0.5);
    // The stale-first case must not earn binary credit at rank 1.
    expect(scored.byCategory.current_vs_historical.hitAt1).toBe(0.5);
  });
});