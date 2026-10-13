import { describe, expect, it } from 'vitest';
import { PRODUCT_QUALITY_METRICS, scoreProductArm, type ProductResult } from '../../src/eval/renorbenchProduct';
import type { EvalCase } from '../../src/eval/scoring';

/**
 * The product arm scores the reply of `search_memory` (what an agent receives), with no model. These pin what each
 * number counts, on small synthetic cases, so that a change to the scorer cannot quietly change what the gate holds the
 * tool to.
 */

type Target = EvalCase['relevant'][number];
const hit = (notePath: string, text: string, reason = 'semantic+content') => ({ notePath, text, score: 0.5, reason });
const answerable = (id: string, relevant: Target[], extra: Partial<EvalCase> = {}): EvalCase => ({ id, category: 'stable_fact', query: `question ${id}`, relevant, split: 'dev', ...extra });
const abstention = (id: string, extra: Partial<EvalCase> = {}): EvalCase => ({ id, category: 'abstention', query: `question ${id}`, relevant: [], shouldAbstain: true, split: 'dev', ...extra });
const reply = (id: string, hits: ProductResult['hits'], verdict: boolean | null = true, replyTokens = 100): ProductResult => ({
  id, hits, verdict: verdict === null ? null : { relevant: verdict, similarity: 0.5, bar: 0.375 }, replyTokens,
});

describe('delivery: what the reply carries', () => {
  it('counts every hit of the reply, not a top-K: gold at position 25 is delivered', () => {
    const noise = Array.from({ length: 24 }, (_, i) => hit(`Noise/n${i}.md`, `unrelated text ${i}`));
    const cases = [answerable('a', [{ match: 'passion fruit', relevance: 3, notePath: 'People/Ava.md' }])];
    const summary = scoreProductArm(cases, [reply('a', [...noise, hit('People/Ava.md', 'Her drink is passion fruit juice.')])]);
    expect(summary.overall).toMatchObject({ replyHit: 1, replyRecall: 1, replyRecallAll: 1 });
  });

  it('a gold target pinned to a note is not satisfied by another note that says the same words', () => {
    const cases = [answerable('a', [{ match: 'cello', relevance: 3, notePath: 'People/Ava.md' }])];
    const summary = scoreProductArm(cases, [reply('a', [hit('Topics/Music.md', 'A coworker plays the cello.')])]);
    expect(summary.overall).toMatchObject({ replyHit: 0, replyRecall: 0, replyRecallAll: 0 });
  });

  it('recall is the share of positive targets in the reply, and recallAll needs every required one', () => {
    const cases = [
      answerable('two', [{ match: 'february 2025', relevance: 3, notePath: 'a.md' }, { match: 'portland', relevance: 3, notePath: 'b.md' }]),
      answerable('one', [{ match: 'cello', relevance: 3, notePath: 'c.md' }]),
    ];
    const summary = scoreProductArm(cases, [
      reply('two', [hit('a.md', 'moved in February 2025')]),
      reply('one', [hit('c.md', 'plays the cello')]),
    ]);
    // 'two' holds half of its targets: recall (0.5 + 1) / 2, and only 'one' is fully answered.
    expect(summary.overall).toMatchObject({ replyHit: 1, replyRecall: 0.75, replyRecallAll: 0.5 });
  });

  it('requiredEvidence, when a case names it, is what recallAll needs', () => {
    const cases = [answerable('a', [{ match: 'portland', relevance: 3, notePath: 'b.md' }, { match: 'february', relevance: 3, notePath: 'a.md' }], {
      requiredEvidence: [{ match: 'portland', notePath: 'b.md' }],
    })];
    const summary = scoreProductArm(cases, [reply('a', [hit('b.md', 'lives in Portland')])]);
    expect(summary.overall).toMatchObject({ replyRecall: 0.5, replyRecallAll: 1 });
  });

  it('a session-expansion statement earns credit where it is the evidence', () => {
    const cases = [answerable('a', [{ match: 'standardized on react', relevance: 3, notePath: 'Projects/Atlas.md' }])];
    const summary = scoreProductArm(cases, [reply('a', [hit('Projects/Atlas.md', 'The team standardized on React.', 'session-expand')])]);
    expect(summary.overall).toMatchObject({ replyHit: 1, replyRecallAll: 1 });
  });

  it('abstention cases are not delivery cases: they leave the delivery scores alone', () => {
    const cases = [answerable('a', [{ match: 'cello', relevance: 3, notePath: 'c.md' }]), abstention('z')];
    const summary = scoreProductArm(cases, [reply('a', [hit('c.md', 'cello')]), reply('z', [])]);
    expect(summary.overall).toMatchObject({ cases: 2, answerableCases: 1, abstentionCases: 1, replyHit: 1, replyRecall: 1, replyRecallAll: 1 });
  });
});

