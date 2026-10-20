import { encodeTokens } from '../indexer/tokenizer';
import { asksForAdvice } from './adviceQuestion';
import { sessionDateMs } from './orchestrator';
import { FIRST_PERSON, GENERIC_VERBS, isUserTurn, questionTerms, quoteOf, sentencesOf, stem, stripHeading, wordsOf, type NoteSource, type NoteTurn } from './readerEvents';
import { formatDay } from './relativeTimeHints';

/**
 * Advice lines: for a query that asks to be advised ("Can you recommend ...", "Any tips ...", "What should I ..."; adviceQuestion.ts),
 * one block first with what the user has said about their own situation, tastes and habits that shares words with the request,
 * quoted as they wrote it and dated by its conversation, oldest first. Opt-in (`RENOR_READER_ADVICE_LINES`, default off): with it
 * unset, or set to anything but an on value, a reply is byte-identical, and so is the reply to any query that does not ask for advice.
 *
 * Why. On the 19 Oct best set with a Claude Haiku 5.5 reader (docs/evals/results/LEDGER.md section AG), 30 of the 61 misses are
 * "I don't know" on a question that has an answer; 28 of those 30 pages hold every gold evidence turn, and the largest group of them
 * is 10 requests for advice (preference questions), each wrong in all six arms on record whatever the page's layout or digests
 * (docs/evals/results/idk-misses-20261019/). A request for advice has no stored answer: what memory holds is the user's earlier words
 * about themselves ("I've been using Premiere Pro for my edits"), one sentence inside a long turn among dozens of excerpts. These
 * lines put those sentences where a reader looks first and say what they are.
 *
 *  - A line is `<day>: "<sentence>"`, the sentence exactly as the user wrote it (one over MAX_QUOTE_CHARS is cut around its first
 *    matching word, with "…" where it is cut), under the date of its conversation. Assistant turns are not quoted, and neither is a
 *    question.
 *  - Picked by the nouns and names the request holds, not by its advice words ("recommend", "tips") or its verbs: one of them is
 *    enough. Every thing the request names gets its own line first, then the best-scoring of the rest (rarer words weigh more).
 *  - Bounded: at most MAX_ADVICE_LINES lines, two per conversation, MAX_ADVICE_TOKENS tokens of lines; only conversations the page
 *    already holds are read; no model call, no embedding.
 *  - The excerpts stay in full below the lines, in the order the page gave them.
 */

/** Default off. `1` / `true` / `yes` / `on` places the advice lines first on the reply to a query that asks to be advised. */
export function readerAdviceLinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RENOR_READER_ADVICE_LINES ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Most lines a reply carries. */
export const MAX_ADVICE_LINES = 6;
/** Most tokens of lines (o200k) a reply carries, the header sentence excluded. */
export const MAX_ADVICE_TOKENS = 400;
/** Most lines taken from one conversation. */
export const MAX_ADVICE_LINES_PER_SESSION = 2;
/** Most sentences considered for one query: the cost of a reply is bounded whatever the page holds. */
export const MAX_ADVICE_CANDIDATES = 4000;

export const ADVICE_LINES_HEADER = 'Statements by the user about their own situation, tastes and habits that share words with this request, oldest first, each under the date of its conversation. The excerpts below are unchanged.';

// The words a request for advice is framed with, not what it is about: they never select a sentence.
const ADVICE_WORDS = new Set([
  'recommend', 'recommendation', 'suggest', 'suggestion', 'advise', 'advice', 'tip', 'idea', 'thought', 'pointer', 'opinion', 'think',
  'option', 'resource', 'good', 'great', 'best', 'better', 'nice', 'new', 'like', 'something', 'anything', 'thing', 'way', 'please',
  'should', 'want', 'need', 'looking', 'help', 'know', 'let',
].map(w => stem(w)));

// A question to someone, not something the user says about themselves.
const ASKS = /^(?:can|could|would|will|do|does|did|is|are|what|how|why|where|which|who|any)\b/i;

