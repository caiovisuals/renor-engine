import { describe, it, expect } from 'vitest';
import path from 'path';
import { clientPath } from '../../src/mvp/engine';

/**
 * The path a client is shown for a stored note path: relative to the memory directory when the note is inside it,
 * its file name when it is not (a product surface never leaks a host path). A search shows the path of every hit it
 * judges, so the answers are kept; they are kept per memory directory and per working directory (a relative path
 * resolves against it), and an answer kept is the answer a fresh call gives.
 */
describe('clientPath', () => {
  it('shows a note inside the memory directory relative to it', () => {
    expect(clientPath('/vault', '/vault/Notes/a.md')).toBe(path.join('Notes', 'a.md'));
    expect(clientPath('/vault', '/vault/a.md')).toBe('a.md');
    expect(clientPath('/vault/', '/vault/Notes/../Notes/a.md')).toBe(path.join('Notes', 'a.md'));
  });

  it('shows a path outside the memory directory by its file name, and the directory itself as it was given', () => {
    expect(clientPath('/vault', '/elsewhere/Notes/a.md')).toBe('a.md');
    expect(clientPath('/vault', '/vault-two/Notes/a.md')).toBe('a.md'); // a sibling that starts with the same letters is not inside
    expect(clientPath('/vault', '/vault')).toBe('/vault');
  });

  it('answers the same when asked again, and keeps the answers of two memory directories apart', () => {
    for (let i = 0; i < 3; i++) {
      expect(clientPath('/a', '/a/b/note.md')).toBe(path.join('b', 'note.md'));
      expect(clientPath('/a/b', '/a/b/note.md')).toBe('note.md');
      expect(clientPath('/c', '/a/b/note.md')).toBe('note.md');
    }
  });

  it('resolves a relative path against the working directory, and the kept answer follows the directory', () => {
    const here = process.cwd();
    expect(clientPath(here, 'Notes/a.md')).toBe(path.join('Notes', 'a.md'));
    expect(clientPath('/somewhere/else', 'Notes/a.md')).toBe('a.md');
  });

  it('keeps answering right past the number of paths it keeps', () => {
    for (let i = 0; i < 5000; i++) expect(clientPath('/vault', `/vault/Notes/n${i}.md`)).toBe(path.join('Notes', `n${i}.md`));
    expect(clientPath('/vault', '/vault/Notes/n0.md')).toBe(path.join('Notes', 'n0.md'));
  });
});
