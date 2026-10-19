import { isTurnLabel } from './conversationShape';
import { sessionDateMs } from './orchestrator';

/**
 * The duration line: for a question that asks how many days, weeks or months lie between two events, one line above the
 * excerpts that quotes the date the user wrote for each event and counts the days between them. A reader that has both
 * dates in front of it still often answers "I don't know" or miscounts; this does that one step and leaves the excerpts,
 * and every other kind of question, alone.
 *
 * What it will not do, on purpose:
 *  - It never subtracts session headers. A header is when a conversation took place, not when its events did, and a
 *    benchmark may date every session on the question's own day. Only a date the user wrote in a turn counts: "on
 *    January 10th", "on 2/15", "on the 22nd of April", "since 3/27", behind "on" or "since", the two words that date the
 *    event itself ("before", "by", "until" give a bound, "from" opens a range). "The March 15th issue" is a title, not a
 *    date, and gets no line. A relative phrase ("yesterday", "three weeks ago") is not a written date either;
 *    relativeTimeHints.ts resolves those below their excerpt and nothing here counts them.
 *  - It guesses nothing. Each of the two events in the question must find one dated statement of its own among the user
 *    turns of the page, clearly better than any other dated statement. A statement is a sentence with exactly one written
 *    date of any kind, and only the clause that holds the date speaks for it ("I went to the festival, and I joined the
 *    workshop on February 25th" dates the workshop). A sentence with a second date or a range ("from May 2nd to May 9th")
 *    is not used. An event named by one short word, two events that find the same statement, and a tie between two
 *    different dates give no line, and then the page is exactly what it was. The session date completes a date written
 *    without its year (the year nearest to the session) and is never subtracted from anything.
 *  - It reads the user, not the assistant. A chunk's speaker is known only from a turn heading in that same chunk: the
 *    continuation of a long turn, which has no heading, is not read.
 *  - It touches no other question. "Which came first", "what is the order of", a count of things, a frequency, a single
 *    "how many days ago" and a question whose two events it cannot name stay byte-identical.
 *
 * Default on (`RENOR_READER_DURATION=0` switches it off), and only on top of the reader layout.
 */

