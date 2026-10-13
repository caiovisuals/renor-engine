import { ImportNote } from './types';

export interface RenderedNote {
  /** Exact bytes to write. */
  content: string;
  /**
   * Line ranges of each chunk inside `content`, 0-based and half-open.
   *
   * Deliberately TIGHT around the chunk's own text (`{0,3}` for a three-line chunk at
   * the top of a file), which is exact for a citation. This is not byte-identical to
   * what the engine's own chunker emits for the same section — its section span runs to
   * the next heading and so includes a trailing blank line (`{0,4}`) — and it is not the
   * source index's stored span either. `chunksSpanInherited` distinguishes the chunks
   * whose span came from the source index because their text could not be located.
   */
  chunkLines: Array<{ startLine: number; endLine: number }>;
  /** True when the source's own bytes were carried, not reconstructed from chunks. */
  fromOriginalBytes: boolean;
  /**
   * Chunks whose text could not be located in the bytes written. Their span is reported
   * as unknown (`0,0`) unless the original bytes were carried, in which case the source
   * index's stored span applies to exactly these bytes and is inherited.
   */
  chunksNotLocated: number;
  /**
   * Of `chunksNotLocated`, how many inherited the source index's stored span. A caller
   * rendering an excerpt from a span cannot otherwise tell a located span from an
   * inherited one.
   */
  chunksSpanInherited: number;
}

/**
 * Produce the bytes to write for a note.
 *
 * The source's **original Markdown is preferred whenever it is reachable**: it is the
 * source of truth, and carrying a document is not re-parsing it (the constraint on this
 * path is that no re-parse, re-chunk or re-embed is run — not that a document may not
 * be carried).
 *
 * Reconstruction is the fallback for an index whose content tree is unavailable. It
 * concatenates the source's own chunk texts in order with the heading structure their
 * `heading_path` values already describe — not a re-parse, but a projection: it is
 * lossy for YAML comments and key order, and a caller that falls back is told so by
 * `fromOriginalBytes: false`.
 *
 * Chunk spans are **located in the bytes actually written**, not copied from the source
 * index. Measured on a real 22,774-chunk index, only 475 of 594 sampled stored spans
 * contained their own chunk text (the engine's paragraph splitter accumulates its
 * offsets approximately), while 593 of 594 chunk texts were found in the note body. A
 * copied span would therefore mis-cite a fifth of chunks; a located span is true of the
 * file being written by construction.
 */
export function renderNoteMarkdown(note: ImportNote): RenderedNote {
  const fromOriginalBytes = typeof note.originalContent === 'string';
  const content = fromOriginalBytes
    ? note.originalContent as string
    : reconstructNoteMarkdown(note);

  const located = locateChunkLines(content, note.chunks);

  let chunksNotLocated = 0;
  let chunksSpanInherited = 0;
  const chunkLines = located.lines.map((span, index) => {
    if (located.found[index]) return span;
    chunksNotLocated += 1;
    const chunk = note.chunks[index];
    // The source's stored span describes the source's own bytes. That is exactly what is
    // being written on the original-bytes path, so it may be inherited there. On the
    // reconstruction path the written file has different bytes (frontmatter re-rendered,
    // headings materialised, empty chunks dropped), so an inherited coordinate would
    // point at unrelated text — report it as unknown instead.
    if (fromOriginalBytes && typeof chunk?.startLine === 'number' && typeof chunk.endLine === 'number') {
      chunksSpanInherited += 1;
      return { startLine: chunk.startLine, endLine: chunk.endLine };
    }
    return { startLine: 0, endLine: 0 };
  });

  return { content, chunkLines, fromOriginalBytes, chunksNotLocated, chunksSpanInherited };
}

