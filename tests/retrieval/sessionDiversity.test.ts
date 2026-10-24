import { describe, it, expect, afterEach, vi } from 'vitest';
import { retrieveContext, resolveSessionDiversityCap, SESSION_DIVERSITY_DEFAULT_CAP } from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { remember } from '../../src/memory/lifecycle';
import type Database from '../../src/db/sqlite';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

const DB = tmpPath('test-session-diversity.db');
afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  delete process.env.RENOR_SESSION_DIVERSITY;
});

// Fixture: 3 notes; note A carries 4 chunks (crowded), notes B and C one each.
// All chunks are distinct text so dedupeHits never fires; only the diversity
// cap can change the window composition.
async function setupFixture(): Promise<void> {
  const db = openDb(DB);
  runMigrations(db);
  const insertNote = db.prepare(
    "INSERT INTO notes VALUES (?,?,'person',?, '2026-03-30','{}')",
  );
  insertNote.run('/v/a.md', 'A', 'ha');
  insertNote.run('/v/b.md', 'B', 'hb');
  insertNote.run('/v/c.md', 'C', 'hc');
  const insertChunk = db.prepare(
    "INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?, '', ?, ?, ?, ?, ?)",
  );
  // Embedding vectors: all along the same axis so semanticSearch ranks purely
  // by insertion order into the index (deterministic, no score flakiness).
  const dims = 4;
  const idx = new VectorIndex(db, dims);
  idx.initTable();
  const texts = ['alpha one', 'alpha two', 'alpha three', 'alpha four', 'beta one', 'gamma one'];
  const noteFor = ['/v/a.md', '/v/a.md', '/v/a.md', '/v/a.md', '/v/b.md', '/v/c.md'];
  const ids: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    insertChunk.run(noteFor[i], texts[i], i, i + 1, 5, `h${i}`);
    ids.push((db.prepare('SELECT id FROM chunks WHERE chunk_hash = ?').get(`h${i}`) as any).id);
  }
  // a-chunks rank above b and c.
  const vecs: number[][] = [
    [0.9, 0, 0, 0], [0.8, 0, 0, 0], [0.7, 0, 0, 0], [0.6, 0, 0, 0],
    [0.5, 0, 0, 0], [0.4, 0, 0, 0],
  ];
  for (let i = 0; i < ids.length; i++) idx.upsert(ids[i], vecs[i]);
  const provider = { dimensions: dims, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
  (setupFixture as any).provider = provider;
  db.close();
}

describe('resolveSessionDiversityCap', () => {
  it('is 2 when the variable is unset or empty: the default since 2026-10-07', () => {
    delete process.env.RENOR_SESSION_DIVERSITY;
    expect(resolveSessionDiversityCap()).toBe(2);
    expect(resolveSessionDiversityCap({})).toBe(2);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '' })).toBe(2);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '   ' })).toBe(2);
    expect(SESSION_DIVERSITY_DEFAULT_CAP).toBe(2);
  });

  it('an explicit value wins over the default, including the one that restores the window as it was', () => {
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '1' })).toBe(1);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '2' })).toBe(2);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '3.7' })).toBe(3);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: ' 4 ' })).toBe(4);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '0' })).toBe(0);
  });

  it('a value that names no cap is off, never the default', () => {
    for (const value of ['junk', '-1', '0.5', 'Infinity', 'NaN']) {
      expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: value }), `RENOR_SESSION_DIVERSITY=${value}`).toBe(0);
    }
  });

  it('get_context has an uncapped per-read default; explicit values still win as on main', () => {
    expect(resolveSessionDiversityCap({}, 0)).toBe(0);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '' }, 0)).toBe(0);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '   ' }, 0)).toBe(0);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '3' }, 0)).toBe(3);
    expect(resolveSessionDiversityCap({ RENOR_SESSION_DIVERSITY: '0' }, 0)).toBe(0);
  });

  it('reads the process environment when none is given', () => {
    process.env.RENOR_SESSION_DIVERSITY = '3';
    expect(resolveSessionDiversityCap()).toBe(3);
    process.env.RENOR_SESSION_DIVERSITY = '0';
    expect(resolveSessionDiversityCap()).toBe(0);
  });
});

