import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { indexFile, removeDailyHeaderFacts } from '../../src/indexer/pipeline';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { appendDailyMemory } from '../../src/memory/writer';
import { engineDailyHeader } from '../../src/memory/dailyNote';
import { tmpPath } from '../helpers/tmpPath';

/**
 * The engine writes `updated: YYYY-MM-DD` into every daily note it creates. It is the day the file is about, which the
 * file's name and heading already say: the engine's own bookkeeping, not something anyone told Renor. YAML reads the
 * bare date as a Date, and the indexer used to store `String(date)` as a "fact" of the note: the date printed in the
 * host's timezone, one per day, a different text on each host (finding N5 of the new-user re-check).
 *
 * Whether a note is the engine's is a question about the FRONT MATTER of the file and nothing else
 * (daily-note-provenance.test.ts has the table): the marker the writer stamps on every note it creates, or, for a note
 * written before the marker existed, the complete front matter the engine wrote then. Not where the note is, not what
 * it is called, not what its body says: a person's own note in the same `Daily/YYYY-MM-DD.md` folder says
 * `updated: 2026-03-30` just as naturally, and may hold a log of timestamped lines in the engine's own entry format.
 * And only the engine's own value is dropped from a note that is the engine's, the bare date of the note's own day: an
 * `updated` a person put there is a fact they said.
 *
 * An index an earlier build wrote still holds that row for every daily note, and an unchanged note is not read again,
 * so they are removed where they would otherwise stay: when the server starts, and when the indexer passes over an
 * unchanged daily note. The same test of the file decides each time. The notes such an index holds were written before
 * the marker existed, which is why the front matter the engine wrote then is the second way to be recognised.
 */

const savedTz = process.env.TZ;
let vault: string;
let dbPath: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-header-'));
  dbPath = tmpPath(`daily-header-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(dbPath, { force: true });
});

function writeNote(rel: string, content: string): string {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** The text an earlier indexer stored for the header of `day`: that day as a Date, printed on a host in São Paulo. */
function earlierBuildsText(day: string): string {
  process.env.TZ = 'America/Sao_Paulo';
  try {
    return String(new Date(`${day}T00:00:00Z`));
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
}

/** What this host's indexer stores for a bare date: the Date, printed here. */
const hostText = (day: string): string => String(new Date(`${day}T00:00:00Z`));

/** One fact row of a note, as the indexer writes a front-matter fact (no ledger event, no object entity). */
function insertFact(db: Database.Database, file: string, predicate: string, text: string, source: string = file, eventId: string | null = null): void {
  const entity = db.prepare('SELECT id FROM entities WHERE source_note = ?').get(file) as { id: number };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at, event_id)
     VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)`,
  ).run(entity.id, predicate, text, source, now, now, eventId);
}

/** Make the `updated` fact of an indexed note the one an earlier build made of it, and only that one. */
function asEarlierBuildLeftIt(db: Database.Database, file: string, day: string): void {
  db.prepare(`DELETE FROM facts WHERE source_path = ? AND predicate = 'updated'`).run(file);
  insertFact(db, file, 'updated', earlierBuildsText(day));
}

function factsOf(db: Database.Database, file: string): Array<{ predicate: string; object_text: string }> {
  return db.prepare('SELECT predicate, object_text FROM facts WHERE source_path = ? ORDER BY predicate').all(file) as Array<{ predicate: string; object_text: string }>;
}

async function indexedFacts(file: string): Promise<Array<{ predicate: string; object_text: string }>> {
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    await indexFile(db, file);
    return factsOf(db, file);
  } finally {
    db.close();
  }
}

const ENTRY = '- [08:30:00] (claude) Dinner was good.\n';
/** The front matter and heading the engine wrote before it stamped its notes, spelled out as the files on disk have it. */
const LEGACY = (day: string): string => `---\nkind: note\nupdated: ${day}\n---\n# ${day}\n`;
/** A person's own daily note: a log in the very format the engine writes entries in. */
const MY_LOG = '- [08:30:00] (alice) Met Bob for breakfast.\n- [12:10:00] (alice) Lunch with Carol.\n';

