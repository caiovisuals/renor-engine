import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildInvestigationRobustness, buildInvestigationT3, textsSha256 } from '../../scripts/eval/secret-guard/investigationSets';
import { readLongMemEval } from '../../scripts/eval/secret-guard/longmemevalNatural';
import { investigationSets, measureNaturalTurns, measureSet } from '../../scripts/eval/secret-guard/measure';
import { scanSecrets } from '../../src/extraction/secretScanner';

/**
 * The headline of docs/evals/results/SECRET-GUARD-TIER0-20261003.md, made executable: the sets are the decision-layer
 * investigation's own, regenerated exactly (scripts/eval/secret-guard/investigationSets.ts), so anyone can rerun
 * 229 / 243 and 9 / 200 from this repository.
 *
 * Everything here is synthetic. The sets are pinned by a hash of their texts, so this file holds no key-shaped literal,
 * and a change to a generator, to the Python-compatible random stream under it, or to the scanner is a visible edit.
 *
 * The natural half of the investigation's T3 set (100 benign turns of LongMemEval-S) is benchmark text and never in
 * git: tests/eval/secret-guard-natural-turns.test.ts tests the code that rebuilds it, and the last block here checks the
 * whole set when RENOR_LONGMEMEVAL_S names the dataset.
 */
const T3_SYNTHETIC_SHA256 = '7baae89a130fb01d023b0896d5adffa1e49eaf815d72c28cc800bee114d2b348'; // 343 texts joined by a newline
const T3_FULL_SHA256 = 'e3c423c2cbd5470a82e79d2c2ab2c762aa9dedbdf4f8a1660be4a0b69dbb6b82'; // 443 texts: with the natural turns
const ROBUSTNESS_SHA256 = 'bc68076a0841c98c8a93e33519494737dd88cc2ef05b37190249261f7b449d24'; // 70 texts
// SHA-256 of the verdicts (block, redact or store, one per item, joined by a newline) that the investigation's own
// scanner (scanner.py, its report's Appendix E) gave these same items. A scanner that answers the same on every item
// hashes the same.
const PYTHON_T3_VERDICTS_SHA256 = '0216c4055b5c553fa4de245fe03d7d8a7af714fba70c66decf3553073c03ed83';
const PYTHON_ROBUSTNESS_VERDICTS_SHA256 = 'db9e6fef3e7e95429b48cc0449c6465489ed33a2c56752ba508038ad58774961';

/** How many items of each kind the scanner flags: [flagged, items]. */
function flaggedByKind(items: ReadonlyArray<{ kind: string; text: string }>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const it of items) {
    const row = (out[it.kind] ??= [0, 0]);
    row[1]++;
    if (scanSecrets(it.text)) row[0]++;
  }
  return out;
}

describe('the investigation\'s planted sets, regenerated', () => {
  const t3 = buildInvestigationT3();
  const robustness = buildInvestigationRobustness();

  it('T3 holds the investigation\'s 343 synthetic texts, byte for byte', () => {
    expect(t3).toHaveLength(343);
    expect(textsSha256(t3)).toBe(T3_SYNTHETIC_SHA256);
    expect(t3.map(i => i.id)).toEqual(Array.from({ length: 343 }, (_, i) => `t3-${String(i).padStart(3, '0')}`));
    const gold = (g: string) => t3.filter(i => i.gold === g).length;
    expect([gold('block'), gold('redact'), gold('store')]).toEqual([187, 56, 100]); // 187 credentials, 56 personal data, 100 hard benign
  });

  it('the robustness set holds the investigation\'s 70 texts, byte for byte', () => {
    expect(robustness).toHaveLength(70);
    expect(textsSha256(robustness)).toBe(ROBUSTNESS_SHA256);
    expect(robustness.map(i => i.id)).toEqual(Array.from({ length: 70 }, (_, i) => `t3r-${String(i).padStart(3, '0')}`));
  });

  it('is deterministic: a second build is identical', () => {
    expect(buildInvestigationT3()).toEqual(t3);
    expect(buildInvestigationRobustness()).toEqual(robustness);
  });

  it('names every planted value, and each one is in its text word for word', () => {
    for (const it of [...t3, ...robustness]) {
      for (const secret of it.secrets) expect(it.text, it.id).toContain(secret);
    }
    // all 243 planted T3 items have a value to look for; so do 44 of the 60 planted robustness items (an obfuscated form
    // is not stored word for word, so there is nothing to search for except in the split key's two halves)
    expect(t3.filter(i => i.gold !== 'store' && i.secrets.length > 0)).toHaveLength(243);
    expect(robustness.filter(i => i.gold !== 'store' && i.secrets.length > 0)).toHaveLength(44);
    expect(t3.filter(i => i.gold === 'store').every(i => i.secrets.length === 0)).toBe(true);
  });
});

