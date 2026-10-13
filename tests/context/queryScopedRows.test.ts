import { describe, it, expect } from 'vitest';
import {
  composeQueryContext,
  filterRowsByQueryTerms,
  queryScopedRowsEnabled,
  type ComposerInput,
} from '../../src/context/composer';
import type { StoredStructuredRow } from '../../src/context/rowStore';
import type { RetrievalHit } from '../../src/retrieval/orchestrator';

// C5 fixture rows. NOTE (adversarial): every fixture is built from StoredStructuredRow
// (sourcePath/sourceChunkId/payload) and RetrievalHit — there is NO field in these
// types (nor in ComposerInput, nor in ComposerOptions) that can carry a benchmark
// category or gold label; the filter's signature accepts only (kind, query, rows).

function hit(notePath: string, text: string, score = 0.5): RetrievalHit {
  return { notePath, chunkId: 1, headingPath: '', text, score, reason: 'semantic' };
}

let nextId = 1;
function grow(
  rowKind: StoredStructuredRow['rowKind'],
  payload: StoredStructuredRow['payload'],
  overrides: Partial<StoredStructuredRow> = {},
): StoredStructuredRow {
  return {
    id: nextId++,
    rowKind,
    sourcePath: 'notes/a.md',
    sourceChunkId: 1,
    sourceHash: 'h',
    extractionVersion: 'v1',
    validFrom: '2024-03-01',
    dedupeKey: `k${nextId}`,
    payload,
    ...overrides,
  } as StoredStructuredRow;
}

const FACT_ROWS = [
  grow('fact', { value: '26', unit: 'km', verb: 'ran', object: 'long run distance' }),
  grow('fact', { value: '7', unit: 'am', verb: 'wakes', object: 'morning wake time' }),
  grow('fact', { value: '42', unit: 'km', verb: 'raced', object: 'marathon distance' }),
  grow('fact', { value: '3:45', unit: '', verb: 'finished', object: 'marathon time' }),
  grow('fact', { value: '2', unit: 'L', verb: 'drank', object: 'hydration target' }),
];

const EVENT_ROWS = [
  grow('event', { when: '2024-02-10', event: 'long run 30km in the hills' }),
  grow('event', { when: '2024-02-11', event: 'rest day, no running' }),
];

const PREF_ROWS = [
  grow('preference', { statement: 'prefers morning runs before work', kind: 'routine' }),
  grow('preference', { statement: 'avoids caffeine after noon', kind: 'diet' }),
];

const ENV_ON = { RENOR_QUERY_SCOPED_ROWS: '1' } as NodeJS.ProcessEnv;
const ENV_OFF = { RENOR_QUERY_SCOPED_ROWS: '' } as NodeJS.ProcessEnv;

function compose(input: Omit<ComposerInput, 'rows'>, rows: StoredStructuredRow[], env = ENV_OFF) {
  return composeQueryContext({ ...input, rows }, { env });
}

