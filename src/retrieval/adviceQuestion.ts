/**
 * Does a search query ask to be advised: for a recommendation, a suggestion, a tip, an idea or an opinion on what to do?
 * Told from the query's own words and nothing else (never a label of the question), because the query is all a search sees.
 * Its one use is the opt-in exception to the reader layout (readerLayout.ts, RENOR_READER_LAYOUT_SKIP_ADVICE).
 *
 * Narrow on purpose, since a wrong yes takes the layout from a question that wants it:
 *
 *  - a request is one of a few plain frames ("Can you recommend ...", "Any tips ...", "What should I ...", "What do you
 *    think"); a word such as "recommendations" inside a phrase that looks something up is not a request;
 *  - a query that points back at what was said before ("what did you recommend last time", "remind me", "our previous
 *    conversation") asks to recall an answer, not to be given one, and is not a request wherever the frame stands;
 *  - only the last line is read for the frame: the benchmark runner puts "Question date: ..." above the question.
 */

// "any" opens a clause ("Any tips?", "..., any suggestions?") or follows "do you have": "did I get any tips" looks something up.
const ANY_ADVICE = String.raw`any\s+(?:[\w'’-]+\s+){0,3}(?:tips?|advice|suggestions?|recommendations?|ideas|thoughts|pointers)\b`;

const REQUEST_FRAMES: readonly RegExp[] = [
  /\b(?:can|could|would|will) you (?:please )?(?:recommend|suggest|advise)\b/i,
  new RegExp(String.raw`(?:^|[,;:.!?]\s*|\bdo you have\s+)${ANY_ADVICE}`, 'i'),
  /\bwhat should i\b/i,
  /\b(?:what do you think|do you think|what would you (?:do|recommend|suggest))\b/i,
];

const POINTS_AT_THE_PAST = new RegExp([
  String.raw`\byou (?:recommended|suggested|advised|told|said|mentioned|gave|provided|listed|named)\b`,
  String.raw`\blast time\b`,
  String.raw`\bearlier\b`,
  String.raw`\bremind me\b`,
  String.raw`\bwe (?:discussed|talked|chatted|spoke)\b`,
  String.raw`\bour (?:previous|last|earlier|past) (?:chat|conversation|discussion)s?\b`,
  String.raw`\bprevious(?:ly)?\b`,
  String.raw`\bdid you\b`,
].join('|'), 'i');

function lastLine(query: string): string {
  const lines = query.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

export function asksForAdvice(query: string): boolean {
  if (POINTS_AT_THE_PAST.test(query)) return false;
  const question = lastLine(query);
  return REQUEST_FRAMES.some(frame => frame.test(question));
}
