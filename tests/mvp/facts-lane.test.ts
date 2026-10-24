import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from '../../src/db/sqlite';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, resolveLedgerPath, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { WRITE_CLOCK_TOLERANCE_MS } from '../../src/retrieval/orchestrator';
import { fullScans, traceStatements } from '../helpers/traceStatements';
import {
  factHits,
  indexBehindLedger,
  indexNotice,
  withFactHits,
  type FactHit,
} from '../../src/mvp/factsLane';

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-lane-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'index.db'));
  runMigrations(db);
  dbs.push(db);
  const ledger = { memoryDir: dir, ledgerRelPath: DEFAULT_LEDGER_REL };
  const put = (subject: string, predicate: string, object: string, scope?: string) =>
    remember(db, dir, DEFAULT_LEDGER_REL, { subject, predicate, object, ...(scope === undefined ? {} : { scope }) });
  return { dir, db, ledger, put };
}

/** The objects of fact hits, read from the one form a fact is shown in: `subject — predicate: object`. */
const objects = (hits: FactHit[]) => hits.map(h => /^.*? — [^:\n]*: (.*)$/s.exec(h.text)?.[1]);

describe('factHits', () => {
  it('all: every query word must be among the fact\'s words; any: one is enough, more shared words rank first', async () => {
    const { db, ledger, put } = store();
    await put('billing', 'webhook_endpoint', '/hooks/stripe');
    await put('billing', 'invoice_day', 'first of the month');
    await put('shipping', 'carrier', 'DHL');

    expect(objects(factHits(db, ledger, { query: 'billing webhook', match: 'all', limit: 20 }))).toEqual(['/hooks/stripe']);
    // Both billing facts, the newer one first.
    expect(objects(factHits(db, ledger, { query: 'billing', match: 'all', limit: 20 }))).toEqual(['first of the month', '/hooks/stripe']);
    expect(objects(factHits(db, ledger, { query: 'billing webhook endpoint', match: 'any', limit: 20 }))).toEqual(['/hooks/stripe', 'first of the month']);
    expect(factHits(db, ledger, { query: 'billing webhook kubernetes', match: 'all', limit: 20 })).toEqual([]);
  });

  it('ignores stop words unless nothing else is left, and reads slugs, snake_case and verb forms', async () => {
    const { db, ledger, put } = store();
    await put('renor-memory-1002', 'design_decision', 'keep ids in the ledger');
    await put('user', 'prefers_package_manager', 'Bun');
    await put('user', 'does_work', 'research');

    const any = (query: string) => objects(factHits(db, ledger, { query, match: 'any', limit: 20 }));
    expect(any('what is the memory decision?')).toEqual(['keep ids in the ledger']);
    expect(any('1002')).toEqual(['keep ids in the ledger']);
    expect(any('which package manager do I prefer')).toEqual(['Bun']);
    expect(any('what do I do')).toEqual(['research']); // only stop words: they are the query
    expect(factHits(db, ledger, { query: '   ', match: 'any', limit: 20 })).toEqual([]);
  });

  it('returns at most the limit it is given, newest first', async () => {
    const { db, ledger, put } = store();
    for (let i = 0; i < 15; i++) await put(`widget ${i}`, 'color', `shade ${i}`);

    expect(objects(factHits(db, ledger, { query: 'color', match: 'all', limit: 3 }))).toEqual(['shade 14', 'shade 13', 'shade 12']);
    expect(factHits(db, ledger, { query: 'color', match: 'all', limit: 100 })).toHaveLength(15);
  });

  it('reads current facts only: a corrected value is gone, and A then B then A leaves the last A', async () => {
    const { db, ledger, put } = store();
    await put('database', 'engine', 'MySQL 8');
    expect(objects(factHits(db, ledger, { query: 'MySQL', match: 'all', limit: 5 }))).toEqual(['MySQL 8']);
    await put('database', 'engine', 'Postgres 16');
    expect(factHits(db, ledger, { query: 'MySQL', match: 'all', limit: 5 })).toEqual([]);
    expect(objects(factHits(db, ledger, { query: 'Postgres', match: 'all', limit: 5 }))).toEqual(['Postgres 16']);
    const back = await put('database', 'engine', 'MySQL 8');
    const hits = factHits(db, ledger, { query: 'database', match: 'all', limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].headingPath.startsWith(back.eventId)).toBe(true);
  });

  it('scope: omitted means every scope, a given scope means exactly that one, empty means global', async () => {
    const { db, ledger, put } = store();
    await put('vault', 'door_code', 'GLOBALCODE');
    await put('vault', 'door_code', 'ALPHACODE', 'scope:alpha');
    await put('vault', 'door_code', 'BETACODE', 'project:beta');
    const codes = (scope?: string) => objects(factHits(db, ledger, { query: 'vault door code', scope, match: 'all', limit: 20 })).sort();

    expect(codes()).toEqual(['ALPHACODE', 'BETACODE', 'GLOBALCODE']);
    expect(codes('global')).toEqual(['GLOBALCODE']);
    expect(codes('')).toEqual(['GLOBALCODE']);
    expect(codes('scope:alpha')).toEqual(['ALPHACODE']);
    expect(codes('alpha')).toEqual(['ALPHACODE']);
    expect(codes('project:beta')).toEqual(['BETACODE']);
    expect(codes('project:nobody')).toEqual([]);
    expect(() => codes('!!!')).toThrow(/invalid scope/);
  });

  it('renders the fact as the index shows it, from the ledger note, and never as the ledger\'s record markup', async () => {
    const { db, dir } = store();
    const ledger = { memoryDir: dir, ledgerRelPath: 'Custom/Events.md' };
    const saved = await remember(db, dir, ledger.ledgerRelPath, { subject: 'vault', predicate: 'door_code', object: '4242', scope: 'scope:alpha' });

    // The reader is the agent that saved it: its own fact carries no source.
    const [hit] = factHits(db, ledger, { query: 'vault door code 4242', scope: 'scope:alpha', match: 'all', limit: 5, dated: true, reader: 'agent' });
    expect(hit).toEqual({
      notePath: path.join('Custom', 'Events.md'),
      headingPath: `${saved.eventId} · ${saved.created!.validFrom}`,
      text: 'vault — door_code: 4242',
      score: 1,
      reason: 'fact',
      session_date: saved.created!.validFrom,
    });
    expect(factHits(db, ledger, { query: 'vault door code', scope: 'scope:alpha', match: 'all', limit: 5 })[0]).not.toHaveProperty('session_date');
  });

  it('caps future projected and named fact clocks before indexing, and leaves them undated without a ledger', async () => {
    const { db, ledger, put } = store();
    const saved = await put('billing', 'host', 'automation');
    const file = resolveLedgerPath(ledger.memoryDir, ledger.ledgerRelPath);
    const bound = fs.statSync(file).mtime.toISOString();
    const justAfter = new Date(Date.parse(bound) + 1).toISOString();
    db.prepare('UPDATE facts SET valid_from = ? WHERE event_id = ?')
      .run(justAfter, saved.eventId);
    expect(factHits(db, ledger, { query: 'billing', match: 'any', limit: 5, dated: true })[0].session_date).toBe(justAfter);
    db.prepare('UPDATE facts SET valid_from = ? WHERE event_id = ?')
      .run(new Date(Date.parse(bound) + WRITE_CLOCK_TOLERANCE_MS + 1).toISOString(), saved.eventId);
    expect(factHits(db, ledger, { query: 'billing', match: 'any', limit: 5, dated: true })[0].session_date).toBe(bound);
    db.prepare('UPDATE facts SET valid_from = ? WHERE event_id = ?').run('2099-01-01T00:00:00.000Z', saved.eventId);
    const args = { query: 'billing automation', match: 'any' as const, limit: 5, dated: true };
    const [hit] = factHits(db, ledger, args);
    expect(hit.session_date).toBe(bound);
    const [added] = withFactHits(db, ledger, [], args);
    expect(added.session_date).toBe(bound);
    const [named] = withFactHits(db, ledger, [], { ...args, query: 'absent' }, [{
      subject: 'billing', predicate: 'host', object: 'automation', validFrom: '2099-01-01T00:00:00.000Z', scope: 'global', eventId: saved.eventId,
    }]);
    expect(named.session_date).toBe(bound);
    fs.unlinkSync(file);
    expect(factHits(db, ledger, args)[0].session_date).toBeUndefined();
  });

  it('scores a hit by the share of the query\'s words the fact matched', async () => {
    const { db, ledger, put } = store();
    await put('billing', 'webhook_endpoint', '/hooks/stripe');
    const [hit] = factHits(db, ledger, { query: 'billing webhook kubernetes cluster', match: 'any', limit: 5 });
    expect(hit.score).toBe(0.5);
  });
});