/** Default on. `0` / `false` / `no` / `off` removes the duration line from a layout-on page. */
export function readerDurationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_READER_DURATION ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * Is the switch set to an on value, written out (`1` / `true` / `yes` / `on`)? Only then does the search_memory tool description
 * name the line: with the switch unset the line still leads the page and says what it is in its own first words, but the
 * published description (kept under 1,200 characters, and equal to the gateway's server card) stays as it was.
 */
export function readerDurationNamed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_READER_DURATION ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export type SpanUnit = 'day' | 'week' | 'month' | 'year';

/** A question is one line of a few hundred characters; a longer one is a pasted text and is left alone. */
const MAX_QUESTION_CHARS = 1_000;

/** The question itself: the last line of the query, since a caller may put "Question date: ..." above it. */
function questionLine(query: string): string {
  const lines = query.split('\n').map(line => line.trim()).filter(line => line !== '');
  const last = lines[lines.length - 1] ?? '';
  return last.length > MAX_QUESTION_CHARS ? '' : last;
}

// "How many days a week" and "how many days per month" ask for a rate, not for the time between two events.
const UNIT_COUNT = /\bhow\s+(?:many|much)\s+(day|week|month|year)s?\b(?!\s+(?:a|an|per|each|every)\s+(?:day|week|month|year)\b)/i;
// "How long is my commute" asks for a length, not for the time between two events.
const HOW_LONG = /\bhow\s+long\s+(?:ago|have|has|had|did|does|do|since|until|passed|before|after)\b|\bhow\s+much\s+time\s+(?:passed|had|have|has|elapsed|between)\b/i;

/**
 * Is this a duration question, and in which unit? `{ unit: null }` is a "how long" or "how much time" question that names
 * no unit. Null for anything else: an order, a count of things, a frequency, a clock time, a length.
 */
export function durationQuestion(query: string): { unit: SpanUnit | null } | null {
  const question = questionLine(query);
  const counted = UNIT_COUNT.exec(question);
  if (counted) return { unit: counted[1].toLowerCase() as SpanUnit };
  return HOW_LONG.test(question) ? { unit: null } : null;
}

const AND_THE_DAY = /\s+and\s+(?:the\s+(?:day|time|moment|date)\b|when\b)/i;
const AND_NEXT_EVENT = /\s+and\s+(?=(?:the|my|our|i|we|a|an|when)\b|['"‘“])/i;

/** The two events of a question that names two, in the order the question names them; null when it names fewer. */
export function questionEvents(query: string): [string, string] | null {
  const question = questionLine(query).replace(/\s*\?+\s*$/, '');
  const pair = (a: string | undefined, b: string | undefined): [string, string] | null => {
    const first = a?.trim() ?? '';
    const second = b?.trim() ?? '';
    return first !== '' && second !== '' ? [first, second] : null;
  };
  const between = /\bbetween\s+(.+)$/i.exec(question);
  if (between) {
    const body = between[1];
    const split = AND_THE_DAY.exec(body) ?? AND_NEXT_EVENT.exec(body);
    return split ? pair(body.slice(0, split.index), body.slice(split.index + split[0].length)) : null;
  }
  const sinceWhen = /\bsince\s+(.+?)\s+when\s+(.+)$/i.exec(question);
  if (sinceWhen) return pair(sinceWhen[1], sinceWhen[2]);
  const agoWhen = /\bago\s+(?:did|do)\s+(.+?)\s+when\s+(.+)$/i.exec(question);
  if (agoWhen) return pair(agoWhen[1], agoWhen[2]);
  const beforeAfter = /\b(?:before|after)\s+(.+?)\s+(?:did|do|does)\s+(.+)$/i.exec(question);
  if (beforeAfter) return pair(beforeAfter[1], beforeAfter[2]);
  const beenWhen = /\b(?:been|being)\s+(.+?)\s+(?:when|before|until)\s+(.+)$/i.exec(question);
  if (beenWhen) return pair(beenWhen[1], beenWhen[2]);
  const takeAfter = /\btake\s+(?:me\s+|for\s+me\s+)?to\s+(.+?)\s+after\s+(.+)$/i.exec(question);
  if (takeAfter) return pair(takeAfter[1], takeAfter[2]);
  return null;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'that', 'this', 'these', 'those', 'than', 'then', 'them',
  'they', 'their', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'whom', 'how', 'did', 'does', 'was', 'were',
  'been', 'being', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'not', 'but',
  'you', 'your', 'our', 'his', 'her', 'its', 'she', 'him', 'also', 'just', 'very', 'really', 'about', 'after', 'before',
  'again', 'some', 'any', 'one', 'out', 'got', 'get', 'day', 'days', 'time', 'week', 'weeks', 'month', 'months',
  'year', 'years', 'event', 'events', 'ago', 'passed', 'between', 'since', 'until', 'take', 'took', 'decide', 'decided',
]);

/** A crude stem, enough to make "started" and "starting", "loved" and "love", "planted" and "plant" the same word. */
function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** The words of a text that tell one thing from another. A number is one whatever its length: the iPhone 13 is not the iPhone 12. */
function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? []) {
    const bare = word.replace(/^['’-]+|['’-]+$/g, '');
    if (STOP.has(bare) || (bare.length < 3 && !/^\d+$/.test(bare))) continue;
    out.add(stem(bare));
  }
  return out;
}

/** How many of an event's words a statement must hold: all of a short event, about 60% of a long one, never fewer than two when it has two. */
function neededOverlap(words: number): number {
  return Math.min(words, Math.max(2, Math.ceil(words * 0.6)));
}

/** An event named by one short word ("the move", "my order") matches any sentence that says the word: it needs a longer one ("my anniversary"). */
const MIN_LONE_WORD = 6;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH = `(${MONTH_NAMES})\\.?`;
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
// "January 10th", "Jan. 5, 2023" | "the 22nd of April", "22 April 2023" | "3/27", "2/15/23" | "2023-03-05", "2023/03/05"
const WRITTEN_DATE = new RegExp(
  [
    `\\b${MONTH}\\s+${DAY}\\b(?:,?\\s+(\\d{4})\\b)?`,
    `\\b(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH}(?![a-z])(?:,?\\s+(\\d{4})\\b)?`,
    '\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\d/])',
    '\\b(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})\\b',
  ].join('|'),
  'gi',
);
// The two words that date the event itself: "attended it on January 10th", "every Friday since 3/27".
const CUE = /\b(?:on|since)\s+(?:the\s+)?(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+)?$/i;
// A date that opens a range ("May 2nd to May 9th", "May 2-9", "3/27 - 3/30") is not the day of one event.
const RANGE_AFTER = new RegExp(`^\\s*(?:[-–—]\\s*|(?:to|through|thru|until|till)\\s+)(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)?\\b|(?:${MONTH_NAMES})\\.?\\s+\\d)`, 'i');
// Month and weekday abbreviations end in a full stop that ends no sentence; so do titles and initials ("I." is a word, not an initial).
const ABBREVIATION = /(?:\b(?:St|Mr|Mrs|Ms|Dr|Jr|Sr|vs|etc|Inc|Ltd|Co|No|Mt|Ft|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)|\b[A-HJ-Z])\.$/;
// Where one clause of a sentence ends and the next begins: what comes before it is about another event.
const CLAUSE_BREAK = /[;—–]|,?\s+(?:and then|and|but|so|then|while|because|although|though|whereas|which)\s+/gi;

