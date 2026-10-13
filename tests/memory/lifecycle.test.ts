import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, replayLedger, factsFor, retireFact, restoreFact } from '../../src/memory/lifecycle';
import type Database from 'better-sqlite3';
import { indexFile } from '../../src/indexer/pipeline';

/**
 * Gate1A lifecycle regression tests.
 *
 * T1–T3 below are adapted from the independently preserved Gate-0 PoC at
 * memory-company-review fc80d65, docs/build-1/gate0-engine-poc.ts
 * (tests T1 flip-flop, T2 concurrent remember, T3 ledger injection).
 * The PoC invariants are preserved verbatim; only harness plumbing
 * (mkdtemp, vitest assertions) is product-local. All data is synthetic.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1a-lifecycle-'));
  tmpDirs.push(d);
  return d;
}

function freshDb(file: string): Database.Database {
  const db = openDb(file);
  runMigrations(db);
  return db;
}

function ledgerPath(v: string): string {
  return path.join(v, LEDGER);
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function openCurrentCount(db: Database.Database, subject: string, predicate: string): number {
  return (db.prepare(
    `SELECT COUNT(*) c FROM facts f JOIN entities e ON f.subject_entity_id = e.id
     WHERE e.canonical_name = ? AND e.source_note = '_mcp_' AND f.predicate = ? AND f.valid_to IS NULL`
  ).get(subject, predicate) as any).c;
}

describe('B1: A->B->A supersession (event identity, transactional replay)', () => {
  it('accepts the third remember (PoC T1 third-remember-succeeds)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Alpha', source: 'poc' });
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Beta', source: 'poc' });
    await expect(
      remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Alpha', source: 'poc' })
    ).resolves.toBeTruthy();
    db.close();
  });

  it('fresh replay of the flip-flop ledger succeeds (PoC T1 rebuild-replay-succeeds)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Alpha', source: 'poc' });
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Beta', source: 'poc' });
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Alpha', source: 'poc' });
    db.close();

    const db2 = freshDb(path.join(v, 'rebuild.db'));
    await expect(replayLedger(db2, v, LEDGER)).resolves.toBe(3);
    db2.close();
  });

  it('all three events survive replay with full history and exactly one current value', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Alpha', source: 'poc' });
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Beta', source: 'poc' });
    await remember(db, v, LEDGER, { subject: 'SynthBob', predicate: 'lives_in', object: 'Alpha', source: 'poc' });
    db.close();

    const db2 = freshDb(path.join(v, 'rebuild.db'));
    await replayLedger(db2, v, LEDGER);
    const history = factsFor(db2, 'SynthBob', { includeHistory: true }) as any[];
    expect(history).toHaveLength(3); // A(closed), B(closed), A(current) — event identity, not (subject,predicate,object) uniqueness
    const current = factsFor(db2, 'SynthBob') as any[];
    expect(current).toHaveLength(1);
    expect(current[0].object_text).toBe('Alpha');
    expect(current[0].valid_to).toBeNull();
    db2.close();
  });

  it('identical duplicate ledger events dedup; a reused event id with a conflicting payload fails explicitly', async () => {
    const v = mkvault();
    fs.mkdirSync(path.dirname(ledgerPath(v)), { recursive: true });
    const block = [
      `## MEM_DUP1 · 2026-09-09T00:00:01.000Z`,
      `- kind: store`,
      `- subject: SynthDup`,
      `- predicate: p`,
      `- object: one`,
      `- source: poc`,
      ``,
    ].join('\n');
    fs.writeFileSync(ledgerPath(v), `---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n${block}${block}`);

    const db = freshDb(path.join(v, 'index.db'));
    // Byte-identical event twice: safe idempotent dedup, applied exactly once.
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(1);
    // Re-replay into the same applied index: 0 new events, no throw, no duplicates.
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM facts WHERE event_id = 'MEM_DUP1'`).get() as any).c).toBe(1);

    // Same event id reused with a DIFFERENT payload is corruption, never a silent skip.
    fs.appendFileSync(ledgerPath(v), [
      ``,
      `## MEM_DUP1 · 2026-09-09T00:00:02.000Z`,
      `- kind: store`,
      `- subject: SynthDup`,
      `- predicate: p`,
      `- object: two`,
      `- source: poc`,
      ``,
    ].join('\n'));
    await expect(replayLedger(db, v, LEDGER)).rejects.toThrow(/conflicting payload/i);
    // The conflicting event never materialized.
    expect((db.prepare(`SELECT COUNT(*) c FROM facts WHERE event_id = 'MEM_DUP1' AND object_text = 'two'`).get() as any).c).toBe(0);
    db.close();
  });
});

describe('B2: concurrent same-subject/predicate remember (in-process serialization)', () => {
  it('leaves exactly one open current fact (PoC T2 single-open-current-fact)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const receipts = await Promise.all(['X1', 'X2', 'X3', 'X4', 'X5'].map(o =>
      remember(db, v, LEDGER, { subject: 'SynthRace', predicate: 'wants', object: o, source: 'poc' })
    ));
    // Every accepted event produced a receipt — none silently lost.
    expect(receipts).toHaveLength(5);
    expect(receipts.every(r => r.ok)).toBe(true);
    const open = openCurrentCount(db, 'SynthRace', 'wants');
    // This engine's semantics are single-current-value per (subject, predicate):
    // exactly one open fact may exist (lifecycle.ts supersede closes LIMIT 1).
    expect(open).toBe(1);
    // All five events are durable in the ledger and rebuild to the same state.
    db.close();
    const db2 = freshDb(path.join(v, 'rebuild.db'));
    await replayLedger(db2, v, LEDGER);
    expect(factsFor(db2, 'SynthRace', { includeHistory: true })).toHaveLength(5);
    expect(factsFor(db2, 'SynthRace')).toHaveLength(1);
    db2.close();
  });
});

describe('B3: strict lifecycle input and ledger framing', () => {
  it('rejects a control-character subject instead of writing it (PoC T3 control-char-write-rejected)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const forged = ['## mem_FORGED1 · 2026-09-09T00:00:00.000Z', '- kind: store', '- subject: SynthVictim',
      '- predicate: bank_pin', '- object: 1234', '- source: forged', ''].join('\n');
    await expect(
      remember(db, v, LEDGER, { subject: 'SynthBob\n' + forged, predicate: 'lives_in', object: 'Alpha', source: 'poc' })
    ).rejects.toThrow(/control character/i);
    db.close();
  });

  it('no forged fact materializes after rebuild (PoC T3 no-forged-fact-after-rebuild)', async () => {
    // The base-engine exploit: a newline in `subject` spliced an attacker-chosen
    // event header INTO the ledger block, so replay materialized a fact the
    // caller never validated (SynthVictim bank_pin). The write path now rejects
    // control characters outright, and — defense in depth — the strict parser
    // treats field values as single lines, so event-lookalike text carried in a
    // field value can never become an event header on replay. Here we place
    // forged-event text INSIDE a field value (single line, exactly what any
    // pre-validation or aliasing bug could leave in a value) and prove replay
    // applies it as inert data, never as a forged event.
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const forgedHeader = '## mem_FORGED1 · 2026-09-09T00:00:00.000Z - kind: store - subject: SynthVictim - predicate: bank_pin - object: 1234 - source: forged';
    fs.mkdirSync(path.dirname(ledgerPath(v)), { recursive: true });
    fs.writeFileSync(ledgerPath(v), [
      `---`, `type: memory-ledger`, `---`, ``, `# Memory Events Ledger`, ``,
      `## MEM_REAL1 · 2026-09-09T00:00:00.000Z`,
      `- kind: store`,
      `- subject: SynthBob ${forgedHeader}`,
      `- predicate: lives_in`,
      `- object: Alpha`,
      `- source: poc`,
      ``,
    ].join('\n'));
    db.close();

    const db2 = freshDb(path.join(v, 'rebuild.db'));
    await expect(replayLedger(db2, v, LEDGER)).resolves.toBe(1);
    // Exactly one fact — the real one; the forged-event text is inert data
    // inside its subject, never materialized as a second event.
    const facts = db2.prepare(`SELECT COUNT(*) c FROM facts`).get() as any;
    expect(facts.c).toBe(1);
    const forgedFacts = db2.prepare(
      `SELECT f.object_text FROM facts f JOIN entities e ON f.subject_entity_id = e.id
       WHERE f.predicate = 'bank_pin' OR e.canonical_name = 'SynthVictim' OR f.object_text = '1234'`
    ).all() as any[];
    expect(forgedFacts).toHaveLength(0);
    // And the inert payload is preserved as the real event's subject (data, not framing).
    const realSubject = db2.prepare(
      `SELECT e.canonical_name AS n FROM entities e JOIN facts f ON f.subject_entity_id = e.id WHERE f.event_id = 'MEM_REAL1'`
    ).get() as any;
    expect(realSubject.n).toContain('mem_FORGED1');
    db2.close();
  });

  it('rejects control characters in every lifecycle field', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    for (const patch of [
      { subject: 'Bad\rSubject' },
      { predicate: 'bad\npredicate' },
      { object: 'line one\nline two' },
      { object: 'tab\tobject' },
    ]) {
      await expect(remember(db, v, LEDGER, {
        subject: 'SynthOk', predicate: 'p', object: 'ok', source: 'poc', ...patch,
      } as any)).rejects.toThrow();
    }
    // Nothing was written: no ledger file, no facts.
    expect(fs.existsSync(ledgerPath(v))).toBe(false);
    expect(openCurrentCount(db, 'SynthOk', 'p')).toBe(0);
    db.close();
  });

  it('drops a control character from the source instead of rejecting the save, and it still cannot forge an event (PoC T3, source field)', async () => {
    // A source is a name, not a value to keep: sourceName.ts drops its control characters before anything is judged, so a stray
    // newline no longer loses the whole fact (it did: LifecycleInputError). The framing the test above protects holds all the
    // same, because no control character reaches the ledger: the forged event below stays inert text inside ONE `- source:` line.
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const forged = ['poc', '## mem_FORGED1 · 2026-09-09T00:00:00.000Z', '- kind: store', '- subject: SynthVictim',
      '- predicate: bank_pin', '- object: 1234', '- source: forged'].join('\n');
    for (const [i, source] of ['bad\x00source', 'tab\tsource', '/home/ana/BOARD\n.md', 'cr\rlf\n', forged].entries()) {
      // one subject each, so no save is a repeat of another
      const saved = await remember(db, v, LEDGER, { subject: `SynthSource${i}`, predicate: 'p', object: 'ok', source });
      expect(saved, JSON.stringify(source)).toMatchObject({ ok: true, action: 'store' });
    }
    const ledger = fs.readFileSync(ledgerPath(v), 'utf8');
    expect(ledger).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/); // the only control character left in the file is the line feed that frames it
    expect(ledger.match(/^## mem_/gim)).toHaveLength(5); // one event block per save: the forged header started no block of its own
    expect(ledger.match(/^- source: .*$/gm)).toEqual(['- source: badsource', '- source: tabsource', '- source: BOARD.md', '- source: crlf',
      `- source: ${forged.replace(/\n/g, '').slice(0, 40)}`]);
    db.close();

    // and a rebuild from the ledger reads exactly those five events, nothing the forged text spelled
    const db2 = freshDb(path.join(v, 'rebuild.db'));
    await expect(replayLedger(db2, v, LEDGER)).resolves.toBe(5);
    expect((db2.prepare(`SELECT COUNT(*) c FROM facts WHERE predicate = 'bank_pin'`).get() as any).c).toBe(0);
    db2.close();
  });

  it('rejects empty and oversized fields', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    await expect(remember(db, v, LEDGER, { subject: '  ', predicate: 'p', object: 'o' } as any)).rejects.toThrow();
    await expect(remember(db, v, LEDGER, { subject: 's', predicate: 'p', object: '' } as any)).rejects.toThrow();
    await expect(remember(db, v, LEDGER, { subject: 'x'.repeat(10000), predicate: 'p', object: 'o' })).rejects.toThrow();
    expect(fs.existsSync(ledgerPath(v))).toBe(false);
    db.close();
  });

  it('strict replay: malformed event blocks fail loudly, valid legacy blocks still replay', async () => {
    const v = mkvault();
    fs.mkdirSync(path.dirname(ledgerPath(v)), { recursive: true });
    const head = `---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n`;

    // Valid block without kind/source lines (legacy tolerance): replays as store.
    fs.writeFileSync(ledgerPath(v), head + [
      `## MEM_LEGACY1 · 2026-09-09T00:00:00.000Z`,
      `- subject: SynthLegacy`,
      `- predicate: p`,
      `- object: fine`,
      ``,
    ].join('\n'));
    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(1);
    db.close();

    // Missing required field -> explicit corruption error. The bad block is followed by a whole event: a final block
    // with a kind line and no source is an unterminated (cut) event that replay sets aside (crash.torn-tail), so this
    // block must not be the final one for the refusal to be what it tests.
    fs.writeFileSync(ledgerPath(v), head + [
      `## MEM_BAD1 · 2026-09-09T00:00:00.000Z`,
      `- kind: store`,
      `- subject: SynthX`,
      `- predicate: p`,
      ``,
      `## MEM_OK1 · 2026-09-09T00:00:01.000Z`,
      `- kind: store`,
      `- subject: SynthOK`,
      `- predicate: p`,
      `- object: fine`,
      `- source: test`,
      ``,
    ].join('\n'));
    const db2 = freshDb(path.join(v, 'b1.db'));
    await expect(replayLedger(db2, v, LEDGER)).rejects.toThrow(/missing required field "object"/i);
    db2.close();

    // Malformed field line inside a block -> explicit corruption error.
    fs.writeFileSync(ledgerPath(v), head + [
      `## MEM_BAD2 · 2026-09-09T00:00:00.000Z`,
      `- subject: SynthX`,
      `- predicate: p`,
      `- object: ok`,
      `- this line has no colon-value shape`,
      ``,
    ].join('\n'));
    const db3 = freshDb(path.join(v, 'b2.db'));
    await expect(replayLedger(db3, v, LEDGER)).rejects.toThrow(/malformed field line/i);
    db3.close();

    // Unknown field key -> explicit corruption error.
    fs.writeFileSync(ledgerPath(v), head + [
      `## MEM_BAD3 · 2026-09-09T00:00:00.000Z`,
      `- subject: SynthX`,
      `- predicate: p`,
      `- object: ok`,
      `- evil_field: yes`,
      ``,
    ].join('\n'));
    const db4 = freshDb(path.join(v, 'b3.db'));
    await expect(replayLedger(db4, v, LEDGER)).rejects.toThrow(/unknown field "evil_field"/i);
    db4.close();

    // Unknown kind -> explicit corruption error. Followed by a whole event for the same reason as MEM_BAD1 above: a final
    // block with a kind line and no source is an unterminated event that replay sets aside (crash.torn-tail).
    fs.writeFileSync(ledgerPath(v), head + [
      `## MEM_BAD4 · 2026-09-09T00:00:00.000Z`,
      `- kind: delete`,
      `- subject: SynthX`,
      `- predicate: p`,
      `- object: ok`,
      ``,
      `## MEM_OK2 · 2026-09-09T00:00:01.000Z`,
      `- kind: store`,
      `- subject: SynthOK2`,
      `- predicate: p`,
      `- object: fine`,
      `- source: test`,
      ``,
    ].join('\n'));
    const db5 = freshDb(path.join(v, 'b4.db'));
    await expect(replayLedger(db5, v, LEDGER)).rejects.toThrow(/unknown kind "delete"/i);
    db5.close();

    // Malformed event-shaped header (## mem_*) -> explicit corruption error.
    fs.writeFileSync(ledgerPath(v), head + `## mem_ · 2026-09-09T00:00:00.000Z\n- subject: SynthX\n`);
    const db6 = freshDb(path.join(v, 'b5.db'));
    await expect(replayLedger(db6, v, LEDGER)).rejects.toThrow(/malformed event header/i);
    db6.close();
  });

  it('ordinary Markdown prose headings between events do not break replay', async () => {
    const v = mkvault();
    fs.mkdirSync(path.dirname(ledgerPath(v)), { recursive: true });
    fs.writeFileSync(ledgerPath(v), [
      `---`, `type: memory-ledger`, `---`, ``, `# Memory Events Ledger`, ``,
      `## Notes`, `Some human prose section.`, ``,
      `## MEM_OK1 · 2026-09-09T00:00:00.000Z`,
      `- kind: store`,
      `- subject: SynthProse`,
      `- predicate: p`,
      `- object: ok`,
      `- source: poc`,
      ``,
      `## More prose`, `Human text.`, ``,
    ].join('\n'));
    const db = freshDb(path.join(v, 'index.db'));
    await expect(replayLedger(db, v, LEDGER)).resolves.toBe(1);
    expect(factsFor(db, 'SynthProse')).toHaveLength(1);
    db.close();
  });
});

describe('clock-regression reads: a lifecycle fact survives a backward step by open rows, a note fact by the ledger stamp', () => {
  /** A note-derived fact (source_path = the note), dated by its content, never by the wall clock. */
  function insertNoteFact(db: Database.Database, subject: string, validFrom: string, scope = 'global'): void {
    const note = `Notes/${subject}.md`;
    db.prepare(`INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at) VALUES (?, ?, 'note', ?, ?)`)
      .run(note, subject, note, validFrom);
    const entity = db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES ('note', ?, '[]', ?, 1.0, ?) RETURNING id`
    ).get(subject, note, validFrom) as { id: number };
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at, scope) VALUES (?, 'amount', 'x', ?, 1.0, ?, ?, ?)`
    ).run(entity.id, note, validFrom, validFrom, scope);
  }

  it('indexing invalidates a cached read clock without promoting future dates, expired windows or another scope', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      insertNoteFact(db, 'NoteIndexedWindow', '2026-10-05T00:00:00.000Z');
      insertNoteFact(db, 'NoteIndexedFuture', '2026-10-20T00:00:00.000Z');
      insertNoteFact(db, 'NoteIndexedExpired', '2026-10-05T00:00:00.000Z');
      db.prepare("UPDATE facts SET valid_to = '2026-10-09T00:00:00.000Z' WHERE source_path = 'Notes/NoteIndexedExpired.md'").run();
      insertNoteFact(db, 'NoteIndexedOtherScope', '2026-10-05T00:00:00.000Z', 'project:elsewhere');
      expect(factsFor(db, 'NoteIndexedWindow', { scope: 'global' })).toHaveLength(0);
      vi.setSystemTime(Date.parse('2026-10-10T12:00:00Z'));
      const note = path.join(v, 'Observed.md');
      fs.writeFileSync(note, '---\nowner: Avery\n---\n\n# Observed\n');
      await indexFile(db, note); // No lifecycle event and no embedder.
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      expect(factsFor(db, 'Observed', { scope: 'global' })).toHaveLength(1);
      expect(factsFor(db, 'NoteIndexedWindow', { scope: 'global' })).toHaveLength(1);
      expect(factsFor(db, 'NoteIndexedWindow', { scope: '' })).toHaveLength(1);
      expect(factsFor(db, 'NoteIndexedFuture')).toHaveLength(0);
      expect(factsFor(db, 'NoteIndexedExpired')).toHaveLength(0);
      expect(factsFor(db, 'NoteIndexedOtherScope', { scope: 'project:elsewhere' })).toHaveLength(0);
      expect(factsFor(db, 'NoteIndexedWindow', { asOf: '2026-01-01T00:00:00.000Z' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('backward reindexing, deletion, reopen and lifecycle retire/restore never lower the index observation', async () => {
    const v = mkvault();
    const dbPath = path.join(v, 'index.db');
    let db = freshDb(dbPath);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-01T12:00:00Z'));
      const saved = await remember(db, v, LEDGER, { subject: 'EarlierClock', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      vi.setSystemTime(Date.parse('2026-10-10T12:00:00Z'));
      const note = path.join(v, 'Newest.md');
      fs.writeFileSync(note, '---\nowner: Avery\n---\n\n# Newest\n');
      await indexFile(db, note);
      insertNoteFact(db, 'NoteAfterLedger', '2026-10-05T00:00:00.000Z');
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      fs.appendFileSync(note, '\nChanged after the clock step.\n');
      await indexFile(db, note);
      expect(factsFor(db, 'NoteAfterLedger')).toHaveLength(1);
      await retireFact(db, v, LEDGER, `fact:${saved.eventId}`, 'poc');
      expect(factsFor(db, 'NoteAfterLedger')).toHaveLength(1);
      await restoreFact(db, v, LEDGER, `fact:${saved.eventId}`, 'poc');
      expect(factsFor(db, 'NoteAfterLedger')).toHaveLength(1);
      // Note retirement deletes the index rows; the observation is independent of them.
      db.prepare('DELETE FROM notes WHERE path = ?').run(note);
      db.close();
      db = freshDb(dbPath);
      expect(factsFor(db, 'NoteAfterLedger')).toHaveLength(1);
      expect(db.prepare('SELECT observed_at FROM note_index_clock WHERE scope = ?').pluck().get('global')).toBe('2026-10-10T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('a lifecycle fact is judged by open rows, so a backward clock step cannot hide it; asOf stays honest', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      await remember(db, v, LEDGER, { subject: 'SynthClockRead', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      // The default read judges the lifecycle fact by open rows, so the value the
      // user gave before the step is still current (the repeat-twice failure).
      const current = factsFor(db, 'SynthClockRead') as any[];
      expect(current).toHaveLength(1);
      expect(current[0].object_text).toBe('PostgreSQL');
      // An explicit point-in-time read at the stepped-back instant is still honest:
      // the fact did not exist then.
      expect(factsFor(db, 'SynthClockRead', { asOf: '2026-01-01T00:00:00.000Z' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('a note-derived fact keeps its content-date window: a future date is not yet current', () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    insertNoteFact(db, 'NotePast', '2026-03-15T00:00:00.000Z');
    insertNoteFact(db, 'NoteFuture', '2099-01-01T00:00:00.000Z');
    expect(factsFor(db, 'NotePast')).toHaveLength(1);
    // The default read does not touch a note-derived fact dated in the future...
    expect(factsFor(db, 'NoteFuture')).toHaveLength(0);
    // ...but history and an explicit asOf still answer for it.
    expect(factsFor(db, 'NoteFuture', { includeHistory: true })).toHaveLength(1);
    expect(factsFor(db, 'NoteFuture', { asOf: '2099-06-01T00:00:00.000Z' })).toHaveLength(1);
    db.close();
  });

  it('a note-derived fact the vault already holds survives a backward clock step', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      insertNoteFact(db, 'NoteRecent', '2026-10-05T00:00:00.000Z');
      // The write path stamps the workspace's own timeline, which the read clock is never older than.
      await remember(db, v, LEDGER, { subject: 'SynthNoteClock', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      expect(factsFor(db, 'NoteRecent')).toHaveLength(1);
      // A backward step (NTP correction, a VM that resumed with a skewed clock) must not
      // hide a note the vault already holds — the repeat-twice failure for note facts.
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      const read = factsFor(db, 'NoteRecent') as any[];
      expect(read).toHaveLength(1);
      expect(read[0].valid_from).toBe('2026-10-05T00:00:00.000Z');
      // The lifecycle fact is unaffected: judged by open rows, as above.
      expect(factsFor(db, 'SynthNoteClock')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('a note fact dated after the newest lifecycle stamp is still not yet: the clamp never invents a past', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      await remember(db, v, LEDGER, { subject: 'SynthStamped', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      insertNoteFact(db, 'NoteNextWeek', '2026-10-20T00:00:00.000Z');
      // The workspace's newest stamp (2026-10-08T12:00Z) is older than the note's content date,
      // so the clamp does not lift the read clock and the future date still means "not yet".
      expect(factsFor(db, 'NoteNextWeek')).toHaveLength(0);
      expect(factsFor(db, 'NoteNextWeek', { includeHistory: true })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('retiring the newest lifecycle fact does not step the read clock back and re-hide the note', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      insertNoteFact(db, 'NoteKept', '2026-10-05T00:00:00.000Z');
      const saved = await remember(db, v, LEDGER, { subject: 'SynthRetired', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      // The stamp lifts the read clock, so the note is visible before the retirement.
      expect(factsFor(db, 'NoteKept')).toHaveLength(1);
      // A retirement moves its row out of `facts` and into `retired_facts`, where the read's
      // high-water mark still counts it: the read clock does not step back with the row.
      const retired = await retireFact(db, v, LEDGER, `fact:${saved.eventId}`, 'poc');
      expect(retired.action).toBe('retired');
      expect(factsFor(db, 'NoteKept')).toHaveLength(1);
      // The lifecycle row itself is out of `facts`, so no read of `facts` — default or
      // includeHistory — shows it; the retired-fact surface (listRetiredFacts, export) does.
      expect(factsFor(db, 'SynthRetired')).toHaveLength(0);
      expect(factsFor(db, 'SynthRetired', { includeHistory: true })).toHaveLength(0);
      // Nor does the restore: the note stays visible and the fact comes back as current again.
      const restored = await restoreFact(db, v, LEDGER, `fact:${saved.eventId}`, 'poc');
      expect(restored.action).toBe('restored');
      expect(factsFor(db, 'NoteKept')).toHaveLength(1);
      expect(factsFor(db, 'SynthRetired')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('every lifecycle row retired leaves the high-water mark standing, so the note stays visible', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      const older = await remember(db, v, LEDGER, { subject: 'SynthTwo', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      vi.setSystemTime(Date.parse('2026-10-09T12:00:00Z'));
      const newer = await remember(db, v, LEDGER, { subject: 'SynthTwo', predicate: 'host', object: 'db-1', source: 'poc' });
      // Dated between the two stamps: visible only while the newer stamp still lifts the read clock.
      insertNoteFact(db, 'NoteBetween', '2026-10-08T18:00:00.000Z');
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      expect(factsFor(db, 'NoteBetween')).toHaveLength(1);
      // Retire the older one: the newer row still lifts the clock.
      await retireFact(db, v, LEDGER, `fact:${older.eventId}`, 'poc');
      expect(factsFor(db, 'NoteBetween')).toHaveLength(1);
      // Retire the newer one too: every lifecycle row is now in `retired_facts`, so a clamp read
      // from `facts` alone would return null and step the read clock all the way back to 2026-01-01.
      await retireFact(db, v, LEDGER, `fact:${newer.eventId}`, 'poc');
      expect(factsFor(db, 'NoteBetween')).toHaveLength(1);
      expect(factsFor(db, 'SynthTwo')).toHaveLength(0);
      // Restoring one brings it back, and the clamp is unchanged either way.
      await restoreFact(db, v, LEDGER, `fact:${newer.eventId}`, 'poc');
      expect(factsFor(db, 'NoteBetween')).toHaveLength(1);
      const live = factsFor(db, 'SynthTwo') as any[];
      expect(live.map((f: any) => f.object_text)).toEqual(['db-1']);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('a scoped read is lifted only by a lifecycle stamp in its own scope', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      insertNoteFact(db, 'NoteHere', '2026-10-05T00:00:00.000Z', 'project:here');
      insertNoteFact(db, 'NoteThere', '2026-10-05T00:00:00.000Z', 'project:other');
      // Only project:other has a stamp of its own before the clock steps back.
      await remember(db, v, LEDGER, { subject: 'SynthOtherScope', predicate: 'database', object: 'PostgreSQL', source: 'poc', scope: 'project:other' });
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      // The stamp that proves the clock regressed lives in project:other, so it decides
      // project:other's read and not project:here's.
      expect(factsFor(db, 'NoteThere', { scope: 'project:other' })).toHaveLength(1);
      expect(factsFor(db, 'NoteHere', { scope: 'project:here' })).toHaveLength(0);
      // A stamp in its own scope lifts it, whenever it was written: the clock has to move
      // forward again for that write to be accepted, and the read judges it at the stamp.
      vi.setSystemTime(Date.parse('2026-10-09T00:00:00Z'));
      await remember(db, v, LEDGER, { subject: 'SynthHere', predicate: 'database', object: 'PostgreSQL', source: 'poc', scope: 'project:here' });
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      expect(factsFor(db, 'NoteHere', { scope: 'project:here' })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('the point-in-time read keeps the instant it was asked for, clamped or not', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      insertNoteFact(db, 'NoteAsOf', '2026-10-05T00:00:00.000Z');
      await remember(db, v, LEDGER, { subject: 'SynthAsOf', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00Z'));
      // The clamp belongs to the default read's window only: an explicit asOf still asks
      // what was true AT that instant, so the note did not exist then.
      expect(factsFor(db, 'NoteAsOf', { asOf: '2026-01-01T00:00:00.000Z' })).toHaveLength(0);
      expect(factsFor(db, 'NoteAsOf', { asOf: '2026-10-06T00:00:00.000Z' })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });

  it('the clamp follows the ledger: a later write moves it, and a supersession keeps one current', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'));
      await remember(db, v, LEDGER, { subject: 'SynthMoving', predicate: 'database', object: 'PostgreSQL', source: 'poc' });
      insertNoteFact(db, 'NoteBetween', '2026-10-05T00:00:00.000Z');
      // The newest stamp is 2026-10-08T12:00Z, so a note dated 2026-10-20 is still in the future.
      insertNoteFact(db, 'NoteAfter', '2026-10-20T00:00:00.000Z');
      expect(factsFor(db, 'NoteAfter')).toHaveLength(0);
      vi.setSystemTime(Date.parse('2026-10-25T00:00:00Z'));
      // A correction moves the stamp past the note's content date, so the note is now current.
      await remember(db, v, LEDGER, { subject: 'SynthMoving', predicate: 'database', object: 'SQLite', source: 'poc' });
      const after = factsFor(db, 'NoteAfter') as any[];
      expect(after).toHaveLength(1);
      // ...and the correction is the only current lifecycle value.
      const moving = factsFor(db, 'SynthMoving') as any[];
      expect(moving).toHaveLength(1);
      expect(moving[0].object_text).toBe('SQLite');
    } finally {
      vi.useRealTimers();
    }
    db.close();
  });
});