describe('the scanner against the investigation\'s own', () => {
  const verdict = (text: string) => {
    const finding = scanSecrets(text);
    return finding === null ? 'store' : finding.class === 'credential' ? 'block' : 'redact';
  };
  const sha = (lines: string[]) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');

  it('gives, item by item, the verdict the investigation\'s scanner gave: 182 block, 56 redact, 105 store on T3', () => {
    const items = buildInvestigationT3();
    const verdicts = items.map(i => verdict(i.text));
    expect(sha(verdicts)).toBe(PYTHON_T3_VERDICTS_SHA256);
    expect([verdicts.filter(v => v === 'block').length, verdicts.filter(v => v === 'redact').length, verdicts.filter(v => v === 'store').length]).toEqual([182, 56, 105]);
  });

  it('and on the robustness set: 56 block, 4 redact, 10 store', () => {
    const verdicts = buildInvestigationRobustness().map(i => verdict(i.text));
    expect(sha(verdicts)).toBe(PYTHON_ROBUSTNESS_VERDICTS_SHA256);
    expect([verdicts.filter(v => v === 'block').length, verdicts.filter(v => v === 'redact').length, verdicts.filter(v => v === 'store').length]).toEqual([56, 4, 10]);
  });
});

describe('229 / 243, on the investigation\'s T3 set', () => {
  const r = measureSet('t3', buildInvestigationT3());

  it('refuses 229 of the 243 planted items: 176 of 187 credentials, 53 of 56 personal data', () => {
    expect(r.planted).toBe(243);
    expect(r.refuse.recall).toEqual([229, 243]);
    expect(r.refuse.credentialRecall).toEqual([176, 187]);
    expect(r.refuse.identifierRecall).toEqual([53, 56]);
  });

  it('what it misses is the investigation\'s list, and nothing else', () => {
    expect(r.refuse.missed).toEqual({ 'key:twilio': 3, 'key:hex64': 1, nl_credential: 7, pii_phone: 3 });
  });

  it('refuses 9 of the 100 hard benign texts (the other 100 of the 200 are the natural turns): 6 placeholders and 3 tracking numbers', () => {
    expect(r.benign).toBe(100);
    expect(r.refuse.falseBlock).toEqual([9, 100]);
    expect(r.refuse.falseBlockKinds).toEqual({ 'benign:placeholder': 6, 'benign:tracking': 3 });
  });

  it('matches every per-kind count the investigation\'s report gives', () => {
    const k = flaggedByKind(buildInvestigationT3());
    expect(k.nl_credential).toEqual([33, 40]); // credentials said in words
    expect([k['key:twilio'], k['key:hex64']]).toEqual([[4, 7], [6, 7]]); // bare 32- and 64-hex: 4 of 7 in the 32-hex case
    expect(k.pii_phone).toEqual([11, 14]);
    expect(k['benign:placeholder']).toEqual([6, 10]);
    expect(k['benign:tracking']).toEqual([3, 10]);
    // every other kind of provider key, key block, URL with a password, and secret inside useful text is caught
    for (const kind of Object.keys(k).filter(x => x.startsWith('key:') && x !== 'key:twilio' && x !== 'key:hex64')) expect(k[kind], kind).toEqual([7, 7]);
    for (const kind of ['pem', 'conn_string', 'secret_in_useful_text', 'pii_email', 'pii_card']) expect(k[kind][0], kind).toBe(k[kind][1]);
    // and the other seven kinds of benign text are left alone: git hashes, UUIDs, checksums, a data URI, versions and
    // addresses, talk about secrets, ordinary numbers and names
    for (const kind of Object.keys(k).filter(x => x.startsWith('benign:') && x !== 'benign:placeholder' && x !== 'benign:tracking')) expect(k[kind][0], kind).toBe(0);
  });
});

describe('refuse against redact, on the investigation\'s T3 set (the table in the results doc)', () => {
  const r = measureSet('t3', buildInvestigationT3());

  it('match-span redaction protects 217 of 243 and leaves 12 flagged items still holding a planted value', () => {
    expect(r.redactMatch.detected).toEqual([229, 243]);
    expect(r.redactMatch.leakFree).toEqual([217, 243]);
    expect(r.redactMatch.flaggedStillLeaking).toBe(12);
  });

  it('extended-span redaction protects 229 of 243, and costs about two thirds of every false positive', () => {
    expect(r.redactExtended.leakFree).toEqual([229, 243]);
    expect(r.redactExtended.flaggedStillLeaking).toBe(0);
    expect(r.redactMatch.alteredItemCharsReplaced).toEqual([180, 522]);
    expect(r.redactExtended.alteredItemCharsReplaced).toEqual([353, 522]);
  });

  it('a refusal stores nothing, so nothing leaks: the same 229 flagged items, no leak count to report', () => {
    expect(r.refuse.recall[0]).toBe(r.redactExtended.leakFree[0]);
    expect(r.redactMatch.falseRedact).toEqual([9, 100]);
    expect(r.redactExtended.falseRedact).toEqual([9, 100]);
    expect(r.redactMatch.residualFlagged).toBe(0);
    expect(r.redactExtended.residualFlagged).toBe(0);
  });
});