describe('withFactHits', () => {
  const indexed = (text: string, headingPath = '', reason = 'fts') => ({ notePath: 'n.md', headingPath, text, reason });
  const args = { query: 'color', match: 'all' as const, limit: 20 };
  const reasons = (hits: ReadonlyArray<{ reason?: string }>) => hits.filter(h => h.reason === 'fact').length;

  it('puts fact hits first, behind a leading evidence summary, leaving index hits in their order', async () => {
    const { db, ledger, put } = store();
    await put('widget', 'color', 'blue');
    const evidence = indexed('| item |', '', 'evidence');
    const a = indexed('prose a');
    const b = indexed('prose b');

    expect(withFactHits(db, ledger, [a, b], args).map(h => h.reason)).toEqual(['fact', 'fts', 'fts']);
    expect(withFactHits(db, ledger, [evidence, a, b], args).map(h => h.reason)).toEqual(['evidence', 'fact', 'fts', 'fts']);
    expect(withFactHits(db, ledger, [a, b], { ...args, query: 'nothing matches this' })).toEqual([a, b]);
  });

  it('does not repeat a fact whose ledger event the index already returned, and a repeat never uses up a slot', async () => {
    const { db, ledger, put } = store();
    const a = await put('widget a', 'color', 'red');
    const b = await put('widget b', 'color', 'green');
    const c = await put('widget c', 'color', 'blue');
    // The index returned the blocks of c (lowercase id, as hand-written ledgers have) and b (found by heading alone).
    const block = indexed(`## ${c.eventId.toLowerCase()} · 2026-10-02T00:00:00.000Z\n- kind: store\n- object: blue`);
    const headerless = indexed('- object: green', `Memory Events Ledger > ${b.eventId} · 2026-10-02T00:00:00.000Z`);

    const merged = withFactHits(db, ledger, [block, headerless], args);
    expect(merged.map(h => h.reason)).toEqual(['fact', 'fts', 'fts']);
    expect(merged[0].headingPath.startsWith(a.eventId)).toBe(true);
    expect(merged.slice(1)).toEqual([block, headerless]);
    // Newest first would pick c, then b: both are already returned, so the one place the two index hits leave under a
    // limit of three still reaches a.
    const [only] = withFactHits(db, ledger, [block, headerless], { ...args, limit: 3 });
    expect(only.headingPath.startsWith(a.eventId)).toBe(true);
  });

  it('returns at most `limit` hits: the facts take only the places the index hits leave, an evidence summary aside', async () => {
    const { db, ledger, put } = store();
    for (const color of ['red', 'green', 'blue']) await put(`widget ${color}`, 'color', color);
    const evidence = indexed('| item |', '', 'evidence');
    const a = indexed('prose a');
    const b = indexed('prose b');

    expect(withFactHits(db, ledger, [a, b], { ...args, limit: 2 })).toEqual([a, b]);
    expect(withFactHits(db, ledger, [a, b], { ...args, limit: 3 }).map(h => h.reason)).toEqual(['fact', 'fts', 'fts']);
    expect(withFactHits(db, ledger, [evidence, a, b], { ...args, limit: 3 }).map(h => h.reason)).toEqual(['evidence', 'fact', 'fts', 'fts']);
    expect(withFactHits(db, ledger, [a, b], { ...args, limit: 1 })).toEqual([a, b]); // the index's own hits are never cut
  });

  /**
   * `also` are facts a caller names because it is about to report one as its closest match (search_memory's verdict).
   * They used to be pushed whatever the page held, so a page top_k had filled answered with top_k + 1 hits. Now they
   * take their places in the room the index leaves - ahead of the index hits behind them and after the facts the words
   * found - and never past `limit`.
   */
  it('lists a named fact only in the room the index hits leave, and never past `limit`', async () => {
    const { db, ledger, put } = store();
    const named = await put('widget', 'color', 'violet');
    const found = await put('widget two', 'color', 'blue');
    const page = ['prose a', 'prose b', 'prose c', 'prose d'].map(text => indexed(text));
    const row = (eventId: string) => ({ eventId, subject: 'widget', predicate: 'color', object: 'violet', validFrom: '2026-10-02T00:00:00.000Z', scope: 'global' });

    // A full page: the named fact is not listed, and no index hit is touched.
    expect(withFactHits(db, ledger, page, { ...args, limit: 4 }, [row(named.eventId)])).toEqual(page);
    // One place left: the named fact takes it, and the fact the words found does not displace it.
    expect(reasons(withFactHits(db, ledger, page.slice(0, 3), { ...args, limit: 4 }, [row(named.eventId)]))).toBe(1);
    const merged = withFactHits(db, ledger, page.slice(0, 3), { ...args, limit: 4 }, [row(named.eventId)]);
    expect(merged[0]).toMatchObject({ reason: 'fact', text: 'widget — color: violet' });
    expect(merged[0].headingPath.startsWith(named.eventId)).toBe(true);
    expect(merged.slice(1)).toEqual(page.slice(0, 3));
    // Room for two facts and one place taken by the named one: the facts the words found come first, the named fact
    // after them, and the page is still inside `limit`.
    const both = withFactHits(db, ledger, page.slice(0, 2), { ...args, limit: 4 }, [row(named.eventId)]);
    expect(both).toHaveLength(4);
    expect(both.slice(0, 2).map(h => h.reason)).toEqual(['fact', 'fact']);
    expect(both[1]).toMatchObject({ reason: 'fact', text: 'widget — color: violet' });
    expect(objects(both.slice(0, 1) as FactHit[])).toContain(found.created?.object);
    expect(both.slice(2)).toEqual(page.slice(0, 2));
    // An evidence summary is outside top_k, so the room it leaves is the room under it.
    const lead = indexed('| item |', '', 'evidence');
    expect(withFactHits(db, ledger, [lead, ...page], { ...args, limit: 5 }, [row(named.eventId)]))
      .toHaveLength(6); // 5 in top_k plus the evidence summary, with the fact counted inside the five
  });

  /**
   * A fact saved through `remember` from a note can have no ledger event, so matching the page by event id alone listed
   * the same fact twice when the query's words had already found it.
   */
  it('lists a named fact with no ledger event once, and never a second copy of one in another scope', async () => {
    const { db, ledger, put } = store();
    const receipt = await put('widget', 'color', 'violet');
    db.prepare('UPDATE facts SET event_id = NULL WHERE id = ?').run(receipt.created?.factId);
    const row = { eventId: null, subject: 'widget', predicate: 'color', object: 'violet', validFrom: '2026-10-02T00:00:00.000Z', scope: 'global' };
    const page = [indexed('prose a'), indexed('prose b')];

    // The words found it and the caller names it: one copy, not two.
    expect(reasons(withFactHits(db, ledger, page, args, [row]))).toBe(1);
    expect(withFactHits(db, ledger, [], args, [row])).toHaveLength(1);
    // The same claim in another scope is a different fact, so it is listed as its own.
    expect(reasons(withFactHits(db, ledger, [], args, [row, { ...row, scope: 'scope:other' }]))).toBe(2);
  });
});

