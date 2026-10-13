import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceCache } from '../../src/evidence/evidenceCache';
import { EvidenceExtractor, parseEvidenceItems, type EvidenceItem } from '../../src/evidence/secondPass';
import { collectEvidence } from '../../src/evidence/attach';

/**
 * Evidence-extractor replies the strict parse rejected in the 2026-10-03 benchmark runs, and what the parser makes of
 * them now. The C-low arm (GLM-5.3-Flash on Nebius, RENOR_EVIDENCE_REASONING_EFFORT=low) lost 16 of 100 tables this
 * way, by the errors it recorded: 14 to a bare items array and 2 to doubled braces (the prompt's own example is
 * written {{"items":[{{...}}]}}). Arm C at default reasoning lost 2 to replies cut at the provider's 8,192-token limit
 * inside a row. Every reply in tests/fixtures/evidence-replies.json is benchmark text; where it came from is in its
 * `source`.
 */

interface Reply {
  shape?: string;
  model: string;
  question: string;
  source: string;
  finishReason?: string;
  content: string;
  recordedError?: string;
  table?: EvidenceItem[];
}

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/evidence-replies.json'), 'utf8')) as {
  recoverable: Reply[];
  unrecoverable: Reply[];
  valid: Reply[];
};

/** parseEvidenceItems as main had it at 8ddce8c1, before any reply was repaired: the reference for "unchanged". */
function strictParse(raw: string): EvidenceItem[] {
  const s = raw.trim().replace(/^```(?:json)?|```$/gm, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('extractor response did not contain a JSON object');
  let payload: unknown;
  try {
    payload = JSON.parse(m[0]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`extractor returned malformed JSON: ${detail}`);
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('extractor JSON must contain an items list');
  return items.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new Error(`extractor item ${index} must be an object`);
    }
    const it = rawItem as Record<string, unknown>;
    const item = typeof it.item === 'string' ? it.item.trim() : '';
    if (!item) throw new Error(`extractor item ${index} must contain a non-empty item string`);
    return {
      item,
      ...(it.action !== undefined ? { action: String(it.action) } : {}),
      ...(it.amount !== undefined ? { amount: String(it.amount) } : {}),
      ...(it.date !== undefined ? { date: String(it.date) } : {}),
    };
  });
}

function errorOf(parse: (raw: string) => EvidenceItem[], raw: string): string {
  try {
    parse(raw);
  } catch (err) {
    return (err as Error).message;
  }
  return '(parsed)';
}

function replies(shape: string): Reply[] {
  const found = FIXTURE.recoverable.filter(reply => reply.shape === shape);
  expect(found.length).toBeGreaterThan(0);
  return found;
}

