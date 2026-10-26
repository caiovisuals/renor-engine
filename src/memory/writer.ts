import path from 'path';
import { MAX_STATEMENT_LENGTH } from './limits';
import { isBlankOrInvisible } from './invisibleText';
import { engineDailyHeader, formatEntry, isDailyNotePath } from './dailyNote';
import { cleanSource, headerSource } from './sourceName';
import { assertStorable, secretGuardEnabled } from '../extraction/secretGuard';
import { saveDecisionModel } from '../extraction/jevDecisionModel';
import { refusal } from '../toolRefusal';
import { assertNoUnstorableControls } from './controls';
import { appendConfined } from './confinedWrite';

export interface DailyEntry { text: string; source: string }

/**
 * A note entry is the user's own words, so it is kept whole: nothing is trimmed, stripped or cut. What
 * cannot be kept is refused instead, which makes a save that succeeds a save that stored every
 * character, and a refused save one that wrote nothing.
 */
function checkedNoteText(text: unknown): string {
  if (typeof text !== 'string') throw refusal('invalid_argument', 'the note must be a string');
  if (text.length > MAX_STATEMENT_LENGTH) {
    throw refusal('field_too_long', `the note exceeds the maximum length of ${MAX_STATEMENT_LENGTH} (got ${text.length}); nothing was written`);
  }
  // An unpaired surrogate is not text: UTF-8 cannot hold it, so writing it would store U+FFFD instead.
  if (/\p{Cs}/u.test(text)) {
    throw refusal('invalid_text', 'the note contains an unpaired UTF-16 surrogate, which cannot be stored as text; nothing was written');
  }
  // A control character is not text either, and the filesystem and SQLite both accept one, so a note
  // holding NUL would be written, indexed and served as if it were ordinary words. Refused instead
  // (memory/controls.ts), so a save that succeeds is a save that stored nothing but the words.
  assertNoUnstorableControls('the note', text);
  if (isBlankOrInvisible(text)) throw refusal('invalid_argument', 'the note is blank (only whitespace or invisible characters); nothing was written');
  return text;
}

/**
 * The forms of a source the secret guard judges: the one the header stores (headerSource: letters, digits and hyphens,
 * the other characters written as hyphens) and the same name with every other character deleted, which is how the header
 * stored it before. Spacing a key apart does not stop it being a key: the stored form joins the pieces with hyphens, and
 * the deleted form joins them whole.
 */
function sourceFormsForGuard(source: unknown): string[] {
  if (typeof source !== 'string') return [];
  return [headerSource(source), cleanSource(source).replace(/[^\p{L}\p{N}-]/gu, '')];
}

function isValidCalendarDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

/**
 * In-process mutual exclusion per daily file. Every writer of a daily file (append here, and the
 * memory map's retire/restore, which rewrites one) runs inside this, so a rewrite can never drop
 * an append that landed between its read and its write. One tenant runs one engine process.
 */
const dailyFileLocks = new Map<string, Promise<unknown>>();
export function withDailyFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = dailyFileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  dailyFileLocks.set(key, settled);
  void settled.then(() => {
    if (dailyFileLocks.get(key) === settled) dailyFileLocks.delete(key);
  });
  return run;
}

/** When an entry is saved: its day and time, and the offset from UTC of the clock they are on when that is not UTC. */
export interface EntryClock {
  /** YYYY-MM-DD: the day the entry is filed under. */
  date: string;
  /** HH:MM:SS. */
  time: string;
  /** `-03:00`; absent when the clock is UTC. */
  offset?: string;
}

/** A fixed offset as a client may give it: `-03:00`, `-0300`, or `Z`. */
const FIXED_OFFSET_RE = /^(?:Z|([+-])(\d{2}):?(\d{2}))$/;

const invalidTimeZone = (timeZone: string) => new Error(
  `timezone ${JSON.stringify(timeZone.slice(0, 64))} is not a time zone: give an IANA name such as "America/Sao_Paulo" or a UTC offset such as "-03:00"; nothing was written`,
);

/**
 * The day and time to stamp an entry with, read once from `now`. In UTC unless the client names the user's time zone,
 * an IANA name ("America/Sao_Paulo") or a fixed offset ("-03:00"): the entry is then filed under the user's own day at
 * their own time, so a note said at 21:00 in São Paulo belongs to that evening, not to the next UTC day. A name that is
 * neither is refused rather than read as UTC, so nothing is filed under a day the user did not mean.
 */
