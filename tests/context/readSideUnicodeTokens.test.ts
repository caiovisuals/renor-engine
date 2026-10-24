import Database from '../../src/db/sqlite';
import { runMigrations } from '../../src/db/schema';
import { describe, expect, it } from 'vitest';
import {
  composeQueryContext,
  filterRowsByQueryTerms,
  type ComposerInput,
} from '../../src/context/composer';
import {
  assessAbstention,
  contentTerms,
  evidenceCoverage,
  querySubjects,
} from '../../src/context/readHonesty';
import { splitWords, type StoredStructuredRow } from '../../src/context/rowStore';
import type { RetrievalHit } from '../../src/retrieval/orchestrator';

/**
 * The read side split queries on ASCII (`[^a-z0-9]`) while the write side
 * already used the Unicode rule (`[^\p{L}\p{N}\p{M}]`, rowStore.normDedupeValue)
 * and the lifecycle-fact index already used one too (factTerms.tokens). So a
 * fact stored with accented or non-Latin words lost part of its identity the
 * moment it was read back: an ASCII-only split deletes every non-ASCII letter,
 * and for a word that is *entirely* non-ASCII the word is gone, not merely
 * shortened. Everything asserted here is reachable from the shipped read
 * surface (composeQueryContext / filterRowsByQueryTerms / contentTerms).
 */

function hit(notePath: string, text: string, score = 0.5): RetrievalHit {
  return { notePath, chunkId: 1, headingPath: '', text, score, reason: 'semantic' };
}

let nextId = 1;
function row(
  rowKind: StoredStructuredRow['rowKind'],
  payload: StoredStructuredRow['payload'],
  validFrom: string,
): StoredStructuredRow {
  return {
    id: nextId++,
    rowKind,
    sourcePath: 'notes/a.md',
    sourceChunkId: 1,
    sourceHash: 'h',
    extractionVersion: 'v1',
    validFrom,
    dedupeKey: `k${nextId}`,
    payload,
  } as StoredStructuredRow;
}

function prefsSectionText(rows: StoredStructuredRow[], query: string): string[] {
  const input: ComposerInput = { query, hits: [hit('notes/a.md', 'text')], rows };
  const composed = composeQueryContext(input, { env: {} as NodeJS.ProcessEnv });
  const section = composed.sections.find((s) => s.name === 'prefs');
  if (!section?.included) return [];
  return section.text.split('\n').filter((line) => line.startsWith('- '));
}

