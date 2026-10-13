import { describe, expect, it } from 'vitest';
import { contentfulText, isSpeakerStub } from '../../src/retrieval/orchestrator';

/**
 * Speaker-stub detection must survive every script and both colons.
 *
 * Reported defect (same family as the dedupe-identity #141 and lifecycle-query
 * #157 Unicode fixes): `contentfulText` and `isSpeakerStub` matched speaker cues
 * with `[A-Za-zÀ-ÿ]` — Latin-1 only — so a transcript label written in any other
 * script was not a cue. Because `contentBoost` and `dedupeHits` both key off
 * `contentfulText`, such a label-only chunk earned the length boost and blocked
 * stub-dedupe, surviving into embedded content.
 *
 * The full-width colon (U+FF1A) is the standard CJK speaker delimiter, so the
 * delimiter class is `[:：]` — matching only `:` would leave the largest
 * non-Latin script family exactly as broken as before (found by the independent
 * review of the first version of this change).
 *
 * Contract asserted here: a label-only line is structure for any script; a line
 * that carries answer text is content for any script.
 */
describe('speaker stubs across scripts', () => {
  it('recognises Latin-1 cues (unchanged behaviour)', () => {
    expect(isSpeakerStub('**Rowan:**')).toBe(true);
    expect(isSpeakerStub('Rowan:')).toBe(true);
    expect(contentfulText('**Rowan:**')).toBe('');
  });

  it('recognises a cue written in a non-Latin script', () => {
    for (const cue of ['東京:', '**東京:**', 'Пётр:', '- דוד:', '> अमित:']) {
      expect(isSpeakerStub(cue), `stub: ${cue}`).toBe(true);
      expect(contentfulText(cue), `visible: ${cue}`).toBe('');
    }
  });

  it('recognises a CJK cue written with the full-width colon', () => {
    for (const cue of ['李雷：', '**李雷：**', '田中：', '- 李雷：']) {
      expect(isSpeakerStub(cue), `stub: ${cue}`).toBe(true);
      expect(contentfulText(cue), `visible: ${cue}`).toBe('');
    }
  });

  it('strips a cue line and keeps the answer text', () => {
    expect(contentfulText('東京:\nRowan lives in Ørrvik.')).toBe('Rowan lives in Ørrvik.');
    expect(isSpeakerStub('東京:\nRowan lives in Ørrvik.')).toBe(false);
    expect(contentfulText('李雷：\nRowan lives in Ørrvik.')).toBe('Rowan lives in Ørrvik.');
  });

  it('keeps a line that carries answer text after the cue', () => {
    expect(isSpeakerStub('東京: he moved in 2026')).toBe(false);
    expect(contentfulText('東京: he moved in 2026')).toBe('東京: he moved in 2026');
    expect(isSpeakerStub('李雷：他搬家了')).toBe(false);
  });
});