interface Day {
  year: number;
  month: number;
  day: number;
}

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A date further than this from the session it was written in has no year the session can tell: half a year away it is as
 * near to one year as to the other, and 29 February may have one candidate only.
 */
const YEAR_REACH_DAYS = 130;

/** The year of a date written without one: the year that puts it nearest to the session it was written in (the earlier on a tie); null when that is further than YEAR_REACH_DAYS. */
function nearestYear(month: number, day: number, sessionMs: number): number | null {
  if (!Number.isFinite(sessionMs)) return null;
  const sessionYear = new Date(sessionMs).getUTCFullYear();
  let best: { year: number; gap: number } | null = null;
  for (const year of [sessionYear - 1, sessionYear, sessionYear + 1]) {
    if (!validDay(year, month, day)) continue;
    const gap = Math.abs(Date.UTC(year, month - 1, day) - sessionMs);
    if (best === null || gap < best.gap) best = { year, gap };
  }
  return best !== null && best.gap <= YEAR_REACH_DAYS * 86_400_000 ? best.year : null;
}

/** A year written with two digits: the century that puts it nearest to the session ("99" in 2023 is 1999), 2000 + n without one. */
function twoDigitYear(raw: string, sessionMs: number): number {
  const n = Number(raw);
  if (raw.length !== 2) return n;
  if (!Number.isFinite(sessionMs)) return 2000 + n;
  const sessionYear = new Date(sessionMs).getUTCFullYear();
  return Math.abs(1900 + n - sessionYear) < Math.abs(2000 + n - sessionYear) ? 1900 + n : 2000 + n;
}

interface WrittenDate {
  at: number;
  end: number;
  /** Null when the year is not written and the session carries no date to complete it from. */
  day: Day | null;
}

/** Every written date of a sentence, of any kind; `usable` are those that date their event (a cue before, no range after). */
function writtenDates(sentence: string, sessionMs: number): { count: number; usable: WrittenDate[] } {
  const usable: WrittenDate[] = [];
  let count = 0;
  for (const m of sentence.matchAll(WRITTEN_DATE)) {
    count += 1;
    let month: number;
    let day: number;
    let year: number | null;
    if (m[1] !== undefined) {
      month = MONTHS[m[1].toLowerCase()];
      day = Number(m[2]);
      year = m[3] === undefined ? null : Number(m[3]);
    } else if (m[5] !== undefined) {
      day = Number(m[4]);
      month = MONTHS[m[5].toLowerCase()];
      year = m[6] === undefined ? null : Number(m[6]);
    } else if (m[7] !== undefined) {
      month = Number(m[7]);
      day = Number(m[8]);
      year = m[9] === undefined ? null : twoDigitYear(m[9], sessionMs);
    } else {
      year = Number(m[10]);
      month = Number(m[11]);
      day = Number(m[12]);
    }
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (!CUE.test(sentence.slice(Math.max(0, at - 30), at))) continue;
    if (RANGE_AFTER.test(sentence.slice(end, end + 24))) continue;
    const resolvedYear = year ?? nearestYear(month, day, sessionMs);
    usable.push({ at, end, day: resolvedYear !== null && validDay(resolvedYear, month, day) ? { year: resolvedYear, month, day } : null });
  }
  return { count, usable };
}

