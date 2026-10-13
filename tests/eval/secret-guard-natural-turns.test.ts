import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NATURAL_PINS_PATH, hasFirstPerson, pyLen, pyStrip, readNaturalPins, rebuildNaturalTurns, sampleNaturalTurns, sha256Hex,
  userTurnsBySession, type NaturalPins,
} from '../../scripts/eval/secret-guard/longmemevalNatural';
import { syntheticLongMemEval, syntheticTurn } from '../helpers/syntheticLongMemEval';

/**
 * The natural half of the investigation's T3 set is 100 benign turns of LongMemEval-S. The benchmark is never committed,
 * so the repository holds a sampler (scripts/eval/secret-guard/longmemevalNatural.ts) and pins (investigation-natural-turns.json:
 * each turn's session, index and SHA-256). These tests cover both without the dataset: the sampler is checked against the
 * investigation's own Python, run on a synthetic dataset built to hit every rule it has, and the check that turns a
 * wrong dataset into a refusal is exercised on every branch. `RENOR_LONGMEMEVAL_S=<path> measure.ts --longmemeval <path>`
 * does the same on the real file.
 *
 * Expected values below were produced by the investigation's `extract_lme.py`, `sample_t1.py` and `gen_t3.py`, unchanged
 * but for the dataset path, run under Python 3.14.7 on tests/helpers/syntheticLongMemEval.ts's dataset.
 */
const cp = String.fromCodePoint;
const BOM = cp(0xfeff);
const NEL = cp(0x85);
const US = cp(0x1f);
const FS = cp(0x1c);
const GS = cp(0x1d);
const VT = cp(0x0b);
const LS = cp(0x2028);
const PS = cp(0x2029);
const NBSP = cp(0xa0);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const ZERO_WIDTH_SPACE = cp(0x200b);
const MONGOLIAN_VOWEL_SEPARATOR = cp(0x180e);
const GRIN = cp(0x1f600);
const DOTTED_I = cp(0x130);
const DOTLESS_I = cp(0x131);
const E_ACUTE = cp(0xe9);
const COMBINING_ACUTE = cp(0x301);

describe('the Python string behaviour the sampler keeps (each expectation is what Python 3.14 answers)', () => {
  it('str.strip() removes U+001C to U+001F, U+0085, line and paragraph separators, but not U+FEFF or a zero-width space', () => {
    const strips: Array<[string, string]> = [
      [`${BOM}abc`, `${BOM}abc`],
      [`${NEL}${US}abc${FS} `, 'abc'],
      [`${LS}abc${PS}`, 'abc'],
      [`${ZERO_WIDTH_SPACE}abc`, `${ZERO_WIDTH_SPACE}abc`],
      [`${MONGOLIAN_VOWEL_SEPARATOR}abc`, `${MONGOLIAN_VOWEL_SEPARATOR}abc`],
      [`abc${NBSP}${IDEOGRAPHIC_SPACE}`, 'abc'],
      [`${GS}abc`, 'abc'],
      [`${VT}abc`, 'abc'],
      [BOM, BOM],
      ['   ', ''],
      ['', ''],
    ];
    for (const [input, want] of strips) expect(pyStrip(input), JSON.stringify(input)).toBe(want);
  });

  it('is not JavaScript\'s trim() where they differ', () => {
    expect(`${BOM}abc`.trim()).toBe('abc'); // trim() removes a BOM, Python does not
    expect(`${NEL}abc`.trim()).toBe(`${NEL}abc`); // trim() keeps U+0085, Python removes it
    expect(pyStrip(`${BOM}abc`)).not.toBe(`${BOM}abc`.trim());
    expect(pyStrip(`${NEL}abc`)).not.toBe(`${NEL}abc`.trim());
  });

  it('len() counts code points: an emoji is one, a lone surrogate is one, a letter and its combining accent are two', () => {
    expect([pyLen(GRIN), pyLen(`a${GRIN}b`), pyLen('\ud83d'), pyLen(`e${COMBINING_ACUTE}`), pyLen('')]).toEqual([1, 3, 1, 2, 0]);
    expect(GRIN.length).toBe(2);
  });

  it('strips a long run of spaces in linear time (a `\\s+$` pattern is quadratic here)', () => {
    const text = `a${' '.repeat(300_000)}b`;
    expect(pyStrip(text)).toBe(text); // nothing to remove at either end; finishes at once
  });

  it('\\b and re.I are Unicode-aware: the first-person filter', () => {
    const matches = ['I', 'i am', 'mine', "I'm", 'my', 'MY', 'me!', 'our', 'wE', "we're", 'a-i-b', `Ünï i`, DOTTED_I, DOTLESS_I, `${DOTTED_I} want`, `i${COMBINING_ACUTE}`, `${COMBINING_ACUTE}i`];
    const nonMatches = ['mining', 'welcome', 'hour', `${E_ACUTE}i`, `i${E_ACUTE}a`, `${DOTLESS_I}i`, `x${DOTLESS_I} y`, '_i', 'i_', '1i', 'i1', 'in', 'hi', 'me2', `${cp(0x1d422)}`, `${cp(0xff49)}`];
    for (const text of matches) expect(hasFirstPerson(text), JSON.stringify(text)).toBe(true);
    for (const text of nonMatches) expect(hasFirstPerson(text), JSON.stringify(text)).toBe(false);
  });
});

