import fs from 'fs';
import type Database from '../../src/db/sqlite';
import { chunkNote, type Chunk } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { hashContent } from '../../src/indexer/hasher';
import type { VectorIndex } from '../../src/embeddings/vectorIndex';

/**
 * Put an indexed daily note back the way the release before per-entry chunking left it in an index: the day as one
 * chunk (cut by headings and paragraphs, which is what `chunkNote` still does for a note without entry starts),
 * with its vector, and the note under the hash of its bytes alone. Everything else the index holds about the note
 * (its entity, its frontmatter facts, its row) and about every other note is left as it was.
 *
 * Returns the chunks it put there.
 */
export async function makeLegacyDailyNote(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: { embed(texts: string[]): Promise<number[][]> },
  file: string,
): Promise<Chunk[]> {
  const content = fs.readFileSync(file, 'utf8');
  const legacy = chunkNote({ ...parseNote(file, content), entryStarts: undefined });
  const current = db.prepare('SELECT id FROM chunks WHERE note_path = ?').all(file) as Array<{ id: number }>;
  for (const row of current) vectorIndex.delete(row.id);
  db.prepare('DELETE FROM chunks WHERE note_path = ?').run(file);
  const insert = db.prepare(
    'INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  );
  for (const chunk of legacy) {
    const { id } = insert.get(file, chunk.headingPath, chunk.text, chunk.startLine, chunk.endLine, chunk.tokenCount, hashContent(chunk.text)) as { id: number };
    vectorIndex.upsert(id, (await provider.embed([chunk.text]))[0]);
  }
  db.prepare('UPDATE notes SET note_hash = ? WHERE path = ?').run(hashContent(content), file);
  return legacy;
}