function splitSentences(body: string): string[] {
  const pieces = body.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'‘(\[])/);
  const out: string[] = [];
  for (const piece of pieces) {
    if (out.length > 0 && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** The words of the sentence that belong to the date: from the last clause break before it. */
function clauseBefore(sentence: string, at: number): string {
  const head = sentence.slice(0, at);
  let from = 0;
  for (const m of head.matchAll(CLAUSE_BREAK)) from = (m.index ?? 0) + m[0].length;
  return head.slice(from);
}

/**
 * The user's own turns of one hit, one string per turn, without the lines the layout adds. Assistant turns are not read,
 * and neither is text whose speaker this hit does not name: the continuation of a long turn comes as a chunk with no
 * heading, and joined to a chunk of the other speaker it would be read as that speaker's.
 */
function userTurnBodies(text: string): string[] {
  const bodies: string[] = [];
  let speaker: 'user' | 'other' | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (speaker === 'user' && body !== '') bodies.push(body);
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      flush();
      if (isTurnLabel(heading[1].trim())) {
        const words = heading[1].toLowerCase().replace(/[\p{N}\p{P}\p{S}\p{Z}]+/gu, ' ').trim().split(' ');
        speaker = words.includes('user') || words.includes('human') ? 'user' : 'other';
      } else speaker = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('[Counted from this session\'s date') || trimmed.startsWith('[Session date:')) continue;
    buffer.push(line);
  }
  flush();
  return bodies;
}

/** The session date a hit carries, or the one its own text opens with (`Timestamp:` or `[Session date: ...]`). */
function hitSessionMs(hit: SpanHit): number {
  const stated = sessionDateMs(hit.session_date);
  if (Number.isFinite(stated)) return stated;
  const inText = /(?:Timestamp:|\[Session date:)\s*([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}(?: \([A-Za-z]{3}\))?(?: [0-9]{2}:[0-9]{2})?)/.exec(hit.text);
  return inText ? sessionDateMs(inText[1].replace(/-/g, '/')) : Number.NEGATIVE_INFINITY;
}

interface Statement {
  day: Day;
  /** The words of the date's clause before the date: what the date is a date of. */
  before: Set<string>;
  quote: string;
  /** Where it stands, so two events cannot both take one statement. */
  key: string;
}

function dayNumber(day: Day): number {
  return Math.round(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

function iso(day: Day): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}`;
}

function quoteAround(sentence: string, at: number, end: number): string {
  const max = 220;
  if (sentence.length <= max) return sentence;
  const start = Math.max(0, at - 150);
  const stop = Math.min(sentence.length, Math.max(end + 40, start + max));
  const cutStart = start === 0 ? 0 : sentence.indexOf(' ', start) + 1 || start;
  const lastSpace = stop >= sentence.length ? -1 : sentence.lastIndexOf(' ', stop);
  const cutStop = stop >= sentence.length ? sentence.length : lastSpace > end ? lastSpace : stop;
  return `${cutStart > 0 ? '…' : ''}${sentence.slice(cutStart, cutStop).trim()}${cutStop < sentence.length ? '…' : ''}`;
}

/**
 * Every dated statement in the user turns of the page: a sentence with exactly one written date, and the words of its
 * clause before the date. A sentence with a second date, cued or not, is left out. "I applied to the program on February
 * 10th and got accepted on March 20th" shares its words between two dates, and which words belong to which date would be
 * a guess.
 */
function datedStatements(hits: readonly SpanHit[]): Statement[] {
  const out: Statement[] = [];
  const seen = new Set<string>();
  hits.forEach((hit, hitIndex) => {
    if (hit.notePath === '' && hit.reason === 'span') return;
    const sessionMs = hitSessionMs(hit);
    userTurnBodies(hit.text).forEach((body, turnIndex) => {
      splitSentences(body).forEach((sentence, sentenceIndex) => {
        const { count, usable } = writtenDates(sentence, sessionMs);
        const [date] = usable;
        if (count !== 1 || usable.length !== 1 || date.day === null) return;
        const quote = quoteAround(sentence, date.at, date.end);
        const identity = `${iso(date.day)}\0${quote}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        out.push({ day: date.day, before: contentStems(clauseBefore(sentence, date.at)), quote, key: `${hitIndex}:${turnIndex}:${sentenceIndex}` });
      });
    });
  });
  return out;
}

/** The one statement that is the date of this event, or null when none is, or when two different dates are equally good. */
function dateOfEvent(event: string, statements: readonly Statement[]): Statement | null {
  const words = contentStems(event);
  if (words.size === 0) return null;
  if (words.size === 1 && [...words][0].length < MIN_LONE_WORD) return null;
  const needed = neededOverlap(words.size);
  // A number names one thing: the iPhone 13 is not a statement about the iPhone 12, whatever else the two share.
  const numbers = [...words].filter(word => /\d/.test(word));
  let best = 0;
  let leaders: Statement[] = [];
  for (const statement of statements) {
    let score = 0;
    for (const word of words) if (statement.before.has(word)) score += 1;
    if (score < needed || score < best || numbers.some(number => !statement.before.has(number))) continue;
    if (score > best) { best = score; leaders = []; }
    leaders.push(statement);
  }
  if (leaders.length === 0) return null;
  const days = new Set(leaders.map(statement => dayNumber(statement.day)));
  return days.size === 1 ? leaders[0] : null;
}

