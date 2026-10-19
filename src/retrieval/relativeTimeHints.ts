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

function format(date: Date, slashStyle: boolean): string {
  const ymd = slashStyle ? `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}` : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return slashStyle ? `${ymd} (${DAY_NAMES[date.getUTCDay()]})` : ymd;
}

/** The hints for one excerpt: `"three weeks ago" is 2023/05/07 (Sun)`, in the order the phrases appear, each phrase once. */
export function relativeTimeHints(text: string, sessionDate: string | undefined): string[] {
  const ms = sessionDateMs(sessionDate);
  if (!Number.isFinite(ms) || sessionDate === undefined) return [];
  const slashStyle = /^\d{4}\//.test(sessionDate);
  const base = new Date(Math.floor(ms / DAY_MS) * DAY_MS);
  const found: Array<{ at: number; phrase: string; value: string }> = [];
  for (const m of text.matchAll(AGO)) {
    const raw = m[1].toLowerCase();
    const n = raw in NUMBER_WORDS ? NUMBER_WORDS[raw] : Number(raw);
    const unit = m[2].toLowerCase();
    const date = unit === 'day' ? new Date(base.getTime() - n * DAY_MS)
      : unit === 'week' ? new Date(base.getTime() - 7 * n * DAY_MS)
        : unit === 'month' ? addMonths(base, -n)
          : addMonths(base, -12 * n);
    found.push({ at: m.index ?? 0, phrase: m[0], value: format(date, slashStyle) });
  }
  for (const m of text.matchAll(SIMPLE)) {
    const phrase = m[1].toLowerCase().replace(/\s+/g, ' ');
    let value: string;
    if (phrase === 'today') value = format(base, slashStyle);
    else if (phrase === 'yesterday') value = format(new Date(base.getTime() - DAY_MS), slashStyle);
    else if (phrase === 'last week') value = format(new Date(base.getTime() - 7 * DAY_MS), slashStyle);
    else if (phrase === 'last month') value = format(addMonths(base, -1), slashStyle).slice(0, slashStyle ? 7 : 7);
    else if (phrase === 'last year') value = String(base.getUTCFullYear() - 1);
    else {
      const target = WEEKDAYS.indexOf(phrase.slice(5));
      const back = ((base.getUTCDay() - target + 7) % 7) || 7;
      value = format(new Date(base.getTime() - back * DAY_MS), slashStyle);
    }
    found.push({ at: m.index ?? 0, phrase: m[1].replace(/\s+/g, ' '), value });
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).flatMap(f => {
    const key = f.phrase.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [`"${f.phrase}" is ${f.value}`];
  });
}

/** The excerpt with its hints on one line below it; the text itself is untouched. An excerpt with no hint is returned as it was. */
export function withRelativeTimeHints(text: string, sessionDate: string | undefined): string {
  const hints = relativeTimeHints(text, sessionDate);
  return hints.length === 0 ? text : `${text}\n\n[Counted from this session's date, ${sessionDate}: ${hints.join('; ')}]`;
}
