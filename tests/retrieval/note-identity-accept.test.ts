import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { selectNoteIdentityHits } from '../../src/retrieval/noteIdentity';
import { tmpPath } from '../helpers/tmpPath';

/**
 * `accept` is how a caller keeps a note out of the identity page (the scope of a read, say). It judges a candidate by
 * its opening chunk, and it does so *before* the limit: a note it turns away takes no slot, so the limit counts the
 * notes that are shown. The opening chunk is what lets a caller judge a note whose path says nothing about its
 * content, such as the ledger, which opens with an event of some scope.
 */

const DB = tmpPath('test-note-identity-accept.db');
const vaults: string[] = [];
afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(DB + suffix)) fs.unlinkSync(DB + suffix);
  for (const v of vaults.splice(0)) fs.rmSync(v, { recursive: true, force: true });
});

const ID = 'shared-id-9';
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

/** Seven notes named by the same identifier, `a` to `g` in path order; each opens with its own line. */
async function sevenNamedNotes() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'note-identity-accept-'));
  vaults.push(vault);
  for (const letter of LETTERS) {
    const file = path.join(vault, letter, ID, 'note.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Note ${letter}\n\nopening of ${letter}\n\n## Later\n\nnot the opening of ${letter}\n`);
  }
  const db = openDb(DB);
  runMigrations(db);
  await indexVault(db, vault, {}, 1);
  return { db, vault };
}

const letterOf = (notePath: string) => notePath.split(path.sep).slice(-3)[0];

describe('selectNoteIdentityHits: accept judges the opening chunk before the limit', () => {
  it('without accept it returns the first `limit` named notes in path order, as their opening chunks', async () => {
    const { db } = await sevenNamedNotes();
    const hits = selectNoteIdentityHits(db, ID, 3);
    expect(hits.map(h => letterOf(h.notePath))).toEqual(['a', 'b', 'c']);
    expect(hits.every(h => h.reason === 'note-identity')).toBe(true);
    expect(hits[0].text).toContain('opening of a');
    expect(hits[0].text).not.toContain('not the opening');
    db.close();
  });

  it('hands accept the note path and the note\'s opening chunk', async () => {
    const { db, vault } = await sevenNamedNotes();
    const offered: Array<{ notePath: string; opening: { notePath: string; headingPath: string; text: string; chunkId: number } }> = [];
    selectNoteIdentityHits(db, ID, 2, new Set(), (notePath, opening) => { offered.push({ notePath, opening }); return true; });
    expect(offered.map(o => letterOf(o.notePath))).toEqual(['a', 'b']);
    for (const { notePath, opening } of offered) {
      expect(notePath.startsWith(vault)).toBe(true);
      expect(opening.notePath).toBe(notePath);
      expect(opening.text).toContain(`opening of ${letterOf(notePath)}`);
      expect(opening.text).not.toContain('not the opening');
      expect(opening.chunkId).toBeGreaterThan(0);
    }
    db.close();
  });

  it('a note accept turns away takes no slot: the limit counts the notes that are shown', async () => {
    const { db } = await sevenNamedNotes();
    // Turn away a to d by what their opening chunk says; a limit applied first would have spent all 3 slots on them.
    const hits = selectNoteIdentityHits(db, ID, 3, new Set(), (_p, opening) => !/opening of [abcd]\b/.test(opening.text));
    expect(hits.map(h => letterOf(h.notePath))).toEqual(['e', 'f', 'g']);
    expect(hits.map(h => h.score)).toEqual([3, 2, 1]);
    db.close();
  });

  it('shows fewer than the limit when fewer notes are accepted', async () => {
    const { db } = await sevenNamedNotes();
    const hits = selectNoteIdentityHits(db, ID, 5, new Set(), (_p, opening) => /opening of [bf]\b/.test(opening.text));
    expect(hits.map(h => letterOf(h.notePath))).toEqual(['b', 'f']);
    db.close();
  });

  it('never offers a note the caller already returns', async () => {
    const { db, vault } = await sevenNamedNotes();
    const have = new Set([path.join(vault, 'a', ID, 'note.md'), path.join(vault, 'c', ID, 'note.md')]);
    const offered: string[] = [];
    const hits = selectNoteIdentityHits(db, ID, 3, have, notePath => { offered.push(letterOf(notePath)); return true; });
    expect(offered).toEqual(['b', 'd', 'e']);
    expect(hits.map(h => letterOf(h.notePath))).toEqual(['b', 'd', 'e']);
    db.close();
  });

  it('stops asking once the limit is reached', async () => {
    const { db } = await sevenNamedNotes();
    const offered: string[] = [];
    selectNoteIdentityHits(db, ID, 2, new Set(), notePath => { offered.push(letterOf(notePath)); return true; });
    expect(offered).toEqual(['a', 'b']);
    db.close();
  });
});
