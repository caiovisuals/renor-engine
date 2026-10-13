/**
 * A ledger longer than any window of the best rows a keyword read has ever been given (it was 200), and a person's own
 * words that every one of its records outranks.
 *
 * Every record of the ledger carries the same markup lines (`- kind: store`, `- subject: …`, `- source: claude`), so a
 * keyword search for one of those words matches every record. Nobody said the word in a record, so a read turns each of
 * them away; what matters is that it turns them away without letting them take a place from a note or a fact that does
 * say it. A record is short and a person's paragraph is long, so for each of these words every record ranks above it.
 */

/** What the real writer is given for one event (the arguments of `remember` after the vault and the ledger path). */
export interface LedgerRecord {
  subject: string;
  predicate: string;
  object: string;
  source?: string;
  scope?: string;
  statement?: string;
}

/**
 * A person's own note, long and in one paragraph (so one chunk), that says each word the records carry as markup.
 * Chunk text is the note without its trailing newline.
 */
export const READING =
  '# Reading\n\nI read a lot in the morning before work, mostly long articles about programming languages, databases, operating systems and the history of computing, and I keep a store of the ones worth rereading, with notes on the kind of lesson each of them taught me about building software that lasts. My favourite subject is databases, my preferred news source is Lobsters, my favourite object lesson is the postmortem, and the predicate of every good essay is a claim.\n';

/** `count` notes like READING (each long, in one paragraph, and saying "source" once): more of them than a page holds. */
export function readingNotes(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`Notes/reading-${i}.md`, READING.replace('# Reading', `# Reading ${i}`)]));
}

/** The words that every record carries as markup, and that READING says. */
export const MARKUP_WORDS = ['source', 'kind', 'store', 'subject', 'object', 'predicate'];

/** More records than the window was long. */
export const RECORDS = 260;

/** `count` events written by the real writer, none of which supersedes another, and none of which says a markup word. */
export function chores(count: number): LedgerRecord[] {
  return Array.from({ length: count }, (_, i) => ({ subject: `chore ${i}`, predicate: 'needs', object: `milk ${i}`, source: 'claude' }));
}

/**
 * `count` events about different things, all of them live, each saying "source" in the user's own words: every one is
 * shown for that word, and is short, so every one ranks above a person's paragraph that says it.
 */
export function sayings(count: number): LedgerRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    subject: `site ${i}`, predicate: 'is_a', object: 'news source', statement: `Site ${i} is a news source.`, source: 'claude',
  }));
}

/**
 * `count` events about one thing, each superseding the one before it, so that every one but the last is closed. Each
 * says "source" in the user's words: a closed event is not shown, and must not take a place from what is.
 */
export function supersessions(count: number): LedgerRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    subject: 'news', predicate: 'source_is', object: `site ${i}`, statement: `My news source is site ${i}.`, source: 'claude',
  }));
}

/** A fact with the user's words that says "source", saved after the records, and longer than each of them. */
export const SOURCE_STATEMENT =
  'Remember that my preferred news source is Lobsters, which I read every morning before work with a coffee, mostly the long threads about programming languages, databases and operating systems, and the occasional history of computing article that someone rereads and annotates over a weekend.';

/** The fact that says it: what a person told their agent, as it is saved. */
export const SOURCE_FACT: LedgerRecord = {
  subject: 'user', predicate: 'reads', object: 'Lobsters', statement: SOURCE_STATEMENT, source: 'claude',
};
