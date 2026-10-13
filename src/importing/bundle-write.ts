import fs from 'fs';
import path from 'path';
import { BUNDLE_FORMAT, ImportBundle } from './types';

/**
 * Write a bundle as `renor-memory-export/v1` JSONL.
 *
 * This is the seam that lets an import run where the workspace lives: a source that is
 * only reachable read-only can be exported once, and the resulting file is the whole
 * input the importer needs. It is also the documented interface a third-party provider
 * can implement directly instead of shipping an adapter.
 *
 * The file contains memory content, so it is written `0600` and must be treated as
 * private material — never committed, never a fixture.
 */
export function writeBundle(bundle: ImportBundle, filePath: string): { bytes: number; records: number } {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'meta',
    format: BUNDLE_FORMAT,
    source: bundle.sourceLabel,
    notes: bundle.notes.length,
    facts: bundle.facts.length,
  }));

  for (const note of bundle.notes) {
    lines.push(JSON.stringify({
      type: 'note',
      path: note.sourcePath,
      relPath: note.relPath,
      title: note.title,
      kind: note.kind,
      modifiedAt: note.modifiedAt,
      frontmatter: note.frontmatter,
      chunks: note.chunks.map(chunk => ({
        headingPath: chunk.headingPath,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      })),
      entities: note.entities,
      // Carried when present so the importer can prefer the original bytes.
      originalContent: note.originalContent,
    }));
  }

  for (const fact of bundle.facts) {
    lines.push(JSON.stringify({
      type: 'fact',
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      scope: fact.scope,
      validFrom: fact.validFrom,
      sourcePath: fact.sourcePath,
      origin: fact.origin,
      ledgerSource: fact.ledgerSource,
    }));
  }

  const body = lines.join('\n') + '\n';
  // `mode` is only honoured when the file is created, so an export over an existing
  // path (or one a shell redirect created) would keep whatever permissions it already
  // had — while this command claims the bundle is 0600. Create, write and chmod so the
  // guarantee holds on overwrite too.
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body, { encoding: 'utf8' });
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return { bytes: Buffer.byteLength(body, 'utf8'), records: lines.length };
}
