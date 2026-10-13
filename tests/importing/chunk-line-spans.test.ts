import { describe, expect, it } from 'vitest';
import { renderNoteMarkdown } from '../../src/importing/serialize';
import type { ImportNote } from '../../src/importing/types';

type Span = { startLine: number; endLine: number };

function note(originalContent: string, texts: string[]): ImportNote {
  return {
    sourcePath: '/source/N.md', relPath: 'N.md', title: 'N', kind: null,
    modifiedAt: '2026-01-01T00:00:00.000Z', frontmatter: {}, entities: [],
    originalContent,
    chunks: texts.map(text => ({ headingPath: '', text, tokenCount: 1 })),
  };
}

/**
 * The algorithm `renderNoteMarkdown` used before the line counter was carried forward with the
 * cursor: locate each chunk's text, then count the newlines before it by rescanning the file from
 * offset 0. Kept verbatim as the oracle for "line numbers are unchanged".
 */
function referenceSpans(content: string, texts: string[]) {
  const lines: Span[] = [];
  const found: boolean[] = [];
  let cursor = 0;
  let viaFallback = 0;
  for (const text of texts) {
    const needle = text.replace(/[ \t]+$/gm, '').trim();
    if (!needle) {
      lines.push({ startLine: 0, endLine: 0 });
      found.push(false);
      continue;
    }
    let at = content.indexOf(needle, cursor);
    if (at < 0) {
      at = content.indexOf(needle);
      if (at >= 0) viaFallback += 1;
    }
    if (at < 0) {
      lines.push({ startLine: 0, endLine: 0 });
      found.push(false);
      continue;
    }
    let startLine = 0;
    for (let i = 0; i < at; i += 1) {
      if (content.charCodeAt(i) === 10) startLine += 1;
    }
    lines.push({ startLine, endLine: startLine + needle.split('\n').length });
    found.push(true);
    cursor = at + needle.length;
  }
  return { lines, found, viaFallback };
}

function expectSameAsReference(original: string, texts: string[]) {
  const rendered = renderNoteMarkdown(note(original, texts));
  const reference = referenceSpans(original, texts);
  expect(rendered.content).toBe(original);
  expect(rendered.chunkLines).toEqual(reference.lines);
  expect(rendered.chunksNotLocated).toBe(reference.found.filter(ok => !ok).length);
  return reference;
}

