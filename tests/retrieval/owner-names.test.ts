import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember } from '../../src/memory/lifecycle';
import { factsFirstHits, subjectsInQuery } from '../../src/retrieval/factsFirst';
import { identityKey, ownerNames } from '../../src/retrieval/queryHelpers';

// The owner's names come from RENOR_OWNER_NAMES. Every case here sets it explicitly, so the suite's fictional owner
// in vitest.config.ts does not decide the result.
const tmpDirs: string[] = [];
const LEDGER = 'System/Memory Events Ledger.md';

beforeEach(() => {
  vi.stubEnv('RENOR_OWNER_NAMES', 'Rowan,Rowan Vale');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function workspace(facts: Array<[string, string, string]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-names-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'i.db'));
  runMigrations(db);
  for (const [subject, predicate, object] of facts) {
    await remember(db, dir, LEDGER, { subject, predicate, object, source: 'test' });
  }
  return db;
}

describe('owner names from RENOR_OWNER_NAMES', () => {
  it('is empty when unset: no name is the owner and no alias is built in', () => {
    vi.stubEnv('RENOR_OWNER_NAMES', undefined as unknown as string);
    expect(ownerNames()).toEqual([]);
    expect(identityKey('Rowan')).toBe('rowan');
    expect(identityKey('Rowan Vale')).not.toBe(identityKey('Rowan'));
    expect(subjectsInQuery('who am I')).toEqual([]);
  });

  it('is empty for an empty value', () => {
    vi.stubEnv('RENOR_OWNER_NAMES', '');
    expect(ownerNames()).toEqual([]);
    expect(subjectsInQuery('what am I building')).toEqual([]);
  });

  it('follows a change made mid-process', () => {
    vi.stubEnv('RENOR_OWNER_NAMES', 'Ada Lovelace,Ada');
    expect(identityKey('Ada')).toBe(identityKey('Ada Lovelace'));
    vi.stubEnv('RENOR_OWNER_NAMES', 'Bea');
    expect(identityKey('Ada')).toBe('ada');
    expect(identityKey('Bea')).toBe('bea');
    expect(subjectsInQuery('what is Bea building')).toEqual(['Bea']);
    expect(subjectsInQuery('what is Ada building')).toEqual([]);
  });

  it('trims padded entries and drops empty ones', () => {
    vi.stubEnv('RENOR_OWNER_NAMES', ' Ada , , Ada Lovelace ,');
    expect(ownerNames()).toEqual(['Ada', 'Ada Lovelace']);
    expect(identityKey('ada lovelace')).toBe(identityKey('Ada'));
  });

  it('answers who-is questions for a name ending in a non-ASCII letter, and one in CJK', async () => {
    vi.stubEnv('RENOR_OWNER_NAMES', 'José');
    const db = await workspace([['José', 'current_project', 'Renor'], ['José', 'location', 'Lisbon']]);
    expect(factsFirstHits(db, 'Who is José?', 5).map(h => h.text).join('\n')).toContain('current_project');
    expect(factsFirstHits(db, 'tell me about José', 5).length).toBeGreaterThan(0);
    db.close();

    vi.stubEnv('RENOR_OWNER_NAMES', '李雷,Li Lei');
    const cjk = await workspace([['李雷', 'current_project', 'Renor']]);
    expect(factsFirstHits(cjk, 'Who is 李雷?', 5).map(h => h.text).join('\n')).toContain('current_project');
    cjk.close();
  });

  it('does not find a short name inside other words', () => {
    vi.stubEnv('RENOR_OWNER_NAMES', 'Al');
    expect(subjectsInQuery('what is the capital of portugal')).toEqual([]);
    expect(subjectsInQuery('is the salad ready')).toEqual([]);
    expect(subjectsInQuery('what is Al building')).toEqual(['Al']);
  });

  it('answers the owner-named questions from the facts lane', async () => {
    const db = await workspace([
      ['Rowan', 'current_project', 'Renor'],
      ['Rowan', 'location', 'Port Alder'],
      ['Rowan', 'preferred_name', 'Ro'],
    ]);
    expect(factsFirstHits(db, 'What is Rowan building?', 3)[0]?.text).toContain('current_project');
    expect(factsFirstHits(db, 'Where does Rowan live?', 3)[0]?.text).toContain('location');
    expect(factsFirstHits(db, "What is Rowan's name?", 3)[0]?.text).toContain('preferred_name');
    db.close();
  });
});
