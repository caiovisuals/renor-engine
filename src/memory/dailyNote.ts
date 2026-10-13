/**
 * The daily-note format, in one place: how a day's file is recognised, how an entry starts, and how the
 * user's own words are kept from being mistaken for an entry.
 *
 * A day's file (`.../Daily/YYYY-MM-DD.md`) holds one entry per statement: a line that starts at column 0
 * with its time and source (`- [08:30:00] (claude) first line`), then the statement's other lines. Those
 * other lines are the user's words and may look like anything, including another entry. The file is read
 * line by line and an entry is whatever starts at column 0 like that, so such a line would forge an entry
 * and split the statement it belongs to.
 *
 * The words are therefore kept behind a reversible escape instead of being altered or refused: a later
 * line that starts like an entry gets one backslash in front (`\- [08:30:00] (alice) secret`, which a
 * Markdown reader shows as the text it was). To keep the escape unambiguous, a line that already starts
 * with backslashes before an entry-shaped start gets one more.
 *
 * The escape is told apart from the user's own text by a mark on the entry that carries it, not by the
 * shape of a line. An entry whose statement was escaped says so in its own header, after the source name
 * (`- [08:30:00] (claude+esc) first line`); only inside such an entry is a backslash line decoded. A note
 * written before the mark existed has no marked entry, so every line of it reads back exactly as stored,
 * including a line whose backslash was the user's own. The mark cannot be forged: the writer keeps a
 * source to letters, digits and hyphens, so no earlier entry has a `+` there, and a statement cannot
 * write a header because its own entry-shaped lines are exactly the ones that get escaped.
 *
 * Reading undoes the escape at the two places that turn a daily file into text (`parseNote` for
 * everything built from the file's text, and the memory map's entry parser), so every reader gets back
 * exactly what was said, and neither the backslash nor the mark (nor the offset an entry on the user's
 * clock carries). Only the raw Markdown file shows them.
 *
 * Both directions split on '\n' alone, exactly as the entry parser does. A JavaScript `m`-flag `^` would
 * also start a line after a lone CR, U+2028 or U+2029, which are not line breaks in this format.
 */

/**
 * A daily note: `.../Daily/YYYY-MM-DD.md`. Group 2 is the date.
 *
 * A path under the import namespace (`Imported/<label>/…`) is never a daily note, whatever it is called: the
 * import tool writes untrusted source files as ordinary notes (`Imported/`, importing/hosted.ts), so a source
 * folder called `Daily/` must not turn an imported file into the engine's own daily log. Without this, a file
 * imported at `Daily/YYYY-MM-DD.md` was read as a daily log: its `- [HH:MM:SS] (source) text` lines became
 * entries attributed to a source the importer chose, and a prose file there vanished from memory_map and the
 * export. The engine's own daily logs live under `Memory/Daily/` or `Memory/Scopes/<slug>/Daily/`, never under
 * `Imported/`.
 */
export const DAILY_FILE_RE = /^(?!Imported\/)(?:(.*)\/)?Daily\/(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * An entry's first line is everything after its prefix, and lines are split on '\n' alone. dotAll, because
 * `.` otherwise refuses U+2028, U+2029 and a lone \r in the text, and an entry whose first line holds one of
 * them stopped being an entry: it was folded into the one above it, so retiring that neighbour took it too.
 */
export const ENTRY_LINE_RE = /^- \[(\d{2}:\d{2}:\d{2})\] \(([^)]*)\) (.*)$/s;

/** Follows the source name in the header of an entry whose statement carries the escape. */
export const ESCAPE_MARK = '+esc';

/**
 * Follows the source name in the header of an entry stamped on the user's own clock rather than in UTC: that clock's
 * offset from UTC (`- [21:00:01] (cursor, UTC-03:00) ...`). The entry's day and time are then the user's, and the
 * offset keeps the moment exact. An entry without it was stamped in UTC, as every entry was before it existed. A
 * source is kept to letters, digits and hyphens, so no source name can write it; it comes before the escape mark,
 * so a release that does not know it still finds the escape. Like the escape mark it is the file's, not the
 * reader's: readers get the user's day and time without it (so it is never searched for, nor paid for in tokens),
 * and the memory map reads it from the file for the exact moment.
 */
const OFFSET_MARK_RE = /, UTC([+-]\d{2}:\d{2})$/;
const offsetMark = (offset: string | undefined) => (offset ? `, UTC${offset}` : '');

