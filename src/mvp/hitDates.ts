import path from 'path';
import type Database from 'better-sqlite3';
import { createNoteDater, createNoteTimeBound } from '../retrieval/orchestrator';
import { createDailyEntryClock } from '../retrieval/dailyEntryTime';

/**
 * The date of a keyword hit, the one search_memory and get_context give the same excerpt: the moment a daily-log entry
 * was saved, otherwise its note's date (front-matter session_date or date, capped at the file's write time, else that
 * time). search_text found a note or an entry by its words and said nothing of when it was written, so an agent could not
 * tell a note from last week from one a year old. A hit that already has a date (a remembered fact, a ledger event) keeps it,
 * and a hit whose note is not in the index stays undated: unknown is never `now`.
 */
export async function withHitDates<T extends { notePath: string; text: string; session_date?: string }>(
  db: Database.Database,
  memoryDir: string,
  hits: T[],
): Promise<T[]> {
  if (!hits.some(h => h.session_date === undefined && h.notePath !== '')) return hits;
  const noteDate = createNoteDater(db);
  const boundTime = createNoteTimeBound(db);
  const entryTime = createDailyEntryClock();
  return Promise.all(hits.map(async hit => {
    if (hit.session_date !== undefined || hit.notePath === '') return hit;
    const stored = path.resolve(memoryDir, hit.notePath);
    const entryAt = await entryTime({ notePath: stored, text: hit.text });
    const session_date = entryAt === undefined ? noteDate(stored) : boundTime(stored, entryAt);
    return session_date === undefined ? hit : { ...hit, session_date };
  }));
}
