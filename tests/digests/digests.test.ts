import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { tmpPath } from '../helpers/tmpPath';
import {
  DIGEST_ASSISTANT_TURN_MAX_CHARS,
  DIGEST_PROMPT_TEMPLATE,
  digestInputOf,
  digestItemText,
  digestsEnabled,
  parseDigestReply,
  renderDigestPrompt,
  resolveDigestOptions,
  resolveDigestProvider,
} from '../../src/digests/digests';
import { DigestCache } from '../../src/digests/digestCache';

describe('RENOR_DIGESTS flag', () => {
  it('is off unless set on, and a typo is refused rather than measured as the control', () => {
    for (const raw of [undefined, '', '0', 'off', 'false', 'no', ' OFF ']) {
      expect(digestsEnabled({ RENOR_DIGESTS: raw })).toBe(false);
    }
    for (const raw of ['1', 'on', 'true', 'YES']) expect(digestsEnabled({ RENOR_DIGESTS: raw })).toBe(true);
    expect(() => digestsEnabled({ RENOR_DIGESTS: 'maybe' })).toThrow(/Invalid RENOR_DIGESTS/);
  });

  it('resolves to null when off and to options with a low reasoning effort when on', () => {
    const config = { dbPath: '/tmp/x/index.db' };
    expect(resolveDigestOptions(config, {})).toBeNull();
    const options = resolveDigestOptions(config, { RENOR_DIGESTS: '1', RENOR_DIGEST_API_KEY: 'k', RENOR_DIGEST_BASE_URL: 'http://127.0.0.1:1/v1' });
    expect(options).toMatchObject({ effort: 'low', cachePath: '/tmp/x/digest-cache.db', cacheOnly: false, tokens: 600 });
    expect(options?.chat).toBeTypeOf('function');
    expect(() => resolveDigestOptions(config, { RENOR_DIGESTS: '1', RENOR_DIGEST_REASONING_EFFORT: 'extreme' })).toThrow(/RENOR_DIGEST_REASONING_EFFORT/);
  });

  it('a cache-only run needs and builds no model client', () => {
    const options = resolveDigestOptions({ dbPath: '/tmp/x/index.db' }, { RENOR_DIGESTS: '1', RENOR_DIGEST_CACHE_ONLY: '1', RENOR_DIGEST_API_KEY: 'k' });
    expect(options).toMatchObject({ cacheOnly: true });
    expect(options?.chat).toBeUndefined();
  });
});

/**
 * The Privacy Policy, the LGPD page and the register name ONE processor for write-time digests (Fireworks AI), which
 * receives whole notes. A digest model client therefore comes from the digest slot or from nowhere: borrowing the
 * evidence provider's key (and URL), the router's or an Ollama Cloud key would send notes to a processor those pages do
 * not name, silently, just because RENOR_DIGESTS was switched on.
 */
describe('the digest provider', () => {
  const config = { dbPath: '/tmp/x/index.db' };
  // Every other model provider the engine can be configured with, and none of the digest slot.
  const elsewhere: NodeJS.ProcessEnv = {
    RENOR_EVIDENCE_API_KEY: 'evidence-key',
    RENOR_EVIDENCE_API_KEYS: 'evidence-a,evidence-b',
    RENOR_EVIDENCE_BASE_URL: 'http://evidence.example/v1',
    RENOR_ROUTER_API_KEY: 'router-key',
    RENOR_ROUTER_BASE_URL: 'http://router.example/v1',
    OLLAMA_API_KEY: 'ollama-key',
    OLLAMA_CLOUD_KEY_1: 'ollama-1',
  };

  it('is the digest slot and no other: the evidence provider, the router and the Ollama keys are never borrowed', () => {
    expect(resolveDigestProvider(elsewhere)).toEqual({ keys: [] });
    const options = resolveDigestOptions(config, { RENOR_DIGESTS: '1', ...elsewhere });
    expect(options).not.toBeNull();
    expect(options?.chat).toBeUndefined();
  });

  it('needs the digest URL as well as the digest key: with no URL there is no default to send notes to', () => {
    for (const env of [
      { RENOR_DIGEST_API_KEY: 'k' },
      { RENOR_DIGEST_API_KEYS: 'k1,k2' },
      // The evidence provider's URL is not the digest provider's.
      { RENOR_DIGEST_API_KEY: 'k', RENOR_EVIDENCE_BASE_URL: 'http://evidence.example/v1' },
      { RENOR_DIGEST_API_KEY: 'k', ...elsewhere },
    ]) {
      expect(resolveDigestOptions(config, { RENOR_DIGESTS: '1', ...env })?.chat, JSON.stringify(Object.keys(env))).toBeUndefined();
    }
    // A URL alone is no client either.
    expect(resolveDigestOptions(config, { RENOR_DIGESTS: '1', RENOR_DIGEST_BASE_URL: 'http://digest.example/v1' })?.chat).toBeUndefined();
  });

  it('builds the model client from the digest slot alone, whatever else is configured', () => {
    const slot = { RENOR_DIGEST_API_KEYS: 'a, b', RENOR_DIGEST_API_KEY: 'c', RENOR_DIGEST_BASE_URL: ' http://digest.example/v1 ' };
    expect(resolveDigestProvider({ ...elsewhere, ...slot })).toEqual({ baseUrl: 'http://digest.example/v1', keys: ['a', 'b', 'c'] });
    expect(resolveDigestOptions(config, { RENOR_DIGESTS: '1', ...elsewhere, ...slot })?.chat).toBeTypeOf('function');
  });
});