describe('the engine\'s own daily-note header is not a fact', () => {
  it.each(['America/Sao_Paulo', 'Pacific/Kiritimati', 'UTC'])('leaves no fact behind when the host is in %s', async (zone) => {
    process.env.TZ = zone;
    const file = await appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' });
    // The note the engine really wrote: its exact header, marker included.
    expect(fs.readFileSync(file, 'utf8').startsWith('---\nkind: note\nupdated: 2026-10-03\nrenor: daily-v1\n---\n# 2026-10-03\n')).toBe(true);

    expect(await indexedFacts(file)).toEqual([]);
  });

  it('is still the note\'s metadata: only the fact is gone, not the front matter', async () => {
    const file = await appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' });
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      await indexFile(db, file);
      const note = db.prepare('SELECT kind, frontmatter_json FROM notes WHERE path = ?').get(file) as { kind: string; frontmatter_json: string };
      expect(note.kind).toBe('note');
      expect(JSON.parse(note.frontmatter_json)).toEqual({ kind: 'note', updated: '2026-10-03T00:00:00.000Z', renor: 'daily-v1' });
    } finally {
      db.close();
    }
  });

  it('stays the engine\'s when a person adds a line at the end of it', async () => {
    const file = await appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' });
    fs.appendFileSync(file, '\nI had the soup, too.\n');
    expect(await indexedFacts(file)).toEqual([]);
  });

  it('is the engine\'s when every entry has been retired and only the header is left', async () => {
    const file = writeNote('Memory/Daily/2026-10-03.md', engineDailyHeader('2026-10-03'));
    expect(await indexedFacts(file)).toEqual([]);
  });

  it.each([
    ['free text', 'Met Bob for breakfast.\n'],
    ['lines a person wrote in the engine\'s own entry format', MY_LOG],
    ['nothing a heading or an entry would say', ''],
  ])('is the engine\'s whatever follows the marker: %s (the body is never asked)', async (_what, body) => {
    const file = writeNote('Memory/Daily/2026-10-03.md', `${engineDailyHeader('2026-10-03')}\n${body}`);
    expect(await indexedFacts(file)).toEqual([]);
  });

  it('drops only the engine\'s own `updated` when a person added keys beside the marker: theirs stay facts', async () => {
    const file = writeNote('Memory/Daily/2026-10-03.md', `---\nkind: note\nupdated: 2026-10-03\nrenor: daily-v1\ntags: [journal]\nstatus: draft\n---\n# 2026-10-03\n\n${ENTRY}`);
    expect(await indexedFacts(file)).toEqual([
      { predicate: 'status', object_text: 'draft' },
      { predicate: 'tags', object_text: 'journal' },
    ]);
  });
});

describe('a note the engine wrote before it stamped its notes: the complete front matter is what is asked', () => {
  it.each([
    ['an entry', ENTRY],
    ['nothing', ''],
    ['free text a person went on with', 'Discussed Alpha project status with John.\n'],
    ['lines a person wrote in the engine\'s own entry format', MY_LOG],
  ])('has no header fact when it is followed by %s', async (_what, body) => {
    const file = writeNote('Daily/2026-03-30.md', `${LEGACY('2026-03-30')}\n${body}`);
    expect(await indexedFacts(file)).toEqual([]);
  });

  it('is not the engine\'s with a further key: the person\'s note keeps its `updated`, and its other keys', async () => {
    const file = writeNote('Daily/2026-03-30.md', `---\nkind: note\nupdated: 2026-03-30\ntags: [journal]\nstatus: draft\n---\n# 2026-03-30\n\n${ENTRY}`);
    expect(await indexedFacts(file)).toEqual([
      { predicate: 'status', object_text: 'draft' },
      { predicate: 'tags', object_text: 'journal' },
      { predicate: 'updated', object_text: hostText('2026-03-30') },
    ]);
  });

  it('is not the engine\'s with the keys in another order', async () => {
    const file = writeNote('Daily/2026-03-30.md', `---\nupdated: 2026-03-30\nkind: note\n---\n# 2026-03-30\n\n${ENTRY}`);
    expect((await indexedFacts(file)).map(f => f.predicate)).toEqual(['updated']);
  });

  it('is not the engine\'s when the day in it is not the day in the file\'s name', async () => {
    const file = writeNote('Daily/2026-03-30.md', `${LEGACY('2026-03-29')}\n${ENTRY}`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: hostText('2026-03-29') }]);
  });
});