describe('session diversity window (RENOR_SESSION_DIVERSITY)', () => {
  it('default (unset): a crowded note holds at most 2 slots and distinct notes take the rest', async () => {
    delete process.env.RENOR_SESSION_DIVERSITY;
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    const paths = result.hits.map((h) => h.notePath);
    expect(paths.length).toBe(4); // window stays full
    expect(paths.filter((p) => p === '/v/a.md').length).toBe(2); // cap enforced with nothing set
    expect(paths).toContain('/v/b.md');
    expect(paths).toContain('/v/c.md');
    db.close();
  });

  it('unset and an explicit 2 are the same window, hit for hit', async () => {
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    delete process.env.RENOR_SESSION_DIVERSITY;
    const byDefault = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    process.env.RENOR_SESSION_DIVERSITY = '2';
    const explicit = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    expect(byDefault).toEqual(explicit);
    db.close();
  });

  it('0 turns the cap off: the crowded note keeps all its chunks in top-K, as before the default', async () => {
    process.env.RENOR_SESSION_DIVERSITY = '0';
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    const paths = result.hits.map((h) => h.notePath);
    expect(paths.slice(0, 4).filter((p) => p === '/v/a.md').length).toBe(4);
    db.close();
  });

  it('an explicit 3 overrides the default upward: the crowded note holds 3 slots', async () => {
    process.env.RENOR_SESSION_DIVERSITY = '3';
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    const paths = result.hits.map((h) => h.notePath);
    expect(paths.filter((p) => p === '/v/a.md').length).toBe(3);
    expect(paths.length).toBe(4);
    db.close();
  });

  it('cap=2: a crowded note holds at most 2 slots and a distinct note backfills', async () => {
    process.env.RENOR_SESSION_DIVERSITY = '2';
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    const paths = result.hits.map((h) => h.notePath);
    expect(paths.length).toBe(4); // window stays full
    expect(paths.filter((p) => p === '/v/a.md').length).toBe(2); // cap enforced
    expect(paths).toContain('/v/b.md'); // backfilled from rank 5
    expect(paths).toContain('/v/c.md'); // backfilled from rank 6
    db.close();
  });

  it('cap cannot be dodged by backfill: a chunk never exceeds the cap', async () => {
    process.env.RENOR_SESSION_DIVERSITY = '2';
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    const counts: Record<string, number> = {};
    for (const h of result.hits) counts[h.notePath] = (counts[h.notePath] ?? 0) + 1;
    expect(Object.values(counts).every((n) => n <= 2)).toBe(true);
    db.close();
  });

  it('OFF (0) and the default return identical windows when no note repeats (invariant)', async () => {
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    process.env.RENOR_SESSION_DIVERSITY = '0';
    const off = await retrieveContext(db, idx, (setupFixture as any).provider, 'beta', 3);
    delete process.env.RENOR_SESSION_DIVERSITY;
    const on = await retrieveContext(db, idx, (setupFixture as any).provider, 'beta', 3);
    // 'beta' matches only /v/b.md contentfully; a-chunks share the query term
    // 'alpha' so they may co-rank — the invariant is the ON window is a
    // subsequence of the OFF ranking with no note over the cap, not byte-equality.
    const counts: Record<string, number> = {};
    for (const h of on.hits) counts[h.notePath] = (counts[h.notePath] ?? 0) + 1;
    expect(Object.values(counts).every((n) => n <= 2)).toBe(true);
    expect(on.hits.length).toBe(off.hits.length);
    db.close();
  });

  /**
   * CATCHES: the false guarantee this module used to advertise. Its own
   * docstring claimed capped chunks are replaced by "deeper-ranked distinct
   * notes [that] backfill the freed slots, so the window keeps topK entries".
   * That could not hold: every surplus hit belongs to a note already at its cap
   * by construction, so there was nothing to promote and the backfill loop was
   * dead code (measured: it appended 0 items in every configuration). The flag
   * therefore SHRINKS the window on a chunk-concentrated pool — the case it
   * exists for. This test pins the behaviour that is actually implemented, so
   * the comment and the code cannot drift apart again in either direction:
   * claiming a full window, or silently "fixing" it by dropping the cap.
   */
  it('a chunk-concentrated pool SHRINKS the window — the cap is not a backfill guarantee', async () => {
    process.env.RENOR_SESSION_DIVERSITY = '1';
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    // Fixture: /v/a.md holds 4 of the 6 chunks, so cap=1 can keep at most
    // 1 (a) + 1 (b) + 1 (c) = 3 of the 4 requested slots.
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', 4);
    const counts: Record<string, number> = {};
    for (const h of result.hits) counts[h.notePath] = (counts[h.notePath] ?? 0) + 1;
    expect(Object.values(counts).every((n) => n <= 1)).toBe(true); // cap honoured
    expect(result.hits.length).toBeLessThan(4); // and the window is NOT kept full
    db.close();
  });

  /**
   * CATCHES: the configured cap being BYPASSED when the candidate pool is no deeper than the
   * window. `applySessionDiversity` used to early-return on `hits.length <= topK`, so a small or
   * single-note vault never had its cap applied at all — the independent review measured cap=1
   * over ten same-note chunks returning every one of them (`kept=10`), while the flag's headline
   * promises a maximum per note. The pool here is the whole fixture and the window is the whole
   * pool, which is exactly that shape; restoring the early return must fail this test.
   */
  it('cap=1 with a pool no deeper than the window: the cap still holds and the window shrinks', async () => {
    process.env.RENOR_SESSION_DIVERSITY = '1';
    await setupFixture();
    const db = openDb(DB);
    const idx = new VectorIndex(db, 4);
    const topK = 10; // >= the fixture's 6 chunks, so the whole pool is the whole window
    const result = await retrieveContext(db, idx, (setupFixture as any).provider, 'alpha beta gamma', topK);
    const counts: Record<string, number> = {};
    for (const h of result.hits) counts[h.notePath] = (counts[h.notePath] ?? 0) + 1;
    // Authoritative on any pool depth: no note holds two slots.
    expect(Object.values(counts).every((n) => n <= 1)).toBe(true);
    // Honoured by shrinking the window, never by silently ignoring the setting.
    expect(result.hits.length).toBeLessThan(topK);
    db.close();
  });
});

