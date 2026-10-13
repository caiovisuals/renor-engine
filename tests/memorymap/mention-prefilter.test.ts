import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { buildMemoryMap, type MemoryMapContext, type MapLink } from '../../src/memorymap/memoryMap';

// The reference is the old, literal /iu mention contract. The prefilter may reject only
// definite misses; names, Unicode boundaries, ordering and capped links must stay identical.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reference = (name: string, text: string) =>
  name.trim().length >= 3 &&
  new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(name.trim())}($|[^\\p{L}\\p{N}_])`, 'iu').test(text);

describe('memory-map mention prefilter', () => {
  let vault: string;
  let db: Database.Database;
  let ctx: MemoryMapContext;
  const at = '2026-10-07T12:00:00.000Z';

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'map-mentions-'));
    db = openDb(path.join(vault, '.memory-index', 'index.db'));
    runMigrations(db);
    ctx = { db, memoryDir: vault, ledgerRelPath: DEFAULT_LEDGER_REL, indexOptions: {} };
    db.prepare('INSERT INTO notes (path, title, note_hash, modified_at) VALUES (?, ?, ?, ?)').run(
      '_mcp_',
      'Lifecycle',
      '',
      at,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });
  function seed(names: string[], objects: string[]) {
    const entity = db.prepare(
      'INSERT INTO entities (type, canonical_name, source_note, updated_at) VALUES (?, ?, ?, ?)',
    );
    const fact = db.prepare(
      'INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, valid_from, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    db.transaction(() => {
      names.forEach((name, i) => {
        const id = entity.run('concept', name, '_mcp_', at).lastInsertRowid;
        fact.run(id, 'mentions', objects[i % objects.length], '_mcp_', at, at);
      });
    })();
  }
  async function note(text: string) {
    fs.writeFileSync(path.join(vault, 'fixture.md'), `# Fixture\n\n${text}`);
    await indexVault(db, vault, {});
  }

  it('keeps the regex semantics and ordered links for Unicode folds, boundaries and overlapping names', async () => {
    const names = [
      'Kelvin',
      'case',
      'KSS',
      'İstanbul',
      'Straße',
      'ẞeta',
      'ΟΣ',
      'ος',
      'CAFÉ',
      'café',
      'Plan',
      'Plan A',
      'a.b',
      'foo_bar',
      'C++',
      'ab',
      '東京駅',
      '𐐀𐐁𐐂',
      ' absent ',
    ];
    const text =
      'KELVIN caſe Kſſ İSTANBUL STRAẞE ßETA ος ΟΣ Café CAFÉ Plan A, a.b foo_bar C++; ' +
      'xKelvin Kelvinx _Kelvin Kelvin_ 7Kelvin Kelvin7 éKelvin Kelviné ' +
      '東京駅 𐐨𐐩𐐪 Plan\u0301. Does not say the last subject.';
    seed(names, [text, 'Plan A works with Kelvin, caſe, ẞeta and 𐐨𐐩𐐪']);
    await note(text);
    const map = await buildMemoryMap(ctx, { limit: 1000 });
    const wanted: MapLink[] = [];
    for (const thing of map.things) {
      if (reference(thing.name, `Fixture\n# Fixture\n\n${text}`)) {
        wanted.push({ source: 'note:fixture.md', target: thing.id, kind: 'mention' });
      }
    }
    const seen = new Set<string>();
    for (const fact of map.facts) {
      for (const thing of map.things) {
        const key = `${fact.thingId}|${thing.id}|${fact.predicate}`;
        if (thing.id === fact.thingId || !reference(thing.name, fact.object) || seen.has(key))
          continue;
        seen.add(key);
        wanted.push({
          source: fact.thingId,
          target: thing.id,
          kind: 'fact',
          label: fact.predicate,
        });
      }
    }
    expect(map.links).toEqual(wanted);
    expect(wanted.some((l) => l.target === map.things.find((t) => t.name === 'Kelvin')!.id)).toBe(
      true,
    );
    expect(wanted.some((l) => l.target === map.things.find((t) => t.name === 'case')!.id)).toBe(
      true,
    );
  });

  it('does not run a Unicode regex for every absent ASCII subject on every memory and fact', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `absent-subject-${i}`);
    seed(names, ['The fixture has no named subjects.']);
    await note('The fixture has no named subjects.');
    let testedSubjects = 0;
    const test = RegExp.prototype.test;
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, text: string) {
      if (this.source.includes('absent-subject-')) testedSubjects++;
      return test.call(this, text);
    });
    const map = await buildMemoryMap(ctx);
    expect(map.links).toEqual([]);
    expect(testedSubjects).toBe(0); // old path: 100 + 100 * 99 regex scans
  });

  it('checks each boundary independently, including a later whole-word occurrence', async () => {
    const names = ['Kelvin', 'case', 'Plan A', 'a.b', '東京駅', '𐐀𐐁𐐂'];
    const texts = [
      'Kelvin',
      'Kelvin',
      'caſe',
      'xKelvin',
      'Kelvinx',
      '_Kelvin',
      'Kelvin_',
      '7Kelvin',
      'Kelvin7',
      'éKelvin',
      'Kelviné',
      'Kelvin\u0301',
      '\u0301Kelvin',
      'İKelvin',
      'Kelvinİ',
      'Plan A',
      'Plan AB',
      'a.b',
      'aXb',
      '東京駅',
      '東京駅前',
      '𐐨𐐩𐐪',
      '𐐨𐐩𐐪𐐨',
      'xKelvin; Kelvin',
      'xcaſe; caſe',
    ];
    seed(names, ['Nothing is mentioned here.']);
    texts.forEach((text, i) =>
      fs.writeFileSync(path.join(vault, `case-${i}.md`), `# Fixture ${i}\n\n${text}`),
    );
    await indexVault(db, vault, {});
    const map = await buildMemoryMap(ctx, { limit: 1000 });
    const expected: MapLink[] = [];
    for (const memory of map.memories) {
      const i = Number(memory.path.match(/case-(\d+)/)![1]);
      for (const thing of map.things) {
        if (reference(thing.name, texts[i]))
          expected.push({ source: memory.id, target: thing.id, kind: 'mention' });
      }
    }
    expect(map.links).toEqual(expected);
  });

  it('preserves the link cap and the earliest links when every subject is present', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `Subject-${i}`);
    const text = names.join(', ');
    seed(names, [text]);
    await note(text);
    const map = await buildMemoryMap(ctx, { limit: 20_000 });
    const expected: MapLink[] = map.things.map((t) => ({
      source: 'note:fixture.md',
      target: t.id,
      kind: 'mention',
    }));
    for (const f of map.facts)
      for (const t of map.things) {
        if (t.id !== f.thingId)
          expected.push({ source: f.thingId, target: t.id, kind: 'fact', label: 'mentions' });
      }
    expect(map.links).toEqual(expected.slice(0, 20_000));
    expect(map.truncated.links).toBe(true);
  });
});