describe('a person\'s note keeps its own facts, in the daily layout too', () => {
  it('keeps a natural `updated: 2026-03-30`: nothing says the engine wrote it', async () => {
    const file = writeNote('Daily/2026-03-30.md', '---\nupdated: 2026-03-30\n---\n# 2026-03-30\n\nA journal note.\n');
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: hostText('2026-03-30') }]);
  });

  it('keeps it under a log of timestamped lines in the engine\'s own entry format: the body says nothing about who wrote the note', async () => {
    const file = writeNote('Daily/2026-10-03.md', `---\ntitle: Journal\nupdated: 2026-10-03\n---\n# 2026-10-03\n\n${MY_LOG}`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: hostText('2026-10-03') }]);
  });

  it('keeps it when the note has no front matter of the engine\'s, whatever the first line of the body is', async () => {
    const file = writeNote('Daily/2026-10-03.md', `---\nupdated: 2026-10-03\n---\n${MY_LOG}`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: hostText('2026-10-03') }]);
  });

  it('keeps it when the marker is in the body: a marker is a line of the front matter', async () => {
    const file = writeNote('Daily/2026-03-30.md', `---\nupdated: 2026-03-30\n---\n# 2026-03-30\n\nrenor: daily-v1\n${ENTRY}`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: hostText('2026-03-30') }]);
  });

  it('keeps an `updated` that is not the note\'s own day, even in a note the engine wrote', async () => {
    const file = writeNote('Daily/2026-03-30.md', `${engineDailyHeader('2026-03-29')}\n${ENTRY}`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: hostText('2026-03-29') }]);
  });

  it('keeps the time a plugin stamped on a note the engine wrote', async () => {
    const file = writeNote('Daily/2026-10-03.md', `---\nkind: note\nupdated: 2026-10-03T09:15:00Z\nrenor: daily-v1\n---\n# 2026-10-03\n\n${ENTRY}`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: String(new Date('2026-10-03T09:15:00Z')) }]);
  });

  it.each([
    ['a quoted date', '"2026-03-30"', '2026-03-30'],
    ['free text', 'evening', 'evening'],
  ])('keeps an `updated` that is %s', async (_what, yaml, text) => {
    const file = writeNote('Daily/2026-03-30.md', `---\nupdated: ${yaml}\n---\n# 2026-03-30\n\nA journal note.\n`);
    expect(await indexedFacts(file)).toEqual([{ predicate: 'updated', object_text: text }]);
  });

  it.each([
    ['the engine\'s marked header', engineDailyHeader('2026-03-30')],
    ['the front matter the engine wrote before the marker', LEGACY('2026-03-30')],
  ])('keeps it in a note outside the daily layout, even under %s', async (_what, header) => {
    const file = writeNote('People/Acme.md', `${header}\n${ENTRY}`);
    expect((await indexedFacts(file)).map(f => f.predicate)).toEqual(['updated']);
  });
});

