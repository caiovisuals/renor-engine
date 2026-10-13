import { describe, it, expect } from 'vitest';

/**
 * The P1 strip-excerpt-meta lever had NO test.
 *
 * `stripExcerptMeta` appeared in exactly three places before this file: the two
 * runners that read the flag, and the flag registry that names it. Nothing asserted
 * what it DOES. Default-OFF protected the baseline assembly, but the armed path —
 * whose entire purpose is to remove meta lines *without* removing turn content or the
 * `Session date:` footer (the excerpt END-time, load-bearing per the tick-9 diversity
 * kill) — was asserted nowhere. A regression there would be silent, and it would also
 * be invisible to the independent reviewer: the pre-filter withholds
 * `engine/scripts/eval/**`, so no reviewer ever sees this code.
 *
 * These tests read the real exported functions out of the real runner — the same
 * module `engine/tests/context/product-read-context-contract.test.ts` imports — and
 * they are deliberately about the SHAPE of what survives, not about a token count.
 */

const META = [
  '# Session sess_0042',
  'Timestamp: 2026-01-15T09:30:00.000Z',
  '### Turn 1 (user)',
  'The machine runs on mains power at 300 W.',
  '### Turn 2 (assistant)',
  'Noted: it draws about 300 W.',
  'Session date: 2026-01-15',
].join('\n');

const hit = (text: string, session_date?: string) => ({ notePath: 'Sessions/a-1.md', text, score: 1, session_date });

describe('RENOR_STRIP_EXCERPT_META — the armed path removes meta and nothing else', () => {
  it('is a byte-exact no-op when the flag is false', async () => {
    const { stripExcerptMetaLines } = await import('../../scripts/eval/run-longmemeval-product.js');
    // The baseline claim the lever rests on: unarmed assembly cannot move.
    expect(stripExcerptMetaLines(META, false)).toBe(META);
  });

  it('removes the two meta line kinds and preserves every other line byte-exact', async () => {
    const { stripExcerptMetaLines } = await import('../../scripts/eval/run-longmemeval-product.js');
    const stripped = stripExcerptMetaLines(META, true);
    expect(stripped).not.toContain('# Session sess_0042');
    expect(stripped).not.toContain('Timestamp:');
    // Everything that is not meta survives, in order, unchanged.
    const survivors = META.split('\n').filter((line) => !/^# Session /.test(line) && !/^Timestamp: /.test(line));
    expect(stripped.split('\n')).toEqual(survivors);
    expect(stripped).toContain('The machine runs on mains power at 300 W.');
    expect(stripped).toContain('Noted: it draws about 300 W.');
  });

  it('keeps the Session date footer, which is the excerpt end-time the screens depend on', async () => {
    const { stripExcerptMetaLines } = await import('../../scripts/eval/run-longmemeval-product.js');
    expect(stripExcerptMetaLines(META, true)).toContain('Session date: 2026-01-15');
  });

  it('does not touch a content line that merely mentions a meta word mid-line', async () => {
    const { stripExcerptMetaLines } = await import('../../scripts/eval/run-longmemeval-product.js');
    const content = '### Turn 1 (user)\nThe Timestamp: field was never filled in.\nSession date: 2026-02-02';
    expect(stripExcerptMetaLines(content, true)).toBe(content);
  });

  it('assembly is byte-identical whether the option is absent or false (baseline cannot move)', async () => {
    const { assembleClientContext } = await import('../../scripts/eval/run-longmemeval-product.js');
    const hits = [hit(META, '2026-01-15T00:00:00.000Z')];
    const absent = assembleClientContext(hits as never, 6000, { contextDates: true });
    const off = assembleClientContext(hits as never, 6000, { contextDates: true, stripExcerptMeta: false });
    expect(off.context).toBe(absent.context);
    expect(off.tokens).toBe(absent.tokens);
  });

  it('armed assembly drops the [Excerpt N] marker but keeps the date line, the content and the footer', async () => {
    const { assembleClientContext } = await import('../../scripts/eval/run-longmemeval-product.js');
    const hits = [hit(META, '2026-01-15T00:00:00.000Z')];
    const armed = assembleClientContext(hits as never, 6000, { contextDates: true, stripExcerptMeta: true });
    expect(armed.context).not.toContain('[Excerpt 1]');
    expect(armed.context).not.toContain('# Session');
    expect(armed.context).not.toContain('Timestamp:');
    // The date the client is told to trust is still there — both the rendered
    // session_date line and the excerpt's own footer.
    expect(armed.context).toContain('Session date: 2026-01-15');
    expect(armed.context).toContain('The machine runs on mains power at 300 W.');
    expect(armed.hitsUsed).toBe(1);
  });

  it('unarmed assembly still carries the [Excerpt N] marker the armed path drops', async () => {
    const { assembleClientContext } = await import('../../scripts/eval/run-longmemeval-product.js');
    const hits = [hit(META, '2026-01-15T00:00:00.000Z')];
    const off = assembleClientContext(hits as never, 6000, { contextDates: true });
    expect(off.context).toContain('[Excerpt 1]');
    expect(off.context).toContain('# Session sess_0042');
  });

  it('the armed path can only shrink the context, never grow it (token monotonicity)', async () => {
    const { assembleClientContext } = await import('../../scripts/eval/run-longmemeval-product.js');
    const hits = [hit(META, '2026-01-15T00:00:00.000Z'), hit(`# Session sess_0043\nTimestamp: 2026-01-16T08:00:00.000Z\n### Turn 1 (user)\nThe kettle is stainless steel.\nSession date: 2026-01-16`, '2026-01-16T00:00:00.000Z')];
    const off = assembleClientContext(hits as never, 6000, { contextDates: true });
    const armed = assembleClientContext(hits as never, 6000, { contextDates: true, stripExcerptMeta: true });
    // A regression that ADDS text under the strip flag would break the lever's premise.
    expect(armed.tokens).toBeLessThanOrEqual(off.tokens);
    expect(armed.hitsUsed).toBe(off.hitsUsed);
  });
});
