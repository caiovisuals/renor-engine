import { describe, it, expect } from 'vitest';
import { resolveEvidenceToolOptions } from '../../src/evidence/options';
import { MAX_EVIDENCE_SESSIONS } from '../../src/evidence/secondPass';

/** The shipped coverage matches the promotion-grade 20-session arm. */
describe('evidence coverage knob (RENOR_EVIDENCE_SESSIONS)', () => {
  const cfg = { dbPath: '/tmp/x/product.db' };

  it('defaults to the shipped 20 sessions when the env var is absent', () => {
    expect(resolveEvidenceToolOptions(cfg, {}).maxSessions).toBe(MAX_EVIDENCE_SESSIONS);
    expect(MAX_EVIDENCE_SESSIONS).toBe(20);
  });

  it('honours an explicit value', () => {
    expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: '20' }).maxSessions).toBe(20);
    expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: '3' }).maxSessions).toBe(3);
  });

  it('treats blank / zero / negative / non-numeric as unset, never as a silent cap of 0', () => {
    for (const bad of ['', '   ', '0', '-5', 'many', 'NaN']) {
      expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: bad }).maxSessions)
        .toBe(MAX_EVIDENCE_SESSIONS);
    }
  });

  it('treats a value that floors below 1 as unset too, so a fraction cannot become 0 sessions', () => {
    // A fractional value is finite and strictly positive, so a bare `> 0`
    // validity test accepts it and Math.floor then yields 0. 0 is rejected
    // downstream (`maxSessions must be > 0` in loadEvidenceSessionsFromVault),
    // which is a thrown error on the `evidence` MCP tool and a swallowed
    // `extractor-error` on the search path — a misconfiguration reading as
    // failure, and, on the search path, as nothing at all. Pinned by the
    // unprimed review's blocker B1 on this branch (2026-09-26).
    for (const fractional of ['0.5', '0.9', '-0.5', '1e-9']) {
      expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: fractional }).maxSessions)
        .toBe(MAX_EVIDENCE_SESSIONS);
    }
    // The boundary is 1, and flooring is deliberate above it: 1 stays 1.
    expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: '1' }).maxSessions).toBe(1);
    expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: '1.9' }).maxSessions).toBe(1);
  });

  it('is bounded so a typo cannot request an unbounded prompt', () => {
    expect(resolveEvidenceToolOptions(cfg, { RENOR_EVIDENCE_SESSIONS: '9999' }).maxSessions).toBe(50);
  });
});
