import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { remember } from '../../src/memory/lifecycle';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { factsFirstHits, subjectsInQuery } from '../../src/retrieval/factsFirst';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('subjectsInQuery', () => {
  it('detects Rowan and first-person', () => {
    expect(subjectsInQuery('what is Rowan currently building')).toContain('Rowan');
    expect(subjectsInQuery("what's my dog's name")).toContain('Rowan');
    expect(subjectsInQuery('what am I building')).toContain('Rowan');
    expect(subjectsInQuery('vector index dimension')).toEqual([]);
  });
});

describe('factsFirstHits', () => {
  it('answers currently-building from current_project even with zero semantic hits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
    tmpDirs.push(dir);
    const db = openDb(path.join(dir, 'i.db'));
    runMigrations(db);
    await remember(db, dir, 'System/Memory Events Ledger.md', {
      subject: 'Rowan', predicate: 'current_project', object: 'Renor — consumer-owned AI memory', source: 'test',
    });
    await remember(db, dir, 'System/Memory Events Ledger.md', {
      subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit', source: 'test',
    });
    const hits = factsFirstHits(db, 'what is Rowan currently building', 3);
    expect(hits[0].text).toContain('Renor');
    expect(hits[0].reason).toBe('fact');
    expect(hits.some(h => h.text.includes('Biscuit'))).toBe(false);

    const idx = new VectorIndex(db, 4); idx.initTable();
    const provider = { embed: async () => [[0, 0, 0, 0]], dimensions: 4 };
    const result = await retrieveContext(db, idx, provider as any, 'what is Rowan currently building', 5, []);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0].text).toContain('Renor');
    expect(result.hits[0].reason).toBe('fact');

    const dog = await retrieveContext(db, idx, provider as any, "Rowan's dog name", 5, []);
    expect(dog.hits[0].text).toContain('Biscuit');

    expect(factsFirstHits(db, 'what is Gabriel building', 3)).toEqual([]);
    expect(factsFirstHits(db, 'what does Rowan think about consumer memory trends', 3)).toEqual([]);
    const mine = factsFirstHits(db, 'what am I building', 3);
    expect(mine[0].text).toContain('Renor');
    db.close();
  });

  it('answers identity facts (name, college, passport, who-is card) without dumping unrelated predicates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-id-'));
    tmpDirs.push(dir);
    const db = openDb(path.join(dir, 'i.db'));
    runMigrations(db);
    const ledger = 'System/Memory Events Ledger.md';
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'full_name', object: 'Rowan Vale Holm', source: 'test' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'college_degree', object: 'none', source: 'test' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'passport_italian_received', object: '2026-08-31', source: 'test' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'current_project', object: 'Renor', source: 'test' });
    await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'hackathon_count', object: '24 / 7', source: 'test' });

    const name = factsFirstHits(db, "What is Rowan's full name?", 5);
    expect(name.some(h => h.text.includes('Holm'))).toBe(true);
    expect(name.some(h => h.text.includes('24 / 7'))).toBe(false);

    const college = factsFirstHits(db, 'Does Rowan have a college degree?', 5);
    expect(college[0].text).toContain('college_degree');
    expect(college[0].text).toContain('none');

    const passport = factsFirstHits(db, 'When did Rowan receive the Italian passport?', 5);
    expect(passport[0].text).toContain('2026-08-31');

    const who = factsFirstHits(db, 'Who is Rowan?', 5);
    expect(who.some(h => h.text.includes('Renor'))).toBe(true);
    expect(who.some(h => h.text.includes('Holm'))).toBe(true);
    expect(who.some(h => h.text.includes('24 / 7'))).toBe(false);

    expect(factsFirstHits(db, 'vector index dimension', 3)).toEqual([]);
    db.close();
  });
});