export interface SpanHit {
  notePath: string;
  text: string;
  score: number;
  reason: string;
  session_date?: string;
}

export interface QuestionSpan {
  unit: SpanUnit | null;
  /** The earlier date and the later one, each with the words it was written in. */
  from: { date: string; quote: string };
  to: { date: string; quote: string };
  days: number;
}

/**
 * The span the question asks about, from the dates the user wrote for its two events. Null when the question is no duration
 * question, does not name two events, or the page does not hold a written date for each of them beyond doubt.
 */
export function questionSpan(hits: readonly SpanHit[], query: string): QuestionSpan | null {
  const kind = durationQuestion(query);
  if (kind === null) return null;
  const events = questionEvents(query);
  if (events === null) return null;
  const statements = datedStatements(hits);
  if (statements.length < 2) return null;
  const first = dateOfEvent(events[0], statements);
  const second = dateOfEvent(events[1], statements);
  if (first === null || second === null || first.key === second.key) return null;
  const [from, to] = dayNumber(first.day) <= dayNumber(second.day) ? [first, second] : [second, first];
  const days = dayNumber(to.day) - dayNumber(from.day);
  if (days > 365 * 20) return null;
  return { unit: kind.unit, from: { date: iso(from.day), quote: from.quote }, to: { date: iso(to.day), quote: to.quote }, days };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A day `months` calendar months on, in ms: the same day of that month, or its last day when it is shorter (31 January plus one month is 28 February). */
function monthsAfter(year: number, month: number, day: number, months: number): number {
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay));
}

/** Whole calendar months from one day to the next, and the days left over (a month is the same day of the next month, or the last day of a shorter one). */
export function calendarMonths(from: string, to: string): { months: number; days: number } {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const target = Date.UTC(ty, tm - 1, td);
  // The later day's own month is the most there can be, and it is reached unless the earlier day, cut to that month, falls after the later one.
  let months = Math.max(0, (ty - fy) * 12 + (tm - fm));
  if (months > 0 && monthsAfter(fy, fm, fd, months) > target) months -= 1;
  return { months, days: Math.round((target - monthsAfter(fy, fm, fd, months)) / 86_400_000) };
}

function describe(days: number, from: string, to: string, unit: SpanUnit | null): string {
  const base = plural(days, 'day');
  const weeks = (): string => (days % 7 === 0 ? plural(days / 7, 'week') : `${plural(Math.floor(days / 7), 'week')} and ${plural(days % 7, 'day')}`);
  const months = (): string => {
    const m = calendarMonths(from, to);
    return m.days === 0 ? plural(m.months, 'month') : `${plural(m.months, 'month')} and ${plural(m.days, 'day')}`;
  };
  if (unit === 'week') return `${base} (${weeks()})`;
  if (unit === 'month') return `${base} (${months()})`;
  if (unit === 'year') {
    const m = calendarMonths(from, to);
    const years = Math.floor(m.months / 12);
    const rest = m.months % 12;
    return `${base} (${plural(years, 'year')}${rest > 0 ? ` and ${plural(rest, 'month')}` : ''})`;
  }
  if (unit === null && days >= 14) return `${base} (${days >= 60 ? `${weeks()}; ${months()}` : weeks()})`;
  return base;
}

/** The line, as it is placed above the excerpts. */
export function questionSpanLine(span: QuestionSpan): string {
  return [
    'Dates the user wrote for the two events in this question, quoted from the excerpts below, earlier first. They are counted from the written dates alone, never from a session date:',
    `- ${span.from.date}: "${span.from.quote}"`,
    `- ${span.to.date}: "${span.to.quote}"`,
    `From the first to the second: ${describe(span.days, span.from.date, span.to.date, span.unit)}.`,
  ].join('\n');
}

/**
 * The page with the duration line first, when RENOR_READER_DURATION is on and the question is one it can answer from
 * written dates; otherwise the page itself (the same array). `source` are the hits the statements are read from when they
 * are not the page: the layout joins the chunks of a session into one text, which loses the chunk a turn heading belongs
 * to, so it hands over the chunks as they were found.
 */
export function withQuestionSpan<T extends SpanHit>(hits: T[], query: string | undefined, options: { source?: readonly SpanHit[]; env?: NodeJS.ProcessEnv } = {}): T[] {
  if (!readerDurationEnabled(options.env) || query === undefined || query.trim() === '') return hits;
  const span = questionSpan(options.source ?? hits, query);
  if (span === null) return hits;
  return [{ notePath: '', text: questionSpanLine(span), score: 0, reason: 'span' } as T, ...hits];
}