describe('erasure and the stale value', () => {
  const erased = (match: string): Partial<EvalCase> => ({ forbiddenEvidence: [{ match, relevance: 1, notePath: 'Erasure/zenith.md' }] });

  it('forbidden evidence anywhere in the reply counts, not only in the first ten hits', () => {
    const noise = Array.from({ length: 14 }, (_, i) => hit(`Noise/n${i}.md`, `unrelated text ${i}`));
    const cases = [abstention('e1', erased('4457')), abstention('e2', erased('4457'))];
    const summary = scoreProductArm(cases, [
      reply('e1', [...noise, hit('Erasure/zenith.md', 'access code 4457')], false),
      reply('e2', noise, false),
    ]);
    expect(summary.overall).toMatchObject({ forbiddenSensitiveCases: 2, forbiddenInReplyRate: 0.5 });
  });

  it('a stale value read before the current one is a contradictionFirst; the current one first is not', () => {
    const targets: Target[] = [{ match: 'passion fruit', relevance: 3, notePath: 'now.md' }, { match: 'oat milk', relevance: 1, notePath: 'old.md' }];
    const cases = [answerable('stale-first', targets), answerable('current-first', targets), answerable('no-conflict', [{ match: 'cello', relevance: 3, notePath: 'c.md' }])];
    const summary = scoreProductArm(cases, [
      reply('stale-first', [hit('old.md', 'oat milk'), hit('now.md', 'passion fruit')]),
      reply('current-first', [hit('now.md', 'passion fruit'), hit('old.md', 'oat milk')]),
      reply('no-conflict', [hit('c.md', 'cello')]),
    ]);
    expect(summary.overall).toMatchObject({ supersessionSensitiveCases: 2, contradictionFirstRate: 0.5 });
  });

  it('has no rate where the data has no such case', () => {
    const summary = scoreProductArm([answerable('a', [{ match: 'cello', relevance: 3, notePath: 'c.md' }])], [reply('a', [hit('c.md', 'cello')])]);
    expect(summary.overall).toMatchObject({ contradictionFirstRate: null, forbiddenInReplyRate: null, verdictAbstainRate: null });
  });
});

describe('the verdict, judged where the data has the label', () => {
  const cases = [
    answerable('a1', [{ match: 'cello', relevance: 3, notePath: 'c.md' }]),
    answerable('a2', [{ match: 'cello', relevance: 3, notePath: 'c.md' }]),
    abstention('z1'),
    abstention('z2'),
  ];
  const hits = [hit('c.md', 'cello')];

  it('an answerable case is right when the reply says relevant, an abstention case when it says not', () => {
    const summary = scoreProductArm(cases, [reply('a1', hits, true), reply('a2', hits, false), reply('z1', hits, false), reply('z2', hits, false)]);
    expect(summary.overall).toMatchObject({ verdictRelevantRate: 0.5, verdictAbstainRate: 1, verdictMissingCases: 0 });
  });

  it('a reply with no verdict is wrong for both kinds of case, and is counted', () => {
    const summary = scoreProductArm(cases, cases.map(test => reply(test.id, hits, null)));
    expect(summary.overall).toMatchObject({ verdictRelevantRate: 0, verdictAbstainRate: 0, verdictMissingCases: 4 });
  });

  it('is judged per category, so a category that loses its verdict shows', () => {
    const summary = scoreProductArm(cases, [reply('a1', hits, true), reply('a2', hits, true), reply('z1', hits, true), reply('z2', hits, true)]);
    expect(summary.byCategory?.stable_fact).toMatchObject({ verdictRelevantRate: 1, verdictAbstainRate: null });
    expect(summary.byCategory?.abstention).toMatchObject({ verdictRelevantRate: null, verdictAbstainRate: 0 });
  });
});

