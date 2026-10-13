import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import {
  factsFor, listLifecycleSubjects, listRetiredFacts, parseLedgerEvents, remember, replayLedger, restoreFact, retireFact,
} from '../../src/memory/lifecycle';
import { refusalReason } from '../../src/toolRefusal';

/**
 * A saved fact can be retired (taken out of recall) and restored, like a note: the captain, 2026-10-07, on test facts that
 * stayed in a workspace forever. The ledger keeps everything (the fact's event, and a retire event saying who and when);
 * the fact's row leaves `facts`, so no read of current values or history returns it, and restore puts the same row back.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const dirs: string[] = [];
const open: Database.Database[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (open.length) open.pop()!.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function vault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-fact-'));
  dirs.push(d);
  return d;
}

function db(file: string): Database.Database {
  const d = openDb(file);
  runMigrations(d);
  open.push(d);
  return d;
}

/** Each step one second after the last, so every event has its own time. */
function clock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  let t = Date.parse('2026-10-07T12:00:00.000Z');
  return () => {
    t += 1000;
    vi.setSystemTime(t);
    return new Date(t).toISOString();
  };
}

const save = (d: Database.Database, v: string, object: string, subject = 'Fjord', predicate = 'database') =>
  remember(d, v, LEDGER, { subject, predicate, object, source: 'test' });

const values = (rows: unknown[]) => (rows as Array<{ object_text: string; valid_to: string | null }>).map(r => [r.object_text, r.valid_to]);

/** Everything the projection holds about lifecycle facts, live and retired. */
function projection(d: Database.Database) {
  return {
    facts: d.prepare(`SELECT f.id, e.canonical_name AS subject, f.predicate, f.object_text, f.valid_from, f.valid_to, f.event_id, f.scope
      FROM facts f JOIN entities e ON e.id = f.subject_entity_id WHERE f.source_path = '_mcp_' ORDER BY f.id`).all(),
    retired: d.prepare(`SELECT r.id, e.canonical_name AS subject, r.predicate, r.object_text, r.valid_from, r.valid_to, r.event_id, r.scope,
      r.retire_event_id, r.retired_at, r.retired_by FROM retired_facts r JOIN entities e ON e.id = r.subject_entity_id ORDER BY r.id`).all(),
    terms: d.prepare('SELECT term, scope, fact_id FROM fact_terms ORDER BY fact_id, term').all(),
  };
}

