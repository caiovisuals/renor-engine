import fs from 'fs';
import { dailyNoteDayName, decodeDailyNoteText, entryInstant, parseEntryHeader } from '../memory/dailyNote';

/**
 * When the daily-note entry a hit is part of was saved.
 *
 * A daily note is ONE file holding one entry per statement, so the date of the note (when the file was last written)
 * is the same for every entry of the day: a correction said later tied with what it corrects, and newest first could
 * put the stale one on top (live dogfood, D3). Each entry is a memory of its own (the chunker cuts one per entry) and
 * its header says when it was said: the day of its file, the time, and the offset of the clock it was stamped on. That
 * is `entryInstant`, the moment the memory map shows for the entry; an entry filed under an earlier day is dated by
 * that day.
 *
 * The offset is in the file only (readers get the user's own day and time without it), so the file is read, once per
 * note however many of its entries are hits, and only for a hit in a daily note. A hit is the entry whose text holds
 * it, as the index cut it. A hit that no entry holds, or that entries saved at different moments all hold (the file
 * changed since it was indexed, text above the first entry, a passage repeated across entries), keeps its note's date.
 */
export function createDailyEntryClock(): (hit: { notePath: string; text: string }) => Promise<string | undefined> {
  const notes = new Map<string, Promise<Array<{ text: string; at: string }>>>();
  return async hit => {
    const day = dailyNoteDayName(hit.notePath);
    if (day === null) return undefined;
    let entries = notes.get(hit.notePath);
    if (!entries) notes.set(hit.notePath, (entries = entriesOf(hit.notePath, day)));
    const at = new Set((await entries).filter(entry => entry.text.includes(hit.text)).map(entry => entry.at));
    return at.size === 1 ? [...at][0] : undefined;
  };
}

/** Every entry of a daily note, as readers get its text (its lines up to the next entry's), with the moment it was saved. */
async function entriesOf(notePath: string, day: string): Promise<Array<{ text: string; at: string }>> {
  let stored: string;
  try {
    stored = await fs.promises.readFile(notePath, 'utf8');
  } catch {
    return []; // gone since it was indexed: the hit keeps its note's date
  }
  // An entry starts where the stored text says one does (dailyEntryStarts), and its words are the decoded lines, which
  // the decode changes in place, never adding or removing one.
  const storedLines = stored.split('\n');
  const lines = decodeDailyNoteText(stored).split('\n');
  const starts = storedLines.flatMap((line, i) => (parseEntryHeader(line) ? [i] : []));
  return starts.map((start, k) => ({
    text: lines.slice(start, starts[k + 1] ?? lines.length).join('\n'),
    at: entryInstant(day, parseEntryHeader(storedLines[start])!),
  }));
}
