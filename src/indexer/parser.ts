import matter from 'gray-matter';
import path from 'path';
import { decodeDailyNoteText, isDailyNotePath } from '../memory/dailyNote';
import { dailyEntryStarts } from './dailyEntries';

export interface ParsedNote {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  wikilinks: string[];
  /** A daily note only: the lines of `body` where its entries start (see dailyEntryStarts). Absent when it has none. */
  entryStarts?: number[];
}

/** One wikilink: where it ends, and its raw target. */
interface WikilinkSpan {
  end: number;
  target: string;
}

/**
 * The first index at or after `p` where `pattern` matches (the text's length when none does), memoised: every p
 * up to that index has the same answer, so a run of failing `[[` starts shares one scan. Without it each start
 * scans to the end of the text and a pathological note (`[[[[...`) costs O(n^2).
 */
function nextMatch(text: string, pattern: RegExp): (p: number) => number {
  let from = -1;
  let at = -1;
  return p => {
    if (from <= p && p <= at) return at;
    pattern.lastIndex = p;
    const m = pattern.exec(text);
    from = p;
    at = m === null ? text.length : m.index;
    return at;
  };
}

/**
 * The wikilinks in `text` from `from`, matched as `[[target]]`, `[[target|alias]]` or `[[target#heading]]`: the
 * target is the run up to the first `]`, `|` or `#` (it may span lines), closed by `]]`, or by a `|` or `#` and an
 * alias that ends at the first `]` followed by another `]`. Matches do not overlap, and a `[[` that does not close
 * is retried one character on. The same matches as the regex /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g, in linear time.
 */
function wikilinkSpans(text: string, from: number): WikilinkSpan[] {
  const spans: WikilinkSpan[] = [];
  const nextDelimiter = nextMatch(text, /[\]|#]/g);
  const nextBracket = nextMatch(text, /\]/g);
  let open = text.indexOf('[[', from);
  while (open !== -1) {
    const start = open + 2;
    const delimiter = nextDelimiter(start);
    let end = -1;
    if (delimiter > start && delimiter < text.length) {
      if (text[delimiter] === ']') {
        if (text[delimiter + 1] === ']') end = delimiter + 2;
      } else {
        const close = nextBracket(delimiter + 1);
        if (text[close + 1] === ']') end = close + 2;
      }
    }
    if (end === -1) {
      open = text.indexOf('[[', open + 1);
    } else {
      spans.push({ end, target: text.slice(start, delimiter) });
      open = text.indexOf('[[', end);
    }
  }
  return spans;
}

/**
 * Frontmatter is stored as JSON. A YAML alias shares one parsed value, so a small note can serialize to
 * far more bytes than it holds: a 2,500-character scalar aliased 2,000 times is a 15 KB note and 5 MB of
 * JSON. Total the serialized size while walking the expanded tree and refuse past a bound proportional to
 * the note, before anything is written.
 */
const FRONTMATTER_FLOOR_BYTES = 64 * 1024;
const FRONTMATTER_EXPANSION = 4;
const FRONTMATTER_DEPTH_LIMIT = 64;

export function assertFrontmatterBounded(value: unknown, sourceLength: number): void {
  const limit = FRONTMATTER_FLOOR_BYTES + FRONTMATTER_EXPANSION * sourceLength;
  let size = 0;
  const walk = (v: unknown, depth: number): void => {
    if (depth > FRONTMATTER_DEPTH_LIMIT) throw new Error('Markdown frontmatter is too large or deeply aliased');
    // Size each value the way JSON.stringify will write it, including toJSON (dates, binary).
    if (v && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON(): unknown }).toJSON();
    if (Array.isArray(v)) {
      size += 2 + Math.max(v.length - 1, 0); // brackets and commas
      for (const child of v) walk(child, depth + 1);
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v);
      size += 2 + Math.max(entries.length - 1, 0);
      for (const [key, child] of entries) { size += JSON.stringify(key).length + 1; walk(child, depth + 1); }
    } else {
      size += JSON.stringify(v)?.length ?? 0;
    }
    if (size > limit) throw new Error('Markdown frontmatter is too large or deeply aliased');
  };
  walk(value, 0);
}

/**
 * gray-matter caches every string it parses, and caches before it parses: a parse that throws leaves empty
 * `data` in the cache and the next call for the same text returns it as if it had parsed. Any options object
 * bypasses that cache. It also ships a JavaScript engine that evaluates `---js` frontmatter as code; a note
 * is data, so only the YAML and JSON engines are usable.
 */
const MATTER_OPTIONS = {
  engines: {
    javascript: (): never => { throw new Error('Unsupported frontmatter language: javascript'); },
  },
};

export function parseNote(filePath: string, content: string): ParsedNote {
  return parseNoteDetailed(filePath, content).note;
}

/**
 * parseNote, with what the indexer needs to index an append to the note by its appended part (pipeline.ts): the
 * text after the frontmatter the body was trimmed from (a suffix of `content`), and whether the title came from a
 * heading in it rather than from the file name.
 */
export function parseNoteDetailed(filePath: string, content: string): { note: ParsedNote; rawBody: string; titleFromHeading: boolean } {
  // The one door every reader of a note's text goes through (the index behind search, recall and get_context,
  // the memory map's note view, the evidence pass). A daily note keeps a line of the user's words that would
  // start like an entry behind a backslash; the words are restored here, so none of them sees the escape.
  const text = isDailyNotePath(filePath) ? decodeDailyNoteText(content) : content;
  const { data, content: rawBody } = matter(text, MATTER_OPTIONS);
  // Only a mapping is front matter. YAML also parses a list, a string, a number or a date as a document, and passing
  // one on made the export write a list's items as keys `0`, `1`, ...
  const frontmatter: Record<string, unknown> = Object.prototype.toString.call(data) === '[object Object]' ? data : {};
  assertFrontmatterBounded(frontmatter, content.length);
  const heading = rawBody.match(/^#\s+(.+)$/m);
  const title = heading?.[1].trim() ?? path.basename(filePath, '.md');
  const wikilinks = wikilinkTargets(rawBody);

  const body = rawBody.trim();
  const entryStarts = isDailyNotePath(filePath) ? dailyEntryStarts(content, text, rawBody, body) : undefined;

  return {
    note: {
      path: filePath,
      title,
      frontmatter,
      body,
      wikilinks,
      ...(entryStarts ? { entryStarts } : {}),
    },
    rawBody,
    titleFromHeading: heading !== null,
  };
}

/** The wikilink targets in `text`, each once, in the order they first appear. */
export function wikilinkTargets(text: string, from = 0): string[] {
  return [...new Set(wikilinkSpans(text, from).map(s => s.target.trim()))].filter(Boolean);
}

/**
 * Whether text appended to `text` can only add wikilinks after the ones it holds, scanning as `wikilinkTargets`
 * does from `from`. A link's target may span lines, so an opening `[[` with no `]` after it could still be closed
 * by what is appended, and become a link that starts in `text`; any other opening is settled by a `]` in `text`.
 */
export function wikilinksSettled(text: string, from = 0): boolean {
  let settledTo = from;
  for (const span of wikilinkSpans(text, from)) settledTo = span.end;
  const open = text.lastIndexOf('[[');
  return open < settledTo || text.indexOf(']', open + 2) !== -1;
}