describe('what a reply costs', () => {
  it('reports the mean and the 95th percentile of the reply tokens, overall and per category', () => {
    const cases = [answerable('a', [{ match: 'x', relevance: 3 }]), answerable('b', [{ match: 'x', relevance: 3 }], { category: 'temporal' }), abstention('z')];
    const summary = scoreProductArm(cases, [reply('a', [hit('n.md', 'x')], true, 100), reply('b', [hit('n.md', 'x')], true, 300), reply('z', [], false, 200)]);
    expect(summary.overall).toMatchObject({ meanReplyTokens: 200, p95ReplyTokens: 300 });
    expect(summary.byCategory?.temporal).toMatchObject({ meanReplyTokens: 300 });
  });

  it('leaves latency out of the tracked metrics (it is noise), and reports it when the run measured it', () => {
    expect(PRODUCT_QUALITY_METRICS.map(metric => metric.key).some(key => /Latency/.test(key))).toBe(false);
    const summary = scoreProductArm([abstention('z')], [{ ...reply('z', []), latencyMs: 12.5 }]);
    expect(summary.overall).toMatchObject({ meanLatencyMs: 12.5, p50LatencyMs: 12.5, p95LatencyMs: 12.5 });
  });
});

describe('what the gate holds the arm to', () => {
  it('tracks delivery, the verdict and the cost, each in its direction, and every tracked number is in the summary', () => {
    expect(PRODUCT_QUALITY_METRICS).toEqual([
      { key: 'replyRecall', higherBetter: true },
      { key: 'replyRecallAll', higherBetter: true },
      { key: 'contradictionFirstRate', higherBetter: false },
      { key: 'forbiddenInReplyRate', higherBetter: false },
      { key: 'verdictRelevantRate', higherBetter: true },
      { key: 'verdictAbstainRate', higherBetter: true },
      { key: 'meanReplyTokens', higherBetter: false },
    ]);
    const summary = scoreProductArm([answerable('a', [{ match: 'x', relevance: 3 }])], [reply('a', [hit('n.md', 'x')])]);
    for (const { key } of PRODUCT_QUALITY_METRICS) expect(Object.keys(summary.overall), key).toContain(key);
  });

  it('scores deterministically: the same replies give the same summary', () => {
    const cases = [answerable('a', [{ match: 'x', relevance: 3 }]), abstention('z')];
    const results = [reply('a', [hit('n.md', 'x')]), reply('z', [], false)];
    expect(JSON.stringify(scoreProductArm(cases, results))).toBe(JSON.stringify(scoreProductArm(cases, results)));
  });
});

describe('a malformed run is refused, never scored', () => {
  const cases = [answerable('a', [{ match: 'x', relevance: 3 }])];
  const good = reply('a', [hit('n.md', 'x')]);

  it('refuses a missing result, an unknown id and a duplicate id', () => {
    expect(() => scoreProductArm(cases, [])).toThrow(/Missing result for eval case: a/);
    expect(() => scoreProductArm(cases, [good, reply('ghost', [])])).toThrow(/unknown case ids: ghost/);
    expect(() => scoreProductArm(cases, [good, good])).toThrow(/Duplicate result id: a/);
  });

  it('refuses a reply with no token count, a negative or fractional one, and a malformed verdict', () => {
    expect(() => scoreProductArm(cases, [{ ...good, replyTokens: undefined as unknown as number }])).toThrow(/replyTokens/);
    expect(() => scoreProductArm(cases, [{ ...good, replyTokens: -1 }])).toThrow(/Invalid contextTokens/);
    expect(() => scoreProductArm(cases, [{ ...good, replyTokens: 1.5 }])).toThrow(/Invalid contextTokens/);
    expect(() => scoreProductArm(cases, [{ ...good, verdict: { relevant: 'yes', similarity: 0.5, bar: 0.4 } as never }])).toThrow(/Invalid verdict/);
    expect(() => scoreProductArm(cases, [{ ...good, verdict: { relevant: true, similarity: NaN, bar: 0.4 } }])).toThrow(/Invalid verdict/);
  });
});
