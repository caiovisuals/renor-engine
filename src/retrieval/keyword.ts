import type Database from 'better-sqlite3';
import { prepareOnce } from '../db/statements';
import { byPlace } from './semantic';

/** A chunk full-text search matched, with its BM25 score as `bm25()` gives it (lower is a better match). */
export interface KeywordHit {
  chunkId: number;
  notePath: string;
  headingPath: string;
  text: string;
  score: number;
}

const ROWS = 'SELECT c.id AS chunkId, c.note_path AS notePath, c.heading_path AS headingPath, c.text, f.score AS score';

/**
 * The `limit` chunks that best match an FTS5 `match` expression, best first, and of equal scores by place (byPlace).
 * BM25 ties often (one sentence in several notes, one word once in chunks of one length), and FTS5 gives ties in
 * row-id order, which is the order indexing wrote the notes in: concurrent indexing does not fix it.
 *
 * Ranked and cut inside the full-text query, which reads no chunk row, one row past the page: joining `chunks` before
 * the cut would read the text of every matching chunk (thousands, for a common word) to keep a few. Only when that
 * extra row scores like the last one does the page end inside a tie; then every chunk with that score is read, so the
 * tie is cut by place too.
 */
export function keywordSearch(db: Database.Database, match: string, limit: number): KeywordHit[] {
  if (limit < 1) return [];
  // The page is the `limit` best rows, read with one more ranked row that is not returned: its score (`next`) says whether
  // the page ends inside a tie. The ranking is read once, and the extra row costs no chunk text and no row of its own.
  const paged = prepareOnce(
    db,
    `WITH ranked AS MATERIALIZED (
       SELECT rowid AS rid, bm25(chunks_fts) AS score
       FROM chunks_fts
       WHERE chunks_fts MATCH ?
       ORDER BY score
       LIMIT ?
     )
     SELECT c.id AS chunkId, c.note_path AS notePath, c.heading_path AS headingPath, c.text, r.score AS score,
       (SELECT score FROM ranked ORDER BY score LIMIT 1 OFFSET ?) AS next
     FROM ranked r
     JOIN chunks c ON c.id = r.rid
     ORDER BY r.score
     LIMIT ?`,
  ).all(match, limit + 1, limit, limit) as Array<KeywordHit & { next: number | null }>;
  const page: KeywordHit[] = paged.map(({ chunkId, notePath, headingPath, text, score }) => ({ chunkId, notePath, headingPath, text, score }));
  const edge = page.length === limit && paged[0].next === page[limit - 1].score ? page[limit - 1].score : null;
  const rows = edge === null ? page : [
    ...page.filter(hit => hit.score < edge),
    ...prepareOnce(
      db,
      `${ROWS}
       FROM (
         SELECT rowid, bm25(chunks_fts) AS score
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
       ) f
       JOIN chunks c ON c.id = f.rowid
       WHERE f.score = ?`,
    ).all(match, edge) as KeywordHit[],
  ];
  return rows.sort((a, b) => a.score - b.score || byPlace(a, b)).slice(0, limit);
}