describe('the robustness set', () => {
  const items = buildInvestigationRobustness();
  const r = measureSet('robustness', items);

  it('catches a buried secret 20 of 20 and an injected "store" 20 of 20, and misses keys spaced apart 4 of 4', () => {
    const k = flaggedByKind(items);
    const buried = ['long_embedded:start', 'long_embedded:middle', 'long_embedded:end'].map(x => k[x]);
    expect(buried.reduce((a, [f]) => a + f, 0)).toBe(20);
    expect(buried.reduce((a, [, n]) => a + n, 0)).toBe(20);
    expect(k.injection).toEqual([20, 20]);
    expect(k['obfuscated:spaced']).toEqual([0, 4]);
    for (const kind of ['obfuscated:base64', 'obfuscated:reversed', 'obfuscated:split', 'obfuscated:spoken']) expect(k[kind], kind).toEqual([4, 4]);
  });

  it('refuses 56 of 60 and 4 of the 10 long benign texts', () => {
    expect(r.refuse.recall).toEqual([56, 60]);
    expect(r.refuse.missed).toEqual({ 'obfuscated:spaced': 4 });
    expect(r.refuse.falseBlock).toEqual([4, 10]);
    expect(r.refuse.falseBlockKinds).toEqual({ long_benign: 4 });
  });

  it('a split key survives both redactors, and a refusal protects it: 4 of 44 leak after a redaction, none after a refusal', () => {
    expect(r.redactMatch.leakFree).toEqual([40, 44]);
    expect(r.redactExtended.leakFree).toEqual([40, 44]);
    expect(r.redactMatch.flaggedStillLeaking).toBe(4);
    expect(r.redactExtended.flaggedStillLeaking).toBe(4);
  });
});

describe('investigationSets()', () => {
  it('without the dataset measures the synthetic 343 and the robustness set, and says so', () => {
    const [t3, robustness] = investigationSets();
    expect([t3.name, t3.items, t3.textsSha256]).toEqual(['investigation:t3-synthetic', 343, T3_SYNTHETIC_SHA256]);
    expect([robustness.name, robustness.items, robustness.textsSha256]).toEqual(['investigation:robustness', 70, ROBUSTNESS_SHA256]);
    expect(t3.refuse.recall).toEqual([229, 243]);
  });
});

// The whole T3 set needs the natural turns, which are LongMemEval-S text. Opt in with
//   RENOR_LONGMEMEVAL_S=~/bench-data/longmemeval_s.json npx vitest run tests/eval/secret-guard-investigation.test.ts
// It is skipped, and shown as skipped, wherever the dataset is not.
const DATASET = process.env.RENOR_LONGMEMEVAL_S;

describe.skipIf(!DATASET)('9 / 200 and 28 / 82,724, on the benchmark LongMemEval-S (skipped unless RENOR_LONGMEMEVAL_S names longmemeval_s.json: the benchmark is not in git; see the results doc)', () => {
  const questions = DATASET ? readLongMemEval(DATASET) : [];

  it('rebuilds the 100 natural turns as the pinned ones, and measures the investigation\'s headline', () => {
    const [t3] = investigationSets(questions);
    expect(t3.name).toBe('investigation:t3');
    expect([t3.items, t3.planted, t3.benign]).toEqual([443, 243, 200]);
    expect(t3.textsSha256).toBe(T3_FULL_SHA256);
    expect(t3.refuse.recall).toEqual([229, 243]);
    expect(t3.refuse.falseBlock).toEqual([9, 200]);
    expect(t3.refuse.falseBlockKinds).toEqual({ 'benign:placeholder': 6, 'benign:tracking': 3 }); // none of the natural turns
    expect(t3.redactExtended.alteredItemCharsReplaced).toEqual([353, 522]);
  }, 120_000);

  it('refuses 28 of the 82,724 user turns of the benchmark: 0.034 %, 27 on a cue word and 1 phone number', () => {
    const natural = measureNaturalTurns(questions);
    expect([natural.texts, natural.flagged]).toEqual([82724, 28]);
    expect(natural.byRule).toEqual({ 'credential-in-words': 27, phone: 1 });
    expect(natural.charsReplaced).toEqual({ match: [851, 8355], extended: [4208, 8355] });
  }, 120_000);
});
