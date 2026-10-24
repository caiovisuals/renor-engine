import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import { remember, replayLedger, factsFor } from '../../src/memory/lifecycle';
import type Database from '../../src/db/sqlite';

/**
 * B5 regression: lifecycle facts must not be cascade-deleted by note
 * reindexing. Lifecycle facts attach to a stable lifecycle-owned entity
 * (source_note '_mcp_'), never to a disposable note-derived entity, so
 * index/replay order cannot change lifecycle identity.
 * Deterministic reproduction of the code-derived Gate-0 finding.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1a-cascade-'));
  tmpDirs.push(d);
  return d;
}

function freshDb(file: string): Database.Database {
  const db = openDb(file);
  runMigrations(db);
  return db;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('B5: lifecycle facts survive note reindex', () => {
  it('a fact about a subject that is also a note title survives note edit + reindex', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const notePath = path.join(v, 'Alice.md');
    fs.writeFileSync(notePath, '# Alice\n\nAlice is a synthetic person.\n');

    await indexFile(db, notePath, {}); // no embedding provider — pure SQL indexing
    await remember(db, v, LEDGER, { subject: 'Alice', predicate: 'lives_in', object: 'Paris', source: 'poc' });

    // Current lookup before reindex.
    expect(factsFor(db, 'Alice')).toHaveLength(1);

    // Edit the note and reindex — at base this cascade-deletes the lifecycle
    // fact (it was attached to the disposable note entity).
    fs.writeFileSync(notePath, '# Alice\n\nEdited body.\n');
    await indexFile(db, notePath, {});

    const current = factsFor(db, 'Alice') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Paris');
    expect(current[0].valid_to).toBeNull();
    db.close();
  });

  it('lifecycle identity is independent of index/replay order', async () => {
    const v = mkvault();
    fs.writeFileSync(path.join(v, 'Alice.md'), '# Alice\n\nAlice is a synthetic person.\n');
    // Seed the ledger through the canonical write path.
    const seedDb = freshDb(path.join(v, 'seed.db'));
    await remember(seedDb, v, LEDGER, { subject: 'Alice', predicate: 'lives_in', object: 'Paris', source: 'poc' });
    seedDb.close();

    // Order A: index note first, then replay ledger.
    const dbA = freshDb(path.join(v, 'a.db'));
    await indexFile(dbA, path.join(v, 'Alice.md'), {});
    await replayLedger(dbA, v, LEDGER);
    const factsA = factsFor(dbA, 'Alice') as any[];

    // Order B: replay ledger first, then index note.
    const dbB = freshDb(path.join(v, 'b.db'));
    await replayLedger(dbB, v, LEDGER);
    await indexFile(dbB, path.join(v, 'Alice.md'), {});
    const factsB = factsFor(dbB, 'Alice') as any[];

    // Same current value and same lifecycle identity in both orders. Identity
    // is semantic (lifecycle-owned entity: canonical_name + source_note
    // '_mcp_'), not the rowid, which legitimately differs between DB files.
    expect(factsA).toHaveLength(1);
    expect(factsB).toHaveLength(1);
    expect(factsA[0].object_text).toBe(factsB[0].object_text);
    expect(factsA[0].event_id).toBe(factsB[0].event_id);
    for (const [label, dbX, fact] of [['A', dbA, factsA[0]], ['B', dbB, factsB[0]]] as const) {
      const owner = dbX.prepare(
        `SELECT canonical_name, source_note FROM entities WHERE id = ?`
      ).get(fact.subject_entity_id) as any;
      expect(owner.source_note).toBe('_mcp_');
      expect(owner.canonical_name.toLowerCase()).toBe('alice');
    }
    dbA.close();
    dbB.close();
  });

  it('every lifecycle fact survives a full derived-table wipe + replay (rebuild contract)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: 'SynthKeep', predicate: 'role', object: 'survivor', source: 'poc' });
    await remember(db, v, LEDGER, { subject: 'SynthKeep', predicate: 'role', object: 'still-survivor', source: 'poc' });
    db.close();

    // Simulate the rebuild wipe of derived tables.
    const db2 = freshDb(path.join(v, 'rebuild.db'));
    db2.transaction(() => {
      ['facts', 'relations', 'entities', 'chunks', 'notes', 'applied_ledger_events'].forEach(t =>
        db2.prepare(`DELETE FROM ${t}`).run()
      );
    })();
    const applied = await replayLedger(db2, v, LEDGER);
    expect(applied).toBe(2);
    const current = factsFor(db2, 'SynthKeep') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('still-survivor');
    const history = factsFor(db2, 'SynthKeep', { includeHistory: true }) as any[];
    expect(history).toHaveLength(2);
    db2.close();
  });
});