describe('a daily note an earlier build indexed', () => {
  it.each([
    ['one the engine writes now', async () => appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' })],
    ['one the engine wrote before it stamped its notes', async () => writeNote('Memory/Daily/2026-10-03.md', `${LEGACY('2026-10-03')}\n- [08:30:00] (agent) Dinner was good.\n`)],
  ])('loses the header fact when the indexer passes over the unchanged note (%s), and nothing else is rebuilt', async (_what, make) => {
    const file = await make();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]));
    const options = { embeddingProvider: { dimensions: 4, embed }, vectorIndex: { upsert: vi.fn(), delete: vi.fn() } };
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      await indexFile(db, file, options);
      // The index an earlier build left: the note is indexed, and its header is a fact.
      insertFact(db, file, 'updated', earlierBuildsText('2026-10-03'));
      expect(factsOf(db, file)).toHaveLength(1);
      const chunks = db.prepare('SELECT id, text FROM chunks WHERE note_path = ? ORDER BY id').all(file);
      expect(chunks.length).toBeGreaterThan(0);
      embed.mockClear();
      options.vectorIndex.upsert.mockClear();
      options.vectorIndex.delete.mockClear();

      await indexFile(db, file, options); // the same bytes: the ordinary reindex

      expect(factsOf(db, file)).toEqual([]);
      // Only the row is gone: the chunks keep their ids, and nothing was embedded, written or deleted in the vector index.
      expect(db.prepare('SELECT id, text FROM chunks WHERE note_path = ? ORDER BY id').all(file)).toEqual(chunks);
      expect(embed).not.toHaveBeenCalled();
      expect(options.vectorIndex.upsert).not.toHaveBeenCalled();
      expect(options.vectorIndex.delete).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([
    ['a natural `updated`', '---\nupdated: 2026-03-30\n---\n# 2026-03-30\n\nA journal note.\n'],
    ['a log in the engine\'s own entry format under a front matter of its own', `---\ntitle: Journal\nupdated: 2026-03-30\n---\n# 2026-03-30\n\n${MY_LOG}`],
  ])('keeps a person\'s own `updated` when the indexer passes over the unchanged note: %s', async (_what, text) => {
    // A person's daily note, indexed by the earlier build, which made a fact of its `updated`.
    const file = writeNote('Daily/2026-03-30.md', text);
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      await indexFile(db, file);
      asEarlierBuildLeftIt(db, file, '2026-03-30');
      expect(factsOf(db, file)).toEqual([{ predicate: 'updated', object_text: earlierBuildsText('2026-03-30') }]);

      await indexFile(db, file); // unchanged

      expect(factsOf(db, file)).toEqual([{ predicate: 'updated', object_text: earlierBuildsText('2026-03-30') }]);
    } finally {
      db.close();
    }
  });

  it('is cleaned note by note, and in one pass, of exactly the engine\'s headers and nothing a person wrote', async () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      // Four daily notes the engine wrote: two it writes now (one in a scope's own daily folder), one it wrote before it
      // stamped its notes, and one whose file is gone, each with the earlier build's row.
      const engineA = await appendDailyMemory(vault, '2026-10-03', { text: 'Dinner was good.', source: 'agent' });
      const engineB = await appendDailyMemory(vault, '2026-09-01', { text: 'Rain all day.', source: 'agent' }, 'Memory/Scopes/alpha/Daily');
      const engineOlder = writeNote('Daily/2026-03-28.md', `${LEGACY('2026-03-28')}\nDiscussed Alpha with John.\n`);
      const engineGone = await appendDailyMemory(vault, '2026-08-01', { text: 'Sunny.', source: 'agent' });
      // What a person wrote, in every shape close to it. Each is indexed by the real indexer.
      const natural = writeNote('Daily/2026-03-29.md', '---\nupdated: 2026-03-29\n---\n# 2026-03-29\n\nA journal note.\n');
      const withTags = writeNote('Daily/2026-03-27.md', `---\nkind: note\nupdated: 2026-03-27\ntags: [journal]\n---\n# 2026-03-27\n\n${ENTRY}`);
      const myLog = writeNote('Daily/2026-03-25.md', `---\ntitle: Journal\nupdated: 2026-03-25\n---\n# 2026-03-25\n\n${MY_LOG}`);
      const markerInBody = writeNote('Daily/2026-03-24.md', `---\nupdated: 2026-03-24\n---\n# 2026-03-24\n\nrenor: daily-v1\n${ENTRY}`);
      const quoted = writeNote('Daily/2026-03-30.md', '---\nupdated: "2026-03-30"\n---\n# 2026-03-30\n\nA journal note.\n');
      const otherDay = writeNote('Daily/2026-03-31.md', '---\nupdated: 2026-03-29\n---\n# 2026-03-31\n\nA journal note.\n');
      const text = writeNote('Daily/2026-03-26.md', '---\nupdated: evening\n---\n# 2026-03-26\n\nA journal note.\n');
      const outside = writeNote('People/Acme.md', '---\nupdated: 2026-10-03\n---\n# Acme\n\nAcme ships the mango press.\n');
      const people = [natural, withTags, myLog, markerInBody, quoted, otherDay, text, outside];
      for (const file of [engineA, engineB, engineOlder, engineGone, ...people]) await indexFile(db, file);

      // The earlier build's row for each of the engine's notes, and the one it made of each of the person's.
      asEarlierBuildLeftIt(db, engineA, '2026-10-03');
      asEarlierBuildLeftIt(db, engineB, '2026-09-01');
      asEarlierBuildLeftIt(db, engineOlder, '2026-03-28');
      asEarlierBuildLeftIt(db, engineGone, '2026-08-01');
      for (const [file, day] of [[natural, '2026-03-29'], [withTags, '2026-03-27'], [myLog, '2026-03-25'], [markerInBody, '2026-03-24']] as const) {
        asEarlierBuildLeftIt(db, file, day);
      }
      fs.rmSync(engineGone); // its file is gone: nothing proves the engine wrote it any more
      // Rows with the header's exact text that are not the header: a ledger event made one, the lifecycle owns one, and
      // one on the engine's own note says something else.
      const header = earlierBuildsText('2026-10-03');
      insertFact(db, engineA, 'updated', header, engineA, 'MEM_HEADER_LOOKALIKE');
      insertFact(db, engineA, 'updated', header, '_mcp_');
      insertFact(db, engineA, 'updated', 'evening');
      const updatedRows = () => (db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE predicate = 'updated'`).get() as { c: number }).c;
      // The engine's four, the three lookalikes, and eight of the person's own.
      expect(updatedRows()).toBe(4 + 3 + 8);

      // One note at a time: only that note's header goes, whether the indexer hands over the text or it is read from disk.
      expect(removeDailyHeaderFacts(db, engineB)).toBe(1);
      expect(factsOf(db, engineB)).toEqual([]);
      expect(removeDailyHeaderFacts(db, engineA, fs.readFileSync(engineA, 'utf8'))).toBe(1);
      expect(factsOf(db, engineA).map(f => f.object_text)).toEqual([header, 'evening']); // the ledger event's row and the other text
      expect(updatedRows()).toBe(4 + 3 + 8 - 2);
      // And in one pass over every note, as the server does when it starts: what is left of the engine's is the older note.
      expect(removeDailyHeaderFacts(db)).toBe(1);
      expect(factsOf(db, engineOlder)).toEqual([]);
      expect(removeDailyHeaderFacts(db)).toBe(0); // nothing is left of the engine's: the cleanup repeats safely
      expect(updatedRows()).toBe(4 + 3 + 8 - 3);
      insertFact(db, engineA, 'updated', header);
      insertFact(db, engineB, 'updated', earlierBuildsText('2026-09-01'));
      expect(removeDailyHeaderFacts(db)).toBe(2);

      // Kept: the engine's note whose file is gone, the lookalikes, and every one of the person's.
      expect(factsOf(db, engineGone)).toEqual([{ predicate: 'updated', object_text: earlierBuildsText('2026-08-01') }]);
      expect(factsOf(db, engineA).map(f => f.object_text).sort()).toEqual([header, 'evening'].sort()); // the ledger event's row and the other text
      expect(db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE source_path = '_mcp_'`).get()).toEqual({ c: 1 });
      for (const kept of people) expect(factsOf(db, kept).map(f => f.predicate), kept).toContain('updated');
      expect(factsOf(db, quoted)).toEqual([{ predicate: 'updated', object_text: '2026-03-30' }]);
      expect(factsOf(db, text)).toEqual([{ predicate: 'updated', object_text: 'evening' }]);
      expect(factsOf(db, natural)).toEqual([{ predicate: 'updated', object_text: earlierBuildsText('2026-03-29') }]);
      expect(factsOf(db, myLog)).toEqual([{ predicate: 'updated', object_text: earlierBuildsText('2026-03-25') }]);
      expect(factsOf(db, markerInBody)).toEqual([{ predicate: 'updated', object_text: earlierBuildsText('2026-03-24') }]);
      expect(factsOf(db, withTags).map(f => f.predicate)).toEqual(['tags', 'updated']);
    } finally {
      db.close();
    }
  });
});
