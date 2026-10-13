import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'fs';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { tmpPath } from '../helpers/tmpPath';

/**
 * The speaker/metadata stub filter must never empty the retrieval window.
 *
 * Measured defect (2026-09-29). `retrieveContext` ends with
 * `contentful.filter(h => !isSpeakerStub(h.text))`. When a query's whole
 * candidate pool consists of stub chunks, that filter produces an EMPTY hit
 * list, and an empty hit list is a hard abort on the product path: the public
 * CLI returns `hits: []` and the benchmark client refuses to score the case —
 *
 *     Error: Retrieval precondition failed: public CLI search returned zero hits
 *     for this case — every case must retrieve at least one hit before scoring
 *
 * A full-500 arm carrying a variant of this filter died at case 122/500 on
 * exactly that precondition. Emptying the window is strictly worse than
 * surfacing a stub, so the filter falls back to the unfiltered ranking.
 *
 * Note on scope: this pins the FAIL-OPEN FLOOR only. It deliberately does NOT
 * assert that stub chunks should be removed from the delivered window — a
 * paired full-500 measured that removing them costs 28 questions (multi-session
 * −12.0pp, temporal −8.3pp, everything else 0.0pp), because those excerpts
 * carry the reader's session-date anchor. The floor is correct either way.
 */
describe('stub filter must not empty the window', () => {
  const DB = tmpPath('test-stub-floor.db');
  afterEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  /** One note row per distinct path; several chunks may share a path. */
  function seed(rows: Array<{ path: string; text: string }>) {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const vectors: number[][] = [];
    const seenNotes = new Set<string>();
    rows.forEach((row, i) => {
      if (!seenNotes.has(row.path)) {
        db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run(row.path, 'Session', null, `h${i}`, '2026-03-30', '{}');
        seenNotes.add(row.path);
      }
      db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
        .run(row.path, '', row.text, 0, 2, 5, `h${i}`);
      const id = (db.prepare('SELECT id FROM chunks WHERE chunk_hash = ?').get(`h${i}`) as { id: number }).id;
      idx.upsert(id, [1, 0, 0, 0]);
      vectors.push([0.9, 0, 0, 0]);
    });
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue(vectors) };
    return { db, idx, provider };
  }

  it('returns at least one hit when every candidate is a speaker stub', async () => {
    const { db, idx, provider } = seed([
      { path: '/v/Sessions/a.md', text: '**Rowan:**' },
      { path: '/v/Sessions/b.md', text: '東京:' },
      { path: '/v/Sessions/c.md', text: '李雷：' },
    ]);
    const result = await retrieveContext(db, idx, provider, 'anything', 20, []);
    expect(result.hits.length).toBeGreaterThan(0);
    db.close();
  });

  it('still returns hits when the whole pool is a heading-only chunk', async () => {
    const { db, idx, provider } = seed([
      { path: '/v/Sessions/a.md', text: '# Session a' },
    ]);
    const result = await retrieveContext(db, idx, provider, 'anything', 20, []);
    expect(result.hits.length).toBeGreaterThan(0);
    db.close();
  });

  it('filters stubs normally when a content-bearing chunk exists', async () => {
    const { db, idx, provider } = seed([
      { path: '/v/Sessions/a.md', text: '**Rowan:**' },
      { path: '/v/Sessions/real.md', text: 'Rowan moved to Port Alder in 2026.' },
    ]);
    const result = await retrieveContext(db, idx, provider, 'anything', 20, []);
    expect(result.hits.some(h => h.text.includes('Port Alder'))).toBe(true);
    expect(result.hits.every(h => h.text.trim() !== '**Rowan:**')).toBe(true);
    db.close();
  });
});
