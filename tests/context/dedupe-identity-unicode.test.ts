import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { LocalRulesDecisionModel } from '../../src/extraction/decision-model';
import {
  normDedupeValue,
  dedupeKeyFor,
  insertStructuredRows,
  readCurrentRowsForNotes,
  type NewStructuredRow,
} from '../../src/context/rowStore';
import { tmpPath } from '../helpers/tmpPath';

/**
 * Dedupe identity must survive every script.
 *
 * Reported bug: `normDedupeValue` stripped `[^\x20-\x7E]` and then re-stripped
 * with `[^a-z0-9]`, so every non-Latin character was deleted before the identity
 * key was built. Two distinct memories written in Chinese, Japanese, Cyrillic,
 * Greek, Arabic, Hebrew or Devanagari therefore shared ONE dedupe identity, and
 * the default adjudicator (`decision-model.ts`) called them `identical` — so an
 * unrelated fact superseded, or was folded into the confirm_count of, an
 * unrelated fact. Silent data loss for any non-Latin writer.
 *
 * Contract asserted here:
 *   1. letters and numbers from EVERY script are identity-bearing;
 *   2. ASCII behaviour is byte-identical to the pre-fix implementation;
 *   3. Latin diacritics still fold after NFKD (`Café` → `cafe`);
 *   4. a value with no letters or numbers is unaffected, because the fix is
 *      strictly "stop deleting letters and numbers" — see the documented
 *      residual below;
 *   5. a normalized identity can never contain the `|` field separator or the
 *      NUL group separator, so joined keys stay unambiguous.
 */

const DB_PATH = tmpPath('test-dedupe-identity-unicode.db');

