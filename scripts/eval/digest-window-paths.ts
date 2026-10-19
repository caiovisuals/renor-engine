import path from 'node:path';

/**
 * The notes the control retrieval returned, as the paths digest-window-notes fills digests for. The public CLI prints a
 * note's path relative to the vault while the index may store it vault-absolute, so both forms go in; notes under
 * `_renor/` (the engine's own files) never do.
 */
export function windowNotePaths(hits: ReadonlyArray<{ notePath: string }>, vaultDir: string): Set<string> {
  const paths = new Set<string>();
  for (const hit of hits) {
    if (hit.notePath.startsWith('_renor/')) continue;
    paths.add(hit.notePath);
    paths.add(path.resolve(vaultDir, hit.notePath));
  }
  return paths;
}
