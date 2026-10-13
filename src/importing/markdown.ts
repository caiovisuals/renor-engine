import fs from 'fs';
import path from 'path';
import { walkVault } from '../indexer/walker';
import { parseNote } from '../indexer/parser';
import { chunkNote } from '../indexer/chunker';
import { isSelected, toRelative, type SourceFilter } from './source';
import { assertNoUnstorableControls } from '../memory/controls';
import { BUNDLE_FORMAT, type ImportBundle, type ImportNote } from './types';

/** Plain vault input: use the shipped walker/parser/chunker, without a source index. */
export async function readMarkdownSource(folder: string, filter: SourceFilter): Promise<ImportBundle> {
  const root = fs.realpathSync(folder);
  if (!fs.statSync(root).isDirectory()) throw new Error('Markdown source must be a folder');
  const nonUtf8Names: string[] = [];
  const files = (await walkVault(root, { onNonUtf8Markdown: name => nonUtf8Names.push(name) })).sort((a, b) => toRelative(root, a).localeCompare(toRelative(root, b)));
  const selected = files.filter(file => isSelected(toRelative(root, file), filter));
  const limited = filter.limit === undefined ? selected : selected.slice(0, filter.limit);
  const notes: ImportNote[] = limited.map(file => {
    const relPath = toRelative(root, file);
    // Refuse a file replaced with a symlink after walking, and do not follow a
    // substituted ancestor outside the chosen vault.
    const resolved = fs.realpathSync(file);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Markdown source escapes the chosen folder: ${relPath}`);
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error(`Markdown source is not a regular file: ${relPath}`);
      const bytes = fs.readFileSync(fd);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`Markdown source is not UTF-8: ${relPath}`);
      }
      const content = bytes.toString('utf8');
      if (content.includes('\0')) throw new Error(`Markdown source contains binary data: ${relPath}`);
      return parseMarkdownImportNote(file, relPath, content, stat.mtime.toISOString());
    } finally {
      fs.closeSync(fd);
    }
  });
  return {
    format: BUNDLE_FORMAT, sourceLabel: path.basename(root), notes, facts: [],
    // A name the selection excludes anyway is not reported; every other one could not be imported.
    nonUtf8Names: nonUtf8Names.filter(name => isSelected(name, filter)).sort(),
    stats: {
      notesAvailable: files.length, notesSelected: notes.length,
      // Everything the selection left out, the --limit cut included, as the other adapters count it.
      notesFilteredOut: files.length - limited.length, notesWithOriginalBytes: notes.length,
      chunksSelected: notes.reduce((sum, note) => sum + note.chunks.length, 0),
      factsAvailable: 0, factsSelected: 0,
    },
  };
}

/** Shared adapter for local files and bounded hosted Markdown uploads. */
export function parseMarkdownImportNote(sourcePath: string, relPath: string, content: string, modifiedAt: string): ImportNote {
  // A control character is refused as it is in a note or a statement (memory/controls.ts): the note is
  // written into the vault and indexed, so what this funnel admits the workspace holds afterwards. One
  // rule for a folder import and a hosted upload both.
  assertNoUnstorableControls(`imported note ${relPath}`, content);
  // gray-matter ships a JavaScript engine that evaluates frontmatter. Remote
  // Markdown is data: admit only default/YAML or JSON before calling the parser.
  const opening = content.replace(/^\uFEFF/, '').match(/^---([^\r\n]*)/);
  if (opening && !['', 'yaml', 'json'].includes(opening[1].trim())) {
    throw new Error(`Unsupported Markdown frontmatter language: ${relPath}. Use YAML between --- lines, or remove the block.`);
  }
  let parsed;
  try {
    parsed = parseNote(sourcePath, content);
  } catch {
    // Do not expose private YAML text in an error.
    throw new Error(`Cannot parse Markdown frontmatter: ${relPath}. Fix the YAML between the --- lines or remove that block, then send again.`);
  }
  return {
    sourcePath, relPath, title: parsed.title,
    kind: typeof parsed.frontmatter.kind === 'string' ? parsed.frontmatter.kind : null,
    modifiedAt, frontmatter: parsed.frontmatter, originalContent: content,
    // Spans are body-relative; the renderer locates chunks in original bytes.
    chunks: chunkNote(parsed).map(chunk => ({
      headingPath: chunk.headingPath, text: chunk.text, tokenCount: chunk.tokenCount,
    })),
    entities: [],
  };
}
