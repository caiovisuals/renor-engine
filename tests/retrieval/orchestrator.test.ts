import { describe, it, expect, afterEach, vi } from 'vitest';
import { retrieveContext, resolveSessionDate, sessionDateMs, createNoteTimeBound, clampSessionDate, orderHits, WRITE_CLOCK_TOLERANCE_MS } from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';

const DB = tmpPath('test-orch.db');
afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  delete process.env.RENOR_NEWEST_FIRST;
});

describe('session date helpers', () => {
  it('prefers session_date over date over modified_at when the claim is no later than mtime', () => {
    expect(resolveSessionDate(
      JSON.stringify({ session_date: '2023/05/20 (Sat) 02:10', date: '2024-01-01' }),
      '2025-01-01T00:00:00.000Z',
    )).toBe('2023/05/20 (Sat) 02:10');
    expect(resolveSessionDate(JSON.stringify({ date: '2024-06-02' }), '2025-01-01T00:00:00.000Z')).toBe('2024-06-02');
    expect(resolveSessionDate('{}', '2021-08-15T12:00:00.000Z')).toBe('2021-08-15T12:00:00.000Z');
    expect(resolveSessionDate(undefined, undefined)).toBeUndefined();
  });

  it.each(['session_date', 'date'])('caps future %s claims, including zoned and official timestamps', field => {
    const modified = '2026-10-11T10:30:00.000Z';
    for (const value of ['2099-01-01', '2099/01/01 (Thu) 00:00', '2026-10-11T12:30:03+02:00']) {
      expect(resolveSessionDate(JSON.stringify({ [field]: value }), modified)).toBe(modified);
    }
    expect(resolveSessionDate(JSON.stringify({ [field]: modified }), modified)).toBe(modified);
  });

  it('preserves coarse write-clock differences but caps dates beyond the tolerance', () => {
    const bound = '2026-10-11T10:30:00.000Z';
    const after = (ms: number) => new Date(Date.parse(bound) + ms).toISOString();
    expect(clampSessionDate(after(1), bound)).toBe(after(1));
    expect(clampSessionDate(after(WRITE_CLOCK_TOLERANCE_MS), bound)).toBe(after(WRITE_CLOCK_TOLERANCE_MS));
    expect(clampSessionDate(after(WRITE_CLOCK_TOLERANCE_MS + 1), bound)).toBe(bound);
    expect(clampSessionDate('2099-01-01', bound)).toBe(bound);
    expect(clampSessionDate(after(1), undefined)).toBeUndefined();
  });

  it('does not grant asserted dates priority without a valid file timestamp', () => {
    expect(resolveSessionDate('{"date":"2099-01-01"}', undefined)).toBeUndefined();
    expect(resolveSessionDate('{"session_date":"2099-01-01"}', 'invalid')).toBeUndefined();
    expect(resolveSessionDate('{invalid', '2026-10-11')).toBe('2026-10-11');
    // A claim that is not an instant is undated, never shown verbatim: it sorts as undated, so it is shown as undated.
    expect(resolveSessionDate('{"date":"invalid"}', '2026-10-11')).toBeUndefined();
  });

  it('shows no date for a claim that cannot be read as an instant, and keeps its place in the order', () => {
    for (const claim of ['2099-01-01T10:00', '2099-01-01 10:00', '2099-01-01T25:00:00Z', '2099-01-01T99:99:99.000Z']) {
      expect(resolveSessionDate(JSON.stringify({ session_date: claim }), '2026-10-11T10:00:00.000Z'), claim).toBeUndefined();
    }
    // Readable claims are unchanged: a date-only and an offset date-time are still read.
    expect(resolveSessionDate('{"session_date":"2026-10-10"}', '2026-10-11T10:00:00.000Z')).toBe('2026-10-10');
    expect(resolveSessionDate('{"session_date":"2026-10-11T09:00:00+00:00"}', '2026-10-11T10:00:00.000Z')).toBe('2026-10-11T09:00:00+00:00');
    // Ordered as before: the unreadable claim is undated and comes after every dated hit.
    const ordered = orderHits([
      { id: 'undated', score: 0.9, session_date: resolveSessionDate('{"session_date":"2099-01-01T10:00"}', '2026-10-11T10:00:00.000Z') },
      { id: 'older', score: 0.1, session_date: '2026-10-10T00:00:00.000Z' },
    ], 'session_date');
    expect(ordered.map(h => h.id)).toEqual(['older', 'undated']);
  });

  it('bounds derived clocks by file time rather than historical front matter, and fails closed without a bound', () => {
    const db = openDb(DB); runMigrations(db);
    try {
      db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)')
        .run('/v/day.md', 'Day', null, 'h', '2026-10-11T10:30:00.000Z', '{"date":"2026-01-01"}');
      db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)')
        .run('/v/invalid.md', 'Invalid', null, 'i', 'invalid', '{}');
      const bound = createNoteTimeBound(db);
      expect(bound('/v/day.md', '2026-10-11T10:29:15.000Z')).toBe('2026-10-11T10:29:15.000Z');
      expect(bound('/v/day.md', '2099-01-01')).toBe('2026-10-11T10:30:00.000Z');
      expect(bound('/v/invalid.md', '2099-01-01')).toBeUndefined();
      expect(bound('/v/missing.md', '2099-01-01')).toBeUndefined();
    } finally { db.close(); }
  });

  it('orders LongMemEval session_date strings newest-first', () => {
    const older = sessionDateMs('2020/01/01 (Wed) 00:00');
    const newer = sessionDateMs('2023/05/20 (Sat) 02:10');
    expect(newer).toBeGreaterThan(older);
    expect(sessionDateMs(undefined)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('requires an explicit zone on ISO datetimes and preserves deterministic date formats', () => {
    const previousTz = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(sessionDateMs('2026-01-01T10:00:00')).toBe(Number.NEGATIVE_INFINITY);
      expect(sessionDateMs('2026-01-01 10:00')).toBe(Number.NEGATIVE_INFINITY);
      expect(sessionDateMs('2026-01-01T10:00:00Z')).toBe(Date.UTC(2026, 0, 1, 10));
      expect(sessionDateMs('2026-01-01T10:00:00+02:00')).toBe(Date.UTC(2026, 0, 1, 8));
      expect(sessionDateMs('2026/01/01 (Thu) 11:00')).toBe(Date.UTC(2026, 0, 1, 11));
      expect(sessionDateMs('2026-01-01')).toBe(Date.UTC(2026, 0, 1));
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});

describe('retrieveContext', () => {
  it('with no embedding provider, finds a note by its words from the keyword index', async () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/bike.md','Bike','note','h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/bike.md','','The red bicycle lives in the garage.',0,2,8,'hb');
    const result = await retrieveContext(db, undefined, undefined, 'bicycle', 5, []);
    expect(result.hits.map(h => h.notePath)).toEqual(['/v/bike.md']);
    expect(await retrieveContext(db, undefined, undefined, 'zeppelin', 5, [])).toMatchObject({ hits: [] });
    db.close();
  });

  it('returns hits with reason field', async () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/john.md','John Doe','person','h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/john.md','','John at Acme.',0,2,5,'h1');
    const id = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable(); idx.upsert(id, [1,0,0,0]);
    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[0.9,0,0,0]]) };

    const result = await retrieveContext(db, idx, provider, 'John', 5, ['OpenClaw Memory/', 'Projects/', 'Infrastructure/']);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0].reason).toBeTruthy();
    db.close();
  });

  it('boosts priority paths', async () => {
    const db = openDb(DB); runMigrations(db);
    // Two notes: one in OpenClaw Memory (priority), one generic
    db.prepare("INSERT INTO notes VALUES ('/v/OpenClaw Memory/User.md','User','preference','h1','2026-03-30','{}')").run();
    db.prepare("INSERT INTO notes VALUES ('/v/scratch.md','Scratch',null,'h2','2026-03-30','{}')").run();

    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/OpenClaw Memory/User.md','','Priority content.',0,2,5,'h1');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/scratch.md','','Generic content.',0,2,5,'h2');

    const id1 = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('h1') as any).id;
    const id2 = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('h2') as any).id;

    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(id1, [1, 0, 0, 0]);
    idx.upsert(id2, [0.95, 0, 0, 0]); // slightly lower semantic score

    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[1,0,0,0]]) };
    const result = await retrieveContext(db, idx, provider, 'content', 5, ['OpenClaw Memory/', 'Projects/', 'Infrastructure/']);

    // Priority note should rank first despite slightly lower base score
    expect(result.hits[0].notePath).toContain('OpenClaw Memory');
    expect(result.hits[0].reason).toContain('priority');
    db.close();
  });

  it('includes graph-related notes in results', async () => {
    const db = openDb(DB); runMigrations(db);

    // Create two notes with entities
    db.prepare("INSERT INTO notes VALUES ('/v/alpha.md','Alpha','project','h1','2026-03-30','{}')").run();
    db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h2','2026-03-30','{}')").run();

    // Chunks
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/alpha.md','','Alpha project uses Redis for caching.',0,2,10,'h1');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/john.md','','John is a Redis expert at Acme.',0,2,8,'h2');

    // Entities
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('project','Alpha','[]','/v/alpha.md',1.0,'2026-03-30');
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('person','John','[]','/v/john.md',1.0,'2026-03-30');

    // Relation: Alpha links_to John
    const alphaId = (db.prepare("SELECT id FROM entities WHERE canonical_name='Alpha'").get() as any).id;
    const johnId = (db.prepare("SELECT id FROM entities WHERE canonical_name='John'").get() as any).id;
    db.prepare("INSERT INTO relations (source_entity_id,relation,target_entity_id,source_note,confidence) VALUES (?,?,?,?,?)")
      .run(alphaId, 'links_to', johnId, '/v/alpha.md', 1.0);

    // Only embed Alpha's chunk — John's chunk is intentionally not in the vector index
    // so John can only be reached via graph expansion
    const chunkId1 = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='h1'").get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId1, [1,0,0,0]);

    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[1,0,0,0]]) };
    const result = await retrieveContext(db, idx, provider, 'Redis caching', 5, []);

    // Alpha should be found semantically, John should appear via graph relation
    const paths = result.hits.map(h => h.notePath);
    expect(paths).toContain('/v/alpha.md');
    expect(paths).toContain('/v/john.md');

    // John's hit should have 'graph' in reason
    const johnHit = result.hits.find(h => h.notePath === '/v/john.md');
    expect(johnHit?.reason).toContain('graph');

    db.close();
  });

  it('boosts hits with matching facts', async () => {
    const db = openDb(DB); runMigrations(db);

    db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h1','2026-03-30','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/john.md','','John is an engineer.',0,2,5,'h1');

    const chunkId = (db.prepare("SELECT id FROM chunks LIMIT 1").get() as any).id;

    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('person','John','[]','/v/john.md',1.0,'2026-03-30');
    const entityId = (db.prepare("SELECT id FROM entities LIMIT 1").get() as any).id;

    // Add a fact: John works_at Acme
    db.prepare("INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,confidence,valid_from,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(entityId, 'works_at', 'Acme Corp', '/v/john.md', 0.9, '2026-03-30', '2026-03-30');

    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId, [1,0,0,0]);

    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[0.9,0,0,0]]) };

    // Search for "Acme" — should match via fact
    const result = await retrieveContext(db, idx, provider, 'Acme', 5, []);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0].reason).toContain('fact');

    db.close();
  });

  it('ranks a contentful note above speaker-only transcript stubs with similar embeddings',
    async () => {
    const db = openDb(DB); runMigrations(db);
    const today = new Date().toISOString();
    db.prepare("INSERT INTO notes VALUES ('/v/Meetings/call.md','Call','meeting','h1',?,'{}')").run(today);
    db.prepare("INSERT INTO notes VALUES ('/v/People/Rowan.md','Rowan','person','h2',?,'{}')").run(today);
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/Meetings/call.md', '', '**Rowan:**', 0, 1, 2, 'stub1');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/Meetings/call.md', '', '**Rowan:**', 2, 3, 2, 'stub2');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/Meetings/call.md', '', '**Rowan:**', 4, 5, 2, 'stub3');
    const longText = 'Rowan\'s dog is Biscuit, a small dog under 10kg. He walks Biscuit twice on weekdays.';
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/People/Rowan.md', '', longText, 0, 4, 20, 'real');
    const stubIds = db.prepare("SELECT id FROM chunks WHERE chunk_hash LIKE 'stub%'").all() as { id: number }[];
    const realId = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='real'").get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    for (const s of stubIds) idx.upsert(s.id, [1, 0, 0, 0]);
    idx.upsert(realId, [0.97, 0.1, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const result = await retrieveContext(db, idx, provider, "Rowan dog name", 5, []);
    expect(result.hits[0].notePath).toContain('Rowan.md');
    expect(result.hits[0].text).toContain('Biscuit');
    expect(result.hits.filter(h => h.text.includes('**Rowan:**'))).toHaveLength(0);
    db.close();
  });

  it('does not treat a short content fact as a speaker stub',
    async () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/p.md','P','person','h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/p.md', '', 'Biscuit', 0, 1, 1, 'name');
    const id = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable(); idx.upsert(id, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const result = await retrieveContext(db, idx, provider, 'dog', 5, []);
    expect(result.hits[0].text).toBe('Biscuit');
    expect(result.hits[0].reason).not.toContain('stub');
    db.close();
  });

  it('buries heading-prefixed speaker stubs the chunker actually emits',
    async () => {
    const db = openDb(DB); runMigrations(db);
    const today = new Date().toISOString();
    db.prepare("INSERT INTO notes VALUES ('/v/Meetings/call.md','Call','meeting','h1',?,'{}')").run(today);
    db.prepare("INSERT INTO notes VALUES ('/v/People/Rowan.md','Rowan','person','h2',?,'{}')").run(today);
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/Meetings/call.md', 'Call with Gabriel', '## Call with Gabriel\n**Rowan:**', 0, 2, 6, 'headstub');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/People/Rowan.md', '', 'Rowan owns a dog: Biscuit.', 0, 1, 6, 'fact');
    const stubId = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='headstub'").get() as { id: number }).id;
    const factId = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='fact'").get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(stubId, [1, 0, 0, 0]);
    idx.upsert(factId, [0.9, 0.1, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const result = await retrieveContext(db, idx, provider, 'Rowan dog', 5, []);
    expect(result.hits[0].text).toContain('Biscuit');
    expect(result.hits.filter(h => h.text.includes('**Rowan:**'))).toHaveLength(0);
    expect(result.hits[0].notePath).toContain('Rowan.md');
    db.close();
  });

  it('defaults to 20 hits and still honors an explicit topK of 10', async () => {
    const db = openDb(DB); runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    for (let i = 0; i < 25; i++) {
      const path = `/v/n${i}.md`;
      db.prepare("INSERT INTO notes VALUES (?,?,'note','h','2026-03-30','{}')").run(path, `N${i}`);
      db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
        .run(path, '', `contentful note ${i} about widgets and retrieval depth.`, 0, 2, 8, `h${i}`);
      const id = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get(`h${i}`) as { id: number }).id;
      idx.upsert(id, [1 - i * 0.001, 0, 0, 0]);
    }
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const defaulted = await retrieveContext(db, idx, provider, 'widgets');
    expect(defaulted.hits).toHaveLength(20);
    const explicit = await retrieveContext(db, idx, provider, 'widgets', 10);
    expect(explicit.hits).toHaveLength(10);
    db.close();
  });

  it('attaches session_date from frontmatter without rewriting chunk text', async () => {
    const db = openDb(DB); runMigrations(db);
    const fm = JSON.stringify({ kind: 'longmemeval-session', session_date: '2023/05/20 (Sat) 02:10' });
    db.prepare("INSERT INTO notes VALUES ('/v/Sessions/s1.md','S1','longmemeval-session','h1','2026-03-30T00:00:00.000Z',?)")
      .run(fm);
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/Sessions/s1.md', '', 'User bought tea on that trip.', 0, 2, 8, 's1');
    const id = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable(); idx.upsert(id, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const result = await retrieveContext(db, idx, provider, 'tea', 5, []);
    expect(result.hits[0].text).toBe('User bought tea on that trip.');
    expect(result.hits[0].session_date).toBe('2023/05/20 (Sat) 02:10');
    db.close();
  });

  it('falls back from session_date to date to modified_at', async () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/a.md','A','conversation','ha','2025-01-01T00:00:00.000Z',?)")
      .run(JSON.stringify({ date: '2024-06-02' }));
    db.prepare("INSERT INTO notes VALUES ('/v/b.md','B','note','hb','2021-08-15T12:00:00.000Z','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/a.md', '', 'Conversation about mango juice.', 0, 2, 6, 'a');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/b.md', '', 'Undated note about mango juice.', 0, 2, 6, 'b');
    const idA = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='a'").get() as { id: number }).id;
    const idB = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='b'").get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(idA, [1, 0, 0, 0]);
    idx.upsert(idB, [0.99, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const result = await retrieveContext(db, idx, provider, 'mango', 5, []);
    const a = result.hits.find(h => h.notePath === '/v/a.md');
    const b = result.hits.find(h => h.notePath === '/v/b.md');
    expect(a?.session_date).toBe('2024-06-02');
    expect(b?.session_date).toBe('2021-08-15T12:00:00.000Z');
    expect(a?.text).toBe('Conversation about mango juice.');
    db.close();
  });

  it('keeps newest-session-first ordering stable across host timezones', async () => {
    const db = openDb(DB); runMigrations(db);
    const oldModifiedAt = '2000-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)')
      .run('/v/naive.md', 'Naive', 'session', 'naive-hash', oldModifiedAt, JSON.stringify({ session_date: '2026-01-01T10:00:00' }));
    db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?)')
      .run('/v/lme.md', 'LME', 'session', 'lme-hash', oldModifiedAt, JSON.stringify({ session_date: '2026/01/01 (Thu) 11:00' }));
    db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
      .run('/v/naive.md', '', 'Naive date note', 0, 1, 3, 'naive-date');
    db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
      .run('/v/lme.md', '', 'LME date note', 0, 1, 3, 'lme-date');
    const naiveId = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='naive-date'").get() as { id: number }).id;
    const lmeId = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='lme-date'").get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(naiveId, [1, 0, 0, 0]);
    idx.upsert(lmeId, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };
    const previousTz = process.env.TZ;
    delete process.env.RENOR_NEWEST_FIRST;
    try {
      const orders: string[][] = [];
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        const result = await retrieveContext(db, idx, provider, 'events', 5, [], { nowMs: Date.UTC(2026, 1, 1) });
        orders.push(result.hits.map((hit) => hit.notePath));
      }
      expect(orders).toEqual(Array.from({ length: 3 }, () => ['/v/lme.md', '/v/naive.md']));
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
      db.close();
    }
  });

  it('defaults to newest-session-first; score order when RENOR_NEWEST_FIRST=0', async () => {
    const db = openDb(DB); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/old.md','Old','session','ho','2020-01-01T00:00:00.000Z',?)")
      .run(JSON.stringify({ session_date: '2020-01-01' }));
    db.prepare("INSERT INTO notes VALUES ('/v/new.md','New','session','hn','2024-12-01T00:00:00.000Z',?)")
      .run(JSON.stringify({ session_date: '2024-12-01' }));
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/old.md', '', 'Older session mentions the red bicycle.', 0, 2, 8, 'old');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/new.md', '', 'Newer session mentions the red bicycle.', 0, 2, 8, 'new');
    const idOld = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='old'").get() as { id: number }).id;
    const idNew = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='new'").get() as { id: number }).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(idOld, [1, 0, 0, 0]);
    idx.upsert(idNew, [0.85, 0.1, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };

    const prev = process.env.RENOR_NEWEST_FIRST;
    delete process.env.RENOR_NEWEST_FIRST;
    const on = await retrieveContext(db, idx, provider, 'bicycle', 5, []);
    expect(on.hits.map(h => h.notePath)).toEqual(['/v/new.md', '/v/old.md']);
    expect(on.hits[0].session_date).toBe('2024-12-01');
    expect(on.hits[0].text).toBe('Newer session mentions the red bicycle.');

    process.env.RENOR_NEWEST_FIRST = '0';
    const off = await retrieveContext(db, idx, provider, 'bicycle', 5, []);
    expect(off.hits.map(h => h.notePath)).toEqual(['/v/old.md', '/v/new.md']);
    expect(off.hits[0].session_date).toBe('2020-01-01');
    expect(off.hits[0].text).toBe('Older session mentions the red bicycle.');
    if (prev === undefined) delete process.env.RENOR_NEWEST_FIRST;
    else process.env.RENOR_NEWEST_FIRST = prev;
    db.close();
  });
});
