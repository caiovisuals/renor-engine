import { describe, it, expect, afterEach } from 'vitest';
import { lookupEntity } from '../../src/retrieval/entityLookup';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

const DB = tmpPath('test-entity.db');
afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

function seedEntity(db: any) {
  db.prepare("INSERT INTO notes VALUES ('/v/john.md','John Doe','person','h','2026-01-01','{}')").run();
  db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
    .run('person','John Doe','["John","JD"]','/v/john.md',1.0,'2026-01-01');
}

describe('lookupEntity', () => {
  it('finds by canonical name', () => {
    const db = openDb(DB); runMigrations(db); seedEntity(db);
    expect(lookupEntity(db,'John Doe')?.type).toBe('person');
    db.close();
  });

  it('finds by alias', () => {
    const db = openDb(DB); runMigrations(db); seedEntity(db);
    expect(lookupEntity(db,'JD')?.canonicalName).toBe('John Doe');
    db.close();
  });

  it('returns null for unknown name', () => {
    const db = openDb(DB); runMigrations(db);
    expect(lookupEntity(db,'Nobody')).toBeNull();
    db.close();
  });
});
