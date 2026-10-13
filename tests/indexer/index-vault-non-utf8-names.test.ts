import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault, type IndexResult } from '../../src/indexer/pipeline';
import { bytes, latin1, rawPath, supportsNonUtf8Names } from '../helpers/nonUtf8Names';
import { tmpPath } from '../helpers/tmpPath';

/**
 * A file or folder name written by another OS or locale can hold bytes that are not UTF-8 (a
 * Latin-1 "Reunião.md"). Node decodes such a name with U+FFFD, so the string path it yields names
 * nothing that exists on disk.
 *
 * The walk could already read the directory as bytes and name those files
 * (`walker.ts`'s `onNonUtf8Markdown`, and `readMarkdownSource` opted into it), but `indexVault`
 * did not, so the indexer itself had two failures for one cause: a bad FILE name came back from
 * the walk as a path that failed its first read and was counted as an indexing error, and a bad
 * FOLDER name made `scandir` throw inside the walk — one such name anywhere in the vault aborted
 * the whole pass, and not one note reached the index.
 *
 * These cases pin the fixed contract at the indexing surface: every note the indexer can address
 * indexes, every note it cannot is named in `skippedNonUtf8Names`, and neither the two are
 * confused for one another. No embedding provider is passed, so no model runs here.
 *
 * Only what is new here. Which bytes make a name invalid, and what an ignored bad name reports,
 * are decided inside the walk and owned by `tests/indexer/walker.test.ts`; the process status and
 * the operator-visible line are owned by `tests/cli/index-error-exit-status.test.ts`.
 *
 * The tests skip on a filesystem that cannot store such a name (APFS); on Linux a skip would only
 * hide them, so say so loudly.
 */

const DB = tmpPath('test-index-non-utf8.db');
const dirs: string[] = [];

afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.runIf(process.platform === 'linux')('can store a name that is not valid UTF-8, so the tests below are not silently skipped', () => {
  expect(supportsNonUtf8Names).toBe(true);
});

/** A vault whose only content is what `put` writes. */
function vault(): string {
  const dir = fs.mkdtempSync(path.join(tmpPath(''), 'vault-'));
  dirs.push(dir);
  return dir;
}

/** Write a Markdown note at `segments` under `root`, creating the folders it needs, as bytes. */
function put(root: string, segments: Buffer[], text = '# note\n\nsomething worth recalling.\n') {
  fs.mkdirSync(rawPath(root, ...segments.slice(0, -1)), { recursive: true });
  fs.writeFileSync(rawPath(root, ...segments), text);
}

/** Index `root` into a fresh database and report both the result and what actually landed. */
async function index(root: string): Promise<{ result: IndexResult; indexed: string[] }> {
  const db = openDb(DB);
  try {
    runMigrations(db);
    const result = await indexVault(db, root);
    const indexed = (db.prepare('SELECT path FROM notes ORDER BY path').all() as Array<{ path: string }>).map(r => r.path);
    return { result, indexed };
  } finally {
    // Closed even when the pass rejects, so a failing case cannot hold the file the next one
    // (and `afterEach`'s unlink) needs.
    db.close();
  }
}

describe.skipIf(!supportsNonUtf8Names)('indexVault with names that are not valid UTF-8', () => {
  it('indexes the other notes and names the one whose file name is not valid UTF-8', async () => {
    const root = vault();
    put(root, [Buffer.from('Projects'), Buffer.from('Alpha.md')]);
    put(root, [latin1('Reunião.md')]);
    const { result, indexed } = await index(root);
    // Not an error: nothing failed, the name simply cannot be addressed.
    expect(result).toEqual({ total: 1, indexed: 1, errors: 0, skippedNonUtf8Names: [String.raw`Reuni\xe3o.md`] });
    expect(indexed).toEqual([path.join(root, 'Projects/Alpha.md')]);
  });

  it('a folder whose name is not valid UTF-8 skips only the notes it holds, not the pass', async () => {
    // The failure this fixes: `scandir` on the U+FFFD path threw out of walkVault, so indexVault
    // rejected and indexed nothing at all — one unreadable name anywhere cost the whole vault.
    const root = vault();
    put(root, [Buffer.from('ok.md')]);
    put(root, [Buffer.from('Daily'), Buffer.from('2026-10-03.md')]);
    put(root, [latin1('Reunião'), Buffer.from('ata.md')]);
    put(root, [latin1('Reunião'), Buffer.from('sub'), Buffer.from('deep.md')]);
    const { result, indexed } = await index(root);
    expect(result).toEqual({
      total: 2, indexed: 2, errors: 0,
      skippedNonUtf8Names: [String.raw`Reuni\xe3o/ata.md`, String.raw`Reuni\xe3o/sub/deep.md`],
    });
    expect(indexed).toEqual([path.join(root, 'Daily/2026-10-03.md'), path.join(root, 'ok.md')]);
  });

  it('names a bad name at any depth and indexes the notes beside it at every depth', async () => {
    const root = vault();
    put(root, [Buffer.from('root.md')]);
    put(root, [bytes([0xff, 0xfe], 'depth-1.md')]);
    put(root, [Buffer.from('Notes'), Buffer.from('depth-2.md')]);
    put(root, [Buffer.from('Notes'), latin1('Reunião'), Buffer.from('depth-3.md')]);
    put(root, [Buffer.from('A'), Buffer.from('B'), Buffer.from('C'), Buffer.from('D'), latin1('Diário'), Buffer.from('depth-5.md')]);
    put(root, [bytes([0xc0, 0x80], 'overlong.md')]);
    const { result, indexed } = await index(root);
    expect(result.skippedNonUtf8Names).toEqual([
      String.raw`A/B/C/D/Di\xe1rio/depth-5.md`,
      String.raw`Notes/Reuni\xe3o/depth-3.md`,
      String.raw`\xc0\x80overlong.md`,
      String.raw`\xff\xfedepth-1.md`,
    ]);
    // Every reachable note indexed, whatever depth the bad name sat at, and the skipped ones
    // never became rows — a name is not an identity the index can hold.
    expect(result).toMatchObject({ total: 2, indexed: 2, errors: 0 });
    expect(indexed).toEqual([path.join(root, 'Notes/depth-2.md'), path.join(root, 'root.md')]);
  });

  it('still reports the skipped names when they hold the only Markdown in the vault', async () => {
    // "Nothing to index" and "nothing indexable" must not read the same: a guard that returned
    // the empty result before reading the walk would hide the only reason the vault is empty.
    const root = vault();
    put(root, [bytes([0xff], 'only.md')]);
    const { result, indexed } = await index(root);
    expect(result).toEqual({ total: 0, indexed: 0, errors: 0, skippedNonUtf8Names: [String.raw`\xffonly.md`] });
    expect(indexed).toEqual([]);
  });

  it('reports no skipped name for a vault of valid ones, however many bytes they take', async () => {
    // The negative control for the new field at this boundary: valid multi-byte names are the
    // common case, and a walk that reported them would leave the field meaningless. (Whether a
    // name is valid is decided byte-wise and owned by the walker; this only pins that nothing
    // valid ever reaches the indexer's report.)
    const root = vault();
    put(root, [Buffer.from('Résumé 日本語 😀.md')]);
    put(root, [Buffer.from('Projects'), Buffer.from('plan.md')]);
    const { result, indexed } = await index(root);
    expect(result).toEqual({ total: 2, indexed: 2, errors: 0, skippedNonUtf8Names: [] });
    expect(indexed).toHaveLength(2);
  });
});