describe('retiring a fact', () => {
  it('takes the current value out of current reads and history, and promotes nothing', async () => {
    const tick = clock();
    const v = vault();
    const d = db(path.join(v, 'index.db'));
    tick();
    const a = await save(d, v, 'Postgres');
    const tB = tick();
    const b = await save(d, v, 'SQLite');
    expect(values(factsFor(d, 'Fjord'))).toEqual([['SQLite', null]]);

    const tRetire = tick();
    const receipt = await retireFact(d, v, LEDGER, `fact:${b.eventId}`, 'dashboard');
    expect(receipt).toEqual({
      ok: true, id: `fact:${b.eventId}`, action: 'retired', title: 'Fjord database: SQLite', at: tRetire,
      eventId: expect.stringMatching(/^MEM_/), current: true,
    });

    // No current value: Postgres was replaced by SQLite, and retiring SQLite does not undo that.
    expect(factsFor(d, 'Fjord')).toEqual([]);
    expect(values(factsFor(d, 'Fjord', { includeHistory: true }))).toEqual([['Postgres', tB]]);
    expect(factsFor(d, 'Fjord', { asOf: tRetire })).toEqual([]);
    expect(listLifecycleSubjects(d)).toEqual(['Fjord']);
    expect(listRetiredFacts(d)).toEqual([expect.objectContaining({
      id: `fact:${b.eventId}`, subject: 'Fjord', predicate: 'database', object: 'SQLite', retiredAt: tRetire, retiredBy: 'dashboard',
    })]);

    // The ledger keeps both saves and says who retired which fact and when, without writing the value again.
    const text = fs.readFileSync(path.join(v, LEDGER), 'utf8');
    const events = parseLedgerEvents(text);
    expect(events.map(e => e.id)).toEqual([a.eventId, b.eventId, receipt.eventId]);
    expect(events[2]).toMatchObject({ kind: 'retire', target: b.eventId, subject: 'Fjord', predicate: 'database', object: '', source: 'dashboard', at: tRetire });
    const block = text.slice(text.indexOf(`## ${receipt.eventId}`));
    expect(block).not.toContain('- object:');
    expect(block).not.toContain('SQLite');
  });

  it('a retired subject with no other fact is known to no subject list', async () => {
    const v = vault();
    const d = db(path.join(v, 'index.db'));
    const t = await save(d, v, 'junk value', 'synthetic test subject', 'probe');
    await retireFact(d, v, LEDGER, `fact:${t.eventId}`);
    expect(listLifecycleSubjects(d)).toEqual([]);
    expect(factsFor(d, 'synthetic test subject', { includeHistory: true })).toEqual([]);
  });

  it('restore puts the same row back, current again, with the same search terms', async () => {
    const tick = clock();
    const v = vault();
    const d = db(path.join(v, 'index.db'));
    tick();
    await save(d, v, 'Postgres');
    tick();
    const b = await save(d, v, 'SQLite');
    const before = projection(d);

    tick();
    await retireFact(d, v, LEDGER, `fact:${b.eventId}`);
    expect(projection(d).terms).not.toEqual(before.terms);
    const tRestore = tick();
    const restored = await restoreFact(d, v, LEDGER, `fact:${b.eventId}`, 'dashboard');
    expect(restored).toMatchObject({ ok: true, id: `fact:${b.eventId}`, action: 'restored', title: 'Fjord database: SQLite', at: tRestore, current: true });

    expect(projection(d)).toEqual({ ...before, retired: [] });
    expect(values(factsFor(d, 'Fjord'))).toEqual([['SQLite', null]]);
    const events = parseLedgerEvents(fs.readFileSync(path.join(v, LEDGER), 'utf8'));
    expect(events.map(e => [e.kind, e.target ?? null])).toEqual([
      ['store', null], ['supersede', null], ['retire', b.eventId], ['restore', b.eventId],
    ]);
  });

  it('a value saved while the current one is retired replaces it, as if it had never been retired', async () => {
    const tick = clock();
    const v = vault();
    const d = db(path.join(v, 'index.db'));
    tick();
    await save(d, v, 'Postgres');
    const tB = tick();
    const b = await save(d, v, 'SQLite');
    tick();
    await retireFact(d, v, LEDGER, `fact:${b.eventId}`);

    const tC = tick();
    const c = await save(d, v, 'DuckDB');
    // Nothing current to replace, as far as any read can tell: the retired value is not named.
    expect(c).toMatchObject({ action: 'store', closed: null });
    expect(values(factsFor(d, 'Fjord'))).toEqual([['DuckDB', null]]);

    tick();
    const restored = await restoreFact(d, v, LEDGER, `fact:${b.eventId}`);
    expect(restored.current).toBe(false);
    expect(values(factsFor(d, 'Fjord'))).toEqual([['DuckDB', null]]);
    expect(values(factsFor(d, 'Fjord', { includeHistory: true }))).toEqual([['DuckDB', null], ['SQLite', tC], ['Postgres', tB]]);
  });

  it('a superseded value can be retired and restored, and the current one is untouched', async () => {
    const tick = clock();
    const v = vault();
    const d = db(path.join(v, 'index.db'));
    tick();
    const a = await save(d, v, 'Postgres');
    tick();
    await save(d, v, 'SQLite');
    const before = projection(d);

    tick();
    const receipt = await retireFact(d, v, LEDGER, `fact:${a.eventId}`);
    expect(receipt.current).toBe(false);
    expect(values(factsFor(d, 'Fjord', { includeHistory: true }))).toEqual([['SQLite', null]]);
    tick();
    expect((await restoreFact(d, v, LEDGER, `fact:${a.eventId}`)).current).toBe(false);
    expect(projection(d)).toEqual(before);
  });

  it('refuses what it cannot do, and writes nothing to the ledger', async () => {
    const v = vault();
    const d = db(path.join(v, 'index.db'));
    const a = await save(d, v, 'Postgres');
    const ledger = () => fs.readFileSync(path.join(v, LEDGER), 'utf8');
    const start = ledger();
    await expect(retireFact(d, v, LEDGER, 'fact:MEM_NOSUCH')).rejects.toThrow('no saved fact has that id');
    await expect(retireFact(d, v, LEDGER, 'note:Notes/a.md')).rejects.toThrow('not a fact id');
    await expect(restoreFact(d, v, LEDGER, `fact:${a.eventId}`)).rejects.toThrow('that fact is not retired');
    expect(ledger()).toBe(start);
    await retireFact(d, v, LEDGER, `fact:${a.eventId.toLowerCase()}`);
    const once = ledger();
    await expect(retireFact(d, v, LEDGER, `fact:${a.eventId}`)).rejects.toThrow('already retired');
    // The codes telemetry reads (toolRefusal.ts): what was asked, never a defect.
    const reasons = await Promise.all([
      retireFact(d, v, LEDGER, `fact:${a.eventId}`), retireFact(d, v, LEDGER, 'fact:MEM_NOSUCH'), retireFact(d, v, LEDGER, 'MEM_X'),
    ].map(p => p.then(() => null, err => refusalReason(err))));
    expect(reasons).toEqual(['memory_already_retired', 'memory_not_found', 'invalid_argument']);
    await expect(restoreFact(d, v, LEDGER, 'fact:MEM_NOSUCH')).rejects.toThrow('no retired fact has that id');
    expect(ledger()).toBe(once);
  });
});

