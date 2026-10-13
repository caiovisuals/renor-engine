import { createHash } from 'crypto';
import { encodeTokens } from './tokenizer';
import { ParsedNote } from './parser';
import { MAX_STATEMENT_LENGTH } from '../memory/limits';

export interface Chunk {
  notePath: string;
  headingPath: string;
  text: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

/** Token count for chunking. Special-token syntax (`<|im_start|>`, `<|endoftext|>`, …)
 * can legitimately appear inside note CONTENT (e.g. imported ShareGPT histories);
 * gpt-tokenizer rejects such text as chat protocol by default and would crash
 * indexing. We count them as plain text instead of failing closed — that is what
 * encodeTokens does, which is also why the tokenizer is loaded on first use
 * rather than at import (see ./tokenizer).
 *
 * Counts are remembered by text. A note that is appended to is chunked whole again each time,
 * and all of it but the tail is text already counted; counting was most of that pass. The memory
 * kept is capped. A text of up to COUNTED_TEXT_MAX characters is kept by its text; a longer one, up to
 * COUNTED_LONG_MAX, by its SHA-256, so a daily note's entries (up to a statement's 4,000 characters each) are
 * counted once, not on every save, and the cache holds a digest for each, not the entry. Longer texts are counted
 * every time.
 *
 * The key kept is never a slice of the note. A chunk's text is a slice, and a slice of a long string keeps the
 * whole string alive: kept as it was, each text remembered held the note it was cut from (3.4 MB for a day's
 * note), the cap counted only the slice, and a daily note's engine grew by the note's size with every save. */
const COUNTED_WEIGHT_LIMIT = 8_000_000;
const COUNTED_TEXT_MAX = 2_000;
const COUNTED_LONG_MAX = 100_000;
/** What a text kept by its digest counts against COUNTED_WEIGHT_LIMIT: the digest and the map's entry. */
const COUNTED_DIGEST_WEIGHT = 128;
const counted = new Map<string, number>();
const countedLong = new Map<string, number>();
let countedWeight = 0;
// A round trip through JSON builds a new string with the same code units, a lone surrogate included.
const owned = (s: string): string => JSON.parse(JSON.stringify(s)) as string;
const tokens = (s: string): number => {
  if (s.length > COUNTED_LONG_MAX) return encodeTokens(s);
  const long = s.length > COUNTED_TEXT_MAX;
  const memo = long ? countedLong : counted;
  const key = long ? createHash('sha256').update(s, 'utf16le').digest('base64') : s;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const n = encodeTokens(s);
  const weight = long ? COUNTED_DIGEST_WEIGHT : s.length;
  if (countedWeight + weight > COUNTED_WEIGHT_LIMIT) {
    counted.clear();
    countedLong.clear();
    countedWeight = 0;
  }
  memo.set(long ? key : owned(s), n);
  countedWeight += weight;
  return n;
};

export function chunkNote(note: ParsedNote, options: ChunkOptions = {}): Chunk[] {
  return chunkNoteCut(note, options).chunks;
}

/**
 * Where a note cut by headings starts its last section: the body line, and the heading stack in force before that
 * line. Text appended to the note can change that section and add sections after it, never the ones before it.
 */
export interface LastSection {
  line: number;
  stack: string[];
}

/**
 * How a note was cut: its chunks and, when it was cut by headings, where the last section starts (`last`) and the
 * index in `chunks` of that section's first chunk (`lastFirst`). Both are absent for a daily note cut by entry and
 * for a note that is one whole-body chunk.
 */
export interface NoteCut {
  chunks: Chunk[];
  last?: LastSection;
  lastFirst?: number;
}

/** chunkNote, and where its last section starts (see NoteCut). */
export function chunkNoteCut(note: ParsedNote, options: ChunkOptions = {}): NoteCut {
  const lines = note.body.split('\n');
  const entries = entryRanges(note, lines);
  if (entries) return { chunks: chunkEntries(note, lines, entries, options) };
  const cut = splitByHeadings(lines, 0, []);
  const { chunks, lastFirst } = chunkSections(note.path, cut.sections, options);

  return chunks.length > 0
    ? { chunks, last: cut.last, lastFirst }
    : {
        chunks: [
          {
            notePath: note.path,
            headingPath: '',
            text: note.body.trim(),
            startLine: 0,
            endLine: lines.length,
            tokenCount: tokens(note.body),
          },
        ],
      };
}

/**
 * The chunks chunkNote cuts from body line `from` on, in a note whose body lines before `from` are unchanged and
 * whose last section, before, started at `from` with the heading stack `stack` (see LastSection): `lines` are the
 * body's lines from `from` to its end. Every number in the result is a line of the whole body.
 */
export function chunkBodyFrom(notePath: string, lines: string[], from: LastSection, options: ChunkOptions = {}): NoteCut {
  const cut = splitByHeadings(lines, from.line, from.stack);
  const { chunks, lastFirst } = chunkSections(notePath, cut.sections, options);
  return { chunks, last: cut.last, lastFirst };
}

function chunkSections(notePath: string, sections: Section[], options: ChunkOptions): { chunks: Chunk[]; lastFirst: number } {
  const max = options.maxTokens ?? 400;
  const overlap = options.overlapTokens ?? 0;
  const chunks: Chunk[] = [];
  let lastFirst = 0;

  for (const sec of sections) {
    lastFirst = chunks.length;
    const text = sec.lines.join('\n').trim();
    if (!text) continue;
    if (tokens(text) <= max) {
      chunks.push({
        notePath,
        headingPath: sec.headingPath,
        text,
        startLine: sec.startLine,
        endLine: sec.endLine,
        tokenCount: tokens(text),
      });
    } else {
      chunks.push(...splitByParagraphs(text, sec.headingPath, notePath, sec.startLine, max, overlap));
    }
  }
  return { chunks, lastFirst };
}

interface Section {
  headingPath: string;
  lines: string[];
  startLine: number;
  endLine: number;
}

/**
 * The sections of `lines`, numbered from line `offset` of the body, read with the heading stack `initial` in force
 * before the first line; and where the last of them starts (see LastSection).
 */
function splitByHeadings(lines: string[], offset: number, initial: string[]): { sections: Section[]; last: LastSection } {
  const sections: Section[] = [];
  let stack: string[] = initial;
  let before = initial; // the stack in force before the heading that started the section being read
  let buf: string[] = [];
  let start = 0;

  for (let i = 0; i < lines.length; i++) {
    const h1 = lines[i].match(/^#\s+(.+)$/);
    const h2 = !h1 ? lines[i].match(/^##\s+(.+)$/) : null;
    const h3 = !h1 && !h2 ? lines[i].match(/^###\s+(.+)$/) : null;
    if (h1 || h2 || h3) {
      if (buf.length) sections.push({ headingPath: stack.join(' > '), lines: buf, startLine: offset + start, endLine: offset + i });
      before = stack;
      if (h1) stack = [h1[1].trim()];
      else if (h2) stack = [stack[0] ?? '', h2[1].trim()].filter(Boolean);
      else if (h3) stack = [stack[0] ?? '', stack[1] ?? '', h3[1].trim()].filter(Boolean);
      buf = [lines[i]];
      start = i;
    } else {
      buf.push(lines[i]);
    }
  }
  if (buf.length) sections.push({ headingPath: stack.join(' > '), lines: buf, startLine: offset + start, endLine: offset + lines.length });
  return { sections, last: { line: offset + start, stack: before } };
}

/** A paragraph and what joins it to the one before it in a chunk: a blank line, or nothing for the rest of a paragraph that was cut. */
interface Para {
  text: string;
  sep: string;
}

function splitByParagraphs(text: string, headingPath: string, notePath: string, base: number, max: number, overlapTokens: number = 0): Chunk[] {
  const paras: Para[] = text.split(/\n\n+/).flatMap(p =>
    (p.length > ONE_CHUNK_CHARS
      ? splitOversized(p, max).map((piece, i): Para => ({ text: piece, sep: i === 0 ? '\n\n' : '' }))
      : [{ text: p, sep: '\n\n' }]));
  const joined = (buf: Para[]) => buf.map((q, i) => (i === 0 ? q.text : q.sep + q.text)).join('');
  const chunks: Chunk[] = [];
  let buf: Para[] = [];
  let bt = 0;
  let offset = base;

  for (const para of paras) {
    const p = para.text;
    const pt = tokens(p);
    if (bt + pt > max && buf.length > 0) {
      const ct = joined(buf);
      const lc = ct.split('\n').length;
      chunks.push({ notePath, headingPath, text: ct, startLine: offset, endLine: offset + lc, tokenCount: tokens(ct) });
      // The rest of a cut paragraph goes on from where this chunk stops, on the same line or the next, not a line below.
      offset += para.sep === '' ? lc - 1 : lc;

      // Implement overlap: carry over last paragraph(s) that fit within overlapTokens
      buf = [];
      bt = 0;
      if (overlapTokens > 0) {
        let overlapBuf: Para[] = [];
        let overlapBt = 0;
        // Start from the end of the previous buffer and work backwards to find paragraphs that fit
        const prevParas = ct.split('\n\n');
        for (let i = prevParas.length - 1; i >= 0; i--) {
          const prevPt = tokens(prevParas[i]);
          if (overlapBt + prevPt <= overlapTokens) {
            overlapBuf.unshift({ text: prevParas[i], sep: '\n\n' });
            overlapBt += prevPt;
          } else {
            break;
          }
        }
        buf = overlapBuf;
        bt = overlapBt;
        // Adjust offset backwards to account for overlap content
        if (overlapBuf.length > 0) {
          const overlapLines = joined(overlapBuf).split('\n').length;
          offset -= overlapLines;
        }
      }
    }
    buf.push(para);
    bt += pt;
  }
  if (buf.length) {
    const ct = joined(buf);
    chunks.push({ notePath, headingPath, text: ct, startLine: offset, endLine: offset + ct.split('\n').length, tokenCount: tokens(ct) });
  }
  return chunks;
}

/** A line of only spaces, tabs and carriage returns is layout: the memory map's rule for where an entry ends. */
const BLANK_LINE_RE = /^[ \t\r]*$/;
/** How an entry's first line begins. The body is trimmed, so a last entry of nothing but spaces has lost the space after its source. */
const ENTRY_START_RE = /^- \[\d{2}:\d{2}:\d{2}\] \(/;

/** Does this text hold anything besides headings? A heading with nothing under it is a title, not a memory. */
const hasBody = (text: string) => text.split('\n').some(l => l.trim() !== '' && !/^#{1,6}\s/.test(l));

/**
 * A daily note's entries as [start, end) line ranges of its body, or null when the note is cut by headings and
 * paragraphs instead (it is not a daily note, or has no entry). An entry runs from the line that starts it to the
 * next entry, less the blank lines that lay out the file; everything in it is the statement's, whatever it looks like.
 */
function entryRanges(note: ParsedNote, lines: string[]): Array<[number, number]> | null {
  const starts = note.entryStarts;
  if (!starts || starts.length === 0) return null;
  // The starts were found on the stored text. If the body no longer agrees (a start that is not an entry's first
  // line, or out of order), cut by headings rather than cut a statement in the wrong place.
  let previous = -1;
  for (const start of starts) {
    if (!Number.isInteger(start) || start <= previous || start >= lines.length || !ENTRY_START_RE.test(lines[start])) return null;
    previous = start;
  }
  return starts.map((start, k): [number, number] => {
    let end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    while (end > start + 1 && BLANK_LINE_RE.test(lines[end - 1])) end--;
    return [start, end];
  });
}

/**
 * One chunk per entry of a daily note, so that recalling one memory returns that memory and not the day it was said
 * on. An entry is cut whole whatever its words contain (headings, blank lines, `---`, a line that looks like another
 * entry); one longer than a chunk is cut into paragraphs, but never together with another entry. The chunk is the
 * entry as the memory map shows it, its time and source included, under the heading the note opens with
 * (`2026-10-03`). What stands above the first entry is cut as any note is, minus a heading with nothing under it,
 * since every entry already carries that heading in its path.
 */
function chunkEntries(note: ParsedNote, lines: string[], entries: Array<[number, number]>, options: ChunkOptions): Chunk[] {
  const max = options.maxTokens ?? 400;
  const overlap = options.overlapTokens ?? 0;
  const chunks: Chunk[] = [];

  const above = lines.slice(0, entries[0][0]);
  let headingPath = '';
  if (above.some(l => l.trim() !== '')) {
    const { sections } = splitByHeadings(above, 0, []);
    headingPath = sections[sections.length - 1].headingPath;
    for (const chunk of chunkNote({ ...note, body: above.join('\n'), entryStarts: undefined }, options)) {
      if (hasBody(chunk.text)) chunks.push(chunk);
    }
  }

  for (const [start, end] of entries) {
    const text = lines.slice(start, end).join('\n');
    const tokenCount = tokens(text);
    if (tokenCount <= max) {
      chunks.push({ notePath: note.path, headingPath, text, startLine: start, endLine: end, tokenCount });
    } else {
      chunks.push(...splitByParagraphs(text, headingPath, note.path, start, max, overlap));
    }
  }
  return chunks;
}

/**
 * A paragraph this short stays one chunk however many tokens it holds, as every paragraph did. A statement the engine
 * saved is up to MAX_STATEMENT_LENGTH characters, stored with each character that needs it as a six-character \uXXXX
 * escape, and it is one daily entry, one chunk and recalled as exactly its words (tests/mvp/statement-ledger.test.ts).
 * A longer paragraph came from a pasted log, an import or a hostile file, and is cut at the chunk limit.
 */
const ONE_CHUNK_CHARS = MAX_STATEMENT_LENGTH * 8;
const PIECE_CHARS = 256;

/** The end of a piece that starts at `from` and wants to end at `to`: after the last space or newline in its back half, never inside a surrogate pair. */
function pieceEnd(p: string, from: number, to: number): number {
  if (to >= p.length) return p.length;
  const floor = from + ((to - from) >> 1);
  for (let cut = to; cut > floor; cut--) {
    if (p[cut] === ' ' || p[cut] === '\n') return cut + 1;
  }
  const last = p.charCodeAt(to - 1);
  return last >= 0xd800 && last < 0xdc00 && to - from > 1 ? to - 1 : to;
}

/**
 * A paragraph over `max` tokens (one long line, a pasted log, a minified blob), cut at whitespace into pieces of at most
 * `max` tokens. Only short pieces are counted, never the whole, and a piece that is still over `max` (CJK, emoji) is halved,
 * so the cost is what the paragraph holds. The pieces are chunked like paragraphs.
 */
function splitOversized(p: string, max: number): string[] {
  const out: string[] = [];
  let buf = '';
  let bt = 0;
  for (let i = 0; i < p.length;) {
    let j = pieceEnd(p, i, i + PIECE_CHARS);
    let pt = tokens(p.slice(i, j));
    while (pt > max && j - i > 2) {
      j = pieceEnd(p, i, i + ((j - i) >> 1));
      pt = tokens(p.slice(i, j));
    }
    if (bt + pt > max && buf) {
      out.push(buf);
      buf = '';
      bt = 0;
    }
    buf += p.slice(i, j);
    bt += pt;
    i = j;
  }
  if (buf) out.push(buf);
  return out;
}
