import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import { hashContent } from '../../src/indexer/hasher';
import { insertStructuredRows, readCurrentRowsForNotes } from '../../src/context/rowStore';
import { laneZeroYieldMarker, recordLaneRun } from '../../src/indexer/laneRuns';
import { deleteStructuredRowsForSourceKind } from '../../src/context/rowStore';
import { LocalRulesDecisionModel } from '../../src/extraction/decision-model';
import type { DecisionModel } from '../../src/extraction/decision-model';
import { FACTS_EXTRACTION_VERSION } from '../../src/extraction/typedFacts';
import { EVENTS_EXTRACTION_VERSION } from '../../src/extraction/eventExtractor';
import type Database from '../../src/db/sqlite';
import { factValue } from '../helpers/factValue';

/**
 * Three optional structured-row lanes share one note. A current fact row is a
 * fact-lane cache hit, not a reason to abandon events and preferences, and a
 * later lane's stale-row cleanup must not delete the earlier lane's rows.
 * All three flags stay default-off; this suite arms them through the real
 * process environment for the duration of each test.
 */

/** What the product serves as this note's current facts, through the shipped
 * current-rows read (valid_to IS NULL), not the raw table. */
function servedFacts(db: Database.Database, note: string) {
  return readCurrentRowsForNotes(db, [note]).filter(row => row.rowKind === 'fact');
}

const tmpDirs: string[] = [];
function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-lane-'));
  tmpDirs.push(d);
  return d;
}
function freshDb(file: string): Database.Database {
  const db = openDb(file);
  runMigrations(db);
  return db;
}

