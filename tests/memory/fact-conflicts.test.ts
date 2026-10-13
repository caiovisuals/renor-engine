import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { MAX_DRIFT_VALUES, namedConflicts, possibleDuplicates } from '../../src/memory/factConflicts';
import { seedFacts } from '../helpers/seedFacts';
import { fullScans, traceStatements } from '../helpers/traceStatements';

/**
 * Which current facts the drift fields relate (memory/factConflicts.ts), on facts saved through the real lifecycle
 * write path. The MCP surfaces are in tests/mvp/drift-conflicts.test.ts.
 */

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-conflicts-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  runMigrations(db);
  dbs.push(db);
  const put = (subject: string, predicate: string, object: string, scope?: string) =>
    remember(db, dir, DEFAULT_LEDGER_REL, { subject, predicate, object, ...(scope === undefined ? {} : { scope }) });
  return { db, put };
}

const brief = (value: { subject: string; object: string; scope: string }) => `${value.subject} = ${value.object} [${value.scope}]`;

describe('which subjects are related', () => {
  // [asked, other, related]. The other one is saved second, so it is newer; identities that fold together are
  // saved in two scopes, because in one scope the second save would supersede the first.
  const PAIRS: Array<[string, string, boolean]> = [
    ['Atlas', 'Atlas project', true], // one word after
    ['staging database', 'Atlas staging database', true], // one word before
    ['Atlas', 'atlas', true], // one identity: case
    ['José', `JOSE${String.fromCodePoint(0x301)}`, true], // one identity: case and Unicode form (NFD)
    ['Atlas', 'Atlas: project', true], // words, not characters: the colon is no word
    ['Café', 'CAFÉ MENU', true], // a name outside ASCII, folded the same way
    ['ATL-412', 'ATL-412 ticket', true], // a slug is one word
    ['Atlas', 'the Atlas project', false], // two words more
    ['Atlas project', 'Atlas new project', false], // a word in the middle
    ['Atlas', 'Atlassian', false], // a longer word is another word
    ['ATL-412', 'ATL-4120', false],
    ['ATL-412', 'ATL', false], // a slug is not split
    ['Ravi', "Ravi's manager", false], // a possessive names another thing
    ['Ravi', "RAVI'S MANAGER", false],
    ['Ravi', 'Ravi’s manager', false],
    ['users', "users' settings", false],
    ["Ravi's manager", "RAVI'S MANAGER", true], // a possessive is still one identity
  ];

  it.each(PAIRS)('%s / %s: related %s', async (asked, other, isRelated) => {
    const { db, put } = store();
    const sameIdentity = asked.normalize('NFC').toLowerCase() === other.normalize('NFC').toLowerCase();
    await put(asked, 'owner', 'Lena');
    const second = await put(other, 'owner', 'Ravi', sameIdentity ? 'scope:elsewhere' : undefined);
    const conflicts = namedConflicts(db, [{ subject: asked, predicate: 'owner' }], null);
    const duplicates = possibleDuplicates(db, { subject: other, predicate: 'owner' }, second.created!.factId, null);
    if (isRelated) {
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].values.map(v => v.object)).toEqual(['Ravi', 'Lena']);
      expect(duplicates.values.map(v => v.object)).toEqual(['Lena']);
    } else {
      expect(conflicts).toEqual([]);
      expect(duplicates).toEqual({ values: [], total: 0 });
    }
  });

  it('two entities left with one identity by an earlier build are related, whatever their spelling', () => {
    const { db } = store();
    // Written straight into the table: the live write path would refuse the second spelling's own entity.
    seedFacts(db, 2, i => ({ subject: ['Rowan', 'ROWAN VALE'][i], predicate: 'lives_in', object: ['Rio', 'Lisbon'][i] }));
    const conflicts = namedConflicts(db, [{ subject: 'Rowan', predicate: 'lives_in' }], null);
    expect(conflicts.map(c => c.values.map(brief))).toEqual([['ROWAN VALE = Lisbon [global]', 'Rowan = Rio [global]']]);
  });
});

