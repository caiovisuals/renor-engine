import { withRelativeTimeHints } from './relativeTimeHints';
import type Database from 'better-sqlite3';
import { isTurnLabel } from './conversationShape';
import type { HitOrder } from './orchestrator';

/**
 * How a search reply is laid out for the model that reads it. Retrieval picks the window and orders it; this only
 * changes how what it picked is handed over, and it never adds, drops or rewrites a word of a stored excerpt:
 *
 *  - one hit per session: the chunks of a note on one date, which the newest-first layout left apart (a session's header,
 *    which carries its date, could come after the turns it dates, and turns of other sessions in between), come as one hit,
 *    in the note's own order, so every turn sits under the date of its session;
 *  - a session that reaches the reader without its header (the date line is its first chunk) opens with
 *    `[Session date: <date>]`;
 *  - each time phrase that names one point in time ("three weeks ago", "last Thursday") is resolved to its date below
 *    the excerpt (relativeTimeHints.ts).
 *
 * Only notes shaped like a conversation (conversationShape.ts) are laid out: a session is one conversation, and merging
 * the chunks of a document or the entries of a daily note would break "a hit is one memory".
 *
 * Measured on LongMemEval-S dev100 with `gemma4:31b` as reader and judge: see docs/evals/results/READER-LAYOUT-20261014.md.
 * Not applied to get_context (its budget cuts whole items by relevance) or to any hit that is no chunk of an ordinary
 * note: a remembered fact, a ledger event, a correction, the evidence or digest table. Kill switch: RENOR_READER_LAYOUT=0.
 */

export function readerLayoutEnabled(): boolean {
  const v = (process.env.RENOR_READER_LAYOUT ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * A note of turns: at least `LAYOUT_MIN_TURNS` of its distinct heading paths end in a speaker or turn label (conversationShape.ts
 * isTurnLabel) and those are at least half of its paths. One exchange, a question and its answer, is a conversation here: the
 * session expansion's own rule asks for four turns because it cuts statements, and this one only joins what a session already is.
 */
export const LAYOUT_MIN_TURNS = 2;
export function isConversation(headingPaths: readonly string[]): boolean {
  const distinct = new Set(headingPaths);
  let turns = 0;
  for (const headingPath of distinct) if (isTurnLabel(headingPath.split(' > ').pop() ?? '')) turns += 1;
  return turns >= LAYOUT_MIN_TURNS && turns * 2 >= distinct.size;
}

/** Is this stored note path a conversation? Told from the headings of its chunks, once per note. */
export function conversationNoteMatcher(db: Database.Database): (storedNotePath: string) => boolean {
  const select = db.prepare('SELECT heading_path AS headingPath FROM chunks WHERE note_path = ?');
  const known = new Map<string, boolean>();
  return storedNotePath => {
    let shaped = known.get(storedNotePath);
    if (shaped === undefined) {
      shaped = isConversation((select.all(storedNotePath) as Array<{ headingPath: string }>).map(row => row.headingPath));
      known.set(storedNotePath, shaped);
    }
    return shaped;
  };
}

export interface LayoutHit {
  notePath: string;
  /** The chunk's id; it grows with the chunk's place in its note. Absent, zero or negative: the hit is no chunk of a note. */
  chunkId?: number;
  text: string;
  score: number;
  reason: string;
  session_date?: string;
  similarity?: number;
}

function isNoteChunk(hit: LayoutHit & { author?: unknown; replaced?: unknown }, isLedger: (notePath: string) => boolean): boolean {
  return (hit.chunkId ?? 0) > 0 && hit.notePath !== '' && !isLedger(hit.notePath) && hit.author === undefined && hit.replaced === undefined;
}

export function layoutHitsForReader<T extends LayoutHit>(hits: T[], opts: { rankedBy: HitOrder | undefined; isLedger: (notePath: string) => boolean; isConversation?: (notePath: string) => boolean }): T[] {
  const chunk = (hit: T): boolean => isNoteChunk(hit, opts.isLedger) && (opts.isConversation?.(hit.notePath) ?? true);
  let laid = hits.map(hit => (chunk(hit) ? { ...hit, text: withRelativeTimeHints(hit.text, hit.session_date) } : hit));
  if (opts.rankedBy === 'session_date') laid = mergeRuns(groupByNote(laid, chunk), chunk);
  return laid.map(hit => (chunk(hit) && hit.session_date && !hit.text.includes('Timestamp:')
    ? { ...hit, text: `[Session date: ${hit.session_date}]\n${hit.text}` }
    : hit));
}

/** The hits of a note on one date stand where the first of them stood, in the note's own order. Other hits stay where they were. */
function groupByNote<T extends LayoutHit>(hits: T[], chunk: (hit: T) => boolean): T[] {
  const keyOf = (hit: T): string | null => (chunk(hit) ? `${hit.notePath}\0${hit.session_date ?? ''}` : null);
  const groups = new Map<string, T[]>();
  for (const hit of hits) {
    const key = keyOf(hit);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  const placed = new Set<string>();
  const out: T[] = [];
  for (const hit of hits) {
    const key = keyOf(hit);
    if (key === null) { out.push(hit); continue; }
    if (placed.has(key)) continue;
    placed.add(key);
    out.push(...groups.get(key)!.sort((a, b) => (a.chunkId ?? 0) - (b.chunkId ?? 0)));
  }
  return out;
}

/** Neighbouring hits of one note and date become one: the texts in order, the score and reason of the best match. */
function mergeRuns<T extends LayoutHit>(hits: T[], chunk: (hit: T) => boolean): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < hits.length) {
    const first = hits[i];
    let j = i + 1;
    if (chunk(first)) while (j < hits.length && chunk(hits[j]) && hits[j].notePath === first.notePath && hits[j].session_date === first.session_date) j++;
    const run = hits.slice(i, j);
    if (run.length === 1) out.push(first);
    else {
      const best = run.reduce((a, b) => (b.score > a.score ? b : a));
      const similarities = run.flatMap(h => (typeof h.similarity === 'number' ? [h.similarity] : []));
      out.push({
        ...first,
        text: run.map(h => h.text).join('\n\n'),
        score: best.score,
        reason: best.reason,
        ...(similarities.length > 0 ? { similarity: Math.max(...similarities) } : {}),
      });
    }
    i = j;
  }
  return out;
}

/**
 * The page search_memory shows, laid out for its reader when RENOR_READER_LAYOUT is on (the chunk ids the layout needed
 * leave with it); otherwise the page as it was.
 */
export function readerLayoutOf<T extends object>(rankedBy: HitOrder | undefined, hits: T[], isLedger: (notePath: string) => boolean): T[] {
  if (!readerLayoutEnabled()) return hits;
  return layoutHitsForReader(hits as Array<T & LayoutHit>, { rankedBy, isLedger }).map(hit => {
    const { chunkId: _chunkId, ...rest } = hit as T & { chunkId?: number };
    return rest as unknown as T;
  });
}
