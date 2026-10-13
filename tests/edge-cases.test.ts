import { describe, it, expect } from 'vitest';
import { parseNote } from '../src/indexer/parser';
import { chunkNote } from '../src/indexer/chunker';
import { walkVault } from '../src/indexer/walker';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('EDGE CASES - Unicode and Special Characters', () => {
  describe('parseNote with Unicode', () => {
    it('handles Cyrillic aliases correctly', () => {
      const r = parseNote(
        '/v/People/Ivan.md',
        '---\nkind: person\naliases:\n  - Иван\n  - Ван\n---\n# Иван Петров\nEngineer.'
      );
      expect(r.frontmatter.aliases).toEqual(['Иван', 'Ван']);
      expect(r.title).toBe('Иван Петров');
    });

    it('handles Arabic characters in wikilinks', () => {
      const r = parseNote(
        '/v/People/Muhammad.md',
        '# محمد\n\nLinked to [[People/فاطمة]] and [[Projects/تقنية]].'
      );
      expect(r.wikilinks).toContain('People/فاطمة');
      expect(r.wikilinks).toContain('Projects/تقنية');
    });

    it('handles CJK characters', () => {
      const r = parseNote(
        '/v/日本語/テスト.md',
        '# テスト太郎\n\nSee [[日本語/花子]] and [[日本語/次郎#セクション]].'
      );
      expect(r.title).toBe('テスト太郎');
      expect(r.wikilinks).toContain('日本語/花子');
      expect(r.wikilinks).toContain('日本語/次郎');
    });
  });

  describe('parseNote with edge case content', () => {
    it('handles empty body after frontmatter', () => {
      const r = parseNote(
        '/v/empty.md',
        '---\nkind: note\ntitle: Empty\n---\n'
      );
      expect(r.body).toBe('');
      expect(r.title).toBe('empty');
    });

    it('handles only frontmatter, no content', () => {
      const r = parseNote(
        '/v/only-fm.md',
        '---\nkind: person\naliases: [Test]\n---'
      );
      expect(r.body.trim()).toBe('');
      expect(r.title).toBe('only-fm');
    });

    it('handles very long titles', () => {
      const longTitle = 'A'.repeat(500);
      const r = parseNote(
        '/v/long.md',
        `# ${longTitle}\n\nContent.`
      );
      expect(r.title).toBe(longTitle);
    });
  });

  describe('parseNote wikilink edge cases', () => {
    it('handles wikilinks with display names correctly', () => {
      const r = parseNote(
        '/v/test.md',
        '[[People/John|Display Name]] and [[Projects/Alpha#Section|Custom]]'
      );
      expect(r.wikilinks).toContain('People/John');
      expect(r.wikilinks).toContain('Projects/Alpha');
      expect(r.wikilinks.length).toBe(2);
    });

    it('deduplicates repeated wikilinks', () => {
      const r = parseNote(
        '/v/test.md',
        '[[People/John]] mentions [[People/John]] again and [[People/John|JD]]'
      );
      expect(r.wikilinks.filter(w => w === 'People/John').length).toBe(1);
    });

    it('handles relative path wikilinks', () => {
      const r = parseNote(
        '/v/test.md',
        '[[../Other/Note]] and [[../../Root/Note]]'
      );
      expect(r.wikilinks).toContain('../Other/Note');
      expect(r.wikilinks).toContain('../../Root/Note');
    });

    it('handles wikilinks with numbers and dashes in path', () => {
      const r = parseNote(
        '/v/test.md',
        '[[Project-2025/Phase_1.0/Component]]'
      );
      expect(r.wikilinks).toContain('Project-2025/Phase_1.0/Component');
    });
  });

  describe('chunkNote with edge cases', () => {
    it('handles note with only frontmatter, no body', () => {
      const r = {
        path: '/v/t.md',
        title: 'T',
        frontmatter: {},
        body: '',
        wikilinks: []
      };
      const chunks = chunkNote(r);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('handles whitespace-only body', () => {
      const r = {
        path: '/v/t.md',
        title: 'T',
        frontmatter: {},
        body: '   \n\n   \n\n   ',
        wikilinks: []
      };
      const chunks = chunkNote(r);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('handles very large documents', () => {
      const largeBody = ('word '.repeat(500) + '\n\n').repeat(50);
      const r = {
        path: '/v/huge.md',
        title: 'Huge',
        frontmatter: {},
        body: largeBody,
        wikilinks: []
      };
      const chunks = chunkNote(r, { maxTokens: 400 });
      expect(chunks.length).toBeGreaterThan(5);
      // NOTE: Some chunks may exceed maxTokens slightly due to paragraph boundaries
    });

    it('correctly splits on H3 headings', () => {
      const body = '# H1\n\n### H3\n\nContent\n\n#### H4\n\nMore';
      const r = {
        path: '/v/t.md',
        title: 'T',
        frontmatter: {},
        body,
        wikilinks: []
      };
      const chunks = chunkNote(r);
      // H1 and H3 should each produce a section; H4 is not split
      expect(chunks.length).toBe(2);
      expect(chunks[0].headingPath).toBe('H1');
      expect(chunks[1].headingPath).toBe('H1 > H3');
    });
  });

  describe('walkVault with edge cases', () => {
    it('handles deeply nested paths', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
      const deep = path.join(tmp, 'a/b/c/d/e/f/g/h/i/j');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'note.md'), '# Deep');
      const files = await walkVault(tmp);
      expect(files.some(f => f.includes('note.md'))).toBe(true);
      fs.rmSync(tmp, { recursive: true });
    });

    it('ignores nested ignore patterns', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
      fs.mkdirSync(path.join(tmp, 'Ignored'));
      fs.writeFileSync(path.join(tmp, 'Ignored', 'secret.md'), '# Secret');
      fs.writeFileSync(path.join(tmp, '.semanticignore'), 'Ignored/\n');
      const files = await walkVault(tmp);
      expect(files.some(f => f.includes('Ignored'))).toBe(false);
      fs.rmSync(tmp, { recursive: true });
    });
  });
});
