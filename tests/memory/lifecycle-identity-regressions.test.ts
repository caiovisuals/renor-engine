import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, replayLedger, factsFor } from '../../src/memory/lifecycle';
import type Database from 'better-sqlite3';

/**
 * Lifecycle subject-identity regressions (scout finding F3).
 *
 * All data is SYNTHETIC. The bug: `resolveLifecycleEntity` matched a subject with SQL
 * `canonical_name = ? COLLATE NOCASE`, which folds ASCII A–Z only and ignores the
 * Unicode normalization form. One person therefore became two lifecycle entities with
 * two OPEN currents (`José` / `JOSÉ`, `Пётр` / `пётр`, NFC vs NFD), the product promise
 * ("never repeat twice") failed, and the split survived a rebuild because the canonical
 * ledger records both spellings.
 *
 * The repair folds subject identity through one primitive: NFC + plain Unicode
 * lowercase, marks preserved, explicit aliases unified. The axis is stated, not
 * implied: case and normalization form close; accents/diacritics (`José`/`Jose`),
 * Greek tonos (`Αθήνα`/`Αθηνα`), `ё`/`е` (`Пётр`/`Петр`) and `ß`/`ss` stay distinct.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const tmpDirs: string[] = [];

function mkvault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-identity-'));
  tmpDirs.push(dir);
  return dir;
}

function freshDb(file: string): Database.Database {
  const db = openDb(file);
  runMigrations(db);
  return db;
}

function ledgerPath(vault: string): string {
  return path.join(vault, ...LEDGER.split('/'));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Lifecycle-owned entity spellings, in row order. */
function lifecycleSpellings(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT canonical_name FROM entities WHERE source_note = '_mcp_' ORDER BY id`,
  ).all() as Array<{ canonical_name: string }>).map(row => row.canonical_name);
}

/** Sorted current object values for a subject, read through the public reader. */
function currentObjects(db: Database.Database, subject: string): string[] {
  return (factsFor(db, subject) as Array<{ object_text: string }>)
    .map(fact => fact.object_text)
    .sort();
}

/**
 * A pre-fix split, written the way the old code left it: two lifecycle entities for one
 * identity, each with its own OPEN current value. Nothing reconciles this state in
 * place, so the repair has to handle it without guessing.
 */
function seedLegacySplit(
  db: Database.Database,
  entries: Array<{ spelling: string; predicate: string; object: string }>,
): number[] {
  db.prepare(
    `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
     VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-01-01T00:00:00.000Z', '{}')`,
  ).run();
  const ids: number[] = [];
  for (const entry of entries) {
    const row = db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
       VALUES ('concept', ?, '[]', '_mcp_', 1.0, '2026-01-01T00:00:00.000Z') RETURNING id`,
    ).get(entry.spelling) as { id: number };
    ids.push(row.id);
  }
  ids.forEach((id, index) => {
    const at = `2026-01-0${index + 1}T00:00:00.000Z`;
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, valid_to, updated_at, scope)
       VALUES (?, ?, ?, '_mcp_', 1.0, ?, NULL, ?, 'global')`,
    ).run(id, entries[index].predicate, entries[index].object, at, at);
  });
  return ids;
}

function writeLedger(vault: string, blocks: string[]): void {
  fs.mkdirSync(path.dirname(ledgerPath(vault)), { recursive: true });
  fs.writeFileSync(
    ledgerPath(vault),
    `---\ntype: memory-ledger\n---\n\n# Memory Events Ledger\n\n${blocks.join('\n')}`,
    'utf8',
  );
}

