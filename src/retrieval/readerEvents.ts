import type Database from 'better-sqlite3';
import { encodeTokens } from '../indexer/tokenizer';
import { isTurnLabel } from './conversationShape';
import { sessionDateMs } from './orchestrator';
import { formatDay, relativeTimePoints } from './relativeTimeHints';

/**
 * Event lines: for a question about the ORDER or the DATE of something the user did ("which happened first", "what was
 * the order of", "what did I buy 10 days ago", "when did I ..."), one short line per statement of the user's that matches
 * the question, oldest first, above the excerpts. On by default (`RENOR_READER_EVENTS=0` switches it off): with it set to 0 a
 * page is byte-identical to the layout's, and so is the page of any question that is not about an order or a date.
 *
 * Why. On the 2026-10-17 slice of 133 temporal-reasoning questions (Fireworks deepseek-v4p1-flash, layout on), the 18
 * misses hold 27 of 40 evidence turns on the page against 217 of 219 for the 115 hits: the reader fails where the one
 * sentence that answers ("By the way, I took my niece to the Natural History Museum today") is a short remark inside a
 * long turn that the page does not carry, or carries only as its session's bare header. The session expansion adds whole
 * turns of at most 120 tokens and none from a session ranked low. This reads the user's turns of every conversation the
 * page already holds, picks the sentences that share words with the question, and writes each under the day it is about.
 *
 *  - A line is `<day>: "<sentence>"`, the sentence exactly as the user wrote it (a sentence over MAX_QUOTE_CHARS is cut
 *    around its first matching word, with "…" where it is cut). Assistant turns are not quoted. A question, a request or a
 *    plan is not a statement and is skipped; so is a sentence with no first-person word or no past tense or date.
 *  - Picked by the nouns and names the question holds, not by the verb it is worded with ("visited", "attended" and "took
 *    her to" are all a visit): every thing the question names gets its own line first, then the best of the rest. A choice
 *    ("which first, A or B") is answered from both sides or not at all.
 *  - The day is the one the statement names: a phrase that places the action counted from its conversation ("two weeks
 *    ago", "last Saturday", "yesterday", "today": relativeTimeHints.ts), else a calendar date written in it ("on February
 *    17th", "2/10"), else a written month ("in January", shown `2023/01`), else the date of its conversation. Nothing is
 *    guessed, and a conversation without a parseable date gets no line (an order needs a date).
 *  - Not a calculation. No line subtracts one date from another: how many days lie between two lines is the reader's
 *    arithmetic, as before (a duration question is left to its own change and gets no lines).
 *  - Bounded: at most MAX_EVENT_LINES lines (more when the question counts its items), two per conversation and
 *    MAX_EVENT_TOKENS tokens of lines; no model call, no embedding.
 *  - The excerpts stay in full below the lines, in the order the layout gave them.
 */