afterEach(() => {
  for (const [flag, value] of ORIGINAL_FLAGS) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOTE = `---
kind: session
session_date: 2026-03-10
---
# Tuesday

The dog weighs 14 kg. Ran 5km. I prefer oat milk in coffee.
`;

/**
 * The three lane flags are read from the REAL process environment (there is no
 * env-injection parameter on IndexOptions): this file arms the variables
 * `renor index` reads and restores them after every test, exactly as the CLI
 * and a developer shell would. Each test still supplies its own extractors, so
 * a lane is armed by the env var and active only when its extractor is passed.
 */
const LANE_FLAGS = ['RENOR_TYPED_FACTS', 'RENOR_CHRONICLE', 'RENOR_PREFS'] as const;
const ORIGINAL_FLAGS = LANE_FLAGS.map(flag => [flag, process.env[flag]] as const);

beforeEach(() => {
  for (const flag of LANE_FLAGS) process.env[flag] = '1';
});

describe('multi-lane structured rows', () => {
  it('runs later lanes after a fact-lane cache hit and keeps sibling rows', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const noteHash = hashContent(NOTE);

    // First index writes the note and its chunk so the planted fact row has a
    // real source. No lane is armed, so this pass extracts nothing.
    await indexFile(db, note);
    const realChunkId = (db.prepare(
      'SELECT id FROM chunks WHERE note_path = ? ORDER BY id LIMIT 1',
    ).get(note) as { id: number }).id;

    // Chunk recreation deletes chunks, and structured_rows.source_chunk_id
    // cascades, so a row planted before the pass is gone before the lane
    // cache check. Replant onto the replacement chunk inside the same
    // transaction — that is the row a real unchanged reindex would still have
    // if the cascade did not exist — and then measure the whole-note return.
    const originalPrepare = db.prepare.bind(db);
    let replanted = false;
    db.prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (typeof sql === 'string' && sql.includes('INSERT INTO chunks') && !replanted) {
        const originalGet = stmt.get.bind(stmt);
        stmt.get = ((...args: unknown[]) => {
          const row = originalGet(...args) as { id: number };
          if (!replanted && row?.id) {
            replanted = true;
            insertStructuredRows(db, [{
              rowKind: 'fact',
              sourcePath: note,
              sourceChunkId: row.id,
              sourceHash: noteHash,
              extractionVersion: FACTS_EXTRACTION_VERSION,
              validFrom: '2026-03-10',
              payload: { value: '14', unit: 'kg', verb: 'weighs', object: 'dog' },
            }]);
          }
          return row;
        }) as typeof stmt.get;
      }
      return stmt;
    }) as typeof db.prepare;
    void realChunkId;

    const calls = { facts: 0, events: 0, prefs: 0 };
    try {
    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '999', object: 'should not replace the cached fact' }];
      },
      eventExtractor: async () => {
        calls.events++;
        return [{ when: 'Tuesday', event: 'ran 5km', entities: ['5km'] }];
      },
      preferenceExtractor: async () => {
        calls.prefs++;
        return [{ statement: 'I prefer oat milk in coffee.', kind: 'like' }];
      },
    });

    expect(calls).toEqual({ facts: 0, events: 1, prefs: 1 });
    const kinds = db.prepare(
      `SELECT row_kind, count(*) AS c FROM structured_rows
       WHERE source_path = ? AND valid_to IS NULL
       GROUP BY row_kind ORDER BY row_kind`,
    ).all(note) as Array<{ row_kind: string; c: number }>;
    expect(kinds).toEqual([
      { row_kind: 'event', c: 1 },
      { row_kind: 'fact', c: 1 },
      { row_kind: 'preference', c: 1 },
    ]);
    const fact = db.prepare(
      `SELECT payload_json FROM structured_rows
       WHERE source_path = ? AND row_kind = 'fact' AND valid_to IS NULL`,
    ).get(note) as { payload_json: string };
    expect(JSON.parse(fact.payload_json).value).toBe('14');
    } finally {
      db.prepare = originalPrepare;
      db.close();
    }
  });

  it('does not let a later lane delete an earlier lane on the same pass', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);

    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
      eventExtractor: async () => [{ when: 'Tuesday', event: 'ran 5km' }],
      preferenceExtractor: async () => [{ statement: 'I prefer oat milk in coffee.', kind: 'like' }],
    });

    const kinds = db.prepare(
      `SELECT row_kind FROM structured_rows
       WHERE source_path = ? AND valid_to IS NULL ORDER BY row_kind`,
    ).all(note) as Array<{ row_kind: string }>;
    expect(kinds.map(row => row.row_kind)).toEqual(['event', 'fact', 'preference']);
    db.close();
  });

  it('re-extracts only a stale preference lane and leaves current fact and event rows', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);

    const calls = { facts: 0, events: 0, prefs: 0 };
    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
      eventExtractor: async () => {
        calls.events++;
        return [{ when: 'Tuesday', event: 'ran 5km' }];
      },
      preferenceExtractor: async () => {
        calls.prefs++;
        return [{ statement: 'I prefer oat milk in coffee.', kind: 'like' }];
      },
    });
    expect(calls).toEqual({ facts: 1, events: 1, prefs: 1 });

    // Bump only the preference lane's version. Facts and events stay
    // current. This pass must re-extract preferences and must not call the
    // other extractors, and the chunk rewrite must not cascade the current rows.
    db.prepare(
      `UPDATE structured_rows SET extraction_version = 'prefs-stale'
       WHERE source_path = ? AND row_kind = 'preference'`,
    ).run(note);

    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '999', object: 'should not replace the cached fact' }];
      },
      eventExtractor: async () => {
        calls.events++;
        return [{ when: 'never', event: 'should not replace the cached event' }];
      },
      preferenceExtractor: async () => {
        calls.prefs++;
        return [{ statement: 'I prefer tea.', kind: 'like' }];
      },
    });

    expect(calls).toEqual({ facts: 1, events: 1, prefs: 2 });
    const rows = db.prepare(
      `SELECT row_kind, payload_json FROM structured_rows
       WHERE source_path = ? AND valid_to IS NULL ORDER BY row_kind`,
    ).all(note) as Array<{ row_kind: string; payload_json: string }>;
    const byKind = Object.fromEntries(rows.map(row => [row.row_kind, JSON.parse(row.payload_json)]));
    expect(byKind.fact.value).toBe('14');
    expect(byKind.event.event).toBe('ran 5km');
    expect(byKind.preference.statement).toBe('I prefer tea.');
    db.close();
  });

  it('keeps a preserved row on the chunk that still contains its source text', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    const body = [
      '---', 'kind: session', 'session_date: 2026-03-10', '---', '# Tuesday', '',
      'Alpha section. '.repeat(80),
      'The dog weighs 14 kg.',
      '',
      '## Later', '',
      'Beta section. '.repeat(80),
      'Ran 5km on Tuesday.',
      '',
    ].join('\n');
    fs.writeFileSync(note, body);

    await indexFile(db, note, {
      chunkOptions: { maxTokens: 40, overlapTokens: 0 },
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
      eventExtractor: async () => [{ when: 'Tuesday', event: 'ran 5km' }],
      preferenceExtractor: async () => [],
    });

    db.prepare(
      `UPDATE structured_rows SET extraction_version = 'prefs-stale'
       WHERE source_path = ? AND row_kind = 'preference'`,
    ).run(note);
    await indexFile(db, note, {
      chunkOptions: { maxTokens: 40, overlapTokens: 0 },
      numericFactExtractor: async () => [{ value: '999', object: 'replaced' }],
      eventExtractor: async () => [{ when: 'never', event: 'replaced' }],
      preferenceExtractor: async () => [{ statement: 'I prefer tea.', kind: 'like' }],
    });

    const rows = db.prepare(
      `SELECT r.row_kind, c.text AS chunk_text
       FROM structured_rows r JOIN chunks c ON c.id = r.source_chunk_id
       WHERE r.source_path = ? AND r.valid_to IS NULL AND r.row_kind IN ('fact', 'event')`,
    ).all(note) as Array<{ row_kind: string; chunk_text: string }>;
    const fact = rows.find(row => row.row_kind === 'fact');
    const event = rows.find(row => row.row_kind === 'event');
    expect(fact?.chunk_text.toLowerCase()).toContain('14 kg');
    expect(event?.chunk_text.toLowerCase()).toContain('5km');
    expect(fact?.chunk_text).not.toBe(event?.chunk_text);
    db.close();
  });

  it('re-extracts a bumped-version fact lane on unchanged bytes and never serves the stale row', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
    });
    // An extraction_version bump is the only change: the bytes and the note
    // hash are untouched, so only the (source_hash, extraction_version) key
    // can see that this lane is stale.
    db.prepare(`UPDATE structured_rows SET extraction_version = 'stale' WHERE source_path = ?`).run(note);

    let calls = 0;
    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls++;
        return [{ value: '16', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
    });

    // The bump invalidated the cache, so the lane re-extracts on unchanged
    // bytes, and the replacement row is the new extraction at the current
    // version — the stale payload is never left as the current row.
    expect(calls).toBe(1);
    const currentRows = servedFacts(db, note);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].extractionVersion).toBe(FACTS_EXTRACTION_VERSION);
    expect(factValue(currentRows[0])).toBe('16');
    db.close();
  });

  it('does not restore a bumped-version fact row when re-extraction throws', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
    });
    db.prepare(`UPDATE structured_rows SET extraction_version = 'stale' WHERE source_path = ?`).run(note);

    // Unchanged bytes: note_hash still matches, so the note-unchanged branch
    // is what reaches the restore. A stale-version row must not come back, and
    // the product must serve no current fact for this note.
    await expect(indexFile(db, note, {
      numericFactExtractor: async () => { throw new Error('extractor down'); },
    })).rejects.toThrow(/extractor down/);

    expect(servedFacts(db, note)).toEqual([]);

    // The failed lane is never reported current, so the next pass retries it
    // and the retry replaces the row at the current version.
    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '16', unit: 'kg', verb: 'weighs', object: 'dog' }],
    });
    const retried = servedFacts(db, note);
    expect(retried).toHaveLength(1);
    expect(retried[0].extractionVersion).toBe(FACTS_EXTRACTION_VERSION);
    expect(factValue(retried[0])).toBe('16');
    db.close();
  });

  it('does not restore a bumped-version fact row when a cleared hash retries the lane', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
    });
    // A previous failure clears note_hash, so noteUnchanged is FALSE on the
    // next pass while the row's source_hash still matches these bytes. That is
    // the branch preservedLaneMatches() decides on its own, with no help from
    // noteUnchanged, so the version guard has to hold here too.
    db.prepare(`UPDATE notes SET note_hash = '' WHERE path = ?`).run(note);
    db.prepare(`UPDATE structured_rows SET extraction_version = 'stale' WHERE source_path = ?`).run(note);

    await expect(indexFile(db, note, {
      numericFactExtractor: async () => { throw new Error('extractor down'); },
    })).rejects.toThrow(/extractor down/);

    expect(servedFacts(db, note)).toEqual([]);
    db.close();
  });

  it('keeps a current-version fact row when a retry after a cleared hash re-runs', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
    });
    db.prepare(`UPDATE notes SET note_hash = '' WHERE path = ?`).run(note);

    // Same bytes, current version: the row still describes this note, so the
    // retry keeps its own row. The version guard must not empty a lane whose
    // contents never changed.
    let calls = 0;
    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls++;
        return [{ value: '999', object: 'should not replace the kept fact' }];
      },
    });

    const kept = servedFacts(db, note);
    expect(kept).toHaveLength(1);
    expect(kept[0].extractionVersion).toBe(FACTS_EXTRACTION_VERSION);
    expect(factValue(kept[0])).toBe('14');
    expect(calls).toBe(0);
    db.close();
  });

  it('does not restore a stale fact onto an edited note when re-extraction throws', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    await indexFile(db, note, {
      numericFactExtractor: async () => [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }],
    });
    const edited = NOTE.replace('14 kg', '16 kg');
    fs.writeFileSync(note, edited);

    await expect(indexFile(db, note, {
      numericFactExtractor: async () => { throw new Error('extractor down'); },
    })).rejects.toThrow(/extractor down/);

    const current = db.prepare(
      `SELECT payload_json FROM structured_rows
       WHERE source_path = ? AND row_kind = 'fact' AND valid_to IS NULL`,
    ).all(note);
    expect(current).toEqual([]);
    db.close();
  });

  it('does not call an empty fact lane again on the next unchanged pass (#189)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0 };
    const options = {
      numericFactExtractor: async () => {
        calls.facts++;
        return [];
      },
    };
    await indexFile(db, note, options);
    await indexFile(db, note, options);
    // RE-TARGETED (#189). This case used to pin `toBe(2)`: a zero-yield lane
    // left no structured row, so nothing recorded that the lane had run and
    // every unchanged pass called the extractor again — repeated model calls
    // and rate-limit exposure for a note that produced nothing. The completed
    // empty run is now recorded in lane_runs, so the second pass is free. The
    // previous assertion is not narrowed: the extractor call count is still
    // the measured thing, and the rows assertion below is unchanged.
    expect(calls.facts).toBe(1);
    const rows = db.prepare(
      `SELECT id FROM structured_rows WHERE source_path = ? AND row_kind = 'fact'`,
    ).all(note);
    expect(rows).toEqual([]);
    // The marker lives outside structured_rows: that table is the scored side
    // of the eval boundary, so a marker row there would look like a fact. It
    // records what the run's own writes returned (0), not a count re-read from
    // the row table.
    expect(db.prepare(
      `SELECT max_rows_written FROM lane_runs
       WHERE source_path = ? AND row_kind = 'fact' AND source_hash = ? AND extraction_version = ?`,
    ).get(note, hashContent(NOTE), FACTS_EXTRACTION_VERSION)).toEqual({ max_rows_written: 0 });
    db.close();
  });

  it('keys the zero-yield marker per lane: an empty fact lane never stands in for the event lane (#189)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0, events: 0 };
    const options = {
      numericFactExtractor: async () => { calls.facts++; return []; },
      eventExtractor: async () => {
        calls.events++;
        return [{ when: 'Tuesday', event: 'ran 5km', entities: ['5km'] }];
      },
    };
    await indexFile(db, note, options);
    expect(calls).toEqual({ facts: 1, events: 1 });

    // The event row is closed (superseded), so the event lane's ROW half is
    // stale and must decide again. A marker keyed only by source+hash would
    // let the fact lane's zero yield suppress this event re-extraction.
    db.prepare(`UPDATE structured_rows SET valid_to = '2026-03-11' WHERE source_path = ?`).run(note);
    await indexFile(db, note, options);
    expect(calls).toEqual({ facts: 1, events: 2 });
    const open = db.prepare(
      `SELECT row_kind FROM structured_rows WHERE source_path = ? AND valid_to IS NULL`,
    ).all(note) as Array<{ row_kind: string }>;
    expect(open.map(row => row.row_kind)).toEqual(['event']);
    db.close();
  });

  it('caches a run whose candidates were all gate-blocked, instead of re-deciding forever (#189)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    // A guardrail that blocks every candidate as `sensitive`: the extractor
    // yields a candidate, the capture gate rejects it, nothing is written. The
    // zero here is TRUE (it is decided from the candidate text alone), so it is
    // the "left nothing current" case — an extractor-yield marker would re-call
    // the extractor AND the per-candidate gate decision on every pass forever.
    const seen = { facts: 0, gate: 0 };
    const model: DecisionModel = {
      async decide(request) {
        if (request.task === 'capture_gate') {
          seen.gate++;
          return { task: 'capture_gate', decision: 'sensitive', confidence: 1, latencyMs: 0, costUSDCents: 0 };
        }
        return new LocalRulesDecisionModel().decide(request);
      },
    };
    const options = {
      numericFactExtractor: async () => {
        seen.facts++;
        return [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
      decisionModel: model,
    };
    await indexFile(db, note, options);
    expect(seen).toEqual({ facts: 1, gate: 1 });
    expect((db.prepare('SELECT count(*) AS c FROM structured_rows').get() as { c: number }).c).toBe(0);

    await indexFile(db, note, options);
    expect(seen).toEqual({ facts: 1, gate: 1 }); // no second extraction, no second gate decision
    expect(db.prepare(
      `SELECT max_rows_written FROM lane_runs
       WHERE source_path = ? AND row_kind = 'fact' AND source_hash = ? AND extraction_version = ?`,
    ).get(note, hashContent(NOTE), FACTS_EXTRACTION_VERSION)).toEqual({ max_rows_written: 0 });
    db.close();
  });

  it('re-extracts a zero-yield lane when the note content changes (#189)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0 };
    const options = {
      numericFactExtractor: async () => {
        calls.facts++;
        return calls.facts === 1
          ? []
          : [{ value: '16', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
    };
    await indexFile(db, note, options);
    expect(calls.facts).toBe(1);
    // The marker is keyed by source_hash: an edit invalidates it exactly as it
    // invalidates a row (ADR-0003 §4.2).
    fs.writeFileSync(note, NOTE.replace('14 kg', '16 kg'));
    await indexFile(db, note, options);
    expect(calls.facts).toBe(2);
    const open = db.prepare(
      `SELECT payload_json FROM structured_rows WHERE source_path = ? AND valid_to IS NULL`,
    ).all(note) as Array<{ payload_json: string }>;
    expect(open).toHaveLength(1);
    expect(JSON.parse(open[0].payload_json).value).toBe('16');
    db.close();
  });

  it('never records a failed extraction as a zero-yield run (#189)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0 };
    await expect(indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        throw new Error('extractor down');
      },
    })).rejects.toThrow(/extractor down/);
    // The throw path resets the note hash so the next pass retries. A marker
    // written there would cache the failure as "nothing to extract".
    expect((db.prepare('SELECT count(*) AS c FROM lane_runs').get() as { c: number }).c).toBe(0);
    await indexFile(db, note, {
      numericFactExtractor: async () => { calls.facts++; return []; },
    });
    expect(calls.facts).toBe(2); // the retry really re-ran the lane
    db.close();
  });

  it('drops a note\'s zero-yield marker with the note, so a re-added note is extracted again (#189)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0 };
    await indexFile(db, note, {
      numericFactExtractor: async () => { calls.facts++; return []; },
    });
    expect((db.prepare('SELECT count(*) AS c FROM lane_runs').get() as { c: number }).c).toBe(1);

    // The watcher's unlink path (src/watcher/watcher.ts): the note row goes and
    // the FK cascade takes the marker with it. A surviving marker would
    // silently suppress extraction of a re-added, byte-identical note forever.
    db.prepare('DELETE FROM notes WHERE path = ?').run(note);
    expect((db.prepare('SELECT count(*) AS c FROM lane_runs').get() as { c: number }).c).toBe(0);

    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
    });
    expect(calls.facts).toBe(2);
    expect((db.prepare(
      `SELECT count(*) AS c FROM structured_rows WHERE source_path = ? AND valid_to IS NULL`,
    ).get(note) as { c: number }).c).toBe(1);
    db.close();
  });

  it('a zero-yield run can never erase a positive record for the same key (review B1, round 6)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const hash = hashContent(NOTE);
    // First pass creates the note row the marker's FK needs and records a zero.
    await indexFile(db, note, { numericFactExtractor: async () => [] });
    // Two concurrent runs can legitimately disagree about the same bytes — the
    // extractor is a model — so the later-finishing run must not be able to
    // erase a positive outcome with a zero. The record is monotone: a zero can
    // only ever mean "no completed run for these bytes wrote a row".
    recordLaneRun(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION, 0);
    expect(laneZeroYieldMarker(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION)).toEqual({ laneZeroYield: true });
    recordLaneRun(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION, 3);
    // The delayed zero lands last, exactly as the review's repro staged it.
    recordLaneRun(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION, 0);
    expect(db.prepare(
      `SELECT max_rows_written FROM lane_runs
       WHERE source_path = ? AND row_kind = 'fact' AND source_hash = ? AND extraction_version = ?`,
    ).get(note, hash, FACTS_EXTRACTION_VERSION)).toEqual({ max_rows_written: 3 });
    // ...so the bytes are not treated as empty once their rows are gone, which
    // is the state an edit-away/revert reaches.
    expect(laneZeroYieldMarker(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION)).toBeUndefined();
    db.close();
  });

  it('a run that yielded rows leaves no skip behind for those bytes (review B1)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0 };
    const options = {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
    };
    await indexFile(db, note, options);
    expect(calls.facts).toBe(1);

    // The edit path deletes rows by (source_path, row_kind), NOT by hash, so a
    // note edited away and back has no rows for the original bytes any more.
    // A marker derived from rows could look empty here and suppress the lane
    // for bytes that DO yield; the recorded run yield (1) is not a skip.
    deleteStructuredRowsForSourceKind(db, note, 'fact');
    await indexFile(db, note, options);
    expect(calls.facts).toBe(2);
    expect((db.prepare(
      `SELECT count(*) AS c FROM structured_rows WHERE source_path = ? AND valid_to IS NULL`,
    ).get(note) as { c: number }).c).toBe(1);
    db.close();
  });

  it('a live row outranks a zero-yield marker for the same key (review U1)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const hash = hashContent(NOTE);
    await indexFile(db, note, { numericFactExtractor: async () => [] });
    expect(laneZeroYieldMarker(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION)).toEqual({ laneZeroYield: true });

    // A concurrent writer for the SAME note (the watcher indexing while a CLI
    // index runs) can insert a row after this run counted its yield, leaving a
    // snapshot that says "nothing". The row half is re-checked in the same
    // statement, so a live row is never suppressed by that stale marker.
    insertStructuredRows(db, [{
      rowKind: 'fact',
      sourcePath: note,
      sourceChunkId: (db.prepare(
        'SELECT id FROM chunks WHERE note_path = ? ORDER BY id LIMIT 1',
      ).get(note) as { id: number }).id,
      sourceHash: hash,
      extractionVersion: FACTS_EXTRACTION_VERSION,
      validFrom: '2026-03-10',
      payload: { value: '14', unit: 'kg', verb: 'weighs', object: 'dog' },
    }]);
    expect(laneZeroYieldMarker(db, note, 'fact', hash, FACTS_EXTRACTION_VERSION)).toBeUndefined();
    db.close();
  });

  it('extracts again when the only current-hash fact row is already closed', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = path.join(v, 'note.md');
    fs.writeFileSync(note, NOTE);
    const calls = { facts: 0 };
    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '14', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
    });
    db.prepare(`UPDATE structured_rows SET valid_to = '2026-03-11' WHERE source_path = ?`).run(note);
    await indexFile(db, note, {
      numericFactExtractor: async () => {
        calls.facts++;
        return [{ value: '16', unit: 'kg', verb: 'weighs', object: 'dog' }];
      },
    });
    expect(calls.facts).toBe(2);
    const open = db.prepare(
      `SELECT payload_json FROM structured_rows
       WHERE source_path = ? AND row_kind = 'fact' AND valid_to IS NULL`,
    ).get(note) as { payload_json: string };
    expect(JSON.parse(open.payload_json).value).toBe('16');
    db.close();
  });
});
