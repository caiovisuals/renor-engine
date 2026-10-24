import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, replayLedger, factsFor, parseLedgerEvents, retireFact, restoreFact } from '../../src/memory/lifecycle';
import { appendDailyMemory } from '../../src/memory/writer';
import { normalizeScope, dailyDirForScope } from '../../src/mvp/scope';
import type Database from '../../src/db/sqlite';

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-mvp-'));
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

describe('normalizeScope', () => {
  it('defaults empty to global', () => {
    expect(normalizeScope()).toBe('global');
    expect(normalizeScope('')).toBe('global');
    expect(normalizeScope('  GLOBAL ')).toBe('global');
  });

  it('normalizes project/scope slugs', () => {
    expect(normalizeScope('project:Acme_App')).toBe('project:acme-app');
    expect(normalizeScope('scope:my-work')).toBe('scope:my-work');
    expect(normalizeScope('Tenant Alpha')).toBe('scope:tenant-alpha');
  });

  it('rejects empty slug after normalize', () => {
    expect(() => normalizeScope('scope:!!!')).toThrow(/invalid scope/);
  });
});

describe('remember + retrieve with scope', () => {
  it('isolates current facts across scopes for the same subject+predicate', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));

    await remember(db, v, LEDGER, {
      subject: 'SynthPat', predicate: 'works_on', object: 'GlobalThing', source: 'poc',
    });
    await remember(db, v, LEDGER, {
      subject: 'SynthPat', predicate: 'works_on', object: 'AcmeThing', source: 'poc',
      scope: 'project:acme',
    });

    const globalFacts = factsFor(db, 'SynthPat', { scope: 'global' }) as any[];
    expect(globalFacts).toHaveLength(1);
    expect(globalFacts[0].object_text).toBe('GlobalThing');
    expect(globalFacts[0].scope ?? 'global').toBe('global');

    const acme = factsFor(db, 'SynthPat', { scope: 'project:acme' }) as any[];
    expect(acme).toHaveLength(1);
    expect(acme[0].object_text).toBe('AcmeThing');
    expect(acme[0].scope).toBe('project:acme');

    // Without scope filter: all current facts across scopes (MVP read behavior)
    const all = factsFor(db, 'SynthPat') as any[];
    expect(all.length).toBeGreaterThanOrEqual(2);

    db.close();
  });

  it('replays legacy ledger events without scope as global', async () => {
    const v = mkvault();
    fs.mkdirSync(path.join(v, 'System'), { recursive: true });
    fs.writeFileSync(path.join(v, LEDGER), [
      `---`, `type: memory-ledger`, `---`, ``, `# Memory Events Ledger`, ``,
      `## MEM_SCOPELEGACY1 · 2026-09-09T00:00:00.000Z`,
      `- kind: store`,
      `- subject: SynthLegacyScope`,
      `- predicate: p`,
      `- object: old`,
      `- source: poc`,
      ``,
    ].join('\n'));

    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(1);
    const facts = factsFor(db, 'SynthLegacyScope', { scope: 'global' }) as any[];
    expect(facts).toHaveLength(1);
    expect(facts[0].object_text).toBe('old');
    expect(facts[0].scope ?? 'global').toBe('global');
    db.close();
  });

  it('supersedes within the same scope only', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, {
      subject: 'SynthScoped', predicate: 'status', object: 'A', scope: 'scope:alpha',
    });
    await remember(db, v, LEDGER, {
      subject: 'SynthScoped', predicate: 'status', object: 'B', scope: 'scope:alpha',
    });
    await remember(db, v, LEDGER, {
      subject: 'SynthScoped', predicate: 'status', object: 'G', // global
    });

    const alpha = factsFor(db, 'SynthScoped', { scope: 'scope:alpha' }) as any[];
    expect(alpha).toHaveLength(1);
    expect(alpha[0].object_text).toBe('B');

    const hist = factsFor(db, 'SynthScoped', { scope: 'scope:alpha', includeHistory: true }) as any[];
    expect(hist).toHaveLength(2);

    const glob = factsFor(db, 'SynthScoped', { scope: 'global' }) as any[];
    expect(glob).toHaveLength(1);
    expect(glob[0].object_text).toBe('G');
    db.close();
  });
});