describe('C5 query-scoped rows: flag default', () => {
  it('RENOR_QUERY_SCOPED_ROWS defaults OFF and parses opt-in values', () => {
    expect(queryScopedRowsEnabled()).toBe(false);
    expect(queryScopedRowsEnabled(ENV_OFF)).toBe(false);
    expect(queryScopedRowsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(queryScopedRowsEnabled({ RENOR_QUERY_SCOPED_ROWS: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(queryScopedRowsEnabled({ RENOR_QUERY_SCOPED_ROWS: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
    expect(queryScopedRowsEnabled({ RENOR_QUERY_SCOPED_ROWS: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
    expect(queryScopedRowsEnabled({ RENOR_QUERY_SCOPED_ROWS: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    expect(queryScopedRowsEnabled({ RENOR_QUERY_SCOPED_ROWS: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('flag off → byte-identical to pre-C5 behavior (filter not consulted)', () => {
    const input = { query: 'marathon distance', hits: [hit('notes/a.md', 'text')] };
    const rows = [...FACT_ROWS, ...EVENT_ROWS, ...PREF_ROWS];
    const ctx = compose(input, rows, ENV_OFF);
    const on = compose(input, rows, ENV_ON);
    expect(on.usedTokens).toBeLessThan(ctx.usedTokens); // flag actually changes behavior
    expect(ctx.text).toBe(compose(input, rows, ENV_OFF).text); // deterministic when off
  });
});

describe('C5 query-scoped rows: fixture semantics (pure function of query + rows)', () => {
  it('aggregate query ("how much in total…") retains the FULL facts table, gold-blind', () => {
    const kept = filterRowsByQueryTerms('fact', 'how much in total did I run across races', FACT_ROWS);
    expect(kept).toHaveLength(FACT_ROWS.length);
    expect(kept).toEqual(FACT_ROWS);
  });

  it('non-aggregate query keeps only term-overlapping fact rows', () => {
    // Terms {marathon, distance} hit rows 1 ("long run distance"), 3 and 4
    // ("marathon ..."); wake-time and hydration rows have no overlap.
    const kept = filterRowsByQueryTerms('fact', 'marathon distance', FACT_ROWS);
    expect(kept.map((r) => r.id)).toEqual([FACT_ROWS[0].id, FACT_ROWS[2].id, FACT_ROWS[3].id]);
    expect(kept.map((r) => r.id)).not.toContain(FACT_ROWS[1].id);
    expect(kept.map((r) => r.id)).not.toContain(FACT_ROWS[4].id);
  });

  it('chronicle and prefs are ALWAYS term-filtered, even for aggregate queries', () => {
    const agg = 'how many long runs total this year'; // aggregate intent, gold-blind
    const keptEvents = filterRowsByQueryTerms('event', agg, EVENT_ROWS);
    const keptPrefs = filterRowsByQueryTerms('preference', agg, PREF_ROWS);
    expect(keptEvents.map((r) => r.id)).toEqual([EVENT_ROWS[0].id]); // "long" overlap
    expect(keptPrefs.map((r) => r.id)).toEqual([PREF_ROWS[0].id]); // "routine" overlap
    const nonAgg = 'morning runs';
    expect(filterRowsByQueryTerms('event', nonAgg, EVENT_ROWS)).toHaveLength(0);
    expect(filterRowsByQueryTerms('preference', nonAgg, PREF_ROWS).map((r) => r.id)).toEqual([PREF_ROWS[0].id]);
  });

  it('query with no overlap terms yields no rows (never falls back to full table)', () => {
    expect(filterRowsByQueryTerms('fact', 'quantum entanglement policy', FACT_ROWS)).toHaveLength(0);
  });

  it('empty query or single-char-only query keeps the full table (cannot scope on nothing)', () => {
    expect(filterRowsByQueryTerms('fact', '', FACT_ROWS)).toHaveLength(FACT_ROWS.length);
    // queryTerms drops tokens shorter than 2 chars, so "a b c" yields no terms.
    expect(filterRowsByQueryTerms('fact', 'a b c', FACT_ROWS)).toHaveLength(FACT_ROWS.length);
  });

  it('overlap is on ROW TEXT via rowSearchText fields (value/unit/verb/object/event/when/entities/statement/kind)', () => {
    // "am" only appears in the wake-time row's unit field.
    expect(filterRowsByQueryTerms('fact', 'am I waking early', FACT_ROWS).map((r) => r.id)).toEqual([FACT_ROWS[1].id]);
    // "routine" only appears in the preference's kind field.
    expect(filterRowsByQueryTerms('preference', 'routine habits', PREF_ROWS).map((r) => r.id)).toEqual([PREF_ROWS[0].id]);
  });
});

describe('C5 query-scoped rows: composition integration', () => {
  it('flag on → composed context contains only term-overlapping structured rows', () => {
    const input = { query: 'marathon distance', hits: [hit('notes/a.md', 'Ran a marathon.')] };
    const rows = [...FACT_ROWS, ...EVENT_ROWS, ...PREF_ROWS];
    const ctx = compose(input, rows, ENV_ON);
    const facts = ctx.sections.find((s) => s.name === 'facts')!;
    expect(facts.included).toBe(true);
    expect(facts.rowCount).toBe(3); // rows 1, 3, 4 overlap {marathon, distance}
    expect(facts.text).toContain('marathon');
    expect(facts.text).not.toContain('wake time');
    expect(facts.text).not.toContain('hydration');
    expect(ctx.sections.find((s) => s.name === 'chronicle')!.rowCount).toBe(0);
    expect(ctx.sections.find((s) => s.name === 'prefs')!.rowCount).toBe(0);
    expect(ctx.usedTokens).toBeLessThan(compose(input, rows, ENV_OFF).usedTokens);
  });

  it('flag on + aggregate query → full facts section in composed context', () => {
    const input = { query: 'how much in total did I run', hits: [hit('notes/a.md', 'Ran a marathon.')] };
    const rows = [...FACT_ROWS, ...EVENT_ROWS, ...PREF_ROWS];
    const ctx = compose(input, rows, ENV_ON);
    const facts = ctx.sections.find((s) => s.name === 'facts')!;
    expect(facts.rowCount).toBe(FACT_ROWS.length);
  });

  it('determinism: unchanged corpus + same query → byte-identical contexts (flag on and off)', () => {
    const input = { query: 'marathon distance training', hits: [hit('notes/a.md', 'Ran a marathon.')] };
    const rows = [...FACT_ROWS, ...EVENT_ROWS, ...PREF_ROWS];
    const on1 = compose(input, rows, ENV_ON);
    const on2 = compose(input, rows, ENV_ON);
    const off1 = compose(input, rows, ENV_OFF);
    const off2 = compose(input, rows, ENV_OFF);
    expect(on1.text).toBe(on2.text);
    expect(off1.text).toBe(off2.text);
    expect(JSON.stringify(on1.sections)).toBe(JSON.stringify(on2.sections));
  });
});

describe('C5 query-scoped rows: adversarial — no gold/category path', () => {

  it('query text containing benchmark-ish words is still treated as plain text (gold-blind)', () => {
    // Even if a query literally mentions category-like words, the filter only
    // does term overlap on row text — it cannot branch on any category.
    const kept = filterRowsByQueryTerms('fact', 'question_type: marathon distance shouldAbstain: no', FACT_ROWS);
    expect(kept.map((r) => r.id)).toEqual([FACT_ROWS[0].id, FACT_ROWS[2].id, FACT_ROWS[3].id]);
    const aggWithGoldWords = 'question_type: aggregate; gold: all; how much in total';
    expect(filterRowsByQueryTerms('fact', aggWithGoldWords, FACT_ROWS)).toHaveLength(FACT_ROWS.length);
  });

  it('aggregate intent detection is a pure regex on query text (EVIDENCE_INTENT), not on any gold field', () => {
    expect(filterRowsByQueryTerms('fact', 'how much in total', [])).toEqual([]);
    expect(filterRowsByQueryTerms('fact', 'total mileage', FACT_ROWS)).toHaveLength(FACT_ROWS.length);
    expect(filterRowsByQueryTerms('fact', 'my mileage', FACT_ROWS)).toHaveLength(0);
  });
});

