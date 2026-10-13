import { describe, it, expect } from 'vitest';
import { chunkNote } from '../../src/indexer/chunker';
import { ParsedNote } from '../../src/indexer/parser';

const note = (body: string): ParsedNote => ({
  path: '/v/t.md',
  title: 'T',
  frontmatter: {},
  body,
  wikilinks: [],
});

describe('chunkNote', () => {
  it('returns at least one chunk', () => {
    expect(chunkNote(note('text')).length).toBeGreaterThanOrEqual(1);
  });

  it('splits by headings and tracks heading path', () => {
    const chunks = chunkNote(note('# S1\n\nA.\n\n## S1.1\n\nB.\n\n# S2\n\nC.'));
    expect(chunks.length).toBe(3);
    expect(chunks[0].headingPath).toBe('S1');
    expect(chunks[1].headingPath).toBe('S1 > S1.1');
    expect(chunks[2].headingPath).toBe('S2');
  });

  it('respects max token limit', () => {
    const long = ('word '.repeat(100) + '\n\n').repeat(6);
    const chunks = chunkNote(note(long), { maxTokens: 400 });
    expect(chunks.every(c => c.tokenCount <= 450)).toBe(true);
  });

  it('sets startLine and endLine', () => {
    const chunks = chunkNote(note('# A\n\nText A.\n\n# B\n\nText B.'));
    chunks.forEach(c => {
      expect(c.startLine).toBeGreaterThanOrEqual(0);
      expect(c.endLine).toBeGreaterThan(c.startLine);
    });
  });

  it('creates overlapping chunks when overlapTokens is set', () => {
    const long = ('word '.repeat(100) + '\n\n').repeat(6);
    const chunks = chunkNote(note(long), { maxTokens: 400, overlapTokens: 50 });
    // Adjacent chunks should share some text
    if (chunks.length >= 2) {
      const end1 = chunks[0].text;
      const start2 = chunks[1].text;
      // The overlap means the end of chunk 1 text should appear at start of chunk 2
      const lastPara1 = end1.split('\n\n').pop()!;
      expect(start2).toContain(lastPara1);
    }
  });
});
