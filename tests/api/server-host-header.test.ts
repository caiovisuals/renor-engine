import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createServer } from '../../src/api/server';
import { requireApiToken, API_TOKEN_ENV } from '../../src/api/apiAuth';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';

/**
 * `renor serve` (adversary run renor-adv-localhost-1012, F1). The API had no credential and answered any Host,
 * so a page that rebinds its domain to 127.0.0.1 read and wrote the whole memory, and any local user could with curl.
 *
 * Now: a foreign Host is refused (403) before anything runs, every route needs the bearer token (401), and a server
 * cannot be built or started without one. Each probe asserts the memory was neither read nor written.
 */

const TOKEN = 'synthetic-api-token-for-host-test';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function appWithMemory() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-api-host-'));
  dirs.push(vault);
  const db = openDb(path.join(vault, 'index.db'));
  runMigrations(db);
  const idx = new VectorIndex(db, 4); idx.initTable();
  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
  const app = createServer(db, idx, provider as any, vault, [], 'Memory/Daily', undefined, { apiToken: TOKEN });
  return { app, db, vault, provider };
}

const factCount = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;

describe('renor serve: Host header (DNS rebinding)', () => {
  const FOREIGN = ['evil.test', 'evil.test:3456', '127.0.0.1.evil.test', 'localhost.evil.test:3456'];

  it('refuses a foreign Host on a write, with the right token, and writes nothing', async () => {
    const { app, db, vault } = appWithMemory();
    for (const host of FOREIGN) {
      const res = await request(app).post('/memory/fact').set('Host', host)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ subject: 'RebindDemo', predicate: 'owner', object: 'planted-by-evil.test' });
      expect(res.status, host).toBe(403);
    }
    expect(factCount(db)).toBe(0);
    expect(fs.existsSync(path.join(vault, 'Memory'))).toBe(false);
    db.close();
  });

  it('refuses a foreign Host on every read route, with the right token', async () => {
    const { app, db, provider } = appWithMemory();
    const reads: Array<['get' | 'post', string]> = [
      ['get', '/facts-for/RebindDemo'], ['get', '/entity/RebindDemo'], ['get', '/facts/1'], ['get', '/search?q=x'],
      ['post', '/retrieve-context'], ['get', '/api/health'],
    ];
    for (const [method, route] of reads) {
      const res = await request(app)[method](route).set('Host', 'evil.test:3456').set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status, route).toBe(403);
    }
    expect(provider.embed).not.toHaveBeenCalled();
    db.close();
  });

  it.each(['localhost:3456', '127.0.0.1:3456', '[::1]:3456', 'localhost'])('answers the loopback Host %s', async (host) => {
    const { app, db } = appWithMemory();
    const res = await request(app).post('/memory/fact').set('Host', host).set('Authorization', `Bearer ${TOKEN}`)
      .send({ subject: 'Alice', predicate: 'works_at', object: 'Globex' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    db.close();
  });
});

describe('renor serve: bearer token', () => {
  const ROUTES: Array<['get' | 'post', string]> = [
    ['post', '/memory/fact'], ['post', '/memory/daily'], ['post', '/retrieve-context'],
    ['get', '/entity/X'], ['get', '/facts/1'], ['get', '/facts-for/X'], ['get', '/search?q=x'], ['get', '/api/health'],
  ];

  it.each(ROUTES)('%s %s needs the token: none, wrong and malformed are 401, nothing is written', async (method, route) => {
    const { app, db, provider } = appWithMemory();
    const attempts: Array<string | undefined> = [undefined, 'Bearer wrong-token', `Bearer${TOKEN}`, TOKEN, 'Basic Zm9vOmJhcg==', 'Bearer '];
    for (const authorization of attempts) {
      const req = request(app)[method](route).send({ subject: 'S', predicate: 'p', object: 'o', date: '2026-10-12', text: 't', query: 'q' });
      const res = authorization === undefined ? await req : await req.set('Authorization', authorization);
      expect(res.status, `${route} with ${authorization}`).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).toEqual({ error: 'unauthorized' });
    }
    expect(factCount(db)).toBe(0);
    expect(provider.embed).not.toHaveBeenCalled();
    db.close();
  });

  it('answers the same bytes to a client that has the token', async () => {
    const { app, db } = appWithMemory();
    const res = await request(app).post('/memory/fact').set('Authorization', `Bearer ${TOKEN}`)
      .send({ subject: 'Alice', predicate: 'works_at', object: 'Globex' });
    expect(res.status).toBe(200);
    const read = await request(app).get('/facts-for/Alice').set('Authorization', `bearer ${TOKEN}`);
    expect(read.status).toBe(200);
    expect(read.body[0].object_text).toBe('Globex');
    db.close();
  });

  it('cannot be built without a token', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const idx = new VectorIndex(db, 4); idx.initTable();
    const provider = { dimensions: 4, embed: vi.fn() };
    for (const options of [undefined, {}, { apiToken: '' }, { apiToken: '   ' }]) {
      expect(() => createServer(db, idx, provider as any, '/v', [], undefined, undefined, options)).toThrow(/apiToken/);
    }
    db.close();
  });

  it('refuses to start on an unset or blank RENOR_API_TOKEN and says how to set it', () => {
    for (const env of [{}, { [API_TOKEN_ENV]: '' }, { [API_TOKEN_ENV]: '  ' }]) {
      expect(() => requireApiToken(env as NodeJS.ProcessEnv)).toThrow(/RENOR_API_TOKEN is not set.*openssl rand -hex 32.*Authorization: Bearer/s);
    }
    expect(requireApiToken({ [API_TOKEN_ENV]: ' abc123 ' } as NodeJS.ProcessEnv)).toBe('abc123');
  });
});
