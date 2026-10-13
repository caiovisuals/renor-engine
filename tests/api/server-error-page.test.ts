import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createServer } from '../../src/api/server';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';

/**
 * `renor serve` answered an unhandled error with Express's own HTML page, which prints the error and the absolute
 * path of the source file that threw it (adversary run renor-adv-localhost-1012, F7). Any error that reaches the end
 * of the chain is now a short JSON body; the cause stays in the process's own log.
 */

const TOKEN = 'synthetic-api-token-for-error-test';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function app() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-api-error-'));
  dirs.push(vault);
  const db = openDb(path.join(vault, 'index.db'));
  runMigrations(db);
  const idx = new VectorIndex(db, 4); idx.initTable();
  const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
  return { app: createServer(db, idx, provider as any, vault, [], undefined, undefined, { apiToken: TOKEN }), db };
}

const LEAKS = /TypeError|SyntaxError|node_modules|\/engine\/|\/home\/|\bat \S+ \(|<pre>|<html/i;

describe('renor serve: error page', () => {
  it('answers a body that is not JSON with a generic JSON error, not a stack path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app: server, db } = app();
    // express.json() leaves req.body undefined for a text/plain body, and the route then throws on it.
    const res = await request(server).post('/memory/fact').set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'text/plain').send('not json');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'internal error' });
    expect(res.text).not.toMatch(LEAKS);
    // The cause is kept where the operator reads it.
    expect(log).toHaveBeenCalled();
    db.close();
  });

  it('answers malformed JSON with a generic 400', async () => {
    const { app: server, db } = app();
    const res = await request(server).post('/memory/fact').set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'application/json').send('{"subject": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad request' });
    expect(res.text).not.toMatch(LEAKS);
    db.close();
  });

  it('keeps the replies the routes themselves make', async () => {
    const { app: server, db } = app();
    const res = await request(server).post('/retrieve-context').set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'query required' });
    db.close();
  });
});