afterEach(() => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

/** The pre-fix implementation, kept as the oracle for requirement (2). */
function legacyNormDedupeValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

describe('dedupe identity is script-preserving (non-Latin memories must not collide)', () => {
  it('reported bug: two distinct non-Latin values no longer share one identity', () => {
    // Pre-fix, EVERY pair below produced the SAME key — the empty string:
    //   猫が好きです -> ""   |   犬が好きです -> ""
    const pairs: Array<[string, string, string]> = [
      ['猫が好きです', '犬が好きです', 'Japanese'],
      ['私は東京に住んでいます', '私は大阪に住んでいます', 'Japanese (city)'],
      ['我喜欢猫', '我喜欢狗', 'Chinese'],
      ['Москва', 'Санкт-Петербург', 'Cyrillic'],
      ['Αθήνα', 'Θεσσαλονίκη', 'Greek'],
      ['القاهرة', 'دبي', 'Arabic'],
      ['דובר עברית', 'דובר יוונית', 'Hebrew'],
      ['मुझे चाय पसंद है', 'मुझे कॉफ़ी पसंद है', 'Devanagari'],
    ];
    for (const [a, b, label] of pairs) {
      const [ka, kb] = [normDedupeValue(a), normDedupeValue(b)];
      expect(ka, `${label}: ${a} normalized to an empty identity`).not.toBe('');
      expect(kb, `${label}: ${b} normalized to an empty identity`).not.toBe('');
      expect(ka, `${label}: distinct values collided`).not.toBe(kb);
    }
  });

  it('keeps each script distinct from the others (mixed scripts in one string)', () => {
    expect(normDedupeValue('東京 2024 Москва Αθήνα')).toBe('東京 2024 москва αθη\u0301να');
    // Visually identical Cyrillic/Latin skeletons are different identities.
    expect(normDedupeValue('Москва 2024')).not.toBe(normDedupeValue('Μосква 2024'));
    // Same ASCII skeleton, different script.
    expect(normDedupeValue('猫cat')).not.toBe(normDedupeValue('犬cat'));
    expect(normDedupeValue('Tokyo 2024')).not.toBe(normDedupeValue('東京 2024'));
    // Only the script differs.
    expect(normDedupeValue('東京 2024')).not.toBe(normDedupeValue('大阪 2024'));
  });

  it('non-Latin letters plus an ASCII number: the number alone is not the identity', () => {
    // Pre-fix both sides of each pair collapsed to just the surviving digits:
    //   '東京 2024' -> "2024"   |  '大阪 2024' -> "2024"
    expect(normDedupeValue('東京 2024')).toBe('東京 2024');
    expect(normDedupeValue('Москва 3:45')).toBe('москва 3 45');
    expect(normDedupeValue('東京 2024')).not.toBe(normDedupeValue('大阪 2024'));
    expect(normDedupeValue('कीमत 500')).not.toBe(normDedupeValue('वजन 500'));
  });

  it('Latin diacritics are unchanged: NFKD folds combining marks, keeps the ASCII letters', () => {
    expect(normDedupeValue('  Café  LATE ')).toBe('cafe late');
    expect(normDedupeValue('Café')).toBe('cafe');
    expect(normDedupeValue('cafe')).toBe('cafe');
    expect(normDedupeValue('ệ')).toBe('e');
    expect(normDedupeValue('  naïve  coöperate  ')).toBe('naive cooperate');
    // The fold is scoped to a LATIN base letter, so Greek keeps its tonos (which
    // is a letter modifier, not an accent on a Latin letter): 'Αθήνα' stays
    // distinct from the unaccented 'Αθηνα' rather than merging with it. The
    // identity is the NFKD-derived spelling, so the tonos is the combining mark
    // U+0301, written escaped here because it renders identically to the
    // precomposed form.
    expect(normDedupeValue('Αθήνα')).toBe('αθη\u0301να');
    expect(normDedupeValue('Αθήνα')).not.toBe(normDedupeValue('Αθηνα'));
  });

  it('combining marks that ARE letters in their script are preserved, not folded away', () => {
    // NFKD moves a diacritic into a combining mark, so a blanket `\p{M}` strip
    // looks correct on Latin but DELETES letters in other scripts, merging
    // meaning-changing pairs in scripts this bug report names. Measured, and
    // pinned here so the fold can never silently widen back to `\p{M}`:
    for (const [a, b, label] of [
      ['が', 'か', 'Japanese dakuten (ga vs ka)'],
      ['ぱ', 'は', 'Japanese handakuten (pa vs ha)'],
      ['で', 'て', 'Japanese dakuten (de vs te)'],
      ['की', 'क', 'Devanagari vowel sign (matra)'],
      ['मिल', 'मील', 'Devanagari vowel length'],
      ['น้ำ', 'นำ', 'Thai vowel/tone marks'],
      ['שָׁלוֹם', 'שלום', 'Hebrew niqqud is preserved'],
    ] as Array<[string, string, string]>) {
      expect(normDedupeValue(a), `${label}: ${a} was folded into ${b}`)
        .not.toBe(normDedupeValue(b));
      expect(normDedupeValue(a), `${label}: ${a} normalized to empty`).not.toBe('');
    }
    // Same script, no marks at all: unchanged.
    expect(normDedupeValue('マラソン')).toBe('マラソン');
    expect(normDedupeValue('मैराथन')).not.toBe(normDedupeValue('मराठन'));
  });

  it('precomposed and decomposed spellings of the same text agree (stable identity)', () => {
    // 'が' is U+304C; its canonical decomposition is U+304B U+3099. Both spellings
    // of the same character must produce the same identity.
    expect(normDedupeValue('が')).toBe(normDedupeValue('\u304b\u3099'));
    expect(normDedupeValue('Café')).toBe(normDedupeValue('Cafe\u0301'));
    expect(normDedupeValue(normDedupeValue('が'))).toBe(normDedupeValue('が'));
  });

  it('non-ASCII Latin letters that NFKD cannot fold are kept, not deleted', () => {
    // Pre-fix these were deleted outright, so 'Bø' collided with 'B' — the same
    // defect, one script over (letters deleted instead of preserved).
    expect(normDedupeValue('Bø')).toBe('bø');
    expect(normDedupeValue('Bø')).not.toBe(normDedupeValue('B'));
    expect(normDedupeValue('straße')).toBe('straße');
    // 'ł' has no NFKD fold and is kept; 'ó'/'ź' DO fold (Latin base letter).
    expect(normDedupeValue('łódź')).toBe('łodz');
  });

  it('documented: a value with no letters or numbers keeps its pre-existing empty identity', () => {
    // The fix is strictly "stop deleting LETTERS and NUMBERS from every script".
    // Punctuation, symbols and emoji are separators, exactly as `.replace(/[^a-z0-9]+/g,' ')`
    // already made them for ASCII, so a content-free value still normalizes to ''.
    // That is UNCHANGED from pre-fix behaviour — see the residual note below.
    for (const s of ['!!!', '???', '...', '///', '$$$', '  -_-  ', '\u00a7\u00b6\u2020']) {
      expect(normDedupeValue(s), `${JSON.stringify(s)} changed identity`).toBe('');
    }
    // An emoji is a separator when the value also carries letters/numbers — it
    // does not silently glue the surrounding words together, and が keeps its
    // dakuten (U+3099) rather than folding to か.
    expect(normDedupeValue('猫😀が好き')).toBe('猫 か\u3099好き');
    expect(normDedupeValue('😀猫')).toBe('猫');
  });

  it('documented RESIDUAL (pre-existing, unchanged, filed separately): distinct letter-free values still share one identity', () => {
    // This is a real collision that this fix deliberately does NOT close,
    // because closing it would change ASCII identity semantics (a value like
    // '!!!' currently keys on '') and that is a separate decision. Pinned here
    // so any future change to it is deliberate rather than accidental.
    expect(normDedupeValue('!!!')).toBe(normDedupeValue('???'));
    expect(normDedupeValue('😀')).toBe(normDedupeValue('🚀'));
    expect(normDedupeValue('!!!')).toBe('');
    // Empty and whitespace-only input are the same case, and are unchanged.
    expect(normDedupeValue('')).toBe('');
    expect(normDedupeValue('   ')).toBe('');
    expect(normDedupeValue('\n\t ')).toBe('');
  });

  it('identity keys can never smuggle the key grammar separators', () => {
    // `dedupeKeyFor` joins fields with `|`; `detectFactConflicts` joins groups
    // with NUL. A normalized identity must not be able to forge either.
    const hostile = ['a|b', '!!!|!!!', 'x\u0000y', '!!!\u0000!!!', '😀|😀', 'a\u0001b', '東|京', '東\u0000京'];
    for (const s of hostile) {
      const n = normDedupeValue(s);
      expect(n, `${JSON.stringify(s)} leaked the field separator`).not.toContain('|');
      expect(n, `${JSON.stringify(s)} leaked the group separator`).not.toContain('\u0000');
    }
    // The identity alphabet is letters, numbers, combining marks and spaces —
    // never a key-grammar separator.
    for (const s of ['東京', 'Café', 'A/B  Test', 'cat😀dog', 'Μосква', 'が', 'की']) {
      expect(normDedupeValue(s)).toMatch(/^[\p{L}\p{N}\p{M} ]*$/u);
    }
  });

  it('documented: a lone combining mark is its own identity; a letter-free value is empty', () => {
    // A mark with no base letter is not folded (there is no Latin base to fold
    // onto), so it stays identity-bearing rather than collapsing to ''.
    expect(normDedupeValue('\u0301')).toBe('\u0301');
    expect(normDedupeValue('\u0301')).not.toBe('');
  });

  it('ASCII behaviour is byte-identical to the pre-fix implementation, with no exception', () => {
    // Requirement (2): the fix must not move ANY ASCII identity.
    const asciiCorpus = [
      '', '   ', 'a', 'A', 'A/B  Test', 'a/b test', '3:45', '3 45',
      'Marathon Time!', 'marathon time', 'Fact #1 (2024)', 'fact 1 2024',
      'x_y-z', 'x y z', 'foo---bar', 'foo bar', 'a.b,c;d', 'a b c d',
      '  leading', 'trailing  ', 'MiXeD CaSe 123', 'mixed case 123',
      '100%', '100', 'v1.2.3', 'v1 2 3', 'user@example.com', 'user example com',
      'C++', 'c', 'a1b2', '!!', '??', '...', '///', '$$$', '  -_-  ',
      '\u0000', '\u0001\u0002', 'a\u0000b', 'a|b',
    ];
    // Proof the corpus is ASCII-only, so the property is actually about ASCII.
    expect(asciiCorpus.every((s) => /^[\x00-\x7F]*$/.test(s))).toBe(true);
    expect(asciiCorpus.length).toBeGreaterThan(35);
    for (const s of asciiCorpus) {
      expect(normDedupeValue(s), `ASCII identity moved for ${JSON.stringify(s)}`)
        .toBe(legacyNormDedupeValue(s));
    }
    // The one input class that could have moved silently, asserted explicitly:
    // legacy STRIPPED ASCII control characters (they sit outside 0x20-0x7E, so it
    // glued their neighbours). The fix removes `\p{C}` for the same reason, so
    // these keep their legacy identity too — no exception, named here so the
    // contract stays honest.
    for (const [input, expected] of [
      ['a\u0000b', 'ab'], ['a\u0001b', 'ab'], ['a\nb', 'ab'], ['a\tb', 'ab'],
      ['\u0000', ''], ['\u0001\u0002', ''], ['\u007f', ''],
      ['東\u200d京', '東京'],
    ] as Array<[string, string]>) {
      expect(normDedupeValue(input), `control-character identity moved for ${JSON.stringify(input)}`)
        .toBe(expected);
      if (input.charCodeAt(0) < 0x80) {
        expect(normDedupeValue(input)).toBe(legacyNormDedupeValue(input));
      }
    }
    // Latin diacritics NFKD-fold to ASCII, so they keep their legacy identity
    // too — this is requirement (2)'s named case.
    for (const s of ['  Café  LATE ', 'Café', 'cafe', 'naïve', 'coöperate']) {
      expect(normDedupeValue(s), `folded identity moved for ${JSON.stringify(s)}`)
        .toBe(legacyNormDedupeValue(s));
    }
  });

  it('dedupeKeyFor separates memories whose ASCII skeleton is identical', () => {
    const row = (value: string, object: string): NewStructuredRow => ({
      rowKind: 'fact',
      sourcePath: 'notes/a.md',
      sourceChunkId: 1,
      sourceHash: 'h',
      extractionVersion: 'v1',
      validFrom: '2024-03-01',
      payload: { value, object },
    });
    // The sharpest form of the bug: the SAME ASCII value, two different
    // non-Latin objects. Pre-fix both produced the key `fact|3 45|`.
    const kA = dedupeKeyFor(row('3:45', '東京マラソン'));
    const kB = dedupeKeyFor(row('3:45', '大阪マラソン'));
    expect(kA).not.toBe(kB);
    expect(kA).toBe('fact|3 45|東京マラソン');
    expect(kB).toBe('fact|3 45|大阪マラソン');
    // Same non-Latin value, different objects.
    expect(dedupeKeyFor(row('вес', 'собаки'))).not.toBe(dedupeKeyFor(row('вес', 'кота')));
    // Genuinely identical content is still one identity (accent/case folded).
    expect(dedupeKeyFor(row('3:45', '  Marathon Time! '))).toBe(dedupeKeyFor(row('3:45', 'marathon time')));
  });
});

describe('non-Latin memories must not supersede or be adjudicated identical to each other', () => {
  function freshDbWithTwoNotes(): ReturnType<typeof openDb> {
    const db = openDb(DB_PATH);
    runMigrations(db);
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('notes/a.md', 'A', 'note', 'ha', '2024-03-01', '{"session_date": "2024-03-01"}'),
              ('notes/b.md', 'B', 'note', 'hb', '2024-03-02', '{"session_date": "2024-03-02"}')`,
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
       VALUES (1, 'notes/a.md', '', 'text', 1, 1, 1, 'c1'),
              (2, 'notes/b.md', '', 'text', 2, 2, 1, 'c2')`,
    ).run();
    return db;
  }

  const factRow = (over: Partial<NewStructuredRow>): NewStructuredRow => ({
    rowKind: 'fact',
    sourcePath: 'notes/a.md',
    sourceChunkId: 1,
    sourceHash: 'h',
    extractionVersion: 'extractor-v1',
    validFrom: '2024-03-01',
    payload: { value: '3:45', object: 'marathon time' },
    ...over,
  });

  it('a second, unrelated Chinese fact does not close the first one', () => {
    const db = freshDbWithTwoNotes();
    try {
      // Same ASCII value on purpose: only the non-Latin object distinguishes
      // these two memories, which is exactly the reported case.
      insertStructuredRows(db, [factRow({ payload: { value: '3:45', object: '东京马拉松' } })]);
      insertStructuredRows(db, [
        factRow({
          sourcePath: 'notes/b.md',
          sourceChunkId: 2,
          validFrom: '2024-03-02',
          payload: { value: '3:45', object: '大阪马拉松' },
        }),
      ]);
      // Pre-fix both rows shared dedupe_key `fact|3 45|`, so the second
      // superseded the first: one row stayed current and the first fact was lost.
      const current = readCurrentRowsForNotes(db, ['notes/a.md', 'notes/b.md']);
      expect(current.length, 'distinct non-Latin facts collapsed into one identity').toBe(2);
      expect(current.map((r) => (r.payload as { object: string }).object))
        .toEqual(expect.arrayContaining(['东京马拉松', '大阪马拉松']));
    } finally {
      db.close();
    }
  });

  it('the default adjudicator calls two distinct non-Latin facts distinct, never identical', () => {
    // Pre-fix `norm` deleted every non-Latin character, so both sides compared
    // equal and the write path answered `identical` — the candidate was folded
    // into the existing row's confirm_count instead of ever being stored.
    expect(
      LocalRulesDecisionModel.adjudicate(
        { value: '3:45', object: '大阪马拉松' },
        { value: '3:45', object: '东京马拉松' },
        'fact',
      ),
    ).toBe('distinct');

    // Same identity, still `identical` — the Latin path is unchanged.
    expect(
      LocalRulesDecisionModel.adjudicate(
        { value: '3:45', object: '  Marathon Time! ' },
        { value: '3:45', object: 'marathon time' },
        'fact',
      ),
    ).toBe('identical');

    // Cyrillic (facts) and Devanagari (events) — different payload fields.
    expect(
      LocalRulesDecisionModel.adjudicate(
        { value: '1', object: 'вес кота' },
        { value: '1', object: 'вес собаки' },
        'fact',
      ),
    ).toBe('distinct');
    expect(
      LocalRulesDecisionModel.adjudicate(
        { when: 'सोमवार', event: 'दौड़' },
        { when: 'सोमवार', event: 'तैराकी' },
        'event',
      ),
    ).toBe('distinct');
    // Preferences (statement IS the identity).
    expect(
      LocalRulesDecisionModel.adjudicate(
        { statement: '私はコーヒーが好きです。' },
        { statement: '私はお茶が好きです。' },
        'preference',
      ),
    ).toBe('distinct');
  });
});
