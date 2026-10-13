import { describe, it, expect } from 'vitest';
import {
  LocalRulesDecisionModel,
  defaultDecisionModel,
  type DecisionModel,
  type FactCandidate,
} from '../../src/extraction/decision-model';

describe('DecisionModel interface (Lane Jev §3 seam)', () => {
  it('capture gate classifies numeric fact spans and gates everything else to none', async () => {
    const model = new LocalRulesDecisionModel();
    const fact = await model.decide({ task: 'capture_gate', text: 'Rowan ran 42 km in the marathon.' });
    expect(fact.task).toBe('capture_gate');
    expect(fact.decision).toBe('fact');
    const none = await model.decide({ task: 'capture_gate', text: 'The weather was pleasant today.' });
    expect(none.decision).toBe('none');
    const empty = await model.decide({ task: 'capture_gate', text: '   ' });
    expect(empty.decision).toBe('none');
  });

  it('dedupe adjudication is identical / updated / distinct', async () => {
    const model = new LocalRulesDecisionModel();
    const candidate: FactCandidate = { value: '3:45', object: 'Marathon' };
    const identical = await model.decide({ task: 'dedupe_adjudication', candidate, existing: { value: '3:45', object: 'marathon' } });
    expect(identical.decision).toBe('identical');
    const updated = await model.decide({ task: 'dedupe_adjudication', candidate, existing: { value: '3:50', object: 'Marathon' } });
    expect(updated.decision).toBe('updated');
    const distinct = await model.decide({ task: 'dedupe_adjudication', candidate, existing: { value: '5', object: 'Parkrun distance' } });
    expect(distinct.decision).toBe('distinct');
    const fresh = await model.decide({ task: 'dedupe_adjudication', candidate, existing: null });
    expect(fresh.decision).toBe('distinct');
  });

  it('reports the contract result shape: decision, confidence, latencyMs, costUSDCents', async () => {
    const model = defaultDecisionModel();
    const result = await model.decide({ task: 'capture_gate', text: 'He weighs 80 kg.' });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.costUSDCents).toBe(0); // local implementation never bills
  });

  it('is deterministic: same input → same decision, twice', async () => {
    const model = new LocalRulesDecisionModel();
    const a = await model.decide({ task: 'capture_gate', text: 'The subscription costs 15 dollars per month.' });
    const b = await model.decide({ task: 'capture_gate', text: 'The subscription costs 15 dollars per month.' });
    expect(a.decision).toBe(b.decision);
    expect(a.decision).toBe('fact');
  });

  it('accepts any pluggable adapter (stub) — no vendor is hardcoded', async () => {
    const stub: DecisionModel = {
      async decide(request) {
        if (request.task === 'capture_gate') {
          return { task: 'capture_gate', decision: 'preference', confidence: 0.9, latencyMs: 5, costUSDCents: 0.1 };
        }
        return { task: 'dedupe_adjudication', decision: 'updated', confidence: 0.8, latencyMs: 5, costUSDCents: 0.1 };
      },
    };
    expect((await stub.decide({ task: 'capture_gate', text: 'I always run Tuesdays' })).decision).toBe('preference');
    expect((await stub.decide({ task: 'dedupe_adjudication', candidate: { value: '1', object: 'x' }, existing: { value: '2', object: 'x' } })).decision).toBe('updated');
  });
});