/** Something the user says about themselves: first person, and not a question. */
export function isSelfStatement(sentence: string): boolean {
  const s = sentence.replace(/^["'“(\[]+/, '');
  return !sentence.trimEnd().endsWith('?') && !ASKS.test(s) && FIRST_PERSON.test(s);
}

/** What the lines need from a hit: the conversation it belongs to and that conversation's date. */
export interface AdviceSource extends NoteSource {
  session_date?: string;
}

interface Candidate {
  sentence: string;
  stems: Set<string>;
  notePath: string;
  sessionDate: string | undefined;
  position: number;
}

/** The conversation's own day, as its date is written (`2023/05/30 (Tue)` or `2023-05-30`), or null when it has none. */
function dayOf(sessionDate: string | undefined): string | null {
  const ms = sessionDateMs(sessionDate);
  if (!Number.isFinite(ms) || sessionDate === undefined) return null;
  return formatDay(new Date(Math.floor(ms / 86_400_000) * 86_400_000), /^\d{4}\//.test(sessionDate));
}

/**
 * The advice lines for one query, or null when the query does not ask to be advised or no statement of the user's shares a
 * word with it. `hits` are the conversation hits of the page; `turnsOf` returns the stored chunks of a conversation note.
 */
export function adviceLines(hits: readonly AdviceSource[], query: string, turnsOf: (source: NoteSource) => NoteTurn[]): string | null {
  if (!asksForAdvice(query)) return null;
  const terms = new Set([...questionTerms(query)].filter(t => !ADVICE_WORDS.has(t)));
  const aboutTerms = new Set([...terms].filter(t => !GENERIC_VERBS.has(t)));
  if (aboutTerms.size === 0) return null;
  // One entry per conversation, in the order the page holds them: its date and a chunk of it, from whichever of its hits has them.
  const sources = new Map<string, { chunkId?: number; sessionDate?: string }>();
  for (const hit of hits) {
    const had = sources.get(hit.notePath) ?? {};
    sources.set(hit.notePath, { chunkId: had.chunkId ?? (hit.chunkId !== undefined && hit.chunkId > 0 ? hit.chunkId : undefined), sessionDate: had.sessionDate ?? hit.session_date });
  }
  const candidates: Candidate[] = [];
  let position = 0;
  for (const [notePath, { chunkId, sessionDate }] of sources) {
    if (notePath === '' || candidates.length >= MAX_ADVICE_CANDIDATES) continue;
    for (const turn of turnsOf({ notePath, chunkId })) {
      if (candidates.length >= MAX_ADVICE_CANDIDATES) break;
      if (!isUserTurn(turn.headingPath)) continue;
      for (const sentence of sentencesOf(stripHeading(turn.text))) {
        if (!isSelfStatement(sentence)) continue;
        candidates.push({ sentence, stems: new Set(wordsOf(sentence).map(w => stem(w.replace(/['’]s$/, '')))), notePath, sessionDate, position: position++ });
      }
    }
  }
  if (candidates.length === 0) return null;
  // A term every sentence holds says little; one a few hold says what the request is about.
  const df = new Map<string, number>();
  for (const c of candidates) for (const t of aboutTerms) if (c.stems.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => Math.log(1 + candidates.length / (df.get(t) ?? 1));
  // A preference is usually stated with one word of the request ("I like hotels near the beach" for "a hotel for my trip to Miami"),
  // so one shared word is enough to be a candidate; the score and the bounds below decide which candidates are shown.
  const scored = candidates.flatMap(candidate => {
    let score = 0;
    for (const t of aboutTerms) if (candidate.stems.has(t)) score += idf(t);
    return score > 0 ? [{ candidate, score }] : [];
  });
  if (scored.length === 0) return null;
  const chosen: Array<{ candidate: Candidate; line: string }> = [];
  const perSession = new Map<string, number>();
  const seen = new Set<string>();
  let tokens = 0;
  const take = (c: Candidate): boolean => {
    const key = `${c.notePath}\0${c.sentence.toLowerCase()}`;
    if (seen.has(key) || (perSession.get(c.notePath) ?? 0) >= MAX_ADVICE_LINES_PER_SESSION) return false;
    const day = dayOf(c.sessionDate);
    const quote = quoteOf(c.sentence, terms);
    const line = day ? `- ${day}: "${quote}"` : `- "${quote}"`;
    const cost = encodeTokens(line) + 1;
    if (tokens + cost > MAX_ADVICE_TOKENS) return false;
    tokens += cost;
    seen.add(key);
    perSession.set(c.notePath, (perSession.get(c.notePath) ?? 0) + 1);
    chosen.push({ candidate: c, line });
    return true;
  };
  // First every thing the request names gets its best line, the sentence that says most of what is still unsaid first; then the
  // best-scoring sentences that are left, until a bound is reached.
  const covered = new Set<string>();
  const refused = new Set<Candidate>();
  while (chosen.length < MAX_ADVICE_LINES) {
    let pick: (typeof scored)[number] | null = null;
    let pickGain = 0;
    for (const s of scored) {
      if (refused.has(s.candidate)) continue;
      let gain = 0;
      for (const t of aboutTerms) if (s.candidate.stems.has(t) && !covered.has(t)) gain += idf(t);
      if (gain > pickGain || (gain === pickGain && gain > 0 && pick !== null && s.score > pick.score)) { pick = s; pickGain = gain; }
    }
    if (pick === null || pickGain === 0) break;
    if (take(pick.candidate)) for (const t of aboutTerms) { if (pick.candidate.stems.has(t)) covered.add(t); }
    refused.add(pick.candidate);
  }
  const rest = scored.filter(s => !refused.has(s.candidate))
    .sort((a, b) => b.score - a.score || a.candidate.sentence.length - b.candidate.sentence.length || a.candidate.position - b.candidate.position);
  for (const s of rest) {
    if (chosen.length >= MAX_ADVICE_LINES) break;
    take(s.candidate);
  }
  if (chosen.length === 0) return null;
  // Oldest first: the conversation's date, then the order of reading.
  chosen.sort((a, b) => (sessionDateMs(a.candidate.sessionDate) - sessionDateMs(b.candidate.sessionDate)) || (a.candidate.position - b.candidate.position));
  return [ADVICE_LINES_HEADER, ...chosen.map(c => c.line)].join('\n');
}

export interface AdviceLinesInput<T> {
  query: string;
  /** Made only when the switch is on and the query asks for advice: the stored chunks of a conversation note. */
  turnsOf: () => (source: NoteSource) => NoteTurn[];
  /** Is this hit a chunk of a conversation note (not a fact, a ledger event, the evidence or digest table, or another block)? */
  isSource: (hit: T) => boolean;
}

/**
 * The page with the advice lines first (reason "advice"), when the switch is on and the query asks to be advised. Otherwise the
 * very array it was given.
 */
export function withAdviceLines<T extends AdviceSource & { text: string; score: number; reason: string }>(hits: T[], input: AdviceLinesInput<T>, env: NodeJS.ProcessEnv = process.env): T[] {
  if (!readerAdviceLinesEnabled(env) || !asksForAdvice(input.query)) return hits;
  const text = adviceLines(hits.filter(input.isSource), input.query, input.turnsOf());
  if (text === null) return hits;
  return [{ notePath: '', text, score: 0, reason: 'advice' } as T, ...hits];
}
