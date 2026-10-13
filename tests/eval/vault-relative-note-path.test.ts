import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { vaultRelativeNotePath } from '../../scripts/eval/run-longmemeval-product';

/**
 * The benchmark scores a hit by its note's path below the case vault. The CLI prints it that way (the form the hosted
 * tools use), and a CLI from before that printed the absolute path: the harness reads both. `path.relative` resolves
 * a relative path against the working directory, so asked of the path the CLI prints now it names a file nowhere near
 * the vault, and every recorded hit would have been scored against a path that is not a note.
 */
describe('vaultRelativeNotePath', () => {
  const vault = '/tmp/renor-product-AbCdEf/vault';

  it('leaves the path the CLI prints as it is, wherever the harness runs', () => {
    expect(vaultRelativeNotePath(vault, 'Sessions/answer_1-0a1b2c3d4e.md')).toBe('Sessions/answer_1-0a1b2c3d4e.md');
    expect(vaultRelativeNotePath(vault, 'inbox.md')).toBe('inbox.md');
    // What the call this replaces gave for it: the path of a file in the working directory, seen from the vault.
    expect(path.relative(vault, 'Sessions/answer_1-0a1b2c3d4e.md').replaceAll(path.sep, '/')).not.toBe('Sessions/answer_1-0a1b2c3d4e.md');
  });

  it('reads the absolute path an older CLI printed as the same path below the vault', () => {
    expect(vaultRelativeNotePath(vault, `${vault}/Sessions/answer_1-0a1b2c3d4e.md`)).toBe('Sessions/answer_1-0a1b2c3d4e.md');
    expect(vaultRelativeNotePath(vault, `${vault}/inbox.md`)).toBe('inbox.md');
  });

  it('leaves the evidence table\'s path, which is no file, as it is', () => {
    expect(vaultRelativeNotePath(vault, '_renor/evidence')).toBe('_renor/evidence');
  });
});
