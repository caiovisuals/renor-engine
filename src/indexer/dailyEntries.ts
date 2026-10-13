import { hashContent } from './hasher';
import { ENTRY_LINE_RE, isDailyNotePath } from '../memory/dailyNote';

/**
 * How a daily note is cut into chunks, as a version: `entries-1` is one chunk per entry (see chunker.ts). A
 * note's chunks are only as current as the layout they were cut in, so the layout is part of what the index
 * remembers about a note (`noteContentHash`). Change how daily notes are cut and change this, and every daily note
 * the index holds is cut again by the next ordinary index pass.
 */
export const DAILY_CHUNK_LAYOUT = 'entries-1';

/**
 * What the index keeps to know a note is unchanged: the hash of its bytes and, for a daily note, of the layout its
 * chunks are cut in. An index built before the layout existed holds a note under the hash of its bytes alone, so the
 * next pass sees that note as changed, cuts it again and stores the new hash, once; nothing else about the note,
 * its file or any other note moves.
 */
export function noteContentHash(filePath: string, content: string): string {
  return hashContent(isDailyNotePath(filePath) ? `${DAILY_CHUNK_LAYOUT}\u0000${content}` : content);
}

/** How many line breaks (`\n` alone, as every reader of this format splits) lie before `end` in `text`. */
function newlinesBefore(text: string, end: number): number {
  let n = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at < end; at = text.indexOf('\n', at + 1)) n++;
  return n;
}

/**
 * Where the entries of a daily note start, as indices into the lines of its parsed `body`; undefined when it has
 * none (a file of free text under a `Daily/` folder, such as an imported journal, is cut like any other note).
 *
 * An entry starts at a line that begins at column 0 like `- [08:30:00] (claude) ...`. That is judged on the text as
 * stored, not as read: a statement's later line that looks like an entry is kept behind a backslash in the file so
 * it cannot forge one (dailyNote.ts), and once the words are restored it looks like an entry again. Cutting the
 * restored text on that shape would split a statement in two; the stored text says which lines really start one.
 * This is the same test the memory map uses, so a chunk is one of its entries.
 *
 * The restore changes lines in place, so line `i` of the stored text is line `i` of the decoded text; `rawBody` is
 * what follows the frontmatter there and `body` is that, trimmed, which fixes the line the body begins on.
 */
export function dailyEntryStarts(stored: string, decoded: string, rawBody: string, body: string): number[] | undefined {
  if (!decoded.endsWith(rawBody)) return undefined;
  const bodyAt = decoded.length - rawBody.length + (rawBody.length - rawBody.trimStart().length);
  const first = newlinesBefore(decoded, bodyAt);
  const bodyLines = body.split('\n');
  const storedLines = stored.split('\n');
  // Fail closed: if the restore ever changes the number of lines, the stored text no longer says which line is
  // which, so say nothing about entries and let the note be cut by headings as before. (The chunker checks each
  // start against the body once more.)
  if (storedLines.length !== newlinesBefore(decoded, decoded.length) + 1) return undefined;

  const starts: number[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = storedLines[first + i] ?? '';
    if (line.startsWith('- [') && ENTRY_LINE_RE.test(line)) starts.push(i);
  }
  return starts.length > 0 ? starts : undefined;
}