/** A line that starts like an entry (whatever follows the parenthesis), behind any number of backslashes. */
const ENTRY_SHAPED = /^\\*- \[\d{2}:\d{2}:\d{2}\] \(/;
/** The same, with at least one backslash: a line the writer escaped. */
const ESCAPED_ENTRY_SHAPED = /^\\+- \[\d{2}:\d{2}:\d{2}\] \(/;

/** Is this file one of the engine's daily notes? Separators are normalised so a Windows path matches too. */
export function isDailyNotePath(filePath: string): boolean {
  return DAILY_FILE_RE.test(filePath.replace(/\\/g, '/'));
}

/**
 * The front-matter key the engine writes into every daily note it creates (`updated: YYYY-MM-DD`, in writer.ts and
 * where the memory map restores an entry into a day that has no file). It is the day the file is about.
 */
export const DAILY_NOTE_HEADER_KEY = 'updated';

/** The day a daily note's own name gives (`.../Daily/2026-10-03.md` is `2026-10-03`), or null when the path is no daily note or the name is no real day. */
export function dailyNoteDayName(filePath: string): string | null {
  const match = DAILY_FILE_RE.exec(filePath.replace(/\\/g, '/'));
  if (!match) return null;
  const at = Date.parse(`${match[2]}T00:00:00Z`);
  // `2026-02-31` parses (as March 3rd): only a name that survives the round trip is a day.
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === match[2] ? match[2] : null;
}

/**
 * The line the engine writes into the front matter of every daily note it creates. It is how a note the engine wrote is
 * told from a person's note in the same folder: not by where the note is, what it is called or what it says (a person
 * writes `updated: 2026-03-30` and timestamped lines too), but by a stamp that nothing but the engine's writers puts
 * there; a person would have to copy it on purpose. Bump the version, never the key, if the layout changes.
 */
export const DAILY_NOTE_MARKER = 'renor: daily-v1';

/**
 * What the engine writes at the top of every daily note it creates (writer.ts, one write with the first entry after it,
 * and the memory map when it restores an entry into a day that has no file): its `kind: note`, the day as a bare YAML
 * date, the marker, and the heading. A test pins both writers to this function.
 *
 * Before the marker existed the engine wrote the same without its line, and those notes are still on disk (see
 * `isEngineDailyNote`).
 */
export function engineDailyHeader(day: string): string {
  return `---\nkind: note\nupdated: ${day}\n${DAILY_NOTE_MARKER}\n---\n# ${day}\n`;
}

/** The text between the fences of the front matter that opens `head`, or null when it does not open with one that closes in it. */
function frontMatterBlock(head: string): string | null {
  if (!head.startsWith('---\n')) return null;
  const end = head.indexOf('\n---\n', 3);
  return end === -1 ? null : head.slice(4, Math.max(4, end));
}

/**
 * Did the engine write this daily note? One rule, over the front matter alone, never the body (a person can write
 * anything in the body, timestamped lines in the engine's own format included). The note must be in the daily layout
 * with a real day for its name, and then:
 *
 *  - a note the engine has written since it stamps its notes carries the marker line, `renor: daily-v1`, in its front
 *    matter;
 *  - a note written before that has none, and is told only by being the complete front matter the engine then wrote,
 *    every key, value and its order and nothing else in it: `kind: note`, then `updated:` with the day of the note's own
 *    name (the engine wrote nothing else, so nothing else matches).
 *
 * A note that is neither keeps what it says: a natural `updated: 2026-03-30`, a further or reordered key, a quoted date,
 * another day, a marker-less note anywhere else, a marker in the body. What this cannot do is tell an old note of the
 * engine's from a person's note that copies its two lines exactly, or one that copies the marker: they are the same
 * bytes. That is why the answer is about the note and the fact dropped is narrower (`isEngineHeaderDate`).
 *
 * `head` is the start of the file (the front matter is a few dozen bytes; a front matter that does not close in `head`
 * is not the engine's).
 */
export function isEngineDailyNote(filePath: string, head: string): boolean {
  const day = dailyNoteDayName(filePath);
  const block = day === null ? null : frontMatterBlock(head);
  if (day === null || block === null) return false;
  return block.split('\n').includes(DAILY_NOTE_MARKER) || block === `kind: note\nupdated: ${day}`;
}

/**
 * Does this daily note hold nothing but what the engine wrote at its top: its own front matter (`isEngineDailyNote`), the
 * heading of its day, and blank lines? That is what is left of a day whose last entry was retired, and none of it is
 * anyone's memory. A line a person wrote anywhere in it, or a front matter that is theirs, makes it a note that holds
 * something.
 */
export function isEmptyEngineDailyNote(filePath: string, content: string): boolean {
  const day = dailyNoteDayName(filePath);
  if (day === null || !isEngineDailyNote(filePath, content)) return false;
  const body = content.slice(content.indexOf('\n---\n', 3) + '\n---\n'.length);
  return body.split('\n').every(line => line === `# ${day}` || /^[ \t\r]*$/.test(line));
}

/**
 * Is this front-matter value the engine's own `updated`: the bare date of the note's own day, which YAML reads as that
 * day's midnight (UTC)? In a note the engine wrote that is the only value of `updated` that is bookkeeping. A person's
 * own value in it (a plugin that stamps the time it was saved, another day, a quoted date) is theirs and is kept.
 */
export function isEngineHeaderDate(filePath: string, value: unknown): boolean {
  const day = dailyNoteDayName(filePath);
  return day !== null && value instanceof Date && value.getTime() === Date.parse(`${day}T00:00:00Z`);
}

/** What `Date.prototype.toString` prints: the Date a bare YAML date becomes, in the timezone of the host that printed it. */
const DATE_TO_STRING_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \(.+\))?$/;

/**
 * Is this the text an earlier indexer stored as the "fact" `updated` of a daily note's header: the Date of the note's
 * own day, printed in the timezone of the host that indexed it (any zone: it is read back to the day)? It says what the
 * row looks like; whether the note is the engine's is `isEngineDailyNote`'s to say.
 */
export function isEarlierHeaderText(filePath: string, text: unknown): boolean {
  const day = dailyNoteDayName(filePath);
  return day !== null && typeof text === 'string' && DATE_TO_STRING_RE.test(text) && Date.parse(text) === Date.parse(`${day}T00:00:00Z`);
}

export interface EntryHeader {
  time: string;
  /** The source name, without the escape mark or the offset. */
  source: string;
  /** The offset from UTC of the clock the day and time are on (`-03:00`); absent for UTC. */
  offset?: string;
  /** Does this entry carry the escape: is a backslash line inside it the writer's, to be decoded? */
  escaped: boolean;
  /** Everything after the prefix: the statement's first line. */
  text: string;
}

/** The parts of an entry's first line, or null when the line does not start an entry. */
export function parseEntryHeader(line: string): EntryHeader | null {
  if (!line.startsWith('- [')) return null; // most lines of a note: skip the regex
  const m = ENTRY_LINE_RE.exec(line);
  if (!m) return null;
  const escaped = m[2].endsWith(ESCAPE_MARK);
  const named = escaped ? m[2].slice(0, -ESCAPE_MARK.length) : m[2];
  const clock = OFFSET_MARK_RE.exec(named);
  return {
    time: m[1],
    source: clock ? named.slice(0, clock.index) : named,
    ...(clock ? { offset: clock[1] } : {}),
    escaped,
    text: m[3],
  };
}

/**
 * When an entry was saved, as an ISO instant: the day of its file and the time of its header, on the clock the header
 * names (UTC when it names none, exactly as before offsets existed). An offset that makes no real time, which only a
 * hand edit can write, is read as UTC too.
 */
export function entryInstant(day: string, header: Pick<EntryHeader, 'time' | 'offset'>): string {
  const utc = `${day}T${header.time}.000Z`;
  if (!header.offset) return utc;
  const at = Date.parse(`${day}T${header.time}${header.offset}`);
  return Number.isNaN(at) ? utc : new Date(at).toISOString();
}

/**
 * A statement as it is written into an entry. The first line follows the entry's prefix, so it is never at
 * column 0; only the later lines can start like an entry and need the escape. `escaped` says whether any
 * did, which is what the entry's header must then record.
 */
export function encodeEntryText(text: string): { text: string; escaped: boolean } {
  const lines = text.split('\n');
  let escaped = false;
  for (let i = 1; i < lines.length; i++) {
    if (ENTRY_SHAPED.test(lines[i])) {
      lines[i] = `\\${lines[i]}`;
      escaped = true;
    }
  }
  return { text: lines.join('\n'), escaped };
}

/** The inverse of the escape for one line of an escaped entry. */
export function decodeEntryLine(line: string): string {
  return ESCAPED_ENTRY_SHAPED.test(line) ? line.slice(1) : line;
}

/**
 * One entry exactly as the writer stores it (without the line break that separates entries). `escape` is
 * false for a file that is not in the daily-note layout, which is written as said. `offset` is given when
 * `time` is on the user's clock rather than UTC.
 */
export function formatEntry(time: string, source: string, text: string, escape = true, offset?: string): string {
  const body = escape ? encodeEntryText(text) : { text, escaped: false };
  return `- [${time}] (${source}${offsetMark(offset)}${body.escaped ? ESCAPE_MARK : ''}) ${body.text}`;
}

/**
 * The inverse for the text of a whole daily note: inside each marked entry every escaped line gets its
 * words back, and the header loses the mark; a header loses its offset too. An entry with neither is left
 * exactly as stored, and so is everything before the first entry. Applying it twice changes nothing more,
 * because the first pass removes the marks.
 */
export function decodeDailyNoteText(content: string): string {
  const lines = content.split('\n');
  let inEscapedEntry = false;
  for (let i = 0; i < lines.length; i++) {
    const header = parseEntryHeader(lines[i]);
    if (header) {
      inEscapedEntry = header.escaped;
      if (header.escaped || header.offset) lines[i] = `- [${header.time}] (${header.source}) ${header.text}`;
    } else if (inEscapedEntry) {
      lines[i] = decodeEntryLine(lines[i]);
    }
  }
  return lines.join('\n');
}
