import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';

const DB = tmpPath('test-watcher.db');

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn();
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({ on: mockOn, close: mockClose })),
  },
}));

// Mock indexFile
vi.mock('../../src/indexer/pipeline', () => ({
  indexFile: vi.fn().mockResolvedValue(undefined),
}));

import { startWatcher } from '../../src/watcher/watcher';
import chokidar from 'chokidar';
import { tmpPath } from '../helpers/tmpPath';

beforeEach(() => {
  vi.clearAllMocks();
  mockOn.mockReturnThis();
});

afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

describe('startWatcher', () => {
  it('registers add, change, and unlink handlers', () => {
    const db = openDb(DB); runMigrations(db);
    startWatcher('/vault', db, {});
    const events = mockOn.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('add');
    expect(events).toContain('change');
    expect(events).toContain('unlink');
    db.close();
  });

  it('watches correct glob pattern', () => {
    const db = openDb(DB); runMigrations(db);
    startWatcher('/vault', db, {});
    expect(chokidar.watch).toHaveBeenCalledWith(
      expect.stringContaining('**/*.md'),
      expect.objectContaining({ persistent: true, ignoreInitial: true })
    );
    db.close();
  });

  it('unlink handler deletes note and relations', () => {
    const db = openDb(DB); runMigrations(db);
    // Seed a note
    db.prepare("INSERT INTO notes VALUES ('/vault/test.md','Test',null,'h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('note', 'Test', '[]', '/vault/test.md', 1.0, '2026-03-30');

    startWatcher('/vault', db, {});

    // Find the unlink handler and call it
    const unlinkCall = mockOn.mock.calls.find((c: any[]) => c[0] === 'unlink');
    expect(unlinkCall).toBeTruthy();
    const unlinkHandler = unlinkCall![1];
    unlinkHandler('/vault/test.md');

    // Verify note was deleted (cascade deletes entities)
    const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('/vault/test.md');
    expect(note).toBeUndefined();
    db.close();
  });
});