/** Default on. `0` / `false` / `no` / `off` removes the event lines from a layout-on page. */
export function readerEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_READER_EVENTS ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * Is the switch set to an on value, written out (`1` / `true` / `yes` / `on`)? Only then does the search_memory tool description
 * name the lines: with the switch unset the lines still lead the page and say what they are in their own first words, but the
 * published description (kept under 1,200 characters, and equal to the gateway's server card) stays as it was.
 */
export function readerEventsNamed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_READER_EVENTS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Most lines a reply carries, unless the question counts its items ("the six museums"). */
export const MAX_EVENT_LINES = 8;
/** Most tokens of lines (o200k) a reply carries, the header sentence excluded. */
export const MAX_EVENT_TOKENS = 560;
/** Most lines taken from one conversation. */
export const MAX_LINES_PER_SESSION = 2;
/** Most of one conversation's chunks read (a session is dozens; an export of years of chat is more, and is not read past this). */
export const MAX_CHUNKS_PER_NOTE = 400;
/** Most sentences considered for one question: the cost of a reply is bounded whatever the page holds. */
export const MAX_CANDIDATE_SENTENCES = 4000;
/** The longest quote of a sentence; a longer one is cut around its first matching word. */
export const MAX_QUOTE_CHARS = 240;

// A duration is somebody else's question: a count of days, weeks or months between two things, or how long. "How many
// days ago did I ..." is not (it asks for a date, counted back from the question's), so a count is a duration only when
// the question does not also say "ago".
const DURATION_QUESTION = /\bhow (?:many|much) (?:days?|weeks?|months?|years?|hours?|minutes?)\b(?![^?]*\bago\b)|\bhow long\b|\bhow much time\b|\bhow old\b|\bpassed (?:between|since)\b/i;
// Which came first, in what order. "first / last / most recently" alone is not enough ("my first client", "the most recent
// visit" ask for a value): an order has a choice ("..., A or B"), says so ("the order of", "from earliest to latest") or has
// "first" as an adverb ("who graduated first, ...?"), not as an adjective ("my first boss").
const ORDER_QUESTION = /\b(?:the order of|what order|which order|in order from|order in which|in the order)\b|\b(?:which|who|what)\b[^?]{0,100}\b(?:first|earlier|earliest|last|latest|most recent(?:ly)?)\b[^?]{0,100}\bor\b|\b(?:which|who)\b[^?]{0,80}\bfirst\b(?=\s*(?:[,?]|$|or\b|and\b))|\bfrom (?:earliest|first) to (?:latest|last)\b|\bhappened first\b|\bfirst to last\b/i;
const COUNT_WORD = '(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few|\\d{1,3})';
// A date asked for: "what was the date", "when did I", "N days ago", "last Saturday".
const DATE_QUESTION = new RegExp(
  `\\bwhat (?:was the )?date\\b|\\bwhich date\\b|\\bwhat day (?:was|did)\\b|\\bwhen (?:did|was|were)\\b|\\b${COUNT_WORD} (?:days?|weeks?|months?|years?) ago\\b|\\blast (?:week|month|year|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b|\\bago\\b|\\bthe past weekend\\b|\\byesterday\\b`,
  'i',
);

function questionOf(query: string): string {
  const lines = query.split('\n').map(line => line.trim()).filter(line => line !== '');
  return lines.length > 0 ? lines[lines.length - 1] : query.trim();
}

/** An order or a date is asked for (and not a duration). The question alone decides: no label, no category. */
export function isEventQuestion(query: string): boolean {
  const q = questionOf(query);
  if (q === '' || DURATION_QUESTION.test(q)) return false;
  return ORDER_QUESTION.test(q) || DATE_QUESTION.test(q);
}

// ---- words ---------------------------------------------------------------------------------------------------------

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'did', 'does', 'doing', 'done', 'you', 'your',
  'yours', 'with', 'from', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'about', 'into', 'over', 'under', 'than', 'then', 'them', 'they', 'their', 'there', 'here', 'would', 'could', 'should', 'will',
  'shall', 'can', 'may', 'might', 'must', 'some', 'any', 'more', 'most', 'other', 'only', 'same', 'very', 'really', 'just', 'also',
  'still', 'such', 'too', 'out', 'off', 'not', 'but', 'its', 'our', 'ours', 'mine', 'myself', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'while', 'during', 'between', 'through', 'each', 'both', 'few', 'many',
  'much', 'got', 'get', 'tell', 'told', 'said', 'say',
]);
// What a question says about WHEN, not about what: it never selects a sentence.
const TIME_WORDS = new Set([
  'order', 'first', 'last', 'latest', 'earliest', 'earlier', 'later', 'recent', 'recently', 'before', 'after', 'ago', 'day', 'days',
  'week', 'weeks', 'month', 'months', 'year', 'years', 'date', 'time', 'times', 'past', 'weekend', 'yesterday', 'today', 'tomorrow',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june',
  'july', 'august', 'september', 'october', 'november', 'december', 'now', 'currently', 'happened', 'start', 'started', 'begin',
  'began', 'finish', 'finished', 'mention', 'mentioned', 'ever', 'again', 'already', 'next', 'previous', 'previously', 'since', 'until',
  'couple', 'whether', 'either', 'event', 'events',
]);