describe('replaying a ledger with retirements', () => {
  /** Retire and restore in every order a person could: current, superseded, replaced while retired, another subject. */
  async function history(d: Database.Database, v: string) {
    const tick = clock();
    tick();
    const a = await save(d, v, 'Postgres');
    tick();
    const b = await save(d, v, 'SQLite');
    tick();
    await retireFact(d, v, LEDGER, `fact:${b.eventId}`);
    tick();
    await save(d, v, 'DuckDB');
    tick();
    await restoreFact(d, v, LEDGER, `fact:${b.eventId}`);
    tick();
    await retireFact(d, v, LEDGER, `fact:${a.eventId}`);
    tick();
    const x = await save(d, v, 'test value', 'synthetic probe', 'marker');
    tick();
    await retireFact(d, v, LEDGER, `fact:${x.eventId}`);
    tick();
    await retireFact(d, v, LEDGER, `fact:${b.eventId}`);
    tick();
    await restoreFact(d, v, LEDGER, `fact:${b.eventId}`);
  }

  it('a fresh index replayed from the ledger holds exactly what the live writes left', async () => {
    const v = vault();
    const live = db(path.join(v, 'index.db'));
    await history(live, v);
    const rebuilt = db(path.join(vault(), 'rebuilt.db'));
    await replayLedger(rebuilt, v, LEDGER);
    expect(projection(rebuilt)).toEqual(projection(live));
    expect(projection(live).retired.map((r: any) => r.object_text)).toEqual(['Postgres', 'test value']);
  });

  it('a restart replays the ledger over the index and changes nothing, and a retired current value stays retired', async () => {
    const v = vault();
    const file = path.join(v, 'index.db');
    const first = db(file);
    await history(first, v);
    const tick = clock();
    tick();
    const y = await save(first, v, 'one', 'Kestrel', 'host');
    tick();
    const z = await save(first, v, 'two', 'Kestrel', 'host');
    tick();
    await retireFact(first, v, LEDGER, `fact:${z.eventId}`);
    // Retired, then replaced while retired: the replacement closes the retired value, as the replay will.
    tick();
    await save(first, v, 'north', 'Osprey', 'region');
    tick();
    const south = await save(first, v, 'south', 'Osprey', 'region');
    tick();
    await retireFact(first, v, LEDGER, `fact:${south.eventId}`);
    tick();
    const east = await save(first, v, 'east', 'Osprey', 'region');
    expect(first.prepare('SELECT valid_to FROM retired_facts WHERE event_id = ?').get(south.eventId)).toEqual({ valid_to: east.created!.validFrom });
    const before = projection(first);
    first.close();
    open.splice(open.indexOf(first), 1);

    const again = db(file);
    expect(await replayLedger(again, v, LEDGER)).toBe(0);
    expect(projection(again)).toEqual(before);
    // "one" was replaced by "two"; "two" is retired. A replay recomputes the chain and must not reopen "one".
    expect(factsFor(again, 'Kestrel')).toEqual([]);
    expect(values(factsFor(again, 'Kestrel', { includeHistory: true }))).toEqual([['one', z.created!.validFrom]]);
    expect(y.eventId).not.toBe(z.eventId);
  });

  it('the ledger decides: a retirement removed from it by hand is undone by the next replay', async () => {
    const v = vault();
    const file = path.join(v, 'index.db');
    const first = db(file);
    const a = await save(first, v, 'Postgres');
    const retire = await retireFact(first, v, LEDGER, `fact:${a.eventId}`);
    expect(factsFor(first, 'Fjord')).toEqual([]);
    first.close();
    open.splice(open.indexOf(first), 1);

    const ledger = path.join(v, LEDGER);
    const text = fs.readFileSync(ledger, 'utf8');
    fs.writeFileSync(ledger, text.slice(0, text.indexOf(`\n## ${retire.eventId}`)));
    const again = db(file);
    await replayLedger(again, v, LEDGER);
    expect(values(factsFor(again, 'Fjord'))).toEqual([['Postgres', null]]);
    expect(listRetiredFacts(again)).toEqual([]);
  });

  it('a retirement whose target is no earlier fact, or that carries a value, is corruption', async () => {
    const header = '---\ntype: memory-ledger\n---\n';
    const fact = '\n## MEM_A1 · 2026-10-07T12:00:01.000Z\n- kind: store\n- subject: Fjord\n- predicate: database\n- object: SQLite\n- source: test\n';
    const retire = (target: string, extra = '') => `\n## MEM_R1 · 2026-10-07T12:00:02.000Z\n- kind: retire\n- subject: Fjord\n- predicate: database\n- target: ${target}\n${extra}- source: test\n`;
    const replayOf = async (text: string) => {
      const v = vault();
      fs.mkdirSync(path.join(v, 'System'), { recursive: true });
      fs.writeFileSync(path.join(v, LEDGER), text);
      return replayLedger(db(path.join(v, 'index.db')), v, LEDGER);
    };
    await expect(replayOf(header + fact + retire('MEM_A1'))).resolves.toBe(2);
    await expect(replayOf(header + fact + retire('MEM_NOPE'))).rejects.toThrow('its target MEM_NOPE is no fact event before it');
    await expect(replayOf(header + retire('MEM_A1') + fact.replace('12:00:01', '12:00:03'))).rejects.toThrow('is no fact event before it');
    await expect(replayOf(header + fact + retire('MEM_A1', '- object: SQLite\n'))).rejects.toThrow('a retire event carries no object');
    await expect(replayOf(header + fact.replace('- source: test', '- target: MEM_A1\n- source: test'))).rejects.toThrow('only a retire or restore event names a target');
  });
});
