/**
 * Is a note shaped like a conversation? Told from the note's own sections, never from a front-matter `kind`, a file
 * name or a source: a chat somebody exported and a benchmark's sessions look the same, and a note the user wrote as a
 * document does not.
 *
 * A conversation written as Markdown gives each turn its own heading, and the heading says who spoke or which turn it
 * is and nothing else ("Turn 7 - User", "User", "### Assistant:", "Q3"). A document's headings name what the section
 * is about. So a note is conversation-shaped when at least half of its distinct heading paths end in such a label.
 *
 * Why the session expansion asks (orchestrator.ts): its statement limit was measured on conversations only. A turn
 * over 100 tokens is mostly an assistant's long answer, and the answer-bearing remark is short; in a document the
 * paragraph that answers is often 100 to 200 tokens, which the same limit would leave out.
 *
 * The rule leans to "document". A note taken for a document keeps the former limit, which costs a saving and nothing
 * else; a document taken for a conversation would lose paragraphs the limit was never measured on. So a label must be
 * made of role words alone, a note needs at least `CONVERSATION_MIN_TURNS` of them, and they must be at least half of its paths.
 */
const TURN_WORDS = new Set([
  'turn', 'user', 'assistant', 'human', 'ai', 'bot', 'me', 'you', 'system', 'claude', 'chatgpt', 'gpt', 'gemini',
  'model', 'speaker', 'message', 'question', 'answer', 'reply', 'response', 'prompt', 'q', 'a',
]);

/** The fewest turn headings a note needs to count as a conversation (a one-exchange note is a document here). */
export const CONVERSATION_MIN_TURNS = 4;

/** True when the heading is only a speaker or turn label: role words, digits, punctuation, symbols and spaces. */
export function isTurnLabel(heading: string): boolean {
  const words = heading.toLowerCase().replace(/[\p{N}\p{P}\p{S}\p{Z}]+/gu, ' ').trim().split(' ').filter(Boolean);
  return words.length > 0 && words.every(word => TURN_WORDS.has(word));
}

/** `headingPaths`: the `heading_path` of every chunk of one note (a path is its headings joined by " > "). */
export function isConversationShaped(headingPaths: readonly string[]): boolean {
  const distinct = new Set(headingPaths);
  let turns = 0;
  for (const headingPath of distinct) {
    const last = headingPath.split(' > ').pop() ?? '';
    if (isTurnLabel(last)) turns += 1;
  }
  return turns >= CONVERSATION_MIN_TURNS && turns * 2 >= distinct.size;
}