export function entryClock(now: Date, timeZone?: string): EntryClock {
  if (timeZone === undefined) {
    const iso = now.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  }
  let minutes: number;
  const fixed = FIXED_OFFSET_RE.exec(timeZone.trim());
  if (fixed) {
    minutes = fixed[1] ? (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3])) : 0;
    if (Number(fixed[3] ?? 0) > 59 || Math.abs(minutes) > 14 * 60) throw invalidTimeZone(timeZone);
  } else {
    let named: string | undefined;
    try {
      named = new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim(), timeZoneName: 'longOffset' })
        .formatToParts(now).find(p => p.type === 'timeZoneName')?.value;
    } catch {
      throw invalidTimeZone(timeZone);
    }
    // `GMT-03:00`, or `GMT` alone at UTC itself.
    const m = named === undefined ? null : /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(named);
    if (!m) throw invalidTimeZone(timeZone);
    minutes = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  }
  const iso = new Date(now.getTime() + minutes * 60_000).toISOString();
  if (minutes === 0) return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  const abs = Math.abs(minutes);
  const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), offset };
}

/**
 * Appends one entry to the daily note of `date`. `clock` stamps it (its time, and its offset when not UTC); without
 * one it is stamped with the current time in UTC. Returns the file's path.
 */
export async function appendDailyMemory(
  vaultPath: string,
  date: string,
  entry: DailyEntry,
  memoryDir = 'Memory/Daily',
  clock?: Pick<EntryClock, 'time' | 'offset'>,
): Promise<string> {
  return (await appendDailyEntry(vaultPath, date, entry, memoryDir, clock)).filePath;
}

/**
 * `appendDailyMemory`, saying what it wrote: the file, and the entry exactly as it went in (without the line break
 * that separates it from the one above), which is what the memory map's id for it is made from.
 */
export async function appendDailyEntry(
  vaultPath: string,
  date: string,
  entry: DailyEntry,
  memoryDir = 'Memory/Daily',
  clock?: Pick<EntryClock, 'time' | 'offset'>,
): Promise<{ filePath: string; entry: string }> {
  if (!isValidCalendarDate(date)) {
    throw new Error('date must be a valid YYYY-MM-DD calendar date');
  }
  // The header must read back as an entry, or the entry would be folded into the one above it.
  if (clock && (!/^\d{2}:\d{2}:\d{2}$/.test(clock.time) || (clock.offset !== undefined && !/^[+-]\d{2}:\d{2}$/.test(clock.offset)))) {
    throw new Error('entry time must be HH:MM:SS, with an offset of the form +HH:MM; nothing was written');
  }
  const text = checkedNoteText(entry.text);

  // RENOR_SECRET_GUARD (default ON): refuse a note that looks like it carries a secret before anything is
  // written, the directory included. The source is scanned as it will be stored, and joined: removing characters
  // can join the pieces of a key that were spaced apart (sourceFormsForGuard).
  if (secretGuardEnabled()) {
    await assertStorable([
      { field: 'note text', text },
      ...sourceFormsForGuard(entry.source).map(form => ({ field: 'note source', text: form, nameOnly: true })),
    ], 'save', saveDecisionModel());
  }

  const dir = path.join(vaultPath, memoryDir);
  const filePath = path.join(dir, `${date}.md`);

  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(dir);
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error('Invalid date: path traversal detected');
  }

  // The source's name, in the alphabet a header keeps: letters, digits and hyphens only (sourceName.ts)
  const sanitizedSource = headerSource(entry.source);

  const time = clock?.time ?? new Date().toISOString().substring(11, 19);
  // The user's words go in as said, except that a later line which would start like an entry is kept behind a
  // backslash so it cannot forge one, and the entry's header then says so (see dailyNote.ts). Both are
  // reversible, and every reader undoes them. A file outside the daily-note layout is written as said.
  const written = formatEntry(time, sanitizedSource, text, isDailyNotePath(filePath), clock?.offset);
  const line = `\n${written}`;

  // Appended in place, or created with its frontmatter, through confinedWrite: a link, a hard link or a FIFO planted in the
  // vault is refused, never followed, and a failed save leaves the note as it was (see appendConfined).
  const relFile = path.relative(path.resolve(vaultPath), resolvedPath);
  await withDailyFileLock(filePath, () => appendConfined(vaultPath, relFile, line, engineDailyHeader(date)));
  return { filePath, entry: written };
}