describe('what a group is', () => {
  it('is one conflict when two returned facts share a related fact, in the order the read returned them', async () => {
    const { db, put } = store();
    await put('Atlas', 'deploy_target', 'Fly.io');
    await put('Atlas project', 'deploy_target', 'Heroku');
    await put('Atlas project team', 'deploy_target', 'ECS'); // related to "Atlas project", not to "Atlas"
    await put('Kestrel', 'deploy_target', 'Expo');
    await put('Kestrel app', 'deploy_target', 'EAS');
    const conflicts = namedConflicts(db, [
      { subject: 'Kestrel', predicate: 'deploy_target' },
      { subject: 'Atlas', predicate: 'deploy_target' },
      { subject: 'Atlas project team', predicate: 'deploy_target' },
    ], null);
    expect(conflicts.map(c => c.values.map(brief))).toEqual([
      ['Kestrel app = EAS [global]', 'Kestrel = Expo [global]'],
      ['Atlas project team = ECS [global]', 'Atlas project = Heroku [global]', 'Atlas = Fly.io [global]'],
    ]);
  });

  it('holds only current facts of the same predicate, and agreeing values are no conflict', async () => {
    const { db, put } = store();
    await put('Atlas', 'database', 'Postgres 15');
    await put('Atlas', 'database', 'Postgres 16'); // supersedes 15
    await put('Atlas project', 'database', 'postgres 16'); // agrees, once folded
    await put('Atlas project', 'database_version', '13'); // another predicate
    expect(namedConflicts(db, [{ subject: 'Atlas', predicate: 'database' }], null)).toEqual([]);
    const duplicates = possibleDuplicates(db, { subject: 'Atlas', predicate: 'database' }, null, null);
    expect(duplicates.values.map(brief)).toEqual(['Atlas project = postgres 16 [global]', 'Atlas = Postgres 16 [global]']);
  });

  it('a scope sees only its own facts; no scope sees them all', async () => {
    const { db, put } = store();
    await put('Atlas', 'api_rate_limit', '600/min', 'project:atlas');
    await put('Atlas', 'api_rate_limit', '1200/min');
    await put('Atlas project', 'api_rate_limit', '900/min', 'project:kestrel');
    const asked = [{ subject: 'Atlas', predicate: 'api_rate_limit' }];
    expect(namedConflicts(db, asked, null).map(c => c.values.map(brief))).toEqual([
      ['Atlas project = 900/min [project:kestrel]', 'Atlas = 1200/min [global]', 'Atlas = 600/min [project:atlas]'],
    ]);
    for (const scope of ['project:atlas', 'global', 'project:kestrel']) expect(namedConflicts(db, asked, scope), scope).toEqual([]);
    expect(possibleDuplicates(db, asked[0], null, 'project:atlas').values.map(brief)).toEqual(['Atlas = 600/min [project:atlas]']);
  });

  it(`lists the newest ${MAX_DRIFT_VALUES} values and the total`, async () => {
    const { db, put } = store();
    for (let i = 1; i <= MAX_DRIFT_VALUES + 2; i++) await put('room', 'booked_by', `team ${i}`, `scope:floor-${i}`);
    const [conflict] = namedConflicts(db, [{ subject: 'room', predicate: 'booked_by' }], null);
    expect(conflict.values.map(v => v.object)).toEqual(Array.from({ length: MAX_DRIFT_VALUES }, (_, k) => `team ${MAX_DRIFT_VALUES + 2 - k}`));
    expect(conflict.total).toBe(MAX_DRIFT_VALUES + 2);
    const duplicates = possibleDuplicates(db, { subject: 'room', predicate: 'booked_by' }, null, null);
    expect(duplicates.values.length).toBe(MAX_DRIFT_VALUES);
    expect(duplicates.total).toBe(MAX_DRIFT_VALUES + 2);
  });
});

describe('what a read costs', () => {
  it('visits current facts only, and reads in full only the facts whose name can be related', async () => {
    const { db, put } = store();
    seedFacts(db, 3000, i => (i < 2000
      ? { subject: `ATL-${i}`, predicate: 'status', object: i % 2 ? 'done' : 'in progress' }
      : { subject: `Service ${i}`, predicate: 'owner', object: 'Ravi' }));
    await put('ATL-7 ticket', 'status', 'blocked');
    const { result, plans } = traceStatements(db, () => namedConflicts(db, [{ subject: 'ATL-7', predicate: 'status' }], null));
    // The seeded facts are dated 2099, so ATL-7 is the newer value.
    expect(result.map(c => c.values.map(brief))).toEqual([['ATL-7 = done [global]', 'ATL-7 ticket = blocked [global]']]);
    expect(plans.length).toBe(2);
    const [names, full] = plans;
    const tableScans = (plan: string[]) => fullScans(plan).filter(line => !line.includes('VIRTUAL TABLE')); // json_each
    // The name pass walks the partial index of current lifecycle facts, never the facts table or a superseded fact.
    expect(tableScans(names.plan)).toEqual(['SCAN f USING INDEX idx_facts_current']);
    expect(names.rows).toBe(2001); // every current status fact's name: the predicate is all SQLite filters on
    expect(full.rows).toBe(2); // ATL-7 and "ATL-7 ticket" only
    expect(tableScans(full.plan)).toEqual([]);
  });

  it('asks the database nothing for a read that returned no facts', () => {
    const { db } = store();
    const { result, plans } = traceStatements(db, () => namedConflicts(db, [], null));
    expect(result).toEqual([]);
    expect(plans).toEqual([]);
  });
});
