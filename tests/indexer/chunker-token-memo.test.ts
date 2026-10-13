import { describe, it, expect, vi } from 'vitest';

const counted = vi.hoisted(() => ({ calls: 0 }));
// The seam is src/indexer/tokenizer, not gpt-tokenizer itself. The tokenizer is now loaded on
// first use through that module (a plain require, so a wake does not compile the ~344 ms o200k
// table before the engine is listening), which means mocking the npm package directly no longer
// observes the chunker's calls. Mocking the module the chunker actually calls keeps this test
// measuring the same thing — how many times counting happens — against the real tokenizer.
vi.mock('../../src/indexer/tokenizer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/indexer/tokenizer')>();
  return {
    ...actual,
    encodeTokens: (...args: Parameters<typeof actual.encodeTokens>) => {
      counted.calls++;
      return actual.encodeTokens(...args);
    },
  };
});

import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';

/**
 * A note that is appended to is chunked whole again each time, and all of it but the tail is text
 * the tokenizer has already counted. Counting was most of that pass for a ledger (one chunk per
 * event), so counts are remembered by text; the chunks themselves must not change.
 */

const ledger = (events: number) => parseNote(
  '/vault/Ledger.md',
  '# Ledger\n\nAppend-only.\n\n' + Array.from({ length: events }, (_, k) => `## Event ${k}\n- kind: store\n- object: value ${k}`).join('\n\n') + '\n',
);

describe('chunkNote token counts', () => {
  it('counts a text once however many times a note holding it is chunked, and counts only what is new', () => {
    const cold = chunkNote(ledger(30));
    expect(counted.calls).toBe(31); // the heading section and 30 events, each counted once
    const afterCold = counted.calls;

    expect(chunkNote(ledger(30))).toEqual(cold);
    expect(counted.calls).toBe(afterCold); // nothing counted again

    const grown = chunkNote(ledger(31));
    expect(counted.calls).toBe(afterCold + 1); // the one new event
    expect(grown).toHaveLength(32);
    expect(grown.slice(0, 30)).toEqual(cold.slice(0, 30));
    // The old last event only has a later end line now that something follows it.
    expect({ ...grown[30], endLine: 0 }).toEqual({ ...cold[30], endLine: 0 });
  });

  it('gives the counts a cold chunking gives', () => {
    const warm = chunkNote(ledger(5)).map((c) => c.tokenCount);
    const text = chunkNote(ledger(5)).map((c) => c.text);
    expect(warm).toEqual(text.map((t) => chunkNote(parseNote('/vault/One.md', t))[0].tokenCount));
  });

  it('counts a text longer than the cache keeps every time rather than keeping it', () => {
    const long = parseNote('/vault/Long.md', `# Long\n\n${'word '.repeat(30_000)}\n`); // > 100,000 characters
    chunkNote(long);
    const afterFirst = counted.calls;
    chunkNote(long);
    expect(counted.calls).toBeGreaterThan(afterFirst);
  });

  it('counts a daily note\'s long entries once, however many saves chunk the note again', () => {
    // An entry is one chunk, up to a statement's 4,000 characters: longer than the texts kept by their text, so a save
    // used to count every entry of the day again (the cost of a save grew with the note, 330 ms at 3.4 MB).
    const day = (entries: number) => parseNote(
      '/vault/Memory/Daily/2026-10-12.md',
      '---\nkind: daily\n---\n\n# 2026-10-12\n' + Array.from({ length: entries }, (_, k) =>
        `\n- [10:${String(k % 60).padStart(2, '0')}:00] (mcp:remember) entry ${k} ${'a decision about the gateway '.repeat(140)}`).join('\n') + '\n',
    );
    const cold = chunkNote(day(20));
    const afterCold = counted.calls;
    expect(afterCold).toBeGreaterThan(0);
    expect(chunkNote(day(20))).toEqual(cold);
    expect(counted.calls).toBe(afterCold); // nothing counted again
    const grown = chunkNote(day(21));
    expect(grown.slice(0, cold.length - 1)).toEqual(cold.slice(0, -1)); // the last entry only gains the line break that now follows it
    expect(grown.length).toBeGreaterThan(cold.length);
    // Only the new entry: its whole text, and each paragraph piece when it is cut.
    expect(counted.calls - afterCold).toBeLessThanOrEqual(3);
  });

  it('keeps counts apart by text: two long texts that differ in one character are each counted', () => {
    const a = parseNote('/vault/A.md', `# A\n\n${'x'.repeat(2_500)}a\n`);
    const b = parseNote('/vault/B.md', `# B\n\n${'x'.repeat(2_500)}b\n`);
    const before = counted.calls;
    chunkNote(a);
    chunkNote(b);
    // Each note has three texts nobody counted before: its whole section, its heading paragraph and its long paragraph.
    // The section was one chunk until the tokenizer began estimating a long run of one character at 4 characters a
    // token (626 tokens for the 2,500 x's, over the 400-token limit), so it is now cut in two. Each text is still counted
    // once, and chunking either note again counts nothing.
    expect(counted.calls - before).toBe(6);
    chunkNote(a);
    chunkNote(b);
    expect(counted.calls - before).toBe(6);
    expect(chunkNote(a)[0].tokenCount).toBe(chunkNote(b)[0].tokenCount);
    expect(chunkNote(a)[1].tokenCount).toBe(chunkNote(b)[1].tokenCount);
  });
});