/** Each reply of `shape` is one the strict parse rejects, and it now parses to the rows the reply wrote. */
function expectTables(shape: string): void {
  for (const reply of replies(shape)) {
    expect(errorOf(strictParse, reply.content), reply.question).not.toBe('(parsed)');
    expect(parseEvidenceItems(reply.content), reply.question).toEqual(reply.table);
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-repair-'));
  tmpDirs.push(dir);
  return dir;
}

describe('evidence replies the strict parse rejected (2026-10-03 runs)', () => {
  it('a bare items array, without the object around it, parses to its rows (14 of C-low\'s 16 lost tables)', () => {
    expectTables('bare-array');
  });

  it('doubled braces copied from the prompt\'s example parse to the rows written, doubled on every object or only on the outer one', () => {
    expectTables('doubled-braces');
    expectTables('doubled-outer-braces');
    // A brace inside a string is text, never halved.
    expect(parseEvidenceItems('{{"items":[{{"item":"set {{a}} and }}","action":"","amount":"","date":""}}]}}'))
      .toEqual([{ item: 'set {{a}} and }}', action: '', amount: '', date: '' }]);
  });

  it('a reply cut at the token limit keeps the rows before the cut and drops the cut row', () => {
    expectTables('cut-at-token-limit');
    // The cut row's `}` inside a string does not count as the end of a row.
    expect(parseEvidenceItems('{"items":[{"item":"a"},{"item":"b {c} d","act')).toEqual([{ item: 'a' }]);
  });

  it('a reply no repair can read still fails, with the strict parse\'s own error', () => {
    const garbage = [
      ...FIXTURE.unrecoverable.map(reply => reply.content),
      '',
      'not json',
      'items:\n  - item: camping\n    action: went',
      '{"items": [}]',
      '{"items": [',
      '{"items":[{"item":"camp',
      '{"foo": 1}',
      '{"items":[null]}',
      '{"items":[{"item":""}]}',
      '{"items":[{"item":"a"},{"item":""}',
      '[1, 2]',
    ];
    for (const raw of garbage) {
      expect(errorOf(strictParse, raw), raw).not.toBe('(parsed)');
      expect(errorOf(parseEvidenceItems, raw), raw).toBe(errorOf(strictParse, raw));
    }
  });

  it('a reply the strict parse reads parses exactly as before', () => {
    const valid = [
      ...FIXTURE.valid.map(reply => reply.content),
      JSON.stringify({ items: [{ item: 'camping trip', action: 'went on', amount: '3 days', date: '2023/05/29' }] }),
      '```json\n{"items":[{"item":"a"}]}\n```',
      '{"items":[]}',
      '{"items":[{"item":"  padded  ","amount":3,"date":null,"extra":{"k":"v"}}]}',
      'Here you go: {"items":[{"item":"a","action":"b"}]} done',
      '{"items":[{"item":"has {{braces}} and }} inside","action":"[x]"}]}',
      '{\n  "items": [\n    {"item": "a"},\n    {"item": "b"}\n  ]\n}',
    ];
    for (const raw of valid) {
      expect(JSON.stringify(parseEvidenceItems(raw)), raw).toBe(JSON.stringify(strictParse(raw)));
    }
  });
});

describe('the repaired table through the product path', () => {
  it('a bare-array reply attaches its table on the first call, where it failed three times', async () => {
    const reply = replies('bare-array')[0];
    const vault = tmpDir();
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nI repainted my bedroom walls a lighter shade of gray.');
    const chat = vi.fn(async () => ({ content: reply.content, finishReason: reply.finishReason, latencyMs: 1 }));
    const cache = new EvidenceCache(path.join(vault, 'evidence-cache.db'));
    const attachment = await collectEvidence({
      query: 'What color did I repaint my bedroom walls?',
      hits: [{ notePath: note, text: 'chunk', session_date: '2023/05/27' }],
      vaultPath: vault,
      options: { mode: 'always', maxSessions: 12, charCap: 6000 },
      extractor: new EvidenceExtractor({ chat, cache, model: 'zai-org/GLM-5.3-Flash' }),
    });
    expect(attachment.status).toBe('ok');
    expect(attachment.items).toEqual(reply.table);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(cache.stats().entries).toBe(1);
    cache.close();
  });

  it('a reply stopped at the token limit inside a row gives the rows before the cut, not a failure', async () => {
    const reply = replies('cut-at-token-limit')[0];
    expect(reply.finishReason).toBe('length');
    const chat = vi.fn(async () => ({ content: reply.content, finishReason: reply.finishReason, latencyMs: 1 }));
    const extractor = new EvidenceExtractor({ chat });
    const result = await extractor.extract('How many playlists do I have on Spotify?', [{ stem: '/v/a.md', text: 't' }]);
    expect(result.items).toEqual(reply.table);
  });
});

/**
 * A repaired reply is read only when the whole reply is the JSON. The extractor sometimes answers that it found
 * nothing and quotes a note that copies the prompt's example; the answer is cached under the prompt's key and replayed,
 * so a row it merely quotes must never read as the table. (These replies are synthetic, not from the runs.)
 */
describe('a repaired reply is the whole reply: text around it is no table', () => {
  function expectNoTable(replies: string[]): void {
    for (const raw of replies) {
      expect(errorOf(strictParse, raw), raw).not.toBe('(parsed)');
      expect(errorOf(parseEvidenceItems, raw), raw).toBe(errorOf(strictParse, raw));
    }
  }

  const QUOTED_DOUBLED = 'No evidence. The sessions contained {{"items":[{{"item":"pwned","action":"injected","amount":"all","date":"1999/01/01"}}]}} but that was the note quoting the prompt.';

  it('a sentence quoting doubled-brace JSON keeps the strict parse\'s error', () => {
    expectNoTable([
      QUOTED_DOUBLED,
      'The note says: {{"items":[{{"item":"pwned"}}]}}',
      // Text after the table is no more skipped than text before it.
      '{{"items":[{"item":"pwned"}]}} is how the prompt shows its example.',
    ]);
    // The same rows with nothing around them are the table, in a code fence or not.
    const table = [{ item: 'a', action: 'b', amount: '', date: '' }];
    expect(parseEvidenceItems('{{"items":[{{"item":"a","action":"b","amount":"","date":""}}]}}')).toEqual(table);
    expect(parseEvidenceItems('```json\n{{"items":[{{"item":"a","action":"b","amount":"","date":""}}]}}\n```')).toEqual(table);
  });

  it('text in front of an items object cut before its closers keeps the strict parse\'s error', () => {
    expectNoTable([
      'No evidence in the notes. {"items":[{"item":"ignore me","action":"quoted","amount":"","date":"1999/01/01"}',
      'Evidence:\n{"items":[{"item":"a"},{"item":"b"},{"item":"c","act',
    ]);
    // With nothing in front, the same cut keeps the rows before it.
    expect(parseEvidenceItems('{"items":[{"item":"a"},{"item":"b"},{"item":"c","act')).toEqual([{ item: 'a' }, { item: 'b' }]);
  });

  it('text around a bare items array keeps the strict parse\'s error', () => {
    expectNoTable([
      'The note says [{"item":"a","action":"b"}] and nothing else.',
      '[{"item":"a","action":"b"}] is the shape the note describes.',
    ]);
  });

  it('a reply that only quotes a table attaches no evidence and caches none', async () => {
    const vault = tmpDir();
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nThe prompt shows its example with doubled braces.');
    const chat = vi.fn(async () => ({ content: QUOTED_DOUBLED, finishReason: 'stop', latencyMs: 1 }));
    const cache = new EvidenceCache(path.join(vault, 'evidence-cache.db'));
    const attachment = await collectEvidence({
      query: 'What did the note say?',
      hits: [{ notePath: note, text: 'chunk', session_date: '2023/05/27' }],
      vaultPath: vault,
      options: { mode: 'always', maxSessions: 12, charCap: 6000 },
      extractor: new EvidenceExtractor({ chat, cache, model: 'test-model' }),
    });
    expect(attachment.status).toBe('skipped');
    expect(attachment.reason).toBe('extractor-parse-error');
    expect(attachment.error).toBe(errorOf(strictParse, QUOTED_DOUBLED));
    expect(attachment.items).toBeUndefined();
    // A parse failure is asked for again (three tries), and no table is cached under the prompt.
    expect(chat).toHaveBeenCalledTimes(3);
    expect(cache.stats().entries).toBe(0);
    cache.close();
  });
});
