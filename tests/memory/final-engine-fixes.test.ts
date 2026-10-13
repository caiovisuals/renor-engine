import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { remember, factsFor, resolveLedgerPath, appendLedgerEvent, replayLedger } from '../../src/memory/lifecycle';

/**
 * Old queued Sol findings, closed in one bounded pass (no new features):
 *
 * S1.1 — toCanonicalInstant previously accepted timezone-less datetimes
 *   (e.g. '2026-09-09T00:30:00'), whose interpretation depended on the HOST
 *   timezone. Now datetime input must carry an explicit timezone (Z or a
 *   numeric ±HH:MM offset); date-only YYYY-MM-DD stays deterministic
 *   (UTC midnight per ISO 8601). Identical outcomes are proven under
 *   TZ=UTC and TZ=America/Sao_Paulo by running this file under both.
 *
 * S2.1 — resolveLedgerPath previously rejected anything whose resolved
 *   relative path merely STARTED WITH '..' — wrongly rejecting harmless
 *   in-vault names like '..safe/ledger' or '..ledger.md'. Escape detection
 *   now matches an actual parent component ('..' exactly or '../…'); all
 *   traversal defenses are preserved.
 */

describe('S1.1: timezone-less datetime input is rejected; zoned instants normalize deterministically', () => {
  let db: Database.Database;
  let vault: string;
  const dirs: string[] = [];

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 's11-vault-'));
    dirs.push(vault);
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('rejects timezone-less datetimes with a clear error, never a TZ-dependent instant', async () => {
    // the subject must exist so the failure is the asOf policy, not lookup
    await remember(db, vault, 'System/Memory Events Ledger.md',
      { subject: 'S11r', predicate: 'p', object: 'v' });
    expect(() => factsFor(db, 'S11r', { asOf: '2026-09-09T00:30:00' }))
      .toThrow(/explicit timezone|timezone-less/i);
    expect(() => factsFor(db, 'S11r', { asOf: '2026-09-09T00:30' }))
      .toThrow(/explicit timezone|timezone-less/i);
    expect(() => factsFor(db, 'S11r', { asOf: 'not-a-date' })).toThrow(/timestamp/i);
  });

  it('zoned instants (Z, ±HH:MM) are accepted and normalize identically, regardless of host TZ', async () => {
    const r1 = await remember(db, vault, 'System/Memory Events Ledger.md',
      { subject: 'S11', predicate: 'p1', object: 'first' });
    const r2 = await remember(db, vault, 'System/Memory Events Ledger.md',
      { subject: 'S11', predicate: 'p1', object: 'second' });
    const first = r1.created!.validFrom; // canonical ...Z instant
    expect(first.endsWith('Z')).toBe(true);
    expect(r2.created!.validFrom > first).toBe(true);

    // same instant, two spellings: Z and a -03:00 offset (local component =
    // instant shifted INTO the UTC-3 zone: local = UTC - 3h)
    const epoch = Date.parse(first);
    const offsetForm = new Date(epoch - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
    expect(offsetForm).toMatch(/-03:00$/);
    const viaZ = factsFor(db, 'S11', { asOf: first }) as any[];
    const viaOffset = factsFor(db, 'S11', { asOf: offsetForm }) as any[];
    expect(viaOffset.map(f => f.object_text)).toEqual(viaZ.map(f => f.object_text));

    // seconds-only and millisecond-precision zoned forms are accepted too
    expect(() => factsFor(db, 'S11', { asOf: first.replace(/\.\d{3}Z$/, 'Z') })).not.toThrow();
    // offset with seconds included is accepted
    const offsetWithSeconds = offsetForm.replace(/(-03:00)$/, ':00$1');
    expect(() => factsFor(db, 'S11', { asOf: offsetWithSeconds.slice(0, -9) + offsetForm.slice(-9) })).not.toThrow();
  });

  it('date-only input remains deterministic: UTC midnight by ISO 8601', async () => {
    await remember(db, vault, 'System/Memory Events Ledger.md',
      { subject: 'S11d', predicate: 'p', object: 'v' });
    const viaDateOnly = factsFor(db, 'S11d', { asOf: '2030-01-01' }) as any[];
    const viaUtcMidnight = factsFor(db, 'S11d', { asOf: '2030-01-01T00:00:00.000Z' }) as any[];
    expect(viaDateOnly.map((f: any) => f.object_text))
      .toEqual(viaUtcMidnight.map((f: any) => f.object_text));
    expect(viaDateOnly.length).toBe(1);
  });
});

describe('S2.1: resolveLedgerPath rejects actual parent escapes, keeps harmless in-vault names', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 's21-vault-'));
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('harmless names that merely start with ".." resolve inside the vault', () => {
    // '..safe/ledger' and '..ledger' are literal in-vault names, NOT escapes
    const a = resolveLedgerPath(vault, '..safe/ledger');
    expect(a).toBe(path.resolve(vault, '..safe', 'ledger.md'));
    const b = resolveLedgerPath(vault, '..ledger');
    expect(b).toBe(path.resolve(vault, '..ledger.md'));
    const c = resolveLedgerPath(vault, 'sub/../ledger'); // resolves inside
    expect(c).toBe(path.resolve(vault, 'ledger.md'));
  });

  it('all traversal defenses are preserved: real parent components and absolutes fail closed', () => {
    expect(() => resolveLedgerPath(vault, '../outside/ledger')).toThrow(/escape|vault root/i);
    expect(() => resolveLedgerPath(vault, 'a/../../outside')).toThrow(/escape|vault root/i);
    expect(() => resolveLedgerPath(vault, 'a/../../outside/ledger.md')).toThrow(/escape|vault root/i);
    expect(() => resolveLedgerPath(vault, '/etc/ledger')).toThrow(/absolute|vault-relative/i);
    expect(() => resolveLedgerPath(vault, '')).toThrow(/escape|vault root/i);
    // '..safe' followed by a REAL parent component still fails closed:
    expect(() => resolveLedgerPath(vault, '..safe/../../outside')).toThrow(/escape|vault root/i);
  });

  it('append and replay through a ".."-prefixed safe name stay inside the vault', async () => {
    const db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    const rel = '..safe/ledger';
    const ev = {
      id: 'mem_s21001',
      at: '2026-09-09T00:00:00.000Z',
      kind: 'store' as const,
      subject: 'S21', predicate: 'p', object: 'in-vault', source: 'test',
      closedEvent: null,
    };
    await appendLedgerEvent(vault, rel, ev);
    const resolved = path.resolve(vault, '..safe', 'ledger.md');
    expect(fs.existsSync(resolved)).toBe(true);          // written INSIDE the vault
    const replayed = await replayLedger(db, vault, rel);
    expect(replayed).toBe(1); // the in-vault ".." -prefixed ledger replayed
    const facts = factsFor(db, 'S21') as any[];
    expect(facts.map(f => f.object_text)).toEqual(['in-vault']);
    db.close();
  });
});