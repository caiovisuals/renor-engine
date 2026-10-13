import { describe, it, expect } from 'vitest';
import { shownPage } from '../../src/retrieval/queryHelpers';

/**
 * shownPage: the page of a ranked read is cut after its rows have been judged, never before.
 *
 * The keyword readers cut their read at a fixed number of rows and judged afterwards, so the rows they turn away (the
 * ledger's own markup) took the places of the rows they keep. Here the source is a plain array and the judgement a
 * plain predicate, so what is pinned is the rule itself: the page is exactly the first `limit` rows that are shown,
 * however many rows that are turned away rank above them.
 */

/** A ranked source of `total` rows, and a record of how many rows each read was asked for. */
function source(total: number) {
  const asked: number[] = [];
  const read = (rows: number) => { asked.push(rows); return Array.from({ length: Math.min(rows, total) }, (_, i) => i); };
  return { read, asked };
}

describe('shownPage', () => {
  it('a read that turns nothing away is the one read of `limit` rows it always was', () => {
    const { read, asked } = source(1000);
    expect(shownPage(read, rows => rows, 20)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(asked).toEqual([20]);
  });

  it('rows that are turned away take no place: the page is the first rows that are shown, however deep they are', () => {
    const { read, asked } = source(1000);
    // The best 900 rows are turned away, as the records of a long ledger are for a word of their markup.
    const page = shownPage(read, rows => rows.filter(i => i >= 900), 20);
    expect(page).toEqual(Array.from({ length: 20 }, (_, i) => 900 + i));
    expect(asked[0]).toBe(20);
    expect(asked[asked.length - 1]).toBeGreaterThanOrEqual(920);
  });

  it('a page that the rows cannot fill is every row that is shown, and the read ends', () => {
    const { read, asked } = source(1000);
    expect(shownPage(read, rows => rows.filter(i => i >= 990), 20)).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]);
    const last = asked[asked.length - 1];
    expect(last).toBeGreaterThan(1000); // the read that found no more rows asked for more than there are
  });

  it('when every row is turned away the page is empty, and the read still ends', () => {
    for (const total of [0, 1, 19, 20, 21, 80, 81, 1000, 100_000]) {
      const { read, asked } = source(total);
      expect(shownPage(read, () => [], 20), String(total)).toEqual([]);
      expect(asked.length, String(total)).toBeLessThanOrEqual(Math.ceil(Math.log(Math.max(total, 20) / 20) / Math.log(4)) + 2);
    }
  });

  it('a source with exactly `limit` rows is not mistaken for one with more', () => {
    const { read, asked } = source(20);
    expect(shownPage(read, rows => rows.filter(i => i !== 7), 20)).toHaveLength(19);
    // The first read was full, so another was made; it came back short, and that is how the read knows no rows are left.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(20);
    expect(asked[1]).toBeGreaterThan(20);
  });

  it('the first read asks for exactly `limit` rows, so a search that turns nothing away is read as it always was', () => {
    for (const limit of [1, 3, 20, 50, 200]) {
      const { read, asked } = source(10_000);
      shownPage(read, rows => rows, limit);
      expect(asked, String(limit)).toEqual([limit]);
    }
  });

  it('a reader with a wider window reads that window first, and a page it fills is the one it always was', () => {
    const { read, asked } = source(1000);
    // search_text has always read the best topK * 10 rows (at most 200) and judged them: the same rows, the same page.
    expect(shownPage(read, rows => rows.filter(i => i % 3 === 0), 20, 200)).toEqual(Array.from({ length: 20 }, (_, i) => 3 * i));
    expect(asked).toEqual([200]);
  });

  it('a wider first window that is all turned away still reads on until the page is full', () => {
    const { read, asked } = source(10_000);
    const page = shownPage(read, rows => rows.filter(i => i >= 5000), 6, 60);
    expect(page).toEqual([5000, 5001, 5002, 5003, 5004, 5005]);
    expect(asked[0]).toBe(60);
    expect(asked.every((rows, i) => i === 0 || rows === asked[i - 1] * 4)).toBe(true);
  });

  it('a first window narrower than the page, or no number at all, reads the page', () => {
    for (const first of [0, 1, 19, -5, Number.NaN]) {
      const { read, asked } = source(1000);
      expect(shownPage(read, rows => rows, 20, first), String(first)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(asked, String(first)).toEqual([20]);
    }
  });

  it('returns what `show` returns, not the rows: a row may be shown as something else', () => {
    const { read } = source(100);
    const page = shownPage(read, rows => rows.filter(i => i % 10 === 9).map(i => `row ${i}`), 3);
    expect(page).toEqual(['row 9', 'row 19', 'row 29']);
  });

  it('a limit that is not a positive number reads nothing and shows nothing', () => {
    for (const limit of [0, -1, Number.NaN]) {
      const { read, asked } = source(10);
      expect(shownPage(read, rows => rows, limit), String(limit)).toEqual([]);
      expect(asked, String(limit)).toEqual([]);
    }
  });

  it('judges the rows from the best and stops at the one that fills the page: nothing below it is looked at', () => {
    const { read } = source(1000);
    const judged: number[] = [];
    const page = shownPage(read, rows => { judged.push(...rows); return rows.filter(i => i % 2 === 0); }, 6, 60);
    expect(page).toEqual([0, 2, 4, 6, 8, 10]);
    // Six shown rows need eleven judged: a batch of 8, then one more. The other 44 rows of the window are never judged.
    expect(Math.max(...judged)).toBeLessThan(16);
    expect(judged).toEqual([...judged].sort((a, b) => a - b));
    expect(new Set(judged).size).toBe(judged.length);
  });

  it('a page that turns everything away judges every row of the read, as it always did', () => {
    const { read } = source(30);
    const judged: number[] = [];
    expect(shownPage(read, rows => { judged.push(...rows); return []; }, 5, 10)).toEqual([]);
    expect(new Set(judged)).toEqual(new Set(Array.from({ length: 30 }, (_, i) => i)));
  });

  it('is exactly "the first `limit` rows that are shown" for any source, any judgement and any limit', () => {
    // A small deterministic generator, so a failure names the case that broke.
    let seed = 20261003;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let n = 0; n < 400; n++) {
      const total = Math.floor(next() * 400);
      const limit = 1 + Math.floor(next() * 60);
      const first = next() < 0.5 ? limit : Math.floor(next() * 300);
      const shownShare = [0, 0.02, 0.1, 0.5, 0.9, 1][Math.floor(next() * 6)];
      const shown = Array.from({ length: total }, () => next() < shownShare);
      const { read } = source(total);
      const page = shownPage(read, rows => rows.filter(i => shown[i]), limit, first);
      const expected = shown.flatMap((s, i) => (s ? [i] : [])).slice(0, limit);
      expect(page, `total=${total} limit=${limit} first=${first} share=${shownShare}`).toEqual(expected);
    }
  });
});
