import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { createMcpTools } from '../../src/mcp/server';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { remember, factsFor } from '../../src/memory/lifecycle';
import { quoteFtsQuery, identityNames, pickEntityName, pickTopK } from '../../src/retrieval/queryHelpers';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('quoteFtsQuery', () => {
  it('wraps hyphenated tokens so FTS5 cannot treat them as columns', () => {
    expect(quoteFtsQuery('tensaku-capture')).toBe('"tensaku-capture"');
  });
  it('escapes quotes', () => {
    expect(quoteFtsQuery('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('identityNames', () => {
  it('maps Rowan / Rowan Vale to the same set', () => {
    const a = identityNames('Rowan').sort();
    const b = identityNames('Rowan Vale').sort();
    expect(a).toEqual(b);
    expect(a).toContain('Rowan Vale Holm');
  });
});

describe('pick aliases', () => {
  it('accepts name as entityName and top_k as topK', () => {
    expect(pickEntityName({ name: 'Rowan' })).toBe('Rowan');
    expect(pickEntityName({ entityName: 'X' })).toBe('X');
    expect(pickTopK({ top_k: 7 })).toBe(7);
    expect(pickTopK({ topK: 3 })).toBe(3);
    expect(pickTopK({})).toBe(20);
    expect(pickTopK({ topK: 10 })).toBe(10);
  });
});

describe('MCP contract + identity', () => {
  it('facts({name}) matches entityName; Rowan Vale sees Rowan facts; hyphen FTS does not throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'i.db');
    const db = openDb(dbPath);
    runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: async () => [], dimensions: 4 } as any, {
      vaultPath: dir, memoryDir: 'Memory/Daily', priorityPaths: [], memoryLedger: 'System/Memory Events Ledger.md',
    });
    await remember(db, dir, 'System/Memory Events Ledger.md', {
      subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit', source: 'test',
    });
    const byName = await tools.facts({ name: 'Rowan' } as any);
    expect(byName.some((f: any) => f.object_text === 'Biscuit')).toBe(true);
    const byFull = await tools.facts({ entityName: 'Rowan Vale' });
    expect(byFull.some((f: any) => f.object_text === 'Biscuit')).toBe(true);
    expect(factsFor(db, 'Rowan Vale Holm').some((f: any) => f.object_text === 'Biscuit')).toBe(true);

    db.prepare("INSERT INTO notes VALUES ('/v/t.md','T',null,'h','2026-01-01','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/t.md', '', 'tensaku-capture notes', 0, 1, 3, 'h1');
    const fts = await tools.keyword({ query: 'tensaku-capture', top_k: 5 } as any);
    expect(Array.isArray(fts) || (fts as any).ok !== false).toBe(true);
    if (Array.isArray(fts)) expect(fts.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