/** A light stem: the same on both sides of a comparison, not a dictionary form ("museums", "museum" -> "museum"; "visited", "visiting" -> "visit"). */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9]*(?:['’][a-z]+)?/g) ?? [];
}

/** The stems of the words the question is about: no function words, no time words, no numbers. */
export function questionTerms(query: string): Set<string> {
  const terms = new Set<string>();
  for (const word of wordsOf(questionOf(query))) {
    const bare = word.replace(/['’]s$/, '');
    if (bare.length < 3 || STOP.has(bare) || TIME_WORDS.has(bare)) continue;
    terms.add(stem(bare));
  }
  return terms;
}

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/** How many items the question names ("the six museums", "the three events"), or null. */
export function itemCountOf(query: string): number | null {
  const m = /\b(?:the|these|those|all|my)\s+(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b/i.exec(questionOf(query));
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = raw in NUMBER_WORDS ? NUMBER_WORDS[raw] : Number(raw);
  return Number.isFinite(n) && n >= 2 ? n : null;
}

/**
 * The options of a choice question ("..., the bike or the car?", "..., 'The Hate U Give' or 'The Nightingale'?"), each as the
 * stems of the words that name it, or null when the question is no choice. The options are what follows the first comma,
 * cut at each comma and each "or".
 */
export function choiceOptions(query: string): Set<string>[] | null {
  const q = questionOf(query).replace(/\?\s*$/, '');
  const comma = q.indexOf(',');
  if (comma < 0 || !/\bor\b/i.test(q.slice(comma))) return null;
  const options = q.slice(comma + 1).split(/,|\bor\b/i).map(segment => questionTerms(segment)).filter(terms => terms.size > 0);
  return options.length >= 2 ? options : null;
}

// ---- sentences -----------------------------------------------------------------------------------------------------

const FIRST_PERSON = /\b(?:i|me|my|mine|we|our|ours)\b/i;
// A request is not an event: "Can you recommend ...", "I'm looking for ...", "I was wondering ...".
const REQUEST = /^(?:can|could|would|will|do|does|did|is|are|what|how|why|where|which|who|please|any|tell me|help me|give me|show me|let me know|i(?:'m| am) (?:looking|wondering|trying to find|curious|hoping)|i (?:need|want|was wondering|would like|am looking)|i'd like)\b/i;

// The verbs a question about events leans on. They are how the user's statement is worded, not what it is about: "visited",
// "attended" and "took her to" are all a visit to a museum, so a sentence is picked for the nouns and names a question holds,
// and one of these only adds to a sentence that already has one.
const GENERIC_VERBS = new Set([
  'visit', 'attend', 'go', 'went', 'take', 'took', 'participate', 'watch', 'buy', 'bought', 'purchase', 'get', 'got', 'meet', 'met',
  'join', 'finish', 'complete', 'read', 'play', 'see', 'saw', 'fly', 'flew', 'use', 'try', 'do', 'make', 'made', 'have', 'receive',
  'sign', 'book', 'order', 'cancel', 'set', 'hear', 'heard', 'start', 'began', 'begin', 'come', 'came', 'give', 'gave', 'find', 'found',
  'become', 'became', 'graduate', 'mention', 'tell', 'told', 'say', 'said', 'think', 'thought', 'want', 'need', 'put', 'ask', 'help',
].map(w => stem(w)));

const NOT_A_VERB = new Set(['related', 'excited', 'interested', 'tired', 'limited', 'advanced', 'supposed', 'required', 'concerned', 'experienced', 'detailed', 'hundred', 'speed', 'seed', 'feed', 'breed', 'indeed', 'proceed', 'succeed', 'exceed', 'united', 'inspired', 'organized', 'prepared', 'dedicated']);
const PAST_FORM = /\b(?:[a-z]{3,}ed|went|took|saw|got|bought|had|met|ran|flew|did|made|gave|found|came|ate|drank|wrote|drove|won|lost|sold|heard|felt|left|began|sat|stood|spent|paid|brought|held|kept|said|told|knew|thought|taught|caught|built|chose|rode|sang|swam|woke|wore|set|put|cut|hit|let|quit|shut|cost)\b/i;
const TIME_MARK = /\b(?:today|yesterday|ago|last|tonight|recently|just|finally|already|earlier|this (?:morning|afternoon|evening|week|month)|the other day)\b/i;
// A plan, a wish or a request is not something that happened.
const PLAN = /\b(?:planning|plan to|plan on|plans? (?:a|an|my|our|the|for)|going to|gonna|want to|wanna|thinking (?:of|about)|wondering|hoping|hope to|looking (?:for|to)|need to|would like|i'd like|if you|can you|could you|interested in|considering|might|maybe|should i)\b/i;

function stripHeading(text: string): string {
  return text.replace(/^\s*#{1,6}[^\n]*\n+/, '');
}

// A full stop that ends a title or an abbreviation, not a sentence ("Dr. Patel", "St. Mary's", "e.g. Paris").
const TITLE_STOP = /\b(?:Dr|Mr|Mrs|Ms|Prof|St|Mt|Jr|Sr|vs|Inc|Ltd|Gen|Sgt|Rev|Hon)\./g;
const ABBREVIATION_STOP = /\b(?:e\.g|i\.e|etc|a\.m|p\.m|U\.S|U\.K)\./gi;
const PROTECTED_STOP = '\uE000';

export function sentencesOf(body: string): string[] {
  const out: string[] = [];
  const guarded = body.replace(TITLE_STOP, m => `${m.slice(0, -1)}${PROTECTED_STOP}`).replace(ABBREVIATION_STOP, m => `${m.slice(0, -1)}${PROTECTED_STOP}`);
  for (const paragraph of guarded.split(/\n+/)) {
    for (const piece of paragraph.split(/(?<=[.!?])\s+(?=["'“(\[]?[A-Z0-9])/)) {
      const sentence = piece.replaceAll(PROTECTED_STOP, '.').trim();
      if (sentence !== '') out.push(sentence);
    }
  }
  return out;
}

/** The sentence writes a calendar date ("on February 17th", "10 March 2023", "2023-03-01", "on 2/10"). */
function hasWrittenDate(sentence: string): boolean {
  return MONTH_DAY.test(sentence) || DAY_MONTH.test(sentence) || ISO_DATE.test(sentence) || NUMERIC_DATE.test(sentence);
}

/**
 * Something the user says happened: first person, not a question or a request, past tense or dated. A plan or a wish
 * ("I'm planning to ...", "it got me thinking about ...") is not an event, but a sentence that reports one and then
 * says what it made the user want is: only the words before the plan clause are read for the tense.
 */
export function isStatement(sentence: string): boolean {
  if (sentence.endsWith('?') || REQUEST.test(sentence.replace(/^["'“(\[]+/, ''))) return false;
  // Past tense is read off verbs: an adjective that ends in -ed ("a science-related exhibition") is not one.
  const verbs = (part: string): string => part.replace(/\b[a-z]+ed\b/gi, word => (NOT_A_VERB.has(word.toLowerCase()) ? ' ' : word));
  const reports = (part: string): boolean => FIRST_PERSON.test(part) && (PAST_FORM.test(verbs(part)) || TIME_MARK.test(part));
  const plan = PLAN.exec(sentence);
  // A date alone makes a statement only when nothing in it looks ahead ("I will visit it on March 15th" is a plan).
  if (!plan) return reports(sentence) || (FIRST_PERSON.test(sentence) && hasWrittenDate(sentence) && !FUTURE.test(sentence));
  // A plan clause is read around, not through: what comes before it, and what comes after the comma that ends it.
  const comma = sentence.indexOf(',', plan.index);
  const tail = comma < 0 ? '' : sentence.slice(comma + 1);
  return reports(sentence.slice(0, plan.index)) || reports(tail);
}

/** The weight of a sentence whose own words place its action on a day: a phrase ("today", "last Saturday") or a date. */
const ANCHORED = 1.6;

/** How sure a sentence is of the day of its action: 1.6 when a phrase or a date places it, 1.25 for a loose "recently" or "last", 1 for neither. */
function anchorWeight(sentence: string, sessionDate: string | undefined): number {
  if (relativeTimePoints(sentence, sessionDate).some(point => point.grain === 'day') || hasWrittenDate(sentence)) return ANCHORED;
  return TIME_MARK.test(sentence) || MONTH_ONLY.test(sentence) ? 1.25 : 1;
}

/** The user's turns of one conversation. A turn heading says who spoke and nothing else (conversationShape.ts isTurnLabel). */
export interface NoteTurn {
  headingPath: string;
  text: string;
  chunkId: number;
}

export function isUserTurn(headingPath: string): boolean {
  const last = headingPath.split(' > ').pop() ?? '';
  if (!isTurnLabel(last)) return false;
  const words = last.toLowerCase().replace(/[\p{N}\p{P}\p{S}\p{Z}]+/gu, ' ').trim().split(' ');
  return words.includes('user') || words.includes('human') || words.includes('me');
}

/** A conversation the page holds, as a hit names it: its path as the caller shows it, and a chunk of it when the hit has one. */
export interface NoteSource {
  notePath: string;
  chunkId?: number;
}

/**
 * The chunks of a note that the user spoke, in document order, read once per note and kept. The chunks hold the text as it
 * was stored. A hit's note is found by one of its chunk ids when it has one (the path a reply shows is not always the path
 * the index stores), else by its path. The query only keeps headings that name a user or a human; isUserTurn decides which
 * of them are a turn.
 */
export function noteTurnsLoader(db: Database.Database): (source: NoteSource) => NoteTurn[] {
  const storedPath = db.prepare('SELECT note_path AS notePath FROM chunks WHERE id = ?');
  const select = db.prepare(
    `SELECT id AS chunkId, heading_path AS headingPath, text FROM chunks
     WHERE note_path = ? AND (heading_path LIKE '%user%' OR heading_path LIKE '%human%' OR heading_path LIKE '%me%') ORDER BY start_line, id`,
  );
  const known = new Map<string, NoteTurn[]>();
  return source => {
    const stored = source.chunkId !== undefined && source.chunkId > 0
      ? (storedPath.get(source.chunkId) as { notePath: string } | undefined)?.notePath ?? source.notePath
      : source.notePath;
    let turns = known.get(stored);
    if (turns === undefined) {
      turns = [];
      // Rows are read one at a time and reading stops at MAX_CHUNKS_PER_NOTE user turns: a note's other headings that happen to
      // hold the word "user" cost a look, not a place.
      for (const row of select.iterate(stored) as Iterable<NoteTurn>) {
        if (!isUserTurn(row.headingPath)) continue;
        turns.push(row);
        if (turns.length >= MAX_CHUNKS_PER_NOTE) break;
      }
      known.set(stored, turns);
    }
    return turns;
  };
}

// ---- dates ---------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTH_NUMBER: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_NAME = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
// "March 15th", "Feb 20, 2023", "15th of March", "15 March 2023"; the month is capitalised, so "may" the verb is not one.
const MONTH_DAY = new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b(?!\\s*(?:%|percent|miles|mi\\b|km|kilomet|minutes|hours|days|weeks|pounds|dollars))`);
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAME})\\b\\.?(?:,?\\s+(\\d{4}))?`);
const ISO_DATE = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/;
const NUMERIC_DATE = /\b(?:on|since|until)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b(?!\s*(?:cups?|teaspoons?|tablespoons?|tsp|tbsp|inch|inches|miles?|pounds?|lbs?|hours?|km|kg|of\b|a\b|an\b))/i;
// "in January", "since March", "last June": a month and nothing of its day. Capitalised and whole, so "may" the verb and "mar" are not months.
const MONTH_ONLY = /\b(?:in|during|since|until|from|by|around|early|late|mid|last|of)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b(?:,?\s+(\d{4}))?(?!\.?\s*\d)/;
const FUTURE = /\b(?:will|won't|going to|gonna|plan(?:s|ning|ned)? (?:to|on|for)|planning|upcoming|next|scheduled|tomorrow|soon|hope to|hoping to|looking forward|want to|would like to|intend to)\b|'ll\b/i;

export interface EventDay {
  ms: number;
  label: string;
}

function validDay(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/**
 * The calendar date a sentence writes, or null: "on February 17th", "10 March 2023", "2023-03-01", "on 2/10". Without a
 * year the date is the one nearest the conversation's own day: in the same year, or in the year before when that would put
 * a statement about the past more than a month after its conversation (a plan keeps the coming one).
 */
export function writtenDate(sentence: string, sessionMs: number): Date | null {
  const found = ISO_DATE.exec(sentence);
  if (found) return validDay(Number(found[1]), Number(found[2]), Number(found[3]));
  let month: number | null = null;
  let day = 0;
  let year: number | null = null;
  const a = MONTH_DAY.exec(sentence);
  const b = DAY_MONTH.exec(sentence);
  const pick = a ?? b;
  if (pick) {
    if (pick === a) { month = MONTH_NUMBER[a[1].toLowerCase()]; day = Number(a[2]); year = a[3] ? Number(a[3]) : null; }
    else { month = MONTH_NUMBER[b![2].toLowerCase()]; day = Number(b![1]); year = b![3] ? Number(b![3]) : null; }
  } else {
    const n = NUMERIC_DATE.exec(sentence);
    if (!n) return null;
    month = Number(n[1]);
    day = Number(n[2]);
    year = n[3] ? (n[3].length === 2 ? 2000 + Number(n[3]) : Number(n[3])) : null;
  }
  if (!month) return null;
  if (year !== null) return validDay(year, month, day);
  if (!Number.isFinite(sessionMs)) return null;
  const sessionYear = new Date(sessionMs).getUTCFullYear();
  const sameYear = validDay(sessionYear, month, day);
  if (!sameYear) return null;
  const future = FUTURE.test(sentence);
  if (!future && sameYear.getTime() > sessionMs + 31 * DAY_MS) return validDay(sessionYear - 1, month, day);
  if (future && sameYear.getTime() < sessionMs - 31 * DAY_MS) return validDay(sessionYear + 1, month, day);
  return sameYear;
}

/**
 * The month a sentence names without a day ("adopted a baby girl in January"), as the first day of it, or null. The year is
 * the one that puts a statement about the past no more than a month after its conversation, and a plan in its coming month.
 */
export function writtenMonth(sentence: string, sessionMs: number): Date | null {
  const m = MONTH_ONLY.exec(sentence);
  if (!m || !Number.isFinite(sessionMs)) return null;
  const month = MONTH_NUMBER[m[1].toLowerCase()];
  if (m[2]) return validDay(Number(m[2]), month, 1);
  const sessionYear = new Date(sessionMs).getUTCFullYear();
  const sameYear = validDay(sessionYear, month, 1)!;
  const future = FUTURE.test(sentence);
  if (!future && sameYear.getTime() > sessionMs + 31 * DAY_MS) return validDay(sessionYear - 1, month, 1);
  if (future && sameYear.getTime() < sessionMs - 31 * DAY_MS) return validDay(sessionYear + 1, month, 1);
  return sameYear;
}

/** A month as the hit's own date style writes it: `2023/01` or `2023-01`. */
function formatMonth(date: Date, slashStyle: boolean): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}${slashStyle ? '/' : '-'}${mm}`;
}

/**
 * The day a statement is about, and how it is written on the line. A phrase that places the action ("today", "yesterday",
 * "two weeks ago", "last Saturday") counts from its conversation and wins over a calendar date in the same sentence, which
 * is as often the date of the thing ("the March 15th issue") as of the doing; then a written date; then a written month ("in
 * January", written `2023/01`); then "last month" or "last year"; then the conversation's own date. A conversation without a parseable date has none.
 */
export function eventDay(sentence: string, sessionDate: string | undefined): EventDay | null {
  const sessionMs = sessionDateMs(sessionDate);
  if (!Number.isFinite(sessionMs) || sessionDate === undefined) return null;
  const slashStyle = /^\d{4}\//.test(sessionDate);
  const points = relativeTimePoints(sentence, sessionDate);
  const exact = points.find(point => point.grain === 'day');
  if (exact) return { ms: exact.date.getTime(), label: exact.value };
  const written = writtenDate(sentence, sessionMs);
  if (written) return { ms: written.getTime(), label: formatDay(written, slashStyle) };
  const month = writtenMonth(sentence, sessionMs);
  if (month) return { ms: month.getTime(), label: formatMonth(month, slashStyle) };
  if (points.length > 0) return { ms: points[0].date.getTime(), label: points[0].value };
  const day = new Date(Math.floor(sessionMs / DAY_MS) * DAY_MS);
  return { ms: day.getTime(), label: formatDay(day, slashStyle) };
}

// ---- lines ---------------------------------------------------------------------------------------------------------

/** What the event lines need from a hit: the conversation it belongs to and that conversation's date. */
export interface EventSource extends NoteSource {
  session_date?: string;
}

interface Candidate {
  sentence: string;
  stems: Set<string>;
  notePath: string;
  sessionDate: string | undefined;
  /** The stored chunk the sentence is in: its cosine to the question says how near its turn is in meaning. */
  chunkId: number;
  /** Order of reading: conversation by conversation as the page holds them, turns in document order. */
  position: number;
}

interface Chosen {
  candidate: Candidate;
  day: EventDay;
  quote: string;
}

/** The same words said in two conversations are two statements (the day is what tells them apart); said twice in one, one. */
const keyOf = (c: Candidate): string => `${c.notePath}\0${c.sentence.toLowerCase()}`;

function sessionIndex(notePath: string): number | null {
  const base = notePath.split('/').pop() ?? notePath;
  const match = /_(\d+)(?:-|\.|$)/.exec(base);
  return match ? Number(match[1]) : null;
}

/** The sentence as written, or a window of at most MAX_QUOTE_CHARS around its first matching word, with "…" at each cut. */
export function quoteOf(sentence: string, terms: Set<string>): string {
  if (sentence.length <= MAX_QUOTE_CHARS) return sentence;
  let at = 0;
  for (const m of sentence.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    if (terms.has(stem(m[0]))) { at = m.index ?? 0; break; }
  }
  let start = Math.max(0, at - Math.floor(MAX_QUOTE_CHARS / 3));
  let end = Math.min(sentence.length, start + MAX_QUOTE_CHARS);
  if (end === sentence.length) start = Math.max(0, end - MAX_QUOTE_CHARS);
  if (start > 0) { const space = sentence.indexOf(' ', start); if (space >= 0 && space < at) start = space + 1; }
  if (end < sentence.length) { const space = sentence.lastIndexOf(' ', end); if (space > at) end = space; }
  return `${start > 0 ? '…' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? '…' : ''}`;
}

export const EVENT_LINES_HEADER = 'Statements by the user that match this question, oldest first. Each date is the day the statement is about: a date or time phrase written in it, counted from its conversation, otherwise the date of its conversation. The excerpts below are unchanged.';

/**
 * Do the vectors of this embedding kind say anything about meaning? A real model's do; the lexical eval stub's (kind
 * "eval-hash") are hashed words, so a cosine order read from them is not meaning and the lines stay words-only.
 */
export function vectorsMeanSomething(kind: string | undefined): boolean {
  return kind !== undefined && kind !== 'eval-hash';
}

/** The cosine of stored chunks to the question's vector, among the chunks asked about: the index's own search, no embedding made. */
export function turnScorer(
  vectorIndex: { search(queryVector: number[], k: number, among?: number[]): Array<{ chunkId: number; score: number }> },
  queryVector: number[],
): (chunkIds: number[]) => Map<number, number> {
  return chunkIds => new Map(chunkIds.length === 0 ? [] : vectorIndex.search(queryVector, chunkIds.length, chunkIds).map(h => [h.chunkId, h.score] as [number, number]));
}

/** What the lines may use besides the words of the question. */
export interface EventLineOptions {
  /**
   * The cosine of each stored chunk to the question, by chunk id, from vectors the index already holds (no embedding is made
   * for it). Given only when the index has real embeddings. Without it the lines are chosen by the words of the question alone.
   */
  scoreTurns?: (chunkIds: number[]) => Map<number, number>;
  /** The day the question is asked when its query does not say so (no `Question date:` line): now. */
  nowMs?: number;
}

/** A list ("the order of the ... I attended", "from earliest to latest") wants every item; "which came first, A or B" wants two. */
const LIST_QUESTION = /\border\b|\bfrom (?:earliest|first) to (?:latest|last)\b|\bfirst to last\b/i;
/** Lines a question that points at a day is given by meaning from the statements dated near that day. */
export const MAX_WINDOW_LINES = 4;

const QUESTION_DATE = /^Question date:[ \t]*([^\n]+)\n/;

/**
 * The day a question points at by counting back from the day it is asked ("10 days ago", "two weeks ago", "last
 * Saturday", "yesterday"), and how far a statement may be from it. The question says its own day in a `Question date:`
 * line, else it is asked today. A count of units the question does not give ("how many days ago did I ...") points at
 * nothing, nor do "today", "last month" or "last year".
 */
export function targetDayOf(query: string, nowMs: number): { ms: number; toleranceDays: number } | null {
  const trimmed = query.trim();
  const given = QUESTION_DATE.exec(trimmed);
  const asked = given ? given[1].trim() : new Date(nowMs).toISOString().slice(0, 10);
  if (!Number.isFinite(sessionDateMs(asked))) return null;
  const point = relativeTimePoints(questionOf(trimmed), asked).find(p => p.grain === 'day' && p.phrase.toLowerCase() !== 'today');
  if (!point) return null;
  const unit = /\b(day|week|month|year)s?\s+ago\b/i.exec(point.phrase)?.[1].toLowerCase();
  const toleranceDays = unit === 'day' ? 1 : unit === 'week' ? 3 : unit === 'month' ? 10 : unit === 'year' ? 30 : point.phrase.toLowerCase() === 'last week' ? 3 : 0;
  return { ms: point.date.getTime(), toleranceDays };
}

/**
 * The event lines for one question, or null when the question is not about an order or a date, nothing matches, or no
 * matching statement has a date. `hits` is the page as the layout laid it out; `turnsOf` returns the stored chunks of
 * a conversation note (a hit's note), user and assistant turns together.
 *
 * Statements are picked by the words of the question (the nouns and names, not the verb), every thing a question names
 * getting its own line. Where the words are not enough and the index can say how near a user's turn is to the question in
 * meaning (`options.scoreTurns`), two things are added: for a question that points at a day ("what did I buy 10 days ago"),
 * the statements dated near that day, nearest in meaning first, since the day is what names the event; and for a list
 * ("the order of the sports events I watched"), the nearest turns' best dated statement each, since "sports events" is not
 * what "an NBA game" says.
 */
export function eventLines(hits: readonly EventSource[], query: string, turnsOf: (source: NoteSource) => NoteTurn[], options: EventLineOptions = {}): string | null {
  if (!isEventQuestion(query)) return null;
  const terms = questionTerms(query);
  const candidates: Candidate[] = [];
  // One entry per conversation, in the order the page holds them: its date and a chunk of it, from whichever of its hits has them.
  const sources = new Map<string, { chunkId?: number; sessionDate?: string }>();
  for (const hit of hits) {
    const had = sources.get(hit.notePath) ?? {};
    sources.set(hit.notePath, { chunkId: had.chunkId ?? (hit.chunkId !== undefined && hit.chunkId > 0 ? hit.chunkId : undefined), sessionDate: had.sessionDate ?? hit.session_date });
  }
  let position = 0;
  for (const [notePath, { chunkId, sessionDate }] of sources) {
    if (candidates.length >= MAX_CANDIDATE_SENTENCES) break;
    if (notePath === '' || !Number.isFinite(sessionDateMs(sessionDate))) continue;
    for (const turn of turnsOf({ notePath, chunkId })) {
      if (candidates.length >= MAX_CANDIDATE_SENTENCES) break;
      if (!isUserTurn(turn.headingPath)) continue;
      for (const sentence of sentencesOf(stripHeading(turn.text))) {
        if (!isStatement(sentence)) continue;
        candidates.push({ sentence, stems: new Set(wordsOf(sentence).map(w => stem(w.replace(/['’]s$/, '')))), notePath, sessionDate, chunkId: turn.chunkId, position: position++ });
      }
    }
  }
  if (candidates.length === 0) return null;
  // What the question is about (nouns, names, titles) picks a sentence; the verb it is worded with only adds to one that
  // already has such a word. A question made of verbs alone falls back to them.
  const strongTerms = new Set([...terms].filter(t => !GENERIC_VERBS.has(t)));
  const aboutTerms = strongTerms.size > 0 ? strongTerms : terms;
  // A term every sentence holds says little; one a few hold says what the question is about.
  const df = new Map<string, number>();
  for (const c of candidates) for (const t of terms) if (c.stems.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => Math.log(1 + candidates.length / (df.get(t) ?? 1));
  interface Scored { candidate: Candidate; score: number; matched: number; rare: boolean }
  const everything: Scored[] = candidates.map(candidate => {
    let score = 0;
    let matched = 0;
    let rare = false;
    for (const t of terms) {
      if (!candidate.stems.has(t)) continue;
      if (aboutTerms.has(t)) {
        matched += 1;
        score += idf(t);
        if ((df.get(t) ?? 0) <= 2) rare = true;
      } else {
        score += 0.25 * idf(t);
      }
    }
    // A sentence that places its action ("today", "last Thursday", "on February 17th") is an event of a day; one that only
    // sounds like the past is less sure of it.
    return { candidate, score: score * anchorWeight(candidate.sentence, candidate.sessionDate), matched, rare };
  });
  // Several words of the question, or one that almost nothing else says (a name, a title).
  const scored = everything.filter(s => s.matched > 0 && ((aboutTerms.size >= 3 ? s.matched >= 2 : true) || s.rare));
  const best = scored.length > 0 ? Math.max(...scored.map(s => s.score)) : 0;
  const cap = Math.max(MAX_EVENT_LINES, (itemCountOf(query) ?? 0) + 3);
  const chosen: Chosen[] = [];
  const perSession = new Map<string, number>();
  const seen = new Set<string>();
  const refused = new Set<Candidate>();
  let tokens = 0;
  // A line is taken unless its sentence is already there, its conversation has its two, it has no day or it does not fit.
  const take = (s: Scored, sessionCap = MAX_LINES_PER_SESSION): boolean => {
    const c = s.candidate;
    const key = keyOf(c);
    if (seen.has(key) || (perSession.get(c.notePath) ?? 0) >= sessionCap) return false;
    const day = eventDay(c.sentence, c.sessionDate);
    if (!day) return false;
    const quote = quoteOf(c.sentence, terms);
    const cost = encodeTokens(`- ${day.label}: "${quote}"`) + 1;
    if (tokens + cost > MAX_EVENT_TOKENS) return false;
    tokens += cost;
    seen.add(key);
    perSession.set(c.notePath, (perSession.get(c.notePath) ?? 0) + 1);
    chosen.push({ candidate: c, day, quote });
    return true;
  };
  // First, every thing the question names gets its best line ("A or B": a line for A and one for B), the sentence that says
  // most of what is still unsaid first. Then the page is filled with the best-scoring sentences that are left, but not
  // those that say far less than the best.
  const covered = new Set<string>();
  while (chosen.length < cap) {
    let pick: Scored | null = null;
    let pickGain = 0;
    for (const s of scored) {
      if (refused.has(s.candidate) || seen.has(keyOf(s.candidate))) continue;
      let gain = 0;
      for (const t of aboutTerms) if (s.candidate.stems.has(t) && !covered.has(t)) gain += idf(t);
      if (gain > pickGain || (gain === pickGain && gain > 0 && pick !== null && s.score > pick.score)) { pick = s; pickGain = gain; }
    }
    if (pick === null || pickGain === 0) break;
    if (take(pick)) {
      for (const t of aboutTerms) if (pick.candidate.stems.has(t)) covered.add(t);
    } else {
      refused.add(pick.candidate);
    }
  }
  const floor = 0.4 * best;
  const rest = scored.filter(s => s.score >= floor).sort((a, b) => b.score - a.score || a.candidate.sentence.length - b.candidate.sentence.length || a.candidate.position - b.candidate.position);
  for (const s of rest) {
    if (chosen.length >= cap) break;
    if (!refused.has(s.candidate)) take(s);
  }
  if (options.scoreTurns) {
    const cosine = options.scoreTurns([...new Set(candidates.map(c => c.chunkId))]);
    const byTurn = new Map<number, Scored[]>();
    for (const s of everything) {
      if (!cosine.has(s.candidate.chunkId)) continue;
      const turn = byTurn.get(s.candidate.chunkId);
      if (turn) turn.push(s); else byTurn.set(s.candidate.chunkId, [s]);
    }
    const nearest = [...byTurn.entries()].sort((a, b) => (cosine.get(b[0]) ?? 0) - (cosine.get(a[0]) ?? 0) || a[0] - b[0]);
    // The statement of a turn that places its action best, then the one that shares most with the question.
    const bestOf = (sentences: Scored[]): Scored => [...sentences].sort((a, b) =>
      anchorWeight(b.candidate.sentence, b.candidate.sessionDate) - anchorWeight(a.candidate.sentence, a.candidate.sessionDate)
      || b.score - a.score || a.candidate.position - b.candidate.position)[0];
    const target = targetDayOf(query, options.nowMs ?? Date.now());
    if (target) {
      let added = 0;
      for (const [, sentences] of nearest) {
        if (added >= MAX_WINDOW_LINES || chosen.length >= cap) break;
        // A statement that places its own action ("today", "last Saturday", "on March 4th") and does it on a day near the target.
        const inWindow = sentences.filter(s => {
          if (anchorWeight(s.candidate.sentence, s.candidate.sessionDate) < ANCHORED) return false;
          const day = eventDay(s.candidate.sentence, s.candidate.sessionDate);
          return day !== null && Math.abs(day.ms - target.ms) <= target.toleranceDays * DAY_MS;
        });
        if (inWindow.length === 0) continue;
        const pick = bestOf(inWindow);
        if (!refused.has(pick.candidate) && take(pick, Number.POSITIVE_INFINITY)) added += 1;
      }
    }
    if (LIST_QUESTION.test(questionOf(query))) {
      const want = Math.min(cap, (itemCountOf(query) ?? 3) + 2);
      for (const [, sentences] of nearest.slice(0, 2 * want)) {
        if (chosen.length >= want) break;
        const pick = bestOf(sentences);
        if (!refused.has(pick.candidate)) take(pick);
      }
    }
  }
  if (chosen.length === 0) return null;
  // A choice ("which first, A or B") is answered from both sides or not at all: a list that dates one option and says nothing
  // of the other reads as an answer. The words only an option has (not the verb, not what the options share) must each be
  // in a line of the list.
  const choices = ORDER_QUESTION.test(questionOf(query)) ? choiceOptions(query) : null;
  if (choices) {
    for (const [i, option] of choices.entries()) {
      const own = [...option].filter(t => !GENERIC_VERBS.has(t) && !choices.some((other, j) => j !== i && other.has(t)));
      if (own.length > 0 && !chosen.some(c => own.some(t => c.candidate.stems.has(t)))) return null;
    }
  }
  // A total order: the day, then the conversation's own date, then its number when the file names say it (the sessions of one
  // question are numbered in the order they happened), then the order of reading.
  const indexOf = (c: Chosen): number => sessionIndex(c.candidate.notePath) ?? Number.POSITIVE_INFINITY;
  chosen.sort((a, b) => (a.day.ms - b.day.ms)
    || (sessionDateMs(a.candidate.sessionDate) - sessionDateMs(b.candidate.sessionDate))
    || (indexOf(a) === indexOf(b) ? 0 : indexOf(a) < indexOf(b) ? -1 : 1)
    || (a.candidate.position - b.candidate.position));
  return [EVENT_LINES_HEADER, ...chosen.map(c => `- ${c.day.label}: "${c.quote}"`)].join('\n');
}