function entityDb(names: Array<[string, string[]]>): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO notes (path, title, kind, note_hash, modified_at)
     VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', '2026-01-01')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
     VALUES ('concept', ?, ?, '_mcp_', 1.0, '2026-01-01')`,
  );
  for (const [name, aliases] of names) insert.run(name, JSON.stringify(aliases));
  return db;
}

describe('read-side query tokenization keeps non-Latin words', () => {
  it('ranks the accented row above a row that only shares its ASCII skeleton', () => {
    // "café" survives an ASCII split as "caf", and substring matching then
    // credits every row containing those three letters. The decoy holds "caf"
    // three times, so it outscores the row that actually answers the question.
    // Under the Unicode rule "café" is one term only the target has.
    const target = row('preference', { statement: 'bebo café depois do almoço', kind: 'bebida' }, '2024-01-01');
    const decoy = row('preference', { statement: 'cafeteira cafeteria cafetaria', kind: 'casa' }, '2024-01-01');
    const text = prefsSectionText([decoy, target], 'café');

    expect(text[0]).toContain('bebo café depois do almoço');
  });

  it('scopes an accented Portuguese query to the row that actually matches', () => {
    // "reuniões" becomes "reuni" + "es" under an ASCII split, and "reuni" is a
    // substring of the ASCII look-alike "reuniao" too, so the look-alike is
    // pulled into the composed context it has nothing to do with.
    const target = row('preference', { statement: 'Eu prefiro reuniões às sextas-feiras', kind: 'rotina' }, '2024-01-01');
    const lookalike = row('preference', { statement: 'reuniao de espera em fila', kind: 'rotina' }, '2024-01-01');

    const kept = filterRowsByQueryTerms('preference', 'Quando são as reuniões?', [target, lookalike]);
    expect(kept.map((r) => r.id)).toEqual([target.id]);
  });

  it('ranks the non-Latin row that matches first instead of falling back to recency', () => {
    // Both rows score 0 relevance under an ASCII-only split, so the newer
    // irrelevant row wins on the date tie-break alone.
    const target = row('preference', { statement: '東京都に住んでいる', kind: '住所' }, '2024-01-01');
    const newer = row('preference', { statement: '大阪に通っている', kind: '通勤' }, '2024-06-01');
    const text = prefsSectionText([newer, target], '東京都');

    expect(text[0]).toContain('東京都に住んでいる');
  });

  it('scopes a non-Latin query to the rows that match instead of the whole table', () => {
    const target = row('preference', { statement: '東京都に住んでいる', kind: '住所' }, '2024-01-01');
    const other = row('preference', { statement: 'prefers morning runs before work', kind: 'routine' }, '2024-01-01');

    const kept = filterRowsByQueryTerms('preference', '東京都', [target, other]);
    expect(kept.map((r) => r.id)).toEqual([target.id]);
  });

  it('resolves a non-Latin subject, so a fact is found by its own name', () => {
    const db = entityDb([['東京都', ['Tokyo']]]);
    try {
      expect(querySubjects(db, '東京都')).toContain('東京都');
      // Names whose letters are non-ASCII but need no case folding already resolved
      // before this PR (the SQL pre-filter lower()s, which is a no-op on them).
      const lower = entityDb([['São Paulo', []], ['café central', []]]);
      try {
        expect(querySubjects(lower, 'São Paulo')).toContain('São Paulo');
        expect(querySubjects(lower, 'café central')).toContain('café central');
      } finally {
        lower.close();
      }
    } finally {
      db.close();
    }
  });
});

/**
 * P2-1 of the independent review: widening the cut also widens the DENOMINATOR of the
 * abstention bar, and the stoplist is English only, so the armed honesty lane started
 * abstaining on Portuguese questions whose answer was on file. `contentTerms` is therefore
 * still ASCII. These tests pin that as a contract, in both directions.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'did', 'does', 'how', 'what',
  'when', 'which', 'who', 'why', 'many', 'much', 'about', 'from', 'into',
  'with', 'this', 'that', 'there', 'their', 'have', 'has', 'had', 'you',
  'your', 'our', 'his', 'her', 'its', 'not', 'but', 'any', 'all', 'can',
  'will', 'would', 'should', 'use', 'used', 'take', 'took', 'name', 'start',
  'here', 'near', 'last', 'over', 'under', 'each', 'than', 'then',
]);

/** The abstention lane exactly as it was before this PR: the ASCII cut, the same length
 *  floor, the same `termStem`, the same 0.5 bar. Every abstention assertion below compares
 *  against this oracle rather than against a hand-written expectation. */
const PRE_PR = {
  coverage(query: string, texts: string[]): number {
    const terms = Array.from(new Set(
      (query ?? '').toLowerCase().split(/[^a-z0-9%.]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ));
    if (terms.length === 0) return 1;
    const hay = texts.join('\n').toLowerCase();
    return terms.filter((t) => hay.includes(t.slice(0, Math.max(4, t.length - 2)))).length / terms.length;
  },
};

describe('the abstention lane is a strict non-regression', () => {
  it('answers the Portuguese question whose answer is on file', () => {
    // The exact pair from the review: coverage was 0.50 before this PR (answers) and
    // 0.33 with a widened term set (abstains "no good answer on file for this").
    expect(contentTerms('Quando são as reuniões?')).toEqual(['quando', 'reuni']);
    expect(evidenceCoverage('Quando são as reuniões?', ['Eu prefiro reuniões às sextas-feiras'])).toBe(0.5);
    expect(assessAbstention({ query: 'Quando são as reuniões?', texts: ['Eu prefiro reuniões às sextas-feiras'] })).toBeNull();
  });

  it('changes no abstention outcome for any Portuguese query/fact pair', () => {
    const pairs: Array<[string, string]> = [
      ['Quando são as reuniões?', 'Eu prefiro reuniões às sextas-feiras'],
      ['Quais são as minhas preferências de café?', 'Prefiro café sem açúcar'],
      ['eu não quero bolo', 'eu não quero bolo de chocolate'],
      ['Onde fica a reunião de amanhã?', 'A reunião de amanhã fica na sala 3'],
      ['Quanto tempo durou o treino?', 'O treino durou 45 minutos'],
      ['Quem escreveu o documento?', 'Ana escreveu o documento final'],
      ['Quando são as reuniões?', 'Prefiro café sem açúcar'],
      ['Quais são as minhas preferências de café?', 'Eu prefiro reuniões às sextas-feiras'],
      ['não quero', 'quero'],
      ['café', 'café com leite'],
      ['ção', 'ação'],
      ['não', 'não'],
    ];

    for (const [q, fact] of pairs) {
      expect({ q, coverage: evidenceCoverage(q, [fact]) }, q).toEqual({ q, coverage: PRE_PR.coverage(q, [fact]) });
      expect({ q, abstains: assessAbstention({ query: q, texts: [fact] }) !== null }, q)
        .toEqual({ q, abstains: PRE_PR.coverage(q, [fact]) < 0.5 });
    }
  });

  it('keeps every English abstention outcome, including the ones that should abstain', () => {
    // The widening must not have been the only change: a weak-hit query must still abstain.
    expect(assessAbstention({ query: 'what is the power source of the machine', texts: ['unrelated note text'] })).not.toBeNull();
    expect(contentTerms('which flights did I take in 2024')).toEqual(['flights', '2024']);
  });
});

describe('English tokenization is unchanged', () => {
  // The pre-fix ASCII rule, kept verbatim as the oracle for "English is unchanged".
  const asciiWords = (text: string, numeric = false): string[] =>
    (text ?? '').toLowerCase().split(numeric ? /[^a-z0-9%.]+/ : /[^a-z0-9]+/);

  const ENGLISH_CORPUS = [
    '',
    'a b c',
    'morning runs before work',
    'what is the pack design capacity in Wh',
    'which flights did I take in 2024',
    'how much in total did I run across races',
    'remembers the ones powered by solar, not diesel',
    'renor-memory-1002 and snake_case_field',
    'capacity 3.5% at 42.0 Wh, efficiency 98.75%',
    "it's the e-mail Rowan's O'Brien setup",
    'ALL CAPS SHOUTING, with punctuation!!!',
    'trailing/separators\\and|or~weird^chars',
    'tabs\tand\nnewlines\r\nand  double  spaces',
    'digits 0123456789 mixed with letters abcdefghijklmnopqrstuvwxyz',
    'under_score inside_word 3.14 pi-r2 snake_case',
    'CVE-2024-3094 and ISO-8601 and RFC-2119',
    'the and for with what how',
    'a',
    '...',
  ];

  // The corpus is the claim "every ASCII query", so it must itself be ASCII-only.
  it('the oracle corpus really is ASCII (otherwise the differential proof is vacuous)', () => {
    for (const q of ENGLISH_CORPUS) {
      expect([...q].every((c) => c.codePointAt(0)! <= 0x7f), JSON.stringify(q)).toBe(true);
    }
  });

  // term lists and row sets the ASCII split produced, pinned as literals.
  it('contentTerms yields the same English terms as before', () => {
    expect(contentTerms('what is the pack design capacity in Wh')).toEqual(['pack', 'design', 'capacity']);
    expect(contentTerms('what is the power source of the machine')).toEqual(['power', 'source', 'machine']);
    expect(contentTerms('the and for with what how')).toEqual([]);
    expect(contentTerms('which flights did I take in 2024')).toEqual(['flights', '2024']);
  });

  it('filterRowsByQueryTerms yields the same English row sets as before', () => {
    const morning = row('preference', { statement: 'prefers morning runs before work', kind: 'routine' }, '2024-01-01');
    const caffeine = row('preference', { statement: 'avoids caffeine after noon', kind: 'diet' }, '2024-01-01');

    expect(filterRowsByQueryTerms('preference', 'morning runs', [morning, caffeine]).map((r) => r.id)).toEqual([morning.id]);
    expect(filterRowsByQueryTerms('preference', 'caffeine', [morning, caffeine]).map((r) => r.id)).toEqual([caffeine.id]);
    // No overlap still means no rows, never a fallback to the full table.
    expect(filterRowsByQueryTerms('preference', 'quantum entanglement policy', [morning, caffeine])).toHaveLength(0);
    // No scorable term still keeps the full table.
    expect(filterRowsByQueryTerms('preference', 'a b c', [morning, caffeine])).toHaveLength(2);
  });

  it('English composition still ranks and renders the English way', () => {
    const rows = [
      row('preference', { statement: 'prefers morning runs before work', kind: 'routine' }, '2024-01-01'),
      row('preference', { statement: 'avoids caffeine after noon', kind: 'diet' }, '2024-01-01'),
    ];
    const input: ComposerInput = { query: 'morning runs before work', hits: [hit('notes/a.md', 'text')], rows };

    // Byte-identical across repeated composition (the composer's determinism contract) and
    // the English row that answers the question is the one ranked first (both rows are
    // rendered: query-scoped filtering is opt-in and off in the shipped default).
    expect(composeQueryContext(input, { env: {} as NodeJS.ProcessEnv }).text)
      .toBe(composeQueryContext(input, { env: {} as NodeJS.ProcessEnv }).text);
    expect(prefsSectionText(rows, 'morning runs before work')[0]).toContain('prefers morning runs before work');
  });

  it('still resolves an English entity and still rejects an unrelated one', () => {
    const db = entityDb([['Machine', ['host']]]);
    try {
      expect(querySubjects(db, 'what is the power source of the machine')).toContain('Machine');
      expect(querySubjects(db, 'how tall is the eiffel tower')).not.toContain('Machine');
    } finally {
      db.close();
    }
  });

  it('cuts every ASCII query into the exact words the ASCII rule produced', () => {
    // Differential proof, not a handful of samples: the pre-fix rule is kept here as the
    // oracle and `splitWords` must agree with it on every ASCII input, in both variants.
    for (const q of ENGLISH_CORPUS) {
      expect(splitWords(q)).toEqual(asciiWords(q));
      expect(splitWords(q, true)).toEqual(asciiWords(q, true));
    }
  });
});

/**
 * P2-2 of the independent review. Stored payloads are never normalized, and NFC and NFD are
 * different strings, so an NFC query term cannot match NFD text (or the reverse) by raw
 * substring. NFD text is real: macOS-authored text, pasted filenames, Obsidian on Mac.
 * `matchForm` (NFC + lowercase) is applied to BOTH sides, so all four combinations match.
 */
describe('an accented query matches an accented fact however either is normalized', () => {
  const NFC_Q = 'Quando você quer café?';
  const NFD_Q = NFC_Q.normalize('NFD');
  const NFC_FACT = 'Eu quero café sem açúcar';
  const NFD_FACT = NFC_FACT.normalize('NFD');

  it('the fixture really is one spelling on each side', () => {
    expect(NFC_Q).not.toBe(NFD_Q);
    expect(NFC_FACT).not.toBe(NFD_FACT);
    expect(NFC_Q.normalize('NFC')).toBe(NFC_Q);
    expect(NFD_Q.normalize('NFC')).toBe(NFC_Q);
  });

  it('keeps the matching row for all four NFC/NFD combinations', () => {
    const target = row('preference', { statement: NFD_FACT, kind: 'bebida' }, '2024-01-01');
    const other = row('preference', { statement: 'prefers morning runs', kind: 'routine' }, '2024-01-01');

    for (const q of [NFC_Q, NFD_Q]) {
      expect({ q, kept: filterRowsByQueryTerms('preference', q, [other, target]).map((r) => r.id) })
        .toEqual({ q, kept: [target.id] });
    }
  });

  it('ranks the matching row first for all four NFC/NFD combinations', () => {
    const target = row('preference', { statement: NFD_FACT, kind: 'bebida' }, '2024-01-01');
    const newer = row('preference', { statement: 'cafeteira cafeteria', kind: 'casa' }, '2024-06-01');

    for (const q of [NFC_Q, NFD_Q]) {
      // The composer renders raw stored text, so the NFD fact renders as NFD: compare
      // after normalizing the rendered line, not by string equality.
      expect(prefsSectionText([newer, target], q)[0].normalize('NFC')).toContain(NFC_FACT);
    }
  });

  it('leaves the abstention outcome exactly where it was, for all four combinations', () => {
    // The abstention lane is ASCII and unchanged (P2-1), so each combination must equal
    // what the pre-PR lane produced on that same combination. It is NOT invariant across
    // combinations and does not need to be: the ASCII cut yields `voc` from an NFC query
    // and `voce` from an NFD one, which is pre-existing behavior of an unchanged function
    // and out of scope here. What must not happen is this PR moving any of the four.
    for (const q of [NFC_Q, NFD_Q]) {
      for (const f of [NFC_FACT, NFD_FACT]) {
        expect({ q, f, coverage: evidenceCoverage(q, [f]) }, `${q.length} / ${f.length}`)
          .toEqual({ q, f, coverage: PRE_PR.coverage(q, [f]) });
      }
    }
  });
});

/**
 * P3-1 of the independent review, pinned so it cannot regress silently. `querySubjects`
 * pre-filters with SQL `lower(canonical_name) LIKE`, and SQLite folds ASCII only, so a
 * name whose first non-ASCII letter is CAPITALIZED is not found. Not a regression (it never
 * resolved); fixing it properly needs either a normalized indexed column — a migration — or
 * an unbounded scan of `entities` in JS on a read path, so it is a separate PR, not this one.
 */
describe('known limit: a capitalized non-ASCII entity name does not resolve', () => {
  it('does not resolve it, today, and says so here', () => {
    const db = entityDb([['Ágata', []], ['Łódź', []], ['ÉCOLE', []]]);
    try {
      expect(querySubjects(db, 'Ágata')).toEqual([]);
      expect(querySubjects(db, 'Łódź')).toEqual([]);
      expect(querySubjects(db, 'ÉCOLE')).toEqual([]);
      // The lowercase/uncased spellings do resolve, which is what the Unicode cut bought.
      const lower = entityDb([['ágata', []], ['łódź', []], ['école', []]]);
      try {
        expect(querySubjects(lower, 'ágata')).toContain('ágata');
        expect(querySubjects(lower, 'łódź')).toContain('łódź');
        expect(querySubjects(lower, 'école')).toContain('école');
      } finally {
        lower.close();
      }
    } finally {
      db.close();
    }
  });
});