describe('the synthetic dataset hits every rule the sampler has', () => {
  const lengths = (j: number) => {
    const t = syntheticTurn(j);
    return { python: pyLen(pyStrip(t)), naive: t.trim().length };
  };

  it('has turns at the 24 / 25 and 1,200 / 1,201 boundaries, each on the side Python puts it, and not where a naive port would', () => {
    expect(lengths(5).python).toBe(24); // too short once Python strips U+0085, U+001F and U+001C ...
    expect(lengths(5).naive).toBeGreaterThanOrEqual(25); // ... but long enough for trim()
    expect(lengths(15).python).toBe(25); // a BOM counts for Python ...
    expect(lengths(15).naive).toBe(24); // ... not for trim()
    expect(lengths(6).python).toBe(24); // twelve emoji and twelve letters: 24 code points ...
    expect(syntheticTurn(6).length).toBe(36); // ... 36 UTF-16 units
    expect(lengths(16).python).toBe(25);
    expect(lengths(8).python).toBe(1200);
    expect(lengths(18).python).toBe(1201);
  });

  it('has first-person and generic prompts, and the three Unicode cases the filter treats differently from JavaScript', () => {
    expect(hasFirstPerson(syntheticTurn(0))).toBe(true);
    expect(hasFirstPerson(syntheticTurn(1))).toBe(false);
    expect(hasFirstPerson(syntheticTurn(2))).toBe(true); // a dotted capital I is "i" to re.I
    expect(hasFirstPerson(syntheticTurn(3))).toBe(false); // a dotless i, then i: one word
    expect(hasFirstPerson(syntheticTurn(4))).toBe(false); // an i glued to an e-acute: one word
    expect(/\bi\b/i.test(syntheticTurn(4))).toBe(true); // JavaScript's \b would have found a boundary there
  });

  it('reads sessions as extract_lme.py does: first occurrence wins, user turns only, indexes count every message', () => {
    const sessions = userTurnsBySession(syntheticLongMemEval());
    expect(sessions).toHaveLength(1600);
    expect(sessions.map(s => s.kind).filter(k => k === 'sharegpt')).toHaveLength(400);
    const ultrachat0 = sessions.find(s => s.sid === 'ultrachat_0');
    expect(ultrachat0?.turns.map(t => t.index)).toEqual([0, 2]);
    expect(sessions.flatMap(s => s.turns).some(t => t.text.includes('a later copy'))).toBe(false);
    const answer = sessions.find(s => s.sid === 'answer_0_1');
    // a system message and a message with no role come first, so the first user turn is the third message
    expect(answer?.turns.map(t => [t.index, t.hasAnswer])).toEqual([[2, true], [4, false]]);
  });
});

describe('the sampler against the investigation\'s Python', () => {
  const { turns, poolSizes } = sampleNaturalTurns(userTurnsBySession(syntheticLongMemEval()));
  const pairs = turns.map(t => `${t.sid}:${t.turn}`);

  it('draws pools of the sizes Python draws, so the random stream is in the same place before set A is shuffled', () => {
    expect(poolSizes).toEqual({ evid: 261, sim_other: 783, ultra: 522, ultra_generic: 362 });
  });

  it('picks the same 100 turns in the same order', () => {
    expect(turns).toHaveLength(100);
    expect(pairs.slice(0, 3)).toEqual(['00000012_18:0', 'answer_270_1:4', 'ultrachat_385:2']);
    expect(pairs.slice(-2)).toEqual(['ultrachat_308:0', 'ultrachat_289:2']);
    expect(sha256Hex(pairs.join('\n'))).toBe('89f16204e978efd33984b3bbaf1eb61568c381cf703c0683e115b3810ae689e0');
    expect(sha256Hex(turns.map(t => t.text).join('\n'))).toBe('243b74d967f1fa6a98d8545e573c34a2a6a4d50902cd14f21e0570edb1c3de6d');
  });

  it('never picks a ShareGPT turn, a turn outside 25 to 1,200 characters, or a turn twice', () => {
    expect(pairs.some(p => p.startsWith('sharegpt_'))).toBe(false);
    for (const t of turns) {
      expect(pyLen(t.text)).toBeGreaterThanOrEqual(25);
      expect(pyLen(t.text)).toBeLessThanOrEqual(1200);
      expect(t.text).toBe(pyStrip(t.text));
    }
    expect(new Set(pairs).size).toBe(100);
  });
});

