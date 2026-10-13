import { describe, expect, it } from 'vitest';
import { ledgerEventIds, resolveLedgerHits } from '../../src/retrieval/ledgerLiveness';

const block = (id: string, object: string) => `## ${id} · 2026-10-02T00:00:00.000Z\n- kind: store\n- subject: database\n- predicate: engine\n- object: ${object}\n`;

describe('ledger event identity liveness', () => {
  it('removes closed A in A -> B -> A without removing the live A', () => {
    const hits = ['MEM_A', 'MEM_B', 'MEM_C'].map((id, i) => ({
      text: block(id, i === 1 ? 'Postgres' : 'MySQL'), reason: 'semantic', headingPath: id,
    }));
    expect(resolveLedgerHits(hits, new Set(['mem_a', 'mem_b']), false)).toEqual([hits[2]]);
    expect(resolveLedgerHits(hits.slice(0, 2), new Set(['mem_a', 'mem_b']), false)).toEqual([]);
  });

  it('filters individual blocks before truncation, including CRLF ledgers', () => {
    const hits = [{ text: `# Ledger\n${block('MEM_A', 'wrong')}${block('MEM_B', 'correct')}`.replace(/\n/g, '\r\n'), reason: 'fts' }];
    const current = resolveLedgerHits(hits, new Set(['mem_a']), false);
    expect(current[0].text).not.toContain('wrong');
    expect(current[0].text).toContain('correct');
    const history = resolveLedgerHits(hits, new Set(['mem_a']), true);
    expect(history[0].text).toContain('[Superseded memory event; historical evidence only]\n## MEM_A');
    expect(history[0].text).toContain(block('MEM_B', 'correct').trim());
  });

  it('keeps ordinary notes and unrelated event blocks byte-identical', () => {
    const hits = [{ text: 'An ordinary note mentions MEM_A in prose.', reason: 'semantic' },
      { text: block('MEM_B', 'current'), reason: 'semantic' }];
    expect(resolveLedgerHits(hits, new Set(['mem_a']), false)).toEqual(hits);
  });
});

describe('ledgerEventIds', () => {
  it('lists the ids of the event blocks a hit carries, lowercased, whatever the line endings', () => {
    const text = `# Ledger\n${block('MEM_A', 'x')}${block('mem_b', 'y')}`.replace(/\n/g, '\r\n');
    expect(ledgerEventIds({ text })).toEqual(['mem_a', 'mem_b']);
  });

  it('falls back to the heading of a chunk with no event header, and finds nothing in ordinary notes', () => {
    expect(ledgerEventIds({ text: '- object: continued', headingPath: 'Memory Events Ledger > MEM_C · 2026-10-02T00:00:00.000Z' })).toEqual(['mem_c']);
    expect(ledgerEventIds({ text: 'An ordinary note mentions MEM_A in prose.', headingPath: 'Notes' })).toEqual([]);
  });
});
