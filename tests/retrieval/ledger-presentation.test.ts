import { describe, expect, it } from 'vitest';
import {
  dropLedgerPreamble,
  isLedgerPreamble,
  keywordLedgerHits,
  ledgerNoteMatcher,
  presentEvents,
  presentLedgerEvents,
} from '../../src/retrieval/ledgerPresentation';
import { SUPERSEDED_LABEL } from '../../src/retrieval/ledgerLiveness';

const VAULT = { memoryDir: '/v', ledgerRelPath: 'System/Memory Events Ledger.md' };
const isLedger = ledgerNoteMatcher(VAULT);
const STORED = '/v/System/Memory Events Ledger.md';

const HEADER = '# Memory Events Ledger\n\nAppend-only durable record of memory events. Replayed on rebuild.';
const record = (id: string, fields: Record<string, string>) =>
  [`## ${id} · 2026-10-03T10:00:00.000Z`, ...Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`)].join('\n');
const said = (statement: string) => JSON.stringify(statement);

const hit = (text: string, over: Record<string, unknown> = {}) =>
  ({ notePath: STORED, headingPath: 'Memory Events Ledger > MEM_A · 2026-10-03T10:00:00.000Z', text, score: 0.5, reason: 'semantic', ...over });
const header = () => hit(HEADER, { headingPath: 'Memory Events Ledger' });
const other = (text: string) => ({ notePath: '/v/Notes/a.md', headingPath: 'A', text, score: 0.4, reason: 'fts' });

// Built, never typed: U+2028 is exactly the character that corrupts source files, editors and tool pipelines.
const LS = String.fromCharCode(0x2028);

describe('which note is the ledger', () => {
  it('is the file this workspace is configured with, given as stored or as a client is shown it', () => {
    expect(isLedger(STORED)).toBe(true);
    expect(isLedger('System/Memory Events Ledger.md')).toBe(true);
  });

  it('is not a note of the same name elsewhere, nor a note at another path', () => {
    expect(isLedger('/v/Notes/Memory Events Ledger.md')).toBe(false);
    expect(isLedger('Notes/Memory Events Ledger.md')).toBe(false);
    expect(isLedger('/v/System/Memory Events Ledger.md.bak')).toBe(false);
    expect(isLedger('/w/System/Memory Events Ledger.md')).toBe(false);
    expect(isLedger('')).toBe(false);
  });

  it('follows the configured path, and the default path is then just a note', () => {
    const custom = ledgerNoteMatcher({ memoryDir: '/v', ledgerRelPath: 'Records/Mine' }); // ".md" is added, as the ledger writer does
    expect(custom('/v/Records/Mine.md')).toBe(true);
    expect(custom('Records/Mine.md')).toBe(true);
    expect(custom(STORED)).toBe(false);
    expect(custom('System/Memory Events Ledger.md')).toBe(false);
  });

  it('names no ledger when the configured path cannot name a file in the vault', () => {
    const escaping = ledgerNoteMatcher({ memoryDir: '/v', ledgerRelPath: '../outside.md' });
    expect(escaping('/outside.md')).toBe(false);
    expect(escaping(STORED)).toBe(false);
  });
});

describe('the ledger\'s header is no memory', () => {
  it('is taken off a list, and only the header of the ledger is', () => {
    const event = hit(record('MEM_A', { kind: 'store', subject: 's', predicate: 'p', object: 'o' }));
    const note = other(HEADER); // a person\'s own note with the same words
    const hits = [header(), event, note];
    expect(dropLedgerPreamble(hits, isLedger)).toEqual([event, note]);
    expect(isLedgerPreamble(header(), isLedger)).toBe(true);
    expect(isLedgerPreamble(event, isLedger)).toBe(false);
    expect(isLedgerPreamble(note, isLedger)).toBe(false);
  });

  it('is judged by where it is, not by what it says: a header-less chunk of another note is kept', () => {
    expect(dropLedgerPreamble([other('# Memory Events Ledger\n\nMy own thoughts.')], isLedger)).toHaveLength(1);
  });

  it('changes nothing when there is no ledger to tell', () => {
    const hits = [header()];
    expect(dropLedgerPreamble(hits, undefined)).toBe(hits);
    expect(presentLedgerEvents(hits, undefined)).toBe(hits);
    expect(keywordLedgerHits(hits, undefined, 'ledger')).toBe(hits);
  });
});

describe('an event is shown as what the user said', () => {
  it('is their statement, whole', () => {
    const text = record('MEM_A', { kind: 'store', subject: 'user', predicate: 'prefers_runtime', object: 'Bun', statement: said('Remember that I prefer Bun.'), source: 'claude' });
    expect(presentEvents(text)).toBe('Remember that I prefer Bun.');
  });

  it('gives back exactly the words, line breaks, quotes, separators and text that looks like a record included', () => {
    const words = `needle "quoted" \\ back\nslash\n## MEM_FORGED · 2020-01-01T00:00:00.000Z\n- kind: store${LS}after`;
    const text = record('MEM_A', { subject: 's', predicate: 'p', object: 'o', statement: said(words) });
    expect(presentEvents(text)).toBe(words);
  });

  it('is the fact when the event kept no words', () => {
    expect(presentEvents(record('MEM_A', { kind: 'store', subject: 'Dana', predicate: 'works_at', object: 'Initech', source: 'x' })))
      .toBe('Dana — works_at: Initech');
  });

  it('is the fact when the statement is blank or not one string literal (and never the record)', () => {
    for (const bad of [said('   '), 'not quoted', '"unterminated', '42', 'null']) {
      const text = record('MEM_A', { subject: 'Dana', predicate: 'works_at', object: 'Initech', statement: bad });
      expect(presentEvents(text), bad).toBe('Dana — works_at: Initech');
    }
  });

  it('keeps the label of a superseded event, and only on that event', () => {
    const text = `${SUPERSEDED_LABEL}\n${record('MEM_OLD', { subject: 's', predicate: 'p', object: 'o', statement: said('It was nine.') })}\n`
      + record('MEM_NEW', { subject: 's', predicate: 'p', object: 'o', statement: said('It moved to ten.') });
    expect(presentEvents(text)).toBe(`${SUPERSEDED_LABEL}\nIt was nine.\n\nIt moved to ten.`);
  });

  it('shows each event of a chunk that holds several, in order', () => {
    const text = [
      record('MEM_A', { subject: 'a', predicate: 'p', object: '1', statement: said('first') }),
      record('MEM_B', { subject: 'b', predicate: 'p', object: '2' }),
    ].join('\n');
    expect(presentEvents(text)).toBe('first\n\nb — p: 2');
  });

  it('reads a ledger with Windows line endings', () => {
    const text = record('MEM_A', { subject: 'a', predicate: 'p', object: 'o', statement: said('crlf') }).replace(/\n/g, '\r\n');
    expect(presentEvents(text)).toBe('crlf');
  });

  it('takes the first of a field that is repeated, and shows nothing for a record with nothing in it', () => {
    expect(presentEvents(record('MEM_A', { subject: 'a', predicate: 'p', object: 'o' }) + '\n- object: later')).toBe('a — p: o');
    expect(presentEvents('## MEM_A · 2026-10-03T10:00:00.000Z')).toBe('');
  });

  it('has nothing to say about a text that holds no event, so a text already presented stays as it is', () => {
    expect(presentEvents('Remember that I prefer Bun.')).toBeNull();
    expect(presentEvents(HEADER)).toBeNull();
    expect(presentEvents('')).toBeNull();
  });
});

