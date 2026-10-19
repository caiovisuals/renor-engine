import { sessionDateMs } from './orchestrator';

/**
 * Says, below an excerpt, which calendar date each relative time phrase in it points to, counted from the excerpt's own
 * session date: "three weeks ago" in a session of 2023/05/28 is 2023/05/07. A reader that has to do that arithmetic,
 * then the arithmetic of the question on top, often answers "I don't know" with both dates in front of it; the hint
 * does the first step and leaves the stored text, and the question's own arithmetic, alone.
 *
 * English only, and only phrases that name one point in time (a count of days, weeks, months or years ago; yesterday,
 * today; last <weekday>, week, month or year). Nothing is guessed: a phrase this does not match gets no hint, and a hit
 * without a parseable date gets none.
 */

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86_400_000;

const AGO = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')}|\\d{1,3})\\s+(day|week|month|year)s?\\s+ago\\b`, 'gi');
const SIMPLE = /\b(yesterday|today|last\s+(?:week|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/gi;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** A day as the hit's own date style writes it: `2023/05/07 (Sun)` for the benchmark's slash dates, `2023-05-07` otherwise. */
export function formatDay(date: Date, slashStyle: boolean): string {
  const ymd = slashStyle ? `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}` : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return slashStyle ? `${ymd} (${DAY_NAMES[date.getUTCDay()]})` : ymd;
}

/** One time phrase of an excerpt, placed on the calendar. */
export interface RelativeTimePoint {
  /** Where the phrase starts in the text. */
  at: number;
  /** The phrase as written; the simple ones (yesterday, last week) with their spaces collapsed. */
  phrase: string;
  /** The day it names, counted from the session date; the first day of the month or year when only that is named. */
  date: Date;
  /** The same date as the hint prints it: a day, or only `2023/04` for "last month" and `2022` for "last year". */
  value: string;
  /** How much of `date` the phrase names. */
  grain: 'day' | 'month' | 'year';
}

/** The phrases of one excerpt that name a point in time, in the order they appear, each phrase once. */
export function relativeTimePoints(text: string, sessionDate: string | undefined): RelativeTimePoint[] {
  const ms = sessionDateMs(sessionDate);
  if (!Number.isFinite(ms) || sessionDate === undefined) return [];
  const slashStyle = /^\d{4}\//.test(sessionDate);
  const base = new Date(Math.floor(ms / DAY_MS) * DAY_MS);
  const found: RelativeTimePoint[] = [];
  for (const m of text.matchAll(AGO)) {
    const raw = m[1].toLowerCase();
    const n = raw in NUMBER_WORDS ? NUMBER_WORDS[raw] : Number(raw);
    const unit = m[2].toLowerCase();
    const date = unit === 'day' ? new Date(base.getTime() - n * DAY_MS)
      : unit === 'week' ? new Date(base.getTime() - 7 * n * DAY_MS)
        : unit === 'month' ? addMonths(base, -n)
          : addMonths(base, -12 * n);
    found.push({ at: m.index ?? 0, phrase: m[0], date, value: formatDay(date, slashStyle), grain: 'day' });
  }
  for (const m of text.matchAll(SIMPLE)) {
    const phrase = m[1].toLowerCase().replace(/\s+/g, ' ');
    let date: Date;
    let value: string;
    let grain: RelativeTimePoint['grain'] = 'day';
    if (phrase === 'today') { date = base; value = formatDay(date, slashStyle); }
    else if (phrase === 'yesterday') { date = new Date(base.getTime() - DAY_MS); value = formatDay(date, slashStyle); }
    else if (phrase === 'last week') { date = new Date(base.getTime() - 7 * DAY_MS); value = formatDay(date, slashStyle); }
    else if (phrase === 'last month') { date = addMonths(base, -1); value = formatDay(date, slashStyle).slice(0, 7); grain = 'month'; }
    else if (phrase === 'last year') { date = new Date(Date.UTC(base.getUTCFullYear() - 1, 0, 1)); value = String(base.getUTCFullYear() - 1); grain = 'year'; }
    else {
      const target = WEEKDAYS.indexOf(phrase.slice(5));
      const back = ((base.getUTCDay() - target + 7) % 7) || 7;
      date = new Date(base.getTime() - back * DAY_MS);
      value = formatDay(date, slashStyle);
    }
    found.push({ at: m.index ?? 0, phrase: m[1].replace(/\s+/g, ' '), date, value, grain });
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).flatMap(f => {
    const key = f.phrase.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [f];
  });
}

/** The hints for one excerpt: `"three weeks ago" is 2023/05/07 (Sun)`, in the order the phrases appear, each phrase once. */
export function relativeTimeHints(text: string, sessionDate: string | undefined): string[] {
  return relativeTimePoints(text, sessionDate).map(point => `"${point.phrase}" is ${point.value}`);
}

/** The excerpt with its hints on one line below it; the text itself is untouched. An excerpt with no hint is returned as it was. */
export function withRelativeTimeHints(text: string, sessionDate: string | undefined): string {
  const hints = relativeTimeHints(text, sessionDate);
  return hints.length === 0 ? text : `${text}\n\n[Counted from this session's date, ${sessionDate}: ${hints.join('; ')}]`;
}