// Deterministic PRNG so a failure reproduces from its case number.
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('chunk line spans are unchanged by carrying the line counter forward', () => {
  it('matches the rescan-from-zero algorithm on hand-built notes that exercise every branch', () => {
    // In order, across blank-line runs, multi-line chunks, a chunk at offset 0 and one at the very end.
    expectSameAsReference('# T\n\nfirst\n\n\n\nsecond line\nsecond line 2\n\nlast', ['# T', 'first', 'second line\nsecond line 2', 'last']);
    // Out of document order: the text is only found by the search from offset 0.
    const backward = expectSameAsReference('alpha\n\nbeta\n\ngamma\n\ndelta\n', ['delta', 'alpha', 'gamma', 'beta']);
    expect(backward.viaFallback).toBeGreaterThan(0);
    // The same text twice: the second occurrence is taken, then the first is found again by the fallback.
    const repeated = expectSameAsReference('same\n\nother\n\nsame\n', ['same', 'same', 'same']);
    expect(repeated.viaFallback).toBeGreaterThan(0);
    // Not in the file at all, whitespace only, and empty: reported unknown, and later chunks are unaffected.
    expectSameAsReference('one\n\ntwo\n\nthree\n', ['one', 'not in the file', '   \n\t', '', 'three']);
    // CRLF bytes, trailing blanks on chunk lines, and indentation that only trim() removes.
    expectSameAsReference('a\r\n\r\nb  \r\n\r\nc\r\n', ['a', 'b  ', '  c  ']);
    expectSameAsReference('x\n\ntabbed\t\n\ny\n', ['x', 'tabbed\t\t', 'y']);
    // UTF-16 surrogate pairs before the chunk: offsets are code units, and the newline count must agree.
    expectSameAsReference('😀😀\n\n😀 mid\n\nend 😀\n', ['😀 mid', 'end 😀', '😀😀']);
    // No chunks, and no newline at all.
    expectSameAsReference('', []);
    expectSameAsReference('single line, no newline', ['single line, no newline']);
  });

  it('matches the rescan-from-zero algorithm on 600 random notes, including every fallback branch', () => {
    const vocabulary = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '# Heading', '## Sub heading', '- item', '😀', 'ünï', 'x', 'same line'];
    const separators = ['\n', '\n', '\n\n', '\n\n\n\n', ' ', '  \n', '\t\n', '\r\n'];
    let located = 0;
    let unlocated = 0;
    let viaFallback = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const random = mulberry32(seed);
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
      let content = '';
      const pieces = 1 + Math.floor(random() * 40);
      for (let i = 0; i < pieces; i += 1) content += pick(vocabulary) + pick(separators);

      const texts: string[] = [];
      const count = Math.floor(random() * 14);
      for (let i = 0; i < count; i += 1) {
        const start = Math.floor(random() * content.length);
        let text = content.slice(start, start + 1 + Math.floor(random() * 90));
        const roll = random();
        if (roll < 0.12) text += ' ZZZ-not-in-the-note';
        else if (roll < 0.2) text = '';
        else if (roll < 0.35) text = text.replace(/\n/g, '  \n');
        texts.push(text);
      }
      // Mostly in document order (the real shape), sometimes shuffled.
      if (random() < 0.7) texts.sort((a, b) => content.indexOf(a.trim()) - content.indexOf(b.trim()));
      else texts.sort(() => random() - 0.5);

      const reference = expectSameAsReference(content, texts);
      located += reference.found.filter(Boolean).length;
      unlocated += reference.found.filter(ok => !ok).length;
      viaFallback += reference.viaFallback;
    }
    // The comparison is only worth something if it reached all three branches.
    expect(located).toBeGreaterThan(1000);
    expect(unlocated).toBeGreaterThan(300);
    expect(viaFallback).toBeGreaterThan(100);
  });
});

// The same bound as the lifecycle replay test, on CPU time, because wall time also counts every
// moment the OS spends on someone else's process on a shared host. Rescanning from offset 0 for
// every chunk reads chunks x bytes / 2 characters: ~7e8 for the 1.2 MB, 1,200-chunk note below
// (seconds of CPU), against ~1.2e6 when the counter is carried forward. The same quadratic took
// minutes on a 13 MB note with 8,000 chunks. The budget sits well above the linear cost and below
// the quadratic one even on a fast machine.
describe('chunk line spans are computed in time linear in the note', () => {
  it('locates 1,200 chunks of a 1.2 MB note without rescanning the file for each one', () => {
    const sections = 1200;
    const filler = 'Durable context told once should be available to every agent later. '.repeat(14);
    const texts: string[] = [];
    const parts: string[] = [];
    for (let i = 0; i < sections; i += 1) {
      const text = `## Section ${i}\n\n${filler}${i}.`;
      texts.push(text);
      parts.push(`${text}\n`);
    }
    // A flat string, as `bytes.toString('utf8')` gives the importer, not a rope of concatenated parts.
    const original = Buffer.from(`# Log\n\n${parts.join('\n')}`, 'utf8').toString('utf8');
    expect(original.length).toBeGreaterThan(1_100_000);

    const before = process.cpuUsage();
    const rendered = renderNoteMarkdown(note(original, texts));
    const used = process.cpuUsage(before);
    const cpuMs = (used.user + used.system) / 1000;
    process.stdout.write(`chunk spans: ${sections} chunks, ${original.length} bytes, cpu=${cpuMs.toFixed(1)}ms\n`);

    expect(rendered.chunksNotLocated).toBe(0);
    expect(cpuMs).toBeLessThan(250);

    // The speed-up must not move a single line number: spot-check that spans slice back to their chunk.
    const lines = original.split('\n');
    for (let i = 0; i < sections; i += 53) {
      const { startLine, endLine } = rendered.chunkLines[i];
      expect(lines.slice(startLine, endLine).join('\n')).toBe(texts[i]);
    }
    const last = rendered.chunkLines[sections - 1];
    expect(lines.slice(last.startLine, last.endLine).join('\n')).toBe(texts[sections - 1]);
  });
});