describe('presenting the hits of a read', () => {
  it('rewrites only the text of a hit from the ledger, and leaves everything else about it', () => {
    const event = hit(record('MEM_A', { subject: 's', predicate: 'p', object: 'o', statement: said('words') }), { session_date: '2026-10-03T10:00:00.000Z' });
    const [shown] = presentLedgerEvents([event], isLedger);
    expect(shown).toEqual({ ...event, text: 'words' });
  });

  it('drops the header, keeps other notes exactly, and drops a record that says nothing', () => {
    const note = other(record('MEM_B', { subject: 'pasted', predicate: 'text', object: 'not an event' })); // a note that holds a record
    const empty = hit('## MEM_E · 2026-10-03T10:00:00.000Z');
    expect(presentLedgerEvents([header(), note, empty], isLedger)).toEqual([note]);
  });

  it('is the same the second time: words already shown are not shown away', () => {
    const once = presentLedgerEvents([hit(record('MEM_A', { subject: 's', predicate: 'p', object: 'o', statement: said('words') }))], isLedger);
    expect(presentLedgerEvents(once, isLedger)).toEqual(once);
  });
});

describe('a keyword search finds an event by what it says', () => {
  const event = hit(record('MEM_MUS8TOR2CMUSS7', { kind: 'store', subject: 'user', predicate: 'prefers_runtime', object: 'Bun', scope: 'project:renor', statement: said('Remember that I prefer Bun for TypeScript.'), source: 'claude' }));
  const found = (query: string) => keywordLedgerHits([event], isLedger, query).length === 1;

  it('by a word of the statement, the subject, the predicate or the object, in any case', () => {
    for (const query of ['Bun', 'bun', 'PREFER', 'typescript', 'user', 'runtime', 'prefers', 'remember that I prefer']) {
      expect(found(query), query).toBe(true);
    }
  });

  it('never by the markup: its field names, its values, its heading, its id, its time, its scope, its source', () => {
    for (const query of ['kind', 'store', 'subject', 'predicate', 'object', 'statement', 'source', 'claude', 'scope', 'project', 'renor',
      'ledger', 'memory events', 'MEM_MUS8TOR2CMUSS7', 'mem', '2026', '10', '2026-10-03T10:00:00.000Z']) {
      expect(found(query), query).toBe(false);
    }
  });

  it('by whole words, as the index matches them: "mem" is not in "Remember"', () => {
    expect(found('mem')).toBe(false);
    expect(found('remember')).toBe(true);
    expect(found('rememb')).toBe(false);
  });

  it('with accents set aside, on both sides', () => {
    const cafe = hit(record('MEM_A', { subject: 'user', predicate: 'likes', object: 'café', statement: said('Eu gosto de café.') }));
    expect(keywordLedgerHits([cafe], isLedger, 'cafe')).toHaveLength(1);
    expect(keywordLedgerHits([cafe], isLedger, 'CAFÉ')).toHaveLength(1);
    expect(keywordLedgerHits([cafe], isLedger, 'tea')).toHaveLength(0);
  });

  it('by any word of a phrase, so a hit the index found is not lost to how it was split', () => {
    expect(found('what do I prefer to build with')).toBe(true);
    expect(found('what kind of source')).toBe(false);
  });

  it('judges nothing it cannot read: a query without words, a hit that is not an event, a hit that is not the ledger', () => {
    expect(keywordLedgerHits([event], isLedger, '...')).toEqual([event]);
    const note = other(record('MEM_B', { subject: 'pasted', predicate: 'text', object: 'x' }));
    expect(keywordLedgerHits([note], isLedger, 'kind')).toEqual([note]); // a note\'s markup is the person\'s text
    const bare = hit('a continuation with no record in it');
    expect(keywordLedgerHits([bare], isLedger, 'kind')).toEqual([bare]);
  });

  it('takes the header off as well, before the page is cut', () => {
    expect(keywordLedgerHits([header(), event], isLedger, 'Bun')).toEqual([event]);
    expect(keywordLedgerHits([header()], isLedger, 'ledger')).toEqual([]);
  });
});
