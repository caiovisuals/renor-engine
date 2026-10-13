import { describe, it, expect } from 'vitest';
import {
  composeQueryContext,
  composeQueryContextFromDb,
  estimateTokens,
  structuredContextEnabled,
  ProvenanceError,
  type ComposerInput,
} from '../../src/context/composer';
import { insertStructuredRows, type NewStructuredRow, type StoredStructuredRow } from '../../src/context/rowStore';
import type { RetrievalHit } from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

function hit(notePath: string, text: string, score = 0.5): RetrievalHit {
  return { notePath, chunkId: 1, headingPath: '', text, score, reason: 'semantic' };
}

// The composer's input is typed as stored rows but reads only some of their fields, and these fixtures leave
// id / dedupeKey / validTo / confirmCount undefined, so rows that tie on date and source keep input order. The
// DB-backed tests insert the same fixtures; insertStructuredRows reads only the NewStructuredRow fields.
function row(overrides: Partial<NewStructuredRow> & { sourceChunkId?: number }): StoredStructuredRow {
  return {
    rowKind: 'fact',
    sourcePath: 'notes/a.md',
    sourceChunkId: 1,
    sourceHash: 'h1',
    extractionVersion: 'v1',
    validFrom: '2024-03-01',
    payload: { value: '3:45', object: 'marathon time' },
    ...overrides,
  } as StoredStructuredRow;
}

const DB_PATH = tmpPath('test-composer-rows.db');

