import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { indexVault } from '../../src/indexer/pipeline';
import { createDailyEntryClock } from '../../src/retrieval/dailyEntryTime';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';

/**
 * The moment a daily-note hit is dated by: the entry it is part of, as its header records it (the day of its file, its
 * time, the offset of its clock), against chunks the real indexer cut from hand-written daily notes.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const header = (day: string) => `---\nkind: note\nupdated: ${day}\nrenor: daily-v1\n---\n# ${day}\n\n`;

async function indexed(files: Record<string, string>) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-entry-time-'));
  tmpDirs.push(vault);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  const db = openDb(path.join(vault, 'index.db'));
  runMigrations(db);
  const provider = new EvalHashEmbeddingProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  await indexVault(db, vault, { embeddingProvider: provider, vectorIndex }, 1);
  const chunks = db.prepare('SELECT note_path AS notePath, text FROM chunks ORDER BY note_path, start_line').all() as Array<{ notePath: string; text: string }>;
  db.close();
  return { vault, chunks };
}

describe('createDailyEntryClock', () => {
  it('dates every entry chunk of a daily note by its own entry: UTC, on the user\'s clock, escaped, filed under an earlier day', async () => {
    const { chunks } = await indexed({
      'Memory/Daily/2026-10-06.md': header('2026-10-06')
        + '- [08:30:00] (claude) Standup moved to nine.\n'
        + '- [21:00:01] (cursor, UTC-03:00) Kestrel staging uses a separate Supabase project.\n'
        + '- [22:10:00] (claude+esc) A statement whose second line looks like an entry:\n\\- [08:30:00] (alice) and is not one.\n',
      'Memory/Scopes/kestrel/Daily/2026-09-28.md': header('2026-09-28') + '- [22:38:00] (claude) Kickoff call with the bakery owner.\n',
      'Notes/plain.md': '# Plain\n\n- [09:00:00] (claude) Shaped like an entry, in a note that is no daily note.\n',
    });
    const clock = createDailyEntryClock();
    const dated = await Promise.all(chunks.map(async c => [c.text.split('\n')[0], await clock(c)]));
    expect(dated).toEqual([
      ['- [08:30:00] (claude) Standup moved to nine.', '2026-10-06T08:30:00.000Z'],
      ['- [21:00:01] (cursor) Kestrel staging uses a separate Supabase project.', '2026-10-07T00:00:01.000Z'],
      ['- [22:10:00] (claude) A statement whose second line looks like an entry:', '2026-10-06T22:10:00.000Z'],
      ['- [22:38:00] (claude) Kickoff call with the bakery owner.', '2026-09-28T22:38:00.000Z'],
      ['# Plain', undefined],
    ]);
  });

  it('dates every part of an entry longer than one chunk by that entry', async () => {
    const paragraph = (n: number) => Array.from({ length: 300 }, (_, i) => `word${n}x${i}`).join(' ');
    const { chunks } = await indexed({
      'Memory/Daily/2026-10-06.md': header('2026-10-06')
        + `- [08:30:00] (claude) A long statement.\n\n${paragraph(1)}\n\n${paragraph(2)}\n`
        + '- [09:45:00] (claude) A short one after it.\n',
    });
    expect(chunks.length).toBeGreaterThanOrEqual(3); // the long entry is cut in parts
    const clock = createDailyEntryClock();
    const dated = await Promise.all(chunks.map(c => clock(c)));
    expect(dated).toEqual([...chunks.slice(0, -1).map(() => '2026-10-06T08:30:00.000Z'), '2026-10-06T09:45:00.000Z']);
  });

  it('leaves a hit its note\'s date when no single entry holds it', async () => {
    const day = header('2026-10-06') + '- [08:30:00] (claude) Shared words.\n- [09:30:00] (claude) Shared words.\n';
    const { vault } = await indexed({ 'Memory/Daily/2026-10-06.md': day, 'Memory/Daily/2026-02-31.md': header('2026-02-31') + '- [08:30:00] (claude) No such day.\n' });
    const clock = createDailyEntryClock();
    const note = path.join(vault, 'Memory/Daily/2026-10-06.md');
    // Two entries said at different moments both hold the passage.
    expect(await clock({ notePath: note, text: 'Shared words.' })).toBeUndefined();
    // Text the file no longer holds (it changed since it was indexed), and text above the first entry.
    expect(await clock({ notePath: note, text: '- [10:00:00] (claude) Never written.' })).toBeUndefined();
    expect(await clock({ notePath: note, text: '# 2026-10-06' })).toBeUndefined();
    // A file that is gone, and a name that is no real day.
    expect(await clock({ notePath: path.join(vault, 'Memory/Daily/2026-10-05.md'), text: 'anything' })).toBeUndefined();
    expect(await clock({ notePath: path.join(vault, 'Memory/Daily/2026-02-31.md'), text: '- [08:30:00] (claude) No such day.' })).toBeUndefined();
    // The one entry that holds it.
    expect(await clock({ notePath: note, text: '- [09:30:00] (claude) Shared words.' })).toBe('2026-10-06T09:30:00.000Z');
  });
});