/** Half-open line spans for each chunk, found by locating its text in the content. */
function locateChunkLines(
  content: string,
  chunks: ImportNote['chunks'],
): { lines: Array<{ startLine: number; endLine: number }>; found: boolean[] } {
  const lines: Array<{ startLine: number; endLine: number }> = [];
  const found: boolean[] = [];
  const newlinesBefore = newlineCounter(content);
  let cursor = 0;
  for (const chunk of chunks) {
    const needle = chunk.text.replace(/[ \t]+$/gm, '').trim();
    if (!needle) {
      lines.push({ startLine: 0, endLine: 0 });
      found.push(false);
      continue;
    }
    let at = content.indexOf(needle, cursor);
    if (at < 0) at = content.indexOf(needle);
    if (at < 0) {
      lines.push({ startLine: 0, endLine: 0 });
      found.push(false);
      continue;
    }
    const startLine = newlinesBefore(at);
    lines.push({ startLine, endLine: startLine + needle.split('\n').length });
    found.push(true);
    cursor = at + needle.length;
  }
  return { lines, found };
}

/**
 * Counts the newlines before an offset, resuming from where the previous count stopped.
 *
 * Chunks are located in document order, so each count reads only the text since the last one
 * and the pass over a note is linear in its size. Rescanning from offset 0 for every chunk cost
 * chunks x bytes: a 13 MB note with 8,000 chunks took minutes to preview. An offset before the
 * last stop (a chunk found out of order) is reached from whichever end is nearer, so no count
 * reads more characters than the rescan did.
 */
function newlineCounter(content: string): (index: number) => number {
  let stop = 0; // `newlines` is exact for content[0, stop)
  let newlines = 0;
  return index => {
    if (index >= stop) newlines += countNewlines(content, stop, index);
    else if (index < stop - index) newlines = countNewlines(content, 0, index);
    else newlines -= countNewlines(content, index, stop);
    stop = index;
    return newlines;
  };
}

function countNewlines(content: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) {
    if (content.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/**
 * Rebuild a note body from its chunks, materialising heading paths that the chunk text
 * does not itself carry. The lines are joined verbatim — no blank-line collapsing —
 * because the chunk spans are computed against these exact bytes.
 */
function reconstructNoteMarkdown(note: ImportNote): string {
  const lines: string[] = [];

  const frontmatter = renderFrontmatter(note.frontmatter);
  if (frontmatter.length > 0) lines.push('---', ...frontmatter, '---', '');

  let stack: string[] = [];
  const first = note.chunks[0];
  if (first && !/^#{1,3}\s/.test(first.text.trimStart()) && note.title) {
    lines.push(`# ${note.title}`, '');
    stack = [note.title];
  }

  for (const chunk of note.chunks) {
    const text = chunk.text.replace(/[ \t]+$/gm, '').trim();
    if (!text) continue;
    const startsWithHeading = /^#{1,3}\s/.test(text);
    const headingStack = chunk.headingPath
      ? chunk.headingPath.split(' > ').map(s => s.trim()).filter(Boolean)
      : [];

    if (startsWithHeading) {
      if (headingStack.length > 0) stack = headingStack;
    } else if (headingStack.length > 0) {
      let common = 0;
      while (common < Math.min(headingStack.length, stack.length) && headingStack[common] === stack[common]) common += 1;
      for (let level = common; level < headingStack.length; level += 1) {
        lines.push(`${'#'.repeat(Math.min(level + 1, 3))} ${headingStack[level]}`);
      }
      stack = headingStack.slice();
    }

    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(...text.split('\n'));
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Frontmatter as YAML key/scalar lines. Values are JSON-encoded, which is a valid YAML
 * scalar or flow collection for every JSON value, so a round-trip through the engine's
 * own frontmatter parser cannot produce malformed YAML.
 */
function renderFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    if (value === undefined) continue;
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 4096) continue;
    out.push(`${key}: ${encoded}`);
  }
  return out;
}

/** `namespace/relPath`, with every segment sanitized so a source path cannot escape. */
export function destinationRelPath(namespace: string, sourceRelPath: string): string {
  const cleanNamespace = sanitizeSegments(namespace);
  const clean = sanitizeSegments(sourceRelPath);
  if (!clean) throw new Error(`source path ${JSON.stringify(sourceRelPath)} has no usable segments`);
  return cleanNamespace ? `${cleanNamespace}/${clean}` : clean;
}

function sanitizeSegments(value: string): string {
  return value
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .map(segment => segment.replace(/[\u0000-\u001F\u007F]/g, '_'))
    .join('/');
}