function freshDb(): ReturnType<typeof openDb> {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = openDb(DB_PATH);
  runMigrations(db);
  db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES ('notes/a.md', 'A', 'note', 'ha', '2024-03-01', '{}'),
            ('notes/b.md', 'B', 'note', 'hb', '2024-02-01', '{}'),
            ('notes/c.md', 'C', 'note', 'hc', '2024-01-01', '{}')`
  ).run();
  db.prepare(
    `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
     VALUES (1, 'notes/a.md', '', 'a', 1, 1, 1, 'c1'),
            (2, 'notes/b.md', '', 'b', 1, 1, 1, 'c2'),
            (3, 'notes/c.md', '', 'c', 1, 1, 1, 'c3')`
  ).run();
  return db;
}

describe('SCR-C0-DETERMINISM: shared context composer', () => {
  it('is byte-identical for identical inputs (composed twice)', () => {
    const input: ComposerInput = {
      query: 'marathon time training',
      hits: [hit('notes/a.md', 'Ran the marathon in 3:45.', 0.9), hit('notes/b.md', 'Training block notes.', 0.4)],
      rows: [
        row({ payload: { value: '3:45', object: 'marathon time' } }),
        row({ sourcePath: 'notes/b.md', sourceChunkId: 2, rowKind: 'event', validFrom: '2024-02-10', payload: { when: '2024-02-10', event: 'long run 30km' } }),
        row({ sourcePath: 'notes/b.md', sourceChunkId: 2, rowKind: 'preference', validFrom: null, payload: { statement: 'prefers morning runs' } }),
      ],
    };
    const first = composeQueryContext(input);
    const second = composeQueryContext(input);
    expect(first.text).toBe(second.text);
    expect(JSON.stringify(first.sections)).toBe(JSON.stringify(second.sections));
    expect(first.includedSections).toEqual(['excerpts', 'facts', 'chronicle', 'prefs']);
  });

  it('rejects rows without provenance (source_path / source_chunk_id required)', () => {
    expect(() => composeQueryContext({ query: 'q', hits: [hit('notes/a.md', 'text')], rows: [row({ sourcePath: '' } as any)] }))
      .toThrow(ProvenanceError);
    expect(() => composeQueryContext({ query: 'q', hits: [hit('notes/a.md', 'text')], rows: [row({ sourceChunkId: 0 } as any)] }))
      .toThrow(ProvenanceError);
  });

  it('joins rows only through the retrieval hits of the query (gold-blind)', () => {
    const ctx = composeQueryContext({
      query: 'marathon',
      hits: [hit('notes/a.md', 'marathon text')],
      rows: [
        row({ payload: { value: '3:45', object: 'marathon time' } }),
        row({ sourcePath: 'notes/unretrieved.md', sourceChunkId: 9, payload: { value: '99', object: 'marathon time' } }),
      ],
    });
    expect(ctx.sections.find((s) => s.name === 'facts')!.rowCount).toBe(1);
    expect(ctx.text).toContain('notes/a.md');
    expect(ctx.text).not.toContain('notes/unretrieved.md');
  });

  it('drops whole sections in declared reverse order on budget overflow — never in-table truncation', () => {
    const bigText = 'x'.repeat(4000);
    const input = {
      query: 'marathon',
      hits: [hit('notes/a.md', bigText), hit('notes/b.md', 'Training log.', 0.4), hit('notes/c.md', 'Prefs note.', 0.3)],
      evidence: { status: 'ok', items: [{ item: 'shoes bought', date: '2024-01-05' }] },
      rows: [
        row({ payload: { value: '3:45', object: 'marathon time' } }),
        row({ sourcePath: 'notes/b.md', sourceChunkId: 2, rowKind: 'event', validFrom: '2024-02-01', payload: { when: '2024-02-01', event: 'long run' } }),
        row({ sourcePath: 'notes/c.md', sourceChunkId: 3, rowKind: 'preference', validFrom: '2024-01-01', payload: { statement: 'morning runs only' } }),
      ],
    };
    // Pass 1: measure true rendered section sizes with an unbounded budget.
    const measured = composeQueryContext(input, { budgetTokens: 1_000_000 });
    const tokensOf = (name: string) => measured.sections.find((s) => s.name === name)!.tokens;
    // Case A: fits excerpts + evidence + facts → prefs and chronicle drop first.
    const budgetA = tokensOf('excerpts') + tokensOf('facts') + tokensOf('evidence') + 10;
    const ctxA = composeQueryContext(input, { budgetTokens: budgetA });
    expect(ctxA.droppedSections).toEqual(['prefs', 'chronicle']);
    expect(ctxA.includedSections).toEqual(['excerpts', 'evidence', 'facts']);
    // Case B: fits excerpts + evidence only → facts drops BEFORE evidence (declared order).
    const budgetB = tokensOf('excerpts') + tokensOf('evidence') + 10;
    const ctx = composeQueryContext(input, { budgetTokens: budgetB });
    expect(ctx.droppedSections).toEqual(['prefs', 'chronicle', 'facts']);
    expect(ctx.includedSections).toEqual(['excerpts', 'evidence']);
    // The surviving evidence table is complete — no silent row-level truncation.
    expect(ctx.text).toContain('shoes bought');
    expect(ctx.text).not.toContain('## Facts');
    expect(ctx.text).not.toContain('## Preferences');
    expect(ctx.usedTokens).toBeLessThanOrEqual(ctx.budgetTokens);
  });

  it('renders unknown dates without fabricating them and sorts NULL valid_from last', () => {
    const ctx = composeQueryContext({
      query: 'marathon',
      hits: [hit('notes/a.md', 'marathon')],
      rows: [
        row({ validFrom: null, payload: { value: 'undated', object: 'marathon time' } }),
        row({ validFrom: '2024-03-01', payload: { value: 'dated', object: 'marathon time' } }),
      ],
    });
    const factsText = ctx.sections.find((s) => s.name === 'facts')!.text;
    const datedIdx = factsText.indexOf('dated');
    const undatedIdx = factsText.indexOf('undated');
    expect(datedIdx).toBeGreaterThan(-1);
    expect(undatedIdx).toBeGreaterThan(datedIdx);
    expect(factsText).toContain('date unknown');
    expect(factsText).not.toMatch(/date unknown.*\d{4}-\d{2}-\d{2}.*date unknown/);
  });

  it('caps each structured section at the declared row cap with deterministic ordering', () => {
    const rows = Array.from({ length: 45 }, (_, i) =>
      row({ sourceChunkId: 1, validFrom: '2024-01-01', payload: { value: `v${i}`, object: 'marathon' } }));
    const ctx = composeQueryContext({
      query: 'marathon',
      hits: [hit('notes/a.md', 'marathon')],
      rows,
    }, { budgetTokens: 100000 });
    const facts = ctx.sections.find((s) => s.name === 'facts')!;
    expect(facts.rowCount).toBe(40);
  });

  it('trims excerpts by deterministic prefix when excerpts alone exceed the budget', () => {
    const big = 'y'.repeat(2000);
    const ctx = composeQueryContext({
      query: 'q',
      hits: [hit('notes/a.md', big, 0.9), hit('notes/b.md', big, 0.8), hit('notes/c.md', big, 0.1)],
    }, { budgetTokens: estimateTokens(big) * 2 + 300 });
    const excerpts = ctx.sections.find((s) => s.name === 'excerpts')!;
    expect(excerpts.rowCount).toBe(2);
    expect(ctx.text).toContain('notes/a.md');
    expect(ctx.text).not.toContain('notes/c.md');
  });
});

describe('C0 composer default-off flag', () => {
  it('RENOR_STRUCTURED_CONTEXT is off by default', () => {
    expect(structuredContextEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(structuredContextEnabled({ RENOR_STRUCTURED_CONTEXT: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(structuredContextEnabled({ RENOR_STRUCTURED_CONTEXT: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('C0 composer over the product DB (openDb — FK pragma caveat)', () => {
  it('composes only current rows joined to live retrieval hits', () => {
    const db = freshDb();
    try {
      insertStructuredRows(db, [
        row({ payload: { value: '3:45', object: 'marathon time' } }),
        row({ sourcePath: 'notes/c.md', sourceChunkId: 3, rowKind: 'preference', validFrom: null, payload: { statement: 'morning runs only' } }),
      ]);
      const ctx = composeQueryContextFromDb(db, {
        query: 'marathon',
        hits: [hit('notes/a.md', 'marathon')],
      });
      expect(ctx.text).toContain('marathon time: 3:45');
      expect(ctx.text).not.toContain('morning runs only'); // source not among hits
      // Delete cascade: removing the note removes its rows from composition.
      db.prepare('DELETE FROM notes WHERE path = ?').run('notes/a.md');
      const after = composeQueryContextFromDb(db, {
        query: 'marathon',
        hits: [hit('notes/a.md', 'marathon')],
      });
      expect(after.text).not.toContain('3:45');
    } finally { db.close(); fs.rmSync(DB_PATH, { force: true }); }
  });
});