/**
 * One lifecycle stream per slug (PR 332 review). `scope:<slug>`, `project:<slug>` and the bare `<slug>` are one scope
 * for reads, so a save corrects the current value of its subject and predicate whatever spelling that was saved with,
 * and each value keeps its own spelling. The ledger says so by naming the closed fact in closed_event; a ledger written
 * before never names one under another spelling, so it replays as it did (both values current, which reads name as
 * a conflict) until a save closes both. Synthetic data, no embeddings.
 */
describe('a save corrects its scope whatever spelling the current value was saved with', () => {
  const SUBJECT = 'zephyr launch';
  type Fact = { predicate: string; object_text: string; scope: string; valid_to: string | null };
  const dates = (facts: unknown[]) => (facts as Fact[]).filter(f => f.predicate === 'date');
  const current = (db: Database.Database, scope: string) =>
    dates(factsFor(db, SUBJECT, { scope })).map(f => [f.object_text, f.scope]);
  const history = (db: Database.Database, scope: string) =>
    dates(factsFor(db, SUBJECT, { scope, includeHistory: true })).map(f => [f.object_text, f.scope, f.valid_to]);
  /** Every lifecycle row, by event: what a rebuild and a replay must reproduce exactly. */
  const rows = (db: Database.Database) => db.prepare(
    `SELECT event_id, object_text, scope, valid_from, valid_to FROM facts WHERE source_path = '_mcp_' ORDER BY event_id`,
  ).all();
  /** The rows of a fresh index rebuilt from the vault's ledger. */
  let rebuilds = 0;
  async function rebuilt(v: string) {
    const db = freshDb(path.join(v, `rebuilt-${++rebuilds}.db`));
    try {
      await replayLedger(db, v, LEDGER);
      return rows(db);
    } finally {
      db.close();
    }
  }
  const ledgerEvents = (v: string) => parseLedgerEvents(fs.readFileSync(path.join(v, LEDGER), 'utf8'));
  /** What the engine logged for each applied event (memory_map lists it). */
  const logged = (db: Database.Database) =>
    db.prepare(`SELECT summary FROM write_events WHERE note_path = '_memory_ledger_' ORDER BY id`).pluck().all();
  function writeLedger(v: string, events: Array<{ id: string; at: string; kind: string; object: string; scope: string; closed?: string; statement?: string }>) {
    fs.mkdirSync(path.join(v, 'System'), { recursive: true });
    fs.writeFileSync(path.join(v, LEDGER), [
      `---`, `type: memory-ledger`, `---`, ``, `# Memory Events Ledger`, ``,
      ...events.flatMap(e => [
        `## ${e.id} · ${e.at}`, `- kind: ${e.kind}`, `- subject: ${SUBJECT}`, `- predicate: date`, `- object: ${e.object}`,
        ...(e.closed ? [`- closed_event: ${e.closed}`] : []), ...(e.scope === 'global' ? [] : [`- scope: ${e.scope}`]),
        ...(e.statement ? [`- statement: ${JSON.stringify(e.statement)}`] : []), `- source: legacy`, ``,
      ]),
    ].join('\n'));
  }
  /** Written before a save could close across spellings: a value under each spelling, one corrected in its own. */
  const LEGACY = [
    { id: 'MEM_LEGACYPROJ1', at: '2026-09-01T00:00:00.000Z', kind: 'store', object: 'March 3', scope: 'project:atlas' },
    { id: 'MEM_LEGACYSCOPE1', at: '2026-09-02T00:00:00.000Z', kind: 'store', object: 'April 9', scope: 'scope:atlas' },
    { id: 'MEM_LEGACYSCOPE2', at: '2026-09-03T00:00:00.000Z', kind: 'supersede', object: 'April 10', scope: 'scope:atlas', closed: 'MEM_LEGACYSCOPE1' },
  ];

  it('a save under another spelling closes the value saved under the first, and a rebuild or a replay of the ledger agrees', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const save = (object: string, scope?: string) =>
      remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object, ...(scope ? { scope } : {}) });
    const first = await save('March 3', 'project:atlas');
    await save('May 1', 'project:kestrel'); // another slug: another scope
    await save('June 2'); // global
    const second = await save('April 9', 'scope:atlas');
    expect(second.action).toBe('supersede');
    expect(second.closed).toEqual({ factId: first.created!.factId, object: 'March 3', validTo: second.created!.validFrom });
    expect(second.alsoClosed).toBeUndefined();
    // The ledger names the fact the save closed, which is how a replay knows to close it too.
    expect(ledgerEvents(v).find(e => e.id === second.eventId)?.closedEvent).toBe(first.eventId);
    // Back and forth between spellings, and the bare slug: each save closes the one before it.
    const third = await save('April 20', 'project:atlas');
    expect(third.closed?.object).toBe('April 9');
    const fourth = await save('April 27', ' Atlas ');
    expect(fourth.closed?.object).toBe('April 20');

    for (const scope of ['project:atlas', 'scope:atlas', 'atlas']) {
      expect(current(db, scope), scope).toEqual([['April 27', 'scope:atlas']]);
      expect(history(db, scope), scope).toEqual([
        ['April 27', 'scope:atlas', null],
        ['April 20', 'project:atlas', fourth.created!.validFrom],
        ['April 9', 'scope:atlas', third.created!.validFrom],
        ['March 3', 'project:atlas', second.created!.validFrom],
      ]);
    }
    expect(current(db, 'project:kestrel')).toEqual([['May 1', 'project:kestrel']]);
    expect(current(db, 'global')).toEqual([['June 2', 'global']]);

    const projected = rows(db);
    expect(await rebuilt(v)).toEqual(projected);
    await replayLedger(db, v, LEDGER); // every event already projected: the stream is reconciled, not reopened
    expect(rows(db)).toEqual(projected);
    db.close();
  });

  it('re-sending the same statement under another spelling of the slug changes nothing', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const args = { subject: SUBJECT, predicate: 'date', object: 'March 3', statement: 'The zephyr launch date is March 3.' };
    const first = await remember(db, v, LEDGER, { ...args, scope: 'project:atlas' });
    const again = await remember(db, v, LEDGER, { ...args, scope: 'scope:atlas' });
    expect(again.action).toBe('nochange');
    expect(again.created?.factId).toBe(first.created!.factId);
    expect(ledgerEvents(v).map(e => e.id)).toEqual([first.eventId]);
    db.close();
  });

  it('a ledger written before replays as it did: the values under two spellings both stay current', async () => {
    const v = mkvault();
    writeLedger(v, LEGACY);
    const db = freshDb(path.join(v, 'index.db'));
    await replayLedger(db, v, LEDGER);
    const legacyRows = [
      { event_id: 'MEM_LEGACYPROJ1', object_text: 'March 3', scope: 'project:atlas', valid_from: LEGACY[0].at, valid_to: null },
      { event_id: 'MEM_LEGACYSCOPE1', object_text: 'April 9', scope: 'scope:atlas', valid_from: LEGACY[1].at, valid_to: LEGACY[2].at },
      { event_id: 'MEM_LEGACYSCOPE2', object_text: 'April 10', scope: 'scope:atlas', valid_from: LEGACY[2].at, valid_to: null },
    ];
    expect(rows(db)).toEqual(legacyRows);
    expect(logged(db)).toEqual(['zephyr launch date → March 3', 'zephyr launch date → April 9', 'zephyr launch date → April 10 (closed fact 2)']);
    await replayLedger(db, v, LEDGER);
    expect(rows(db)).toEqual(legacyRows);
    for (const scope of ['project:atlas', 'scope:atlas', 'atlas']) {
      expect(current(db, scope), scope).toEqual([['April 10', 'scope:atlas'], ['March 3', 'project:atlas']]);
    }
    db.close();
  });

  it('a save to a scope that holds two such values closes both, and its receipt names both', async () => {
    const v = mkvault();
    writeLedger(v, LEGACY);
    const db = freshDb(path.join(v, 'index.db'));
    await replayLedger(db, v, LEDGER);
    const factId = (eventId: string) => (db.prepare('SELECT id FROM facts WHERE event_id = ?').get(eventId) as { id: number }).id;

    const saved = await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'April 20', scope: 'scope:atlas' });
    expect(saved.action).toBe('supersede');
    const validTo = saved.created!.validFrom;
    // closed is the value the ledger event names (saved under the other spelling); alsoClosed is the one under its own.
    expect(saved.closed).toEqual({ factId: factId('MEM_LEGACYPROJ1'), object: 'March 3', validTo });
    expect(saved.alsoClosed).toEqual({ factId: factId('MEM_LEGACYSCOPE2'), object: 'April 10', validTo });
    expect(ledgerEvents(v).find(e => e.id === saved.eventId)?.closedEvent).toBe('MEM_LEGACYPROJ1');
    expect(logged(db).at(-1)).toBe(`zephyr launch date → April 20 (closed facts ${factId('MEM_LEGACYSCOPE2')}, ${factId('MEM_LEGACYPROJ1')})`);
    for (const scope of ['project:atlas', 'scope:atlas', 'atlas']) {
      expect(current(db, scope), scope).toEqual([['April 20', 'scope:atlas']]);
    }

    const projected = rows(db);
    expect(await rebuilt(v)).toEqual(projected);
    await replayLedger(db, v, LEDGER);
    expect(rows(db)).toEqual(projected);
    db.close();
  });

  it('saving again the newer of two such values is not a no-op: it closes both, so the scope holds one value', async () => {
    const v = mkvault();
    writeLedger(v, LEGACY);
    const db = freshDb(path.join(v, 'index.db'));
    await replayLedger(db, v, LEDGER);
    const saved = await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'April 10', scope: 'scope:atlas' });
    expect([saved.action, saved.closed?.object, saved.alsoClosed?.object]).toEqual(['supersede', 'March 3', 'April 10']);
    expect(current(db, 'atlas')).toEqual([['April 10', 'scope:atlas']]);
    expect(rows(db).filter((r: any) => r.valid_to === null).map((r: any) => r.event_id)).toEqual([saved.eventId]);
    db.close();
  });

  it('when two such values agree, re-sending the newer one\'s statement changes nothing', async () => {
    const v = mkvault();
    writeLedger(v, [
      { id: 'MEM_AGREEPROJ1', at: '2026-09-01T00:00:00.000Z', kind: 'store', object: 'March 3', scope: 'project:atlas', statement: 'The launch is March 3.' },
      { id: 'MEM_AGREESCOPE1', at: '2026-09-02T00:00:00.000Z', kind: 'store', object: 'March 3', scope: 'scope:atlas', statement: 'Still March 3 for the launch.' },
    ]);
    const db = freshDb(path.join(v, 'index.db'));
    await replayLedger(db, v, LEDGER);
    const newer = (db.prepare('SELECT id FROM facts WHERE event_id = ?').get('MEM_AGREESCOPE1') as { id: number }).id;
    const again = await remember(db, v, LEDGER,
      { subject: SUBJECT, predicate: 'date', object: 'March 3', scope: 'project:atlas', statement: 'Still March 3 for the launch.' });
    expect([again.action, again.created?.factId]).toEqual(['nochange', newer]);
    db.close();
  });

  it('a value saved with no ledger event cannot be named, so a save leaves it current and its receipt does not claim it', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'owner', object: 'Ana', scope: 'project:atlas' });
    // What the base engine wrote before the ledger: a lifecycle row with no event.
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id, scope)
       SELECT id, 'date', 'March 3', '_mcp_', 1.0, '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z', NULL, 'project:atlas'
       FROM entities WHERE source_note = '_mcp_' AND canonical_name = ?`,
    ).run(SUBJECT);
    const saved = await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'April 9', scope: 'scope:atlas' });
    expect([saved.action, saved.closed]).toEqual(['store', null]);
    expect(ledgerEvents(v).find(e => e.id === saved.eventId)?.closedEvent).toBeNull();
    expect(current(db, 'atlas')).toEqual([['April 9', 'scope:atlas'], ['March 3', 'project:atlas']]);
    db.close();
  });

  it('a closed_event written in lower case closes the same fact on a rebuild and on a replay', async () => {
    const v = mkvault();
    writeLedger(v, [
      { id: 'MEM_CASEPROJ1', at: '2026-09-01T00:00:00.000Z', kind: 'store', object: 'March 3', scope: 'project:atlas' },
      { id: 'MEM_CASESCOPE1', at: '2026-09-02T00:00:00.000Z', kind: 'supersede', object: 'April 9', scope: 'scope:atlas', closed: 'mem_caseproj1' },
    ]);
    const db = freshDb(path.join(v, 'index.db'));
    await replayLedger(db, v, LEDGER);
    expect(current(db, 'atlas')).toEqual([['April 9', 'scope:atlas']]);
    const projected = rows(db);
    await replayLedger(db, v, LEDGER);
    expect(rows(db)).toEqual(projected);
    db.close();
  });

  it('a closed_event that names a fact in another scope closes nothing there: another slug and global keep their values', async () => {
    const v = mkvault();
    writeLedger(v, [
      { id: 'MEM_OTHERKESTREL1', at: '2026-09-01T00:00:00.000Z', kind: 'store', object: 'May 1', scope: 'project:kestrel' },
      { id: 'MEM_OTHERGLOBAL1', at: '2026-09-02T00:00:00.000Z', kind: 'store', object: 'June 2', scope: 'global' },
      { id: 'MEM_OTHERATLAS1', at: '2026-09-03T00:00:00.000Z', kind: 'supersede', object: 'April 9', scope: 'scope:atlas', closed: 'MEM_OTHERKESTREL1' },
      { id: 'MEM_OTHERATLAS2', at: '2026-09-04T00:00:00.000Z', kind: 'supersede', object: 'April 10', scope: 'project:atlas', closed: 'MEM_OTHERGLOBAL1' },
    ]);
    const db = freshDb(path.join(v, 'index.db'));
    await replayLedger(db, v, LEDGER);
    expect(current(db, 'project:kestrel')).toEqual([['May 1', 'project:kestrel']]);
    expect(current(db, 'global')).toEqual([['June 2', 'global']]);
    // Within atlas the two values were saved under two spellings and neither event names the other: both current.
    expect(current(db, 'atlas')).toEqual([['April 10', 'project:atlas'], ['April 9', 'scope:atlas']]);
    const projected = rows(db);
    await replayLedger(db, v, LEDGER);
    expect(rows(db)).toEqual(projected);
    db.close();
  });

  it('a save whose clock is behind the value it would close under the other spelling is refused before the ledger is touched', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(realNow + 3600_000)); // the clock ran ahead when this was saved
      await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'March 3', scope: 'project:atlas' });
      vi.setSystemTime(new Date(realNow)); // and was then corrected back
      const before = fs.readFileSync(path.join(v, LEDGER), 'utf8');
      await expect(remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'April 9', scope: 'scope:atlas' }))
        .rejects.toThrow(/rejected without publishing/);
      expect(fs.readFileSync(path.join(v, LEDGER), 'utf8')).toBe(before);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('a refused save names the instant the clock must reach, and that the refusal is not transient', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const realNow = Date.now();
    const ahead = new Date(realNow + 3600_000).toISOString();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(realNow + 3600_000));
      await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'March 3', scope: 'project:atlas' });
      vi.setSystemTime(new Date(realNow));
      const before = fs.readFileSync(path.join(v, LEDGER), 'utf8');
      const refused = remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'April 9', scope: 'scope:atlas' });
      await expect(refused).rejects.toThrow(`Writes are accepted again once the clock reaches ${ahead}.`);
      await expect(refused).rejects.not.toThrow(/transient/);
      expect(fs.readFileSync(path.join(v, LEDGER), 'utf8')).toBe(before);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('a replay closes again a value that an older release left open beside its correction', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const first = await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'March 3', scope: 'project:atlas' });
    await remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object: 'April 9', scope: 'scope:atlas' });
    const projected = rows(db);
    // A release from before reads the ledger one spelling at a time, so its replay reopens the closed value.
    db.prepare('UPDATE facts SET valid_to = NULL WHERE event_id = ?').run(first.eventId);
    expect(current(db, 'atlas')).toHaveLength(2);

    await replayLedger(db, v, LEDGER);
    expect(rows(db)).toEqual(projected);
    expect(current(db, 'atlas')).toEqual([['April 9', 'scope:atlas']]);
    db.close();
  });

  it('retiring, retiring, then restoring both across a scope spelling leaves one current value and replays cleanly', async () => {
    // The exact sequence the review found workspace-fatal: A retired under scope:alpha, B saved then retired under
    // project:alpha, then both restored. B's save must close retired A across the spelling (the stream is the slug),
    // so restoring A brings it back as history and restoring B makes B current — live, on a restart replay, and on a
    // rebuild from scratch. Before the fix the rejected restore B was already in the ledger, so no replay could start.
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let t = Date.parse('2026-10-07T12:00:00.000Z');
      const tick = () => { t += 1000; vi.setSystemTime(t); };
      const save = (object: string, scope: string) =>
        remember(db, v, LEDGER, { subject: SUBJECT, predicate: 'date', object, scope });

      tick();
      const old = await save('March 3', 'scope:alpha');
      tick();
      await retireFact(db, v, LEDGER, `fact:${old.eventId}`);
      tick();
      const newer = await save('April 9', 'project:alpha');
      // The newer save closes the retired value as if it had never been retired, so a restore brings it back as history.
      expect(db.prepare('SELECT valid_to FROM retired_facts WHERE event_id = ?').get(old.eventId))
        .toEqual({ valid_to: newer.created!.validFrom });
      tick();
      await retireFact(db, v, LEDGER, `fact:${newer.eventId}`);
      tick();
      const restoredOld = await restoreFact(db, v, LEDGER, `fact:${old.eventId}`);
      tick();
      const restoredNew = await restoreFact(db, v, LEDGER, `fact:${newer.eventId}`);

      expect([restoredOld.current, restoredNew.current]).toEqual([false, true]);
      for (const scope of ['scope:alpha', 'project:alpha', 'alpha']) {
        expect(current(db, scope), scope).toEqual([['April 9', 'project:alpha']]);
        expect(history(db, scope), scope).toEqual([
          ['April 9', 'project:alpha', null],
          ['March 3', 'scope:alpha', newer.created!.validFrom],
        ]);
      }

      const projected = rows(db);
      expect(await rebuilt(v)).toEqual(projected); // a rebuild from scratch
      await replayLedger(db, v, LEDGER);           // a restart replay over the live index (the startup path)
      expect(rows(db)).toEqual(projected);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('a ledger whose save closes a newer value under another spelling is refused, by a rebuild and by a replay into an index holding both', async () => {
    const v = mkvault();
    const outOfOrder = [
      { id: 'MEM_NEWERPROJ1', at: '2026-09-05T00:00:00.000Z', kind: 'store', object: 'March 3', scope: 'project:atlas' },
      { id: 'MEM_OLDERSCOPE1', at: '2026-09-01T00:00:00.000Z', kind: 'supersede', object: 'April 9', scope: 'scope:atlas', closed: 'MEM_NEWERPROJ1' },
    ];
    writeLedger(v, outOfOrder);
    const fresh = freshDb(path.join(v, 'fresh.db'));
    await expect(replayLedger(fresh, v, LEDGER)).rejects.toThrow(/MEM_OLDERSCOPE1 .* is older than the current fact/);
    fresh.close();

    // An index an older release built from the same ledger: it never closed across spellings, so both rows are open.
    const db = freshDb(path.join(v, 'index.db'));
    db.prepare(`INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`).run(outOfOrder[0].at);
    const entityId = (db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('concept', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`,
    ).get(SUBJECT, outOfOrder[0].at) as { id: number }).id;
    for (const e of outOfOrder) {
      db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, event_id, scope)
         VALUES (?, 'date', ?, '_mcp_', 1.0, ?, NULL, ?, ?, ?)`,
      ).run(entityId, e.object, e.at, e.at, e.id, e.scope);
    }
    const held = rows(db);
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/MEM_OLDERSCOPE1 .* is older than the current fact/);
    expect(rows(db)).toEqual(held); // refused whole: nothing was reconciled
    db.close();
  });
});

describe('remember_note path for scope', () => {
  it('writes scoped daily notes under Memory/Scopes/<slug>/Daily', async () => {
    const v = mkvault();
    const scope = normalizeScope('project:acme');
    const dir = dailyDirForScope(scope);
    expect(dir).toBe('Memory/Scopes/acme/Daily');
    await appendDailyMemory(v, '2026-09-16', { text: 'Scoped note.', source: 'test' }, dir);
    const p = path.join(v, 'Memory', 'Scopes', 'acme', 'Daily', '2026-09-16.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toContain('Scoped note.');
  });

  it('writes global daily notes under Memory/Daily', async () => {
    const v = mkvault();
    const dir = dailyDirForScope('global');
    await appendDailyMemory(v, '2026-09-16', { text: 'Global note.', source: 'test' }, dir);
    const p = path.join(v, 'Memory', 'Daily', '2026-09-16.md');
    expect(fs.existsSync(p)).toBe(true);
  });
});
