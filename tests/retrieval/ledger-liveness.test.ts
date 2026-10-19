import { describe, expect, it, vi } from 'vitest';
import { ledgerEventIds, resolveLedgerHits, SUPERSEDED_LABEL } from '../../src/retrieval/ledgerLiveness';

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

/**
 * `resolveLedgerHits` as it was before it let a hit that names no event through unread: every hit is split at the event
 * headers and each block is matched, whatever the hit holds.
 */
function referenceResolve<T extends { text: string; headingPath?: string; reason: string }>(
  hits: T[], closed: ReadonlySet<string> & { readonly hidden?: ReadonlySet<string> }, includeHistory: boolean,
): T[] {
  if (!closed.size) return hits;
  const hidden = closed.hidden;
  return hits.flatMap(hit => {
    let superseded = false;
    let dropped = false;
    const blocks = hit.text.replace(/\r\n/g, '\n').split(/(?=^## MEM_[A-Za-z0-9]+ · )/im);
    const kept = blocks.flatMap(block => {
      const id = block.match(/^## (MEM_[A-Za-z0-9]+) · /im)?.[1]
        ?? (blocks.length === 1 ? hit.headingPath?.match(/\b(MEM_[A-Za-z0-9]+)\b/i)?.[1] : undefined);
      const isClosed = !!id && closed.has(id.toLowerCase());
      if (!isClosed) return [block];
      if (hidden?.has(id!.toLowerCase())) {
        dropped = true;
        return [];
      }
      superseded = true;
      return includeHistory ? [`${SUPERSEDED_LABEL}\n${block}`] : [];
    });
    if (!superseded && !dropped) return [hit];
    const text = kept.join('').trim();
    const history = includeHistory && superseded;
    if (!text || (!history && !kept.some(b => /^## MEM_/im.test(b)))) return [];
    return [{ ...hit, text,
      ...(!history ? { headingPath: text.match(/^## (MEM_[A-Za-z0-9]+ · .+)$/im)?.[1] ?? hit.headingPath } : {}),
      reason: history ? `${hit.reason}+superseded` : hit.reason }];
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('a hit that names no event is not read for one', () => {
  const IDS = ['MEM_A1', 'mem_b2', 'Mem_C3', 'MEM_D4', 'mEm_e5'];
  const PROSE = [
    'An ordinary note about the plans.', 'Remember_this is not an event.', 'mem_leak was found in the gateway.', 'A line that says MEM_A1 in prose.',
    '', '   ', '# Heading\nBody text.', 'Rowan moved to Port Alder.', 'summary: the memory budget', 'MEM without the underscore',
  ];
  const HEADINGS = [undefined, '', 'Notes', 'Notes > Plans', 'Memory Events Ledger > MEM_C3 · 2026-10-02T00:00:00.000Z', 'item_mem_9', 'Ledger > mem_b2', 'Memory notes'];

  function corpus(seed: number) {
    const rnd = mulberry32(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const hit = () => {
      const parts = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => (rnd() < 0.45 ? block(pick(IDS), pick(['x', 'y', 'Postgres', 'MySQL'])) : pick(PROSE) + '\n'));
      let text = parts.join(rnd() < 0.5 ? '' : '\n');
      if (rnd() < 0.3) text = text.replace(/\n/g, '\r\n');
      const headingPath = pick(HEADINGS);
      return { text, reason: pick(['semantic', 'fts']), ...(headingPath === undefined ? {} : { headingPath }) };
    };
    const closed = () => {
      const ids = IDS.filter(() => rnd() < 0.5).map(id => id.toLowerCase());
      const hiddenIds = ids.filter(() => rnd() < 0.4);
      return Object.assign(new Set(ids), { hidden: new Set(hiddenIds) });
    };
    return { hit, closed, rnd };
  }

  it('resolves every kind of hit exactly as before, for any set of closed events, with and without history', () => {
    const { hit, closed, rnd } = corpus(20261018);
    for (let i = 0; i < 600; i++) {
      const hits = Array.from({ length: 1 + Math.floor(rnd() * 6) }, hit);
      const set = closed();
      for (const history of [false, true]) {
        expect(resolveLedgerHits(hits, set, history), JSON.stringify({ hits, closed: [...set], history })).toEqual(referenceResolve(hits, set, history));
      }
    }
  });

  it('returns a hit with no MEM_ in its text or heading as the very same object, in any case', () => {
    const hits = [
      { text: 'An ordinary note about the plans.', reason: 'semantic' },
      { text: 'Rowan moved to Port Alder.', reason: 'fts', headingPath: 'Notes > Plans' },
      { text: '', reason: 'fts', headingPath: '' },
    ];
    const out = resolveLedgerHits(hits, new Set(['mem_a']), false);
    expect(out).toHaveLength(3);
    out.forEach((h, i) => expect(h).toBe(hits[i]));
  });

  it('still reads an event named in lower or mixed case, in the text or only in the heading', () => {
    const closed = Object.assign(new Set(['mem_b2', 'mem_c3']), { hidden: new Set<string>() });
    const lower = { text: block('mem_b2', 'old'), reason: 'fts' };
    const mixed = { text: block('Mem_C3', 'old'), reason: 'fts' };
    const headingOnly = { text: '- object: continued', reason: 'fts', headingPath: 'Ledger > mem_b2' };
    const live = { text: block('MEM_D4', 'new'), reason: 'fts' };
    expect(resolveLedgerHits([lower, mixed, headingOnly, live], closed, false)).toEqual([live]);
  });

  it('does not split a hit that names no event', () => {
    const hits = Array.from({ length: 200 }, (_, i) => ({ text: `An ordinary note ${i} about the plans.\nSecond line.`, reason: 'fts', headingPath: `Notes > ${i}` }));
    const split = vi.spyOn(String.prototype, 'split');
    try {
      resolveLedgerHits(hits, new Set(['mem_a']), false);
      // Splitting each of the 200 at the event headers is what the check is there to save.
      expect(split.mock.calls.filter(([separator]) => separator instanceof RegExp)).toHaveLength(0);
    } finally {
      split.mockRestore();
    }
  });
});