/**
 * WHAT THE CAP COUNTS. The default is for the chunks of one conversation or one document crowding out the others (the
 * held-out answer evidence is chat sessions). Three kinds of hit share a note path without being parts of one thing
 * said: an entry of a daily log (one file per day), an event of the ledger (one file for every fact-mode save) and a
 * fact row (no chunk of a note: every facts-first hit carries the pseudo-path `_mcp_`). Counted by path they were capped
 * too, and twelve tests of how a saved statement is read back failed with the plain flip (see
 * docs/evals/results/SESSION-DIVERSITY-DEFAULT-20261007.md). The query embeds to [1, 0, 0, 0]; each chunk's second
 * component sets its rank, so the crowded note outranks the two single-chunk notes.
 */
describe('what the per-note cap counts', () => {
  const opened: Array<{ db: Database.Database; file: string }> = [];
  afterEach(() => {
    for (const { db, file } of opened.splice(0)) {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
  });

  let dbCount = 0;
  const provider = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
  const NOW = { nowMs: Date.parse('2026-10-03T00:00:00Z') };

  function freshIndex(): { db: Database.Database; idx: VectorIndex } {
    const file = tmpPath(`session-diversity-counts-${process.pid}-${dbCount++}.db`);
    const db = openDb(file);
    runMigrations(db);
    opened.push({ db, file });
    const idx = new VectorIndex(db, 4);
    idx.initTable();
    return { db, idx };
  }

  function addChunk(db: Database.Database, idx: VectorIndex, note: string, text: string, drift: number, headingPath = ''): void {
    db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, null, 'h', '2025-01-01T00:00:00.000Z', '{}')").run(note, note);
    const id = Number(db.prepare(
      'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, 0, 1, ?, ?)',
    ).run(note, headingPath, text, 5, `${note}#${text}`).lastInsertRowid);
    idx.upsert(id, [1, drift, 0, 0]);
  }

  /** `crowded` holds four chunks that outrank one chunk each of two other notes. */
  function vault(crowded: string, texts: string[], headingPath = ''): { db: Database.Database; idx: VectorIndex } {
    const { db, idx } = freshIndex();
    texts.forEach((text, i) => addChunk(db, idx, crowded, text, 0.01 * (i + 1), headingPath));
    addChunk(db, idx, '/v/other/b.md', 'beta one', 0.5);
    addChunk(db, idx, '/v/other/c.md', 'gamma one', 0.6);
    return { db, idx };
  }

  const inCrowded = (hits: Array<{ notePath: string }>, crowded: string) => hits.filter(h => h.notePath === crowded).length;
  const PLAIN = ['alpha one', 'alpha two', 'alpha three', 'alpha four'];

  it('counts the chunks of an ordinary note: 2 of its 4 hold slots by default', async () => {
    const { db, idx } = vault('/v/Sessions/chat.md', PLAIN);
    const { hits } = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(inCrowded(hits, '/v/Sessions/chat.md')).toBe(2);
    expect(hits.map(h => h.notePath)).toEqual(expect.arrayContaining(['/v/other/b.md', '/v/other/c.md']));
  });

  it('does not count the entries of a daily log: all 4 keep their slots, whatever the cap', async () => {
    const daily = '/v/Memory/Daily/2026-03-30.md';
    const { db, idx } = vault(daily, PLAIN);
    const byDefault = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(inCrowded(byDefault.hits, daily)).toBe(4);
    process.env.RENOR_SESSION_DIVERSITY = '1';
    const capOne = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(inCrowded(capOne.hits, daily)).toBe(4);
  });

  it('does not count the events of the ledger: all 4 keep their slots', async () => {
    const ledger = '/v/System/Memory Events Ledger.md';
    const events = [1, 2, 3, 4].map(i => `## MEM_CAP${i} · 2026-03-30T0${i}:00:00.000Z\n- kind: store\n- subject: alpha ${i}\n- predicate: said\n- object: alpha ${i}`);
    const { db, idx } = vault(ledger, events);
    const { hits } = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(inCrowded(hits, ledger)).toBe(4);
  });

  it('does not count an event cut below its header: the id is in its heading path', async () => {
    const ledger = '/v/System/Memory Events Ledger.md';
    const { db, idx } = vault(ledger, PLAIN, 'Memory Events Ledger > MEM_CAPX · 2026-03-30T00:00:00.000Z');
    const { hits } = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(inCrowded(hits, ledger)).toBe(4);
  });

  it('does not count fact rows: three facts of one subject all come back in a window of three', async () => {
    const { db, idx } = freshIndex();
    const dir = tmpPath(`session-diversity-facts-${process.pid}-${dbCount}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const ledger = 'System/Memory Events Ledger.md';
      await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'location', object: 'SOMEWHERE', source: 'test' });
      await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'current_project', object: 'SOMETHING', source: 'test' });
      await remember(db, dir, ledger, { subject: 'Rowan', predicate: 'dog_name', object: 'SOMEDOG', source: 'test' });
      const { hits } = await retrieveContext(db, idx, provider, 'what is my current project, location and dog name?', 3, [], NOW);
      expect(hits.map(h => h.text).sort()).toEqual([
        'Rowan\'s current_project is SOMETHING.', 'Rowan\'s dog_name is SOMEDOG.', 'Rowan\'s location is SOMEWHERE.',
      ]);
      expect(hits.every(h => h.chunkId < 0)).toBe(true); // they are fact rows, not chunks
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a note that only mentions a daily log or an event: the exemption is the file and the header, not a word', async () => {
    const prose = [
      'See Daily/2026-03-30.md for the day this was said. alpha one',
      'The record MEM_CAP1 is in the ledger, as the notes say. alpha two',
      'Memory Events Ledger is the file those are kept in. alpha three',
      'A line that quotes a header, ## MEM_NOT · like so, is not a header: it is not at the start of the line. alpha four',
    ];
    const { db, idx } = vault('/v/Sessions/mentions.md', prose);
    const { hits } = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
    expect(inCrowded(hits, '/v/Sessions/mentions.md')).toBe(2);
  });

  it('counts a file named for a day outside a Daily folder, and a file in a Daily folder that is no day', async () => {
    for (const crowded of ['/v/Sessions/2026-03-30.md', '/v/Memory/Daily/notes.md']) {
      const { db, idx } = vault(crowded, PLAIN);
      const { hits } = await retrieveContext(db, idx, provider, 'q', 4, [], NOW);
      expect(inCrowded(hits, crowded), crowded).toBe(2);
    }
  });
});
