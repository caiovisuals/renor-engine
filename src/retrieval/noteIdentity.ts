/**
 * Note-identity recall for exact terms that chunk full-text search cannot match.
 *
 * `chunks_fts` indexes chunk text and heading path; `note_path` is UNINDEXED and
 * `parseNote` drops YAML frontmatter from the indexed body. So an identifier that
 * *names* a note — a task id, a slug, a file name, a frontmatter `id` — was invisible
 * to a keyword search even though the note is right there in the index.
 *
 * Migration 13 indexes those names in `note_identity_fts`, one row per note, with
 * `-_.%` as token characters so an identifier is one whole token. This module asks
 * that index for notes the term names. Callers keep their normal full-text page
 * untouched and add these notes beside it, so no prose hit is ever lost or reordered.
 *
 * Only terms shaped like an identifier (a `-`, `_` or `.` between word characters)
 * are asked: `md`, `notes` or `OR` are words, not names, and would match every note.
 */

import type Database from 'better-sqlite3';
import { prepareOnce } from '../db/statements';

export interface NoteIdentityHit {
  chunkId: number;
  notePath: string;
  headingPath: string;
  text: string;
  score: number;
  reason: 'note-identity';
}

/** The first chunk of a named note, before it becomes a hit. */
export type NoteIdentityOpening = Omit<NoteIdentityHit, 'score' | 'reason'>;

/** Most named notes added beside a full prose page — the page itself is never shortened. */
export const NOTE_IDENTITY_EXTRA = 5;

/** `deploy-unit-required.test.sh`, `MVP_MCP_JSON`, `literally-100%` — not `md`, `.md`, `notes`. */
function looksLikeIdentifier(term: string): boolean {
  return /^\w[\w.%-]*[\w%]$/.test(term) && /[-_.]/.test(term);
}

/**
 * The opening chunk of every note named by `term`, ordered by path so the result is
 * deterministic. `exclude` lists note paths the caller already returns; `accept`
 * judges a candidate by its opening chunk (e.g. by scope: a ledger opens with an event, and
 * the ledger's path says nothing about that event's scope) *before* the limit applies.
 */
export function selectNoteIdentityHits(
  db: Database.Database,
  term: string,
  limit: number,
  exclude: ReadonlySet<string> = new Set(),
  accept: (notePath: string, opening: NoteIdentityOpening) => boolean = () => true
): NoteIdentityHit[] {
  const q = (term ?? '').trim();
  const max = Math.max(1, Math.floor(limit) || 1);
  if (!looksLikeIdentifier(q)) return [];
  const named = prepareOnce(
    db,
    `SELECT n.path FROM note_identity_fts f JOIN notes n ON n.rowid = f.rowid
     WHERE note_identity_fts MATCH ? ORDER BY n.path`
  ).all(`"${q.replace(/"/g, '""')}"`) as { path: string }[];
  const first = prepareOnce(
    db,
    `SELECT id AS chunkId, note_path AS notePath, heading_path AS headingPath, text
     FROM chunks WHERE note_path = ? ORDER BY start_line, id LIMIT 1`
  );
  const rows: NoteIdentityOpening[] = [];
  for (const { path: notePath } of named) {
    if (rows.length === max) break;
    if (exclude.has(notePath)) continue;
    const opening = first.get(notePath) as NoteIdentityOpening | undefined;
    if (opening && accept(notePath, opening)) rows.push(opening);
  }

  // bm25() does not apply to a name match. Consumers read `score` as "higher is
  // better", so hand back a descending ordinal rather than a fake BM25 value: the
  // ordering is real (path order), the magnitude is not.
  return rows.map((r, i) => ({ ...r, score: rows.length - i, reason: 'note-identity' as const }));
}