describe('lifecycle identity — case and normalization form close, accents do not', () => {
  it('supersedes instead of forking when the same person is written in another case or form', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));

    const first = await remember(db, vault, LEDGER, { subject: 'José', predicate: 'lives_in', object: 'Recife' });
    const second = await remember(db, vault, LEDGER, { subject: 'JOSÉ', predicate: 'lives_in', object: 'São Paulo' });

    expect(first.action).toBe('store');
    expect(second.action).toBe('supersede');
    expect(second.closed?.object).toBe('Recife');
    expect(lifecycleSpellings(db)).toEqual(['José']);
    expect(currentObjects(db, 'JOSÉ')).toEqual(['São Paulo']);
    // The other normalization form reads the same single identity.
    expect(currentObjects(db, 'José'.normalize('NFD'))).toEqual(['São Paulo']);
    expect(factsFor(db, 'José', { includeHistory: true })).toHaveLength(2);
    db.close();
  });

  it('closes an NFC/NFD pair written in the other order too', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));

    await remember(db, vault, LEDGER, { subject: 'José'.normalize('NFD'), predicate: 'lives_in', object: 'Recife' });
    const second = await remember(db, vault, LEDGER, { subject: 'José', predicate: 'lives_in', object: 'São Paulo' });

    expect(second.action).toBe('supersede');
    expect(lifecycleSpellings(db)).toHaveLength(1);
    expect(currentObjects(db, 'José')).toEqual(['São Paulo']);
    db.close();
  });

  it('closes case for non-Latin scripts (Cyrillic, Greek)', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));

    await remember(db, vault, LEDGER, { subject: 'Пётр', predicate: 'lives_in', object: 'Moscow' });
    const cyrillic = await remember(db, vault, LEDGER, { subject: 'пётр', predicate: 'lives_in', object: 'Petersburg' });
    await remember(db, vault, LEDGER, { subject: 'Αθήνα', predicate: 'population', object: '3M' });
    const greek = await remember(db, vault, LEDGER, { subject: 'αθήνα', predicate: 'population', object: '4M' });

    expect(cyrillic.action).toBe('supersede');
    expect(greek.action).toBe('supersede');
    expect(lifecycleSpellings(db)).toEqual(['Пётр', 'Αθήνα']);
    db.close();
  });

  it('unifies the explicit alias group on the write path', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));

    await remember(db, vault, LEDGER, { subject: 'Rowan', predicate: 'dog_name', object: 'Biscuit' });
    const aliased = await remember(db, vault, LEDGER, { subject: 'Rowan Vale', predicate: 'dog_name', object: 'Rex' });

    expect(aliased.action).toBe('supersede');
    expect(aliased.closed?.object).toBe('Biscuit');
    expect(lifecycleSpellings(db)).toEqual(['Rowan']);
    expect(currentObjects(db, 'Rowan Vale Holm')).toEqual(['Rex']);
    db.close();
  });

  // Negative controls: the fold must not over-merge. These pass before and after the
  // fix; they exist because a naive reuse of the repo's NFKD dedupe fold would merge
  // every pair below.
  it('keeps names that differ by an accent, tonos, letter or script apart', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));

    for (const [a, b] of [
      ['José', 'Jose'],
      ['Αθήνα', 'Αθηνα'],
      ['Пётр', 'Петр'],
      ['東京', '大阪'],
      ['🙂', '🎉'],
    ] as Array<[string, string]>) {
      const first = await remember(db, vault, LEDGER, { subject: a, predicate: 'label', object: `value for ${a}` });
      const second = await remember(db, vault, LEDGER, { subject: b, predicate: 'label', object: `value for ${b}` });
      expect(first.action, `${a} was already superseded`).toBe('store');
      expect(second.action, `${b} folded into ${a}`).toBe('store');
      expect(lifecycleSpellings(db)).toContain(a);
      expect(lifecycleSpellings(db)).toContain(b);
    }
    db.close();
  });
});

