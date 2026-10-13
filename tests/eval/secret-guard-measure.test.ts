import { describe, it, expect } from 'vitest';
import { flaggedSpans, measureSet, measureTexts, redact, wilson } from '../../scripts/eval/secret-guard/measure';
import { KEY_SHAPES, NATURAL_BENIGN, Rng, buildPlantedSet, buildRobustnessSet } from '../../scripts/eval/secret-guard/plantedSet';
import { scanSecrets } from '../../src/extraction/secretScanner';

/**
 * The measurement behind the refuse-or-redact decision (scripts/eval/secret-guard/measure.ts). Redaction is NOT
 * shipped; these tests pin what the measurement does, so the comparison in the results doc can be trusted and
 * re-run. Planted synthetic secrets only.
 */

describe('the redactors', () => {
  const r = new Rng(31);
  const words = ['maple', 'orbit', 'canyon', 'velvet', 'harbor', 'copper', 'lantern', 'meadow', 'falcon', 'quartz', 'ember', 'willow'];
  const seed = `my wallet seed phrase: ${words.join(' ')}`;

  it('a match-only redactor takes the first word of a seed phrase and leaves the other eleven', () => {
    const out = redact(seed, false);
    expect(out).toContain('[redacted]');
    expect(words.filter(w => out.includes(w))).toHaveLength(11);
  });

  it('an extended redactor takes the rest of the line, and only that line', () => {
    const out = redact(`${seed}\nthe next line is not a secret`, true);
    expect(words.filter(w => out.includes(w))).toEqual([]);
    expect(out).toContain('the next line is not a secret');
  });

  it('takes the body of a private key out in both: the text says "key", so each long line is flagged on its own', () => {
    const body = Array.from({ length: 5 }, () => r.str(64));
    const pem = `my deploy key:\n-----BEGIN RSA PRIVATE KEY-----\n${body.join('\n')}\n-----END RSA PRIVATE KEY-----\nthat was it`;
    for (const extend of [false, true]) {
      const out = redact(pem, extend);
      expect(body.filter(l => out.includes(l)), `extend=${extend}`).toEqual([]);
      expect(out).toContain('that was it');
    }
    // the extension reaches the END line too, which a match-only redactor leaves
    expect(redact(pem, false)).toContain('-----END RSA PRIVATE KEY-----');
    expect(redact(pem, true)).not.toContain('-----END RSA PRIVATE KEY-----');
  });

  it('takes the user and password out of a URL in both, whatever the scheme looks like', () => {
    const pw = r.str(14);
    for (const extend of [false, true]) {
      const out = redact(`DATABASE_URL=postgres://app:${pw}@db.example.com:5432/app`, extend);
      expect(out).not.toContain(pw);
      expect(out.startsWith('DATABASE_URL=postgres')).toBe(true);
    }
  });

  it('cannot take back a key that was split in two: the half the scanner does not recognise survives both', () => {
    const k = KEY_SHAPES.openai_proj(r);
    const half = k.length >> 1;
    const text = `key part one: ${k.slice(0, half)}\nkey part two: ${k.slice(half)}`;
    for (const extend of [false, true]) expect(redact(text, extend)).toContain(k.slice(half));
    expect(scanSecrets(text)).not.toBeNull(); // so a refusal still protects it
  });

  it('writes a placeholder that cannot flag itself on the next save', () => {
    const out = redact(seed, true);
    expect(out).toBe('my wallet [redacted]');
    expect(scanSecrets(out)).toBeNull();
  });

  it('leaves benign text exactly as it is', () => {
    for (const text of NATURAL_BENIGN) {
      expect(redact(text, false)).toBe(text);
      expect(redact(text, true)).toBe(text);
      expect(flaggedSpans(text, true)).toEqual([]);
    }
  });

  it('merges spans that touch, so a text with two findings has one placeholder per run', () => {
    const out = redact(`card 4242 4242 4242 4242 and mail jo.doe@example.com`, false);
    expect(out.match(/\[redacted\]/g)).toHaveLength(2);
    expect(out).not.toContain('4242');
    expect(out).not.toContain('jo.doe');
    expect(out).toContain('mail ');
  });
});

describe('the numbers', () => {
  it('computes a Wilson 95 % interval', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 0)).toEqual([0, 0]);
    expect(wilson(0, 200)[0]).toBe(0);
    expect(wilson(229, 243)[0]).toBeCloseTo(0.9, 1);
  });

  it('pins refuse against both redactors on the mirror set: redaction leaks, or it erases', () => {
    const r = measureSet('mirror:planted', buildPlantedSet());
    expect(r.refuse.recall).toEqual([222, 243]);
    expect(r.refuse.falseBlock).toEqual([12, 130]);
    // Match spans: every flagged item is altered, and 10 of them still hold a planted value (seed phrases, code lists,
    // a password after a second cue).
    expect(r.redactMatch.detected).toEqual([222, 243]);
    expect(r.redactMatch.leakFree).toEqual([212, 243]);
    expect(r.redactMatch.flaggedStillLeaking).toBe(10);
    // Extended spans: no flagged item leaks, and a false positive loses more than half of its characters.
    expect(r.redactExtended.leakFree).toEqual([222, 243]);
    expect(r.redactExtended.flaggedStillLeaking).toBe(0);
    expect(r.redactExtended.falseRedact).toEqual([12, 130]);
    const [replaced, chars] = r.redactExtended.alteredItemCharsReplaced;
    expect(replaced / chars).toBeGreaterThan(0.5);
    expect(r.redactMatch.alteredItemCharsReplaced[0]).toBeLessThan(replaced);
    // A placeholder never flags itself.
    expect(r.redactMatch.residualFlagged).toBe(0);
    expect(r.redactExtended.residualFlagged).toBe(0);
  });

  it('pins the robustness set: a split key leaks under both redactors and is protected by a refusal', () => {
    const r = measureSet('mirror:robustness', buildRobustnessSet());
    expect(r.refuse.recall).toEqual([55, 60]);
    expect(r.refuse.falseBlock).toEqual([0, 10]);
    expect(r.redactMatch.flaggedStillLeaking).toBe(3);
    expect(r.redactExtended.flaggedStillLeaking).toBe(3);
  });

  it('counts false blocks and the characters each redactor would replace in benign texts', () => {
    const quiet = measureTexts('quiet', NATURAL_BENIGN);
    expect(quiet).toMatchObject({ texts: 30, flagged: 0, byRule: {} });
    const mixed = measureTexts('mixed', [...NATURAL_BENIGN, 'the secret is amazing, honestly, said the neighbour', 'Invoice 2023-4567-8901 is due on the 15th.']);
    expect(mixed.texts).toBe(32);
    expect(mixed.flagged).toBe(2);
    expect(mixed.byRule).toEqual({ 'credential-in-words': 1, phone: 1 });
    expect(mixed.charsReplaced.extended[0]).toBeGreaterThan(mixed.charsReplaced.match[0]);
  });
});
