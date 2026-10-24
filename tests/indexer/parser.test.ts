import { describe, it, expect } from 'vitest';
import { parseNote } from '../../src/indexer/parser';

describe('parseNote', () => {
  it('extracts frontmatter and title', () => {
    const r = parseNote(
      '/v/People/John.md',
      `---\nkind: person\naliases:\n  - John\n  - JD\n---\n# John Doe\n\nEngineer.`
    );
    expect(r.frontmatter.kind).toBe('person');
    expect(r.frontmatter.aliases).toEqual(['John', 'JD']);
    expect(r.title).toBe('John Doe');
  });

  it('works with plain markdown', () => {
    const r = parseNote('/v/scratch.md', '# Hello\n\nText.');
    expect(r.frontmatter).toEqual({});
    expect(r.title).toBe('Hello');
  });

  it('reads a front matter block that is not a mapping as no front matter (found by tests/fuzz)', () => {
    // A YAML list here made the export write its items as keys `0`, `1`.
    for (const block of ['- a\n- b', 'hello', '42', 'true', '2024-01-01']) {
      const r = parseNote('/v/odd.md', `---\n${block}\n---\n# Odd\n\nBody.`);
      expect(r.frontmatter, block).toEqual({});
      expect(r.body).toBe('# Odd\n\nBody.');
    }
  });

  it('falls back to filename when no h1', () => {
    const r = parseNote('/v/my-note.md', 'Just text.');
    expect(r.title).toBe('my-note');
  });

  it('extracts wikilinks including aliased and heading variants', () => {
    const r = parseNote('/v/test.md', '# T\n\nSee [[People/John|JD]] and [[Projects/Alpha#Beta]].');
    expect(r.wikilinks).toContain('People/John');
    expect(r.wikilinks).toContain('Projects/Alpha');
  });
});

describe('parseNote frontmatter safety', () => {
  const flatAliases = (width: number, count: number) =>
    `---\nbig: &big ${'x'.repeat(width)}\nlist: [${Array(count).fill('*big').join(', ')}]\n---\n# Flat`;

  it('refuses a flat list of aliases of one large scalar, however small the note', () => {
    // 2,000 aliases of a 2,500-character scalar: a 15 KB note that serializes to 5 MB.
    const note = flatAliases(2_500, 2_000);
    expect(note.length).toBeLessThan(16_000);
    expect(() => parseNote('/v/flat.md', note)).toThrow(/too large/);
  });

  it('counts what is stored, so aliases of a long number or a date are bounded too', () => {
    // 20,000 three-byte aliases: a 60 KB note whose JSON is roughly half a megabyte.
    for (const anchor of ['1.2345678901234567e+300', '2024-01-01T10:00:00Z']) {
      const note = `---\nv: &v ${anchor}\nlist: [${Array(20_000).fill('*v').join(',')}]\n---\n# Flat`;
      expect(note.length).toBeLessThan(64 * 1024);
      expect(() => parseNote('/v/flat.md', note), anchor).toThrow(/too large/);
    }
  });

  it('accepts frontmatter only within 64 KiB plus four times the note, measured as stored', () => {
    const results = [100, 400, 700, 1_000, 2_000, 5_000].map(count => {
      const note = `---\ns: &s ${'m'.repeat(100)}\nlist: [${Array(count).fill('*s').join(',')}]\n---\n# Edge`;
      try {
        return { count, stored: JSON.stringify(parseNote('/v/edge.md', note).frontmatter).length, bound: 64 * 1024 + 4 * note.length };
      } catch { return { count, stored: -1, bound: 0 }; }
    });
    expect(results[0].stored).toBeGreaterThan(0);
    expect(results[results.length - 1].stored).toBe(-1);
    for (const r of results) if (r.stored >= 0) expect(r.stored, `count ${r.count}`).toBeLessThanOrEqual(r.bound);
  });

  it('keeps ordinary anchors, aliases and merge keys', () => {
    const r = parseNote('/v/anchored.md',
      '---\nbase: &base {kind: person, tags: [a, b]}\ncopy: *base\nmerged:\n  <<: *base\n  name: Ada\n---\n# Anchored');
    expect(r.frontmatter.copy).toEqual({ kind: 'person', tags: ['a', 'b'] });
    expect(r.frontmatter.merged).toEqual({ kind: 'person', tags: ['a', 'b'], name: 'Ada' });
  });

  it('refuses a note every time when its first parse failed, never from a cache', () => {
    const broken = [
      '---\nsecret: [invalid\n---\nbody',
      "---\nrun: !!js/function 'function () { return 1; }'\n---\nbody",
      `---\ndeep: ${'['.repeat(5_000)}${']'.repeat(5_000)}\n---\nbody`,
    ];
    for (const note of broken) {
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(() => parseNote('/v/broken.md', note), `attempt ${attempt}: ${note.slice(0, 24)}`).toThrow();
      }
    }
  });

  it('never evaluates JavaScript frontmatter', () => {
    for (const opening of ['---js', '---javascript', '---JavaScript']) {
      expect(() => parseNote('/v/js.md', `${opening}\n(globalThis.__parseNoteExecuted = true, {})\n---\n# JS`)).toThrow();
      expect((globalThis as { __parseNoteExecuted?: boolean }).__parseNoteExecuted).toBeUndefined();
    }
  });
});