describe('the pins', () => {
  const pins = readNaturalPins();

  it('hold ids, places and hashes, and no text', () => {
    expect(pins.turns).toHaveLength(100);
    expect(pins.turns.map(t => t.id)).toEqual(Array.from({ length: 100 }, (_, i) => `t3-${343 + i}`));
    for (const t of pins.turns) {
      expect(Object.keys(t).sort()).toEqual(['id', 'sha256', 'sid', 'turn']);
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(t.turn) && t.turn >= 0).toBe(true);
    }
    expect(new Set(pins.turns.map(t => `${t.sid}:${t.turn}`)).size).toBe(100);
    expect(new Set(pins.turns.map(t => t.sha256)).size).toBe(100);
    expect(pins.textsSha256.natural).toMatch(/^[0-9a-f]{64}$/);
    expect(pins.textsSha256.fullSet).toMatch(/^[0-9a-f]{64}$/);
    expect(pins.source).toEqual({ file: 'longmemeval_s.json', sha256: '08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894' });
    expect(pins.sampler).toEqual({ poolSeed: 20261002, naturalSeed: 77, poolSizes: { evid: 813, sim_other: 52430, ultra: 25933, ultra_generic: 11770 } });
    // the file is JSON a person can diff: one turn per line, 100 of them
    expect(fs.readFileSync(NATURAL_PINS_PATH, 'utf8').split('\n').filter(l => l.includes('"sha256"'))).toHaveLength(101); // 100 turns, and the source
  });

  it('say the whole T3 set hashes to the value the results doc gives', () => {
    expect(pins.textsSha256.fullSet.startsWith('e3c423c2cbd5470a')).toBe(true);
  });
});

describe('rebuildNaturalTurns refuses anything that is not the pinned set', () => {
  const dataset = syntheticLongMemEval();
  const { turns, poolSizes } = sampleNaturalTurns(userTurnsBySession(dataset));
  const texts = turns.map(t => t.text);
  const pinsFor = (): NaturalPins => ({
    source: { file: 'synthetic', sha256: '0'.repeat(64) },
    sampler: { poolSeed: 20261002, naturalSeed: 77, poolSizes: { ...poolSizes } },
    textsSha256: { natural: sha256Hex(texts.join('\n')), fullSet: '0'.repeat(64) },
    turns: turns.map((t, i) => ({ id: `t3-${343 + i}`, sid: t.sid, turn: t.turn, sha256: sha256Hex(t.text) })),
  });

  it('returns the texts, in order, when the dataset is the one the pins were taken from', () => {
    expect(rebuildNaturalTurns(dataset, pinsFor())).toEqual(texts);
  });

  it('names the pool that is the wrong size: another dataset', () => {
    const pins = pinsFor();
    pins.sampler.poolSizes.sim_other += 1;
    expect(() => rebuildNaturalTurns(dataset, pins)).toThrow(/pool "sim_other" holds 783 turns, the pins say 784/);
  });

  it('names the turn that sits somewhere else', () => {
    const pins = pinsFor();
    pins.turns[7] = { ...pins.turns[7], turn: pins.turns[7].turn + 2 };
    expect(() => rebuildNaturalTurns(dataset, pins)).toThrow(/t3-350: sampled session .* turn \d+, pinned/);
    const other = pinsFor();
    other.turns[0] = { ...other.turns[0], sid: 'ultrachat_0' };
    expect(() => rebuildNaturalTurns(dataset, other)).toThrow(/t3-343: sampled session 00000012_18/);
  });

  it('names the turn whose text changed', () => {
    const pins = pinsFor();
    pins.turns[41] = { ...pins.turns[41], sha256: sha256Hex('another text') };
    expect(() => rebuildNaturalTurns(dataset, pins)).toThrow(/t3-384: the text of .* does not match its pinned sha256/);
  });

  it('refuses a different number of turns', () => {
    const pins = pinsFor();
    pins.turns.pop();
    expect(() => rebuildNaturalTurns(dataset, pins)).toThrow(/100 natural turns sampled, 99 pinned/);
  });

  it('refuses when the turns do not add up to the pinned total', () => {
    const pins = pinsFor();
    pins.textsSha256.natural = sha256Hex('not these');
    expect(() => rebuildNaturalTurns(dataset, pins)).toThrow(/joined do not match the pinned sha256/);
  });

  it('refuses a dataset in which one turn was edited', () => {
    const edited = syntheticLongMemEval();
    // the first turn the sampler picks: its text changes by one character
    const first = turns[0];
    const q = edited.find(x => x.haystack_session_ids.includes(first.sid));
    if (!q) throw new Error('test setup: the first sampled session is not in the dataset');
    const messages = q.haystack_sessions[q.haystack_session_ids.indexOf(first.sid)];
    messages[first.turn] = { ...messages[first.turn], content: `${messages[first.turn].content}!` };
    expect(() => rebuildNaturalTurns(edited, pinsFor())).toThrow(/does not match its pinned sha256|pool/);
  });
});