describe('what the model is shown', () => {
  const body = [
    '# Session s1', '', 'Timestamp: 2023/05/01',
    '### Turn 1 — User', '', 'I adopted a cat named Miso last week.',
    '### Turn 2 — Assistant', '', 'x'.repeat(2000),
    '### Turn 3 — User', '', 'Miso is three years old.',
  ].join('\n');

  it("keeps the user's turns whole and clips the assistant's, with the turn labels the digest cites", () => {
    const input = digestInputOf(body);
    expect(input).toContain('[Turn 1 User]\nI adopted a cat named Miso last week.');
    expect(input).toContain('[Turn 3 User]\nMiso is three years old.');
    const assistant = /\[Turn 2 Assistant\]\n([^\n]*)/.exec(input)![1];
    expect(assistant.length).toBe(DIGEST_ASSISTANT_TURN_MAX_CHARS + 2);
    expect(assistant.endsWith(' …')).toBe(true);
  });

  it('reads a note with no turn structure whole', () => {
    expect(digestInputOf('Plain note.\n\n- bought a bike')).toBe('Plain note.\n\n- bought a bike');
  });

  it('puts every note of a batch under its id and date', () => {
    const prompt = renderDigestPrompt([{ id: 'c01', date: 'D1', text: 'A' }, { id: 'c02', date: 'D2', text: 'B' }]);
    expect(prompt).toContain('Below are 2 conversations');
    expect(prompt).toContain('=== CONVERSATION id=c01 date=D1 ===\nA');
    expect(prompt).toContain('=== CONVERSATION id=c02 date=D2 ===\nB');
    expect(DIGEST_PROMPT_TEMPLATE).not.toContain('QUESTION');
  });
});

describe('parseDigestReply', () => {
  it('normalises ids, keeps provenance, and keeps an empty list as an answer', () => {
    const parsed = parseDigestReply(JSON.stringify({
      notes: [
        { id: 'C1', items: [{ item: 'rescue cat Miso', action: 'adopted', amount: '', date: '2023/04/24', turn: 'Turn 1' }, { item: '' }, 'junk'] },
        { id: 'c02', items: [] },
        { id: 'c03' },
      ],
    }));
    expect([...parsed.keys()]).toEqual(['c1', 'c2']);
    expect(parsed.get('c1')).toEqual([{ item: 'rescue cat Miso', action: 'adopted', amount: '', date: '2023/04/24', source: 'Turn 1' }]);
    expect(parsed.get('c2')).toEqual([]);
  });

  it('accepts a fenced or wrapped reply and refuses a reply that is not a notes list', () => {
    expect(parseDigestReply('```json\n{"notes":[{"id":"c01","items":[{"item":"a bike"}]}]}\n```').get('c1')).toHaveLength(1);
    expect(parseDigestReply('Here you go: {"notes":[{"id":"c01","items":[]}]} done').has('c1')).toBe(true);
    expect(parseDigestReply('no json at all').size).toBe(0);
    expect(parseDigestReply('{"items":[{"item":"a"}]}').size).toBe(0);
  });

  it('renders the text an item is embedded as without its date', () => {
    expect(digestItemText({ item: 'a bike', action: 'bought', amount: '$300', date: 'D', source: 'Turn 2' })).toBe('a bike | bought | $300');
  });
});

describe('DigestCache', () => {
  it('keys on model, effort, prompt, input version and note hash', () => {
    const base = DigestCache.digestKey('m', 'low', 'p', 'v1', 'h');
    expect(DigestCache.digestKey('m', 'low', 'p', 'v1', 'h')).toBe(base);
    for (const other of [
      DigestCache.digestKey('m2', 'low', 'p', 'v1', 'h'),
      DigestCache.digestKey('m', 'high', 'p', 'v1', 'h'),
      DigestCache.digestKey('m', 'low', 'p2', 'v1', 'h'),
      DigestCache.digestKey('m', 'low', 'p', 'v2', 'h'),
      DigestCache.digestKey('m', 'low', 'p', 'v1', 'h2'),
    ]) expect(other).not.toBe(base);
  });

  it('stores a digest (an empty one too) and the vectors of its items per embedding space, readable read-only', () => {
    const file = tmpPath('digest-cache-unit/digest-cache.db');
    const cache = new DigestCache(file);
    const key = DigestCache.digestKey('m', 'low', 'p', 'v1', 'h');
    expect(cache.getDigest(key)).toBeNull();
    const items = [{ item: 'a', action: 'b', amount: '', date: 'D', source: 'Turn 1' }, { item: 'c', action: '', amount: '', date: 'D', source: '' }];
    cache.putDigest(key, 'h', { items, model: 'm' });
    cache.putDigest(DigestCache.digestKey('m', 'low', 'p', 'v1', 'empty'), 'empty', { items: [], model: 'm' });
    cache.putVectors(key, 'space-a', [[0.5, -1.25], [2, 3]]);
    cache.close();

    const reader = new DigestCache(file, { readonly: true });
    expect(reader.getDigest(key)).toEqual({ items, model: 'm' });
    expect(reader.getDigest(DigestCache.digestKey('m', 'low', 'p', 'v1', 'empty'))).toEqual({ items: [], model: 'm' });
    expect(reader.getVectors(key, 'space-a', 2)).toEqual([[0.5, -1.25], [2, 3]]);
    // Another space, or a count that does not match the items, is never served.
    expect(reader.getVectors(key, 'space-b', 2)).toBeNull();
    expect(reader.getVectors(key, 'space-a', 3)).toBeNull();
    reader.close();
    expect(fs.existsSync(file)).toBe(true);
  });
});