describe('legacy split state — refuse, disclose, never guess', () => {
  it('refuses a live write that would extend a conflicting split, publishing nothing', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));
    await remember(db, vault, LEDGER, { subject: 'Unrelated', predicate: 'noise', object: 'x' });
    seedLegacySplit(db, [
      { spelling: 'Пётр', predicate: 'city', object: 'Moscow' },
      { spelling: 'пётр', predicate: 'city', object: 'Petersburg' },
    ]);

    const before = fs.readFileSync(ledgerPath(vault), 'utf8');
    const factsBefore = db.prepare('SELECT count(*) AS c FROM facts').get() as { c: number };

    await expect(
      remember(db, vault, LEDGER, { subject: 'ПЁТР', predicate: 'city', object: 'Kazan' }),
    ).rejects.toThrow(/legacy identity ambiguity/i);

    // Fail closed means the canonical bytes never moved: no half-applied write.
    expect(fs.readFileSync(ledgerPath(vault), 'utf8')).toBe(before);
    expect(db.prepare('SELECT count(*) AS c FROM facts').get()).toEqual(factsBefore);
    expect(lifecycleSpellings(db)).toEqual(['Unrelated', 'Пётр', 'пётр']);
    db.close();
  });

  it('discloses both sides of a split on read instead of hiding one behind a pick', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));
    seedLegacySplit(db, [
      { spelling: 'José', predicate: 'lives_in', object: 'Recife' },
      { spelling: 'JOSÉ', predicate: 'lives_in', object: 'São Paulo' },
    ]);

    expect(currentObjects(db, 'José')).toEqual(['Recife', 'São Paulo']);
    expect(currentObjects(db, 'josé'.normalize('NFD'))).toEqual(['Recife', 'São Paulo']);
    db.close();
  });

  it('resolves a split deterministically when nothing conflicts, without forking a third identity', async () => {
    const vault = mkvault();
    const db = freshDb(path.join(vault, 'index.db'));
    const ids = seedLegacySplit(db, [
      // Different streams: no disagreement to preserve, so the write joins the lowest id.
      { spelling: 'Пётр', predicate: 'city', object: 'Moscow' },
      { spelling: 'пётр', predicate: 'country', object: 'Russia' },
    ]);

    const receipt = await remember(db, vault, LEDGER, { subject: 'ПЁТР', predicate: 'nickname', object: 'Peter' });
    expect(receipt.action).toBe('store');
    expect(lifecycleSpellings(db)).toEqual(['Пётр', 'пётр']);
    const row = db.prepare(`SELECT subject_entity_id AS id FROM facts WHERE predicate = 'nickname'`).get() as { id: number };
    expect(row.id).toBe(ids[0]);
    db.close();
  });

  it('reconciles a ledger that already recorded both spellings, in canonical event order', async () => {
    const vault = mkvault();
    writeLedger(vault, [
      `## MEM_IDA0001 · 2026-01-01T00:00:00.000Z\n- kind: store\n- subject: José\n- predicate: lives_in\n- object: Recife\n- source: fixture\n`,
      `## MEM_IDA0002 · 2026-01-02T00:00:00.000Z\n- kind: store\n- subject: JOSÉ\n- predicate: lives_in\n- object: São Paulo\n- source: fixture\n`,
    ]);
    const db = freshDb(path.join(vault, 'index.db'));

    // A pre-fix ledger must still replay: the split it records reconciles by event
    // position instead of throwing the monotonicity error at service startup.
    await expect(replayLedger(db, vault, LEDGER)).resolves.toBe(2);
    expect(lifecycleSpellings(db)).toEqual(['José']);
    expect(currentObjects(db, 'José')).toEqual(['São Paulo']);
    const history = factsFor(db, 'José', { includeHistory: true }) as Array<{ valid_to: string | null }>;
    expect(history).toHaveLength(2);
    expect(history.filter(fact => fact.valid_to === null)).toHaveLength(1);

    // Replaying again is a no-op: entity and fact counts do not drift.
    await expect(replayLedger(db, vault, LEDGER)).resolves.toBe(0);
    expect(lifecycleSpellings(db)).toEqual(['José']);
    expect(factsFor(db, 'José', { includeHistory: true })).toHaveLength(2);
    db.close();
  });
});
