import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/api/server';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A fixed /tmp path is shared state: two suites running at once (two worktrees, or an agent
// gate alongside a developer run) would migrate and seed the same SQLite file. Derive it from
// os.tmpdir() so the path is per-run — the agent gate points TMPDIR at its own run directory.
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renor-api-test-')), 'test-api.db');
afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  delete process.env.RENOR_SEARCH_EVIDENCE;
});

// The API requires a bearer token on every route (tests/api/server-host-header.test.ts proves the refusals); these
// tests are about what the routes answer to a client that has it.
const API_TOKEN = 'synthetic-api-token-for-tests';
const authed = (app: Parameters<typeof request>[0]) => request.agent(app).set('Authorization', `Bearer ${API_TOKEN}`);

function createTestApp() {
  const db = openDb(DB);
  runMigrations(db);
  // Seed data
  db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h1','2026-03-30T00:00:00.000Z','{}')").run();
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run('/v/john.md', '', 'John is an engineer.', 0, 2, 5, 'h1');
  db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
    .run('person', 'John', '["JD"]', '/v/john.md', 1.0, '2026-03-30');
  const entityId = (db.prepare('SELECT id FROM entities LIMIT 1').get() as any).id;
  db.prepare("INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,confidence,valid_from,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(entityId, 'works_at', 'Acme Corp', '/v/john.md', 0.9, '2026-03-30', '2026-03-30');

  const chunkId = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
  const idx = new VectorIndex(db, 4); idx.initTable();
  idx.upsert(chunkId, [1, 0, 0, 0]);

  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
  const app = createServer(db, idx, provider as any, '/v', [], undefined, undefined, { apiToken: API_TOKEN });
  return { app, db };
}

describe('API server', () => {
  it('POST /retrieve-context returns hits', async () => {
    process.env.RENOR_SEARCH_EVIDENCE = '0';
    const { app, db } = createTestApp();
    const res = await authed(app).post('/retrieve-context').send({ query: 'engineer' });
    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.body.query).toBe('engineer');
    expect(res.body.evidence).toBeUndefined();
    db.close();
    delete process.env.RENOR_SEARCH_EVIDENCE;
  });

  it('POST /retrieve-context returns 400 without query', async () => {
    const { app, db } = createTestApp();
    const res = await authed(app).post('/retrieve-context').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('query required');
    db.close();
  });

  it('GET /entity/:name returns entity', async () => {
    const { app, db } = createTestApp();
    const res = await authed(app).get('/entity/John');
    expect(res.status).toBe(200);
    expect(res.body.canonicalName).toBe('John');
    db.close();
  });

  it('GET /entity/:name returns 404 for unknown', async () => {
    const { app, db } = createTestApp();
    const res = await authed(app).get('/entity/Unknown');
    expect(res.status).toBe(404);
    db.close();
  });

  it('GET /facts/:entityId returns facts', async () => {
    const { app, db } = createTestApp();
    const entityId = (db.prepare('SELECT id FROM entities LIMIT 1').get() as any).id;
    const res = await authed(app).get(`/facts/${entityId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].predicate).toBe('works_at');
    db.close();
  });

  it('GET /facts/:entityId is current-only (superseded facts hidden)', async () => {
    const { app, db } = createTestApp();
    const entityId = (db.prepare('SELECT id FROM entities LIMIT 1').get() as any).id;
    // Seed a superseded fact for the same entity/predicate (closed by valid_to).
    db.prepare(
      "INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,confidence,valid_from,valid_to,updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(entityId, 'works_at', 'Old Corp', '/v/john.md', 0.9, '2026-03-01', '2026-03-29', '2026-03-29');
    const res = await authed(app).get(`/facts/${entityId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].object_text).toBe('Acme Corp');
    db.close();
  });

  it('GET /search is not exposed; use POST /retrieve-context', async () => {
    const { app, db } = createTestApp();
    const res = await authed(app).get('/search?q=engineer');
    expect(res.status).toBe(404);
    db.close();
  });
});

/**
 * POST /memory/fact is the HTTP face of the ledger-backed durable write.
 *
 * The distinction under test is caller error vs engine fault. remember() validates every
 * lifecycle field BEFORE it touches the ledger, so a bad field is a bad request: it must
 * answer 4xx. Answering 500 made a client-side type bug (a non-string `object`) indistinguishable
 * from a real outage and pointed every page at the wrong owner. Engine faults must stay 5xx —
 * that is what keeps the 4xx mapping honest.
 */
describe('POST /memory/fact — caller errors are 4xx, engine faults stay 5xx', () => {
  const writeVerts: string[] = [];
  afterEach(() => {
    for (const d of writeVerts.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function createWriteApp(ledgerPath?: string) {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-api-write-'));
    writeVerts.push(vault);
    const db = openDb(path.join(vault, 'index.db'));
    runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
    return { app: createServer(db, idx, provider as any, vault, [], 'Memory/Daily', ledgerPath, { apiToken: API_TOKEN }), db, vault };
  }

  it('stores a plain-string fact and returns its receipt', async () => {
    const { app, db, vault } = createWriteApp();
    const res = await authed(app).post('/memory/fact')
      .send({ subject: 'Alice', predicate: 'works_at', object: 'Globex', source: 'api-test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created.object).toBe('Globex');
    expect(fs.readFileSync(path.join(vault, 'System/Memory Events Ledger.md'), 'utf8')).toContain('- object: Globex');
    db.close();
  });

  it('answers a non-string object with 400, not 500', async () => {
    const { app, db } = createWriteApp();
    const res = await authed(app).post('/memory/fact')
      .send({ subject: 'Alice', predicate: 'languages', object: ['js', 'ts'] });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(res.body.error).toMatch(/lifecycle object must be a string \(received array\)/);
    db.close();
  });

  it.each([
    ['non-string subject', { subject: 7, predicate: 'works_at', object: 'Globex' }, /lifecycle subject must be a string \(received number\)/],
    ['non-string predicate', { subject: 'Alice', predicate: { name: 'works_at' }, object: 'Globex' }, /lifecycle predicate must be a string \(received object\)/],
    ['empty subject', { subject: '  ', predicate: 'works_at', object: 'Globex' }, /lifecycle subject must be a non-empty string/],
    ['oversized object', { subject: 'Alice', predicate: 'works_at', object: 'x'.repeat(8193) }, /lifecycle object exceeds the maximum length of 8192/],
    ['control characters', { subject: 'Alice', predicate: 'works_at', object: 'line one\nline two' }, /lifecycle object contains control characters/],
  ])('answers %s with 400', async (_label, body, pattern) => {
    const { app, db } = createWriteApp();
    const res = await authed(app).post('/memory/fact').send(body as any);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(pattern as RegExp);
    db.close();
  });

  it('still answers 500 when the engine itself faults (misconfigured ledger path)', async () => {
    // Not a caller error: a ledger path escaping the vault is server misconfiguration, and the
    // 4xx mapping must not swallow it.
    const { app, db } = createWriteApp('../escapes-the-vault.md');
    const res = await authed(app).post('/memory/fact')
      .send({ subject: 'Alice', predicate: 'works_at', object: 'Globex' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ledger path escapes the vault root/);
    db.close();
  });
});