describe('indexBehindLedger', () => {
  // The chunk the indexer makes for one ledger event: a section headed `# Title > MEM_x · ts`.
  const indexEvent = (db: Database.Database, dir: string, eventId: string, lowercase = false, notePath = resolveLedgerPath(dir, DEFAULT_LEDGER_REL)) => {
    db.prepare(`INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at) VALUES (?, 'Ledger', 'system', 'h', '2026-10-02T00:00:00.000Z')`).run(notePath);
    db.prepare(`INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash) VALUES (?, ?, 'x', 0, 1, 1, 'c')`)
      .run(notePath, `Memory Events Ledger > ${lowercase ? eventId.toLowerCase() : eventId} · 2026-10-02T00:00:00.000Z`);
  };

  it('is behind only while the newest saved event is missing from the indexed ledger', async () => {
    const { db, dir, put } = store();
    const ledgerPath = resolveLedgerPath(dir, DEFAULT_LEDGER_REL);
    expect(indexBehindLedger(db, ledgerPath)).toBe(false); // nothing saved

    const first = await put('a', 'p', '1');
    expect(indexBehindLedger(db, ledgerPath)).toBe(true); // saved, never indexed
    indexEvent(db, dir, first.eventId);
    expect(indexBehindLedger(db, ledgerPath)).toBe(false);

    const second = await put('a', 'p', '2');
    expect(indexBehindLedger(db, ledgerPath)).toBe(true); // the index holds only the first
    indexEvent(db, dir, second.eventId, true); // ids are compared without case
    expect(indexBehindLedger(db, ledgerPath)).toBe(false);
  });

  it('finds the newest event through the full-text index, never by reading the ledger\'s chunks', async () => {
    const { db, dir, put } = store();
    const ledgerPath = resolveLedgerPath(dir, DEFAULT_LEDGER_REL);
    for (let i = 0; i < 1_500; i++) indexEvent(db, dir, `MEM_OLD${i}`);
    const newest = await put('a', 'p', '1');

    const behind = traceStatements(db, () => indexBehindLedger(db, ledgerPath));
    expect(behind.result).toBe(true);
    indexEvent(db, dir, newest.eventId);
    const current = traceStatements(db, () => indexBehindLedger(db, ledgerPath));
    expect(current.result).toBe(false);

    for (const { sql, plan } of [...behind.plans, ...current.plans]) {
      expect(plan.join('\n'), sql).not.toContain('TEMP B-TREE');
      expect(fullScans(plan).filter(line => !line.startsWith('SCAN chunks_fts VIRTUAL TABLE INDEX')), sql).toEqual([]);
    }
    expect(behind.plans.some(({ plan }) => plan.some(line => line.startsWith('SCAN chunks_fts VIRTUAL TABLE INDEX')))).toBe(true);
  });

  it('finds the newest event of a scope in one seek of the term index, however many newer facts other scopes hold', async () => {
    const { db, dir, put } = store();
    const ledgerPath = resolveLedgerPath(dir, DEFAULT_LEDGER_REL);
    const alpha = await put('a', 'p', 'alpha value', 'scope:alpha');
    for (let i = 0; i < 300; i++) await put(`s${i}`, 'p', `global value ${i}`);

    const behind = traceStatements(db, () => indexBehindLedger(db, ledgerPath, 'scope:alpha'));
    expect(behind.result).toBe(true);
    indexEvent(db, dir, alpha.eventId);
    expect(indexBehindLedger(db, ledgerPath, 'scope:alpha')).toBe(false);

    const lookup = behind.plans.find(({ sql }) => sql.includes('fact_terms'));
    expect(lookup?.plan.join('\n')).toContain('USING PRIMARY KEY (term=? AND scope=?)');
    for (const { sql, plan } of behind.plans) {
      expect(plan.join('\n'), sql).not.toContain('TEMP B-TREE');
      expect(fullScans(plan).filter(line => !line.startsWith('SCAN chunks_fts VIRTUAL TABLE INDEX')), sql).toEqual([]);
    }
  });

  it('counts only chunks of the ledger note', async () => {
    const { db, dir, put } = store();
    const saved = await put('a', 'p', '1');
    indexEvent(db, dir, saved.eventId, false, path.join(dir, 'Notes', 'quoting-the-ledger.md'));
    expect(indexBehindLedger(db, resolveLedgerPath(dir, DEFAULT_LEDGER_REL))).toBe(true);
  });

  it('is behind only by the events a scope can see: a named scope by its own, global by global, no scope by all', async () => {
    const { db, dir, put } = store();
    const ledgerPath = resolveLedgerPath(dir, DEFAULT_LEDGER_REL);
    const global = await put('a', 'p', 'global value');
    indexEvent(db, dir, global.eventId);
    const alpha = await put('a', 'p', 'alpha value', 'scope:alpha'); // newest event overall, never indexed

    expect(indexBehindLedger(db, ledgerPath)).toBe(true);
    expect(indexBehindLedger(db, ledgerPath, 'global')).toBe(false);
    expect(indexBehindLedger(db, ledgerPath, 'scope:alpha')).toBe(true);
    expect(indexBehindLedger(db, ledgerPath, 'project:other')).toBe(false); // it has no event of its own

    indexEvent(db, dir, alpha.eventId);
    await put('b', 'p', 'newer global value');
    expect(indexBehindLedger(db, ledgerPath, 'global')).toBe(true);
    expect(indexBehindLedger(db, ledgerPath, 'scope:alpha')).toBe(false); // its newest event is indexed
  });
});

describe('indexNotice', () => {
  it('is empty without semantic search, and says what to run when the index is behind', async () => {
    const { db, ledger, put } = store();
    await put('a', 'p', '1');

    expect(indexNotice(db, false, ledger)).toEqual({});
    const notice = indexNotice(db, true, ledger);
    expect(notice.index?.stale).toBe(true);
    expect(notice.index?.detail).toContain('index_memory');
    expect(indexNotice(db, true, ledger, 'scope:alpha')).toEqual({});
    expect(() => indexNotice(db, true, ledger, '!!!')).toThrow(/invalid scope/);
  });
});
