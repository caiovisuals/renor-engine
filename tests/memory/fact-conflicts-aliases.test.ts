import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import * as queryHelpers from '../../src/retrieval/queryHelpers';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { namedConflicts, possibleDuplicates } from '../../src/memory/factConflicts';
import { seedFacts } from '../helpers/seedFacts';

/**
 * An explicit alias is one identity however it is spelled, so the drift fields relate its spellings even when they
 * share no word. The shipped alias table holds one group whose spellings all begin with the same word, so this file
 * stands in a group that shares none ("Bob" / "Robert") for the identity primitive.
 */
vi.mock('../../src/retrieval/queryHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof queryHelpers>();
  const group = ['Bob', 'Robert'];
  const inGroup = (name: string) => group.some(member => member.toLowerCase() === name.normalize('NFC').trim().toLowerCase());
  return {
    ...actual,
    identityKey: (name: string) => (inGroup(name) ? 'bob' : actual.identityKey(name)),
    identityNames: (name: string) => (inGroup(name) ? [...new Set([name, ...group])] : actual.identityNames(name)),
  };
});

const dbs: Database.Database[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('an alias is looked for by each of its spellings', () => {
  it('two entities that are one alias group are related, though their names share no word', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-conflicts-aliases-'));
    tmpDirs.push(dir);
    const db = openDb(path.join(dir, 'index.db'));
    runMigrations(db);
    dbs.push(db);
    // Two entities, as an earlier build could leave them: the live write path would give both spellings one entity.
    seedFacts(db, 2, i => ({ subject: ['Bob', 'Robert'][i], predicate: 'lives_in', object: ['Rio', 'Lisbon'][i] }));
    const conflicts = namedConflicts(db, [{ subject: 'Bob', predicate: 'lives_in' }], null);
    expect(conflicts.map(c => c.values.map(v => `${v.subject} = ${v.object}`))).toEqual([['Robert = Lisbon', 'Bob = Rio']]);
    expect(possibleDuplicates(db, { subject: 'Robert', predicate: 'lives_in' }, null, null).values.map(v => v.subject)).toEqual(['Robert', 'Bob']);
  });
});
