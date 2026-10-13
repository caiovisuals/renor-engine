import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadEvidenceSessionsFromVault,
  renderEvidencePrompt,
  EvidenceExtractor,
  type EvidenceChat,
} from '../../src/evidence/secondPass';
import { collectEvidence } from '../../src/evidence/attach';
import { EvidenceCache } from '../../src/evidence/evidenceCache';

/**
 * C1 second-pass evidence session-selection parity fixtures
 * (card HYP-20260921-evidence-session-parity, screen SCR-C1-SELECTION-PARITY).
 *
 * The selection fixture is RED against the shipped first-20-by-encounter-rank
 * cap (secondPass.ts): a target note ranked 21st+ by chunk rank has the
 * highest deterministic lexical query-term overlap in its hydrated body, so
 * body-relevance ranking must select it where encounter order drops it.
 * No gold fields anywhere; zero model calls and zero embeddings at query time.
 */

const tmpDirs: string[] = [];
function tmpVault(): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-bodyrank-'));
  tmpDirs.push(vault);
  return vault;
}
beforeEach(() => {
  delete process.env.RENOR_EVIDENCE_BODY_RANK;
});
afterEach(() => {
  delete process.env.RENOR_EVIDENCE_BODY_RANK;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const QUERY = 'how many days did the kyoto trip last in total';

/** 23 unique candidate notes; s21 ranks 21st by chunk rank but its body has
 *  by far the highest query-term overlap (stubs win chunk rank on headers). */
function buildSelectionVault(): { vault: string; paths: string[] } {
  const vault = tmpVault();
  const paths = Array.from({ length: 23 }, (_, i) => path.join(vault, `s${i}.md`));
  for (let i = 0; i < paths.length; i++) {
    const body = i === 21
      ? `# S21 header\n\nThe kyoto trip lasted 9 days. We remember the kyoto trip: it was 9 days total. \
Nine days, the kyoto trip, 9 days. The whole kyoto trip took 9 days of travel.`
      : `# S${i} kyoto header\n\nUnrelated meeting notes about sprint planning and standups (note ${i}).`;
    fs.writeFileSync(paths[i], body);
  }
  return { vault, paths };
}

function selectionHits(paths: string[]): Array<{ notePath: string; text: string }> {
  // 28 chunk hits covering 23 unique notes; ranks 23..27 duplicate s0..s4.
  const hits = paths.map((notePath, i) => ({ notePath, text: `retrieved chunk ${i}` }));
  for (let i = 0; i < 5; i++) hits.push({ notePath: paths[i], text: `dup chunk ${i}` });
  return hits;
}

describe('C1 body-relevance session selection (RENOR_EVIDENCE_BODY_RANK)', () => {
  it('selection fixture: selects the 21st-ranked note with the highest body term-overlap (RED vs shipped first-20-by-rank)', async () => {
    process.env.RENOR_EVIDENCE_BODY_RANK = '1';
    const { vault, paths } = buildSelectionVault();
    const selected = await loadEvidenceSessionsFromVault(selectionHits(paths), vault, { query: QUERY });
    expect(selected).toHaveLength(20);
    const stems = selected.map(s => s.stem);
    expect(new Set(stems).size).toBe(20);
    expect(stems).toContain(paths[21]);
    expect(selected[0].stem).toBe(paths[21]);
    // Hydrated complete body, never chunk text.
    expect(selected[0].text).toContain('kyoto trip lasted 9 days');
    expect(selected[0].text).not.toContain('retrieved chunk');
  });

  it('flag-off default keeps shipped first-20-by-encounter-rank behavior', async () => {
    const { vault, paths } = buildSelectionVault();
    const selected = await loadEvidenceSessionsFromVault(selectionHits(paths), vault);
    expect(selected).toHaveLength(20);
    expect(selected.map(s => s.stem)).toEqual(paths.slice(0, 20));
  });

  it('caps the complete hydrated body at the char cap under body ranking', async () => {
    process.env.RENOR_EVIDENCE_BODY_RANK = '1';
    const vault = tmpVault();
    const a = path.join(vault, 'a.md');
    const b = path.join(vault, 'b.md');
    fs.writeFileSync(a, '# A\n\nbudget note\n' + 'kyoto '.repeat(2000));
    fs.writeFileSync(b, '# B\n\nother note');
    const selected = await loadEvidenceSessionsFromVault([
      { notePath: a, text: 'chunk a' }, { notePath: b, text: 'chunk b' },
    ], vault, { maxSessions: 2, charCap: 6000 });
    expect(selected).toHaveLength(2);
    expect(selected[0].text.endsWith('…[truncated]')).toBe(true);
    expect(selected[0].text.length).toBe(6000 + ' …[truncated]'.length);
  });

  it('returns an explicit empty selection when no hit resolves to a readable note', async () => {
    process.env.RENOR_EVIDENCE_BODY_RANK = '1';
    const vault = tmpVault();
    const selected = await loadEvidenceSessionsFromVault([
      { notePath: path.join(vault, 'missing-1.md'), text: 'virtual' },
      { notePath: path.join(vault, 'missing-2.md'), text: 'virtual' },
    ], vault);
    expect(selected).toEqual([]);
  });

  it('is deterministic: same query + corpus twice -> identical selection and byte-identical rendered context', async () => {
    process.env.RENOR_EVIDENCE_BODY_RANK = '1';
    const { vault, paths } = buildSelectionVault();
    const first = await loadEvidenceSessionsFromVault(selectionHits(paths), vault, { query: QUERY });
    const second = await loadEvidenceSessionsFromVault(selectionHits(paths), vault, { query: QUERY });
    expect(second.map(s => s.stem)).toEqual(first.map(s => s.stem));
    expect(renderEvidencePrompt(QUERY, second)).toBe(renderEvidencePrompt(QUERY, first));
    // Tie-break determinism: all-equal scores must resolve by hit rank then notePath.
    const empty = await loadEvidenceSessionsFromVault(selectionHits(paths), vault, { query: 'zzzzunmatchable' });
    expect(empty.map(s => s.stem)).toEqual(paths.slice(0, 20));
  });
});

describe('C1 regression guards (must stay green)', () => {
  it('parse-error handling: extractor-parse-error after at most 3 attempts, never cached', async () => {
    const vault = tmpVault();
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nwe went camping for 3 days');
    let calls = 0;
    const chat = (async () => {
      calls += 1;
      return { content: 'items:\n  - item: camping\n    action: went', promptTokens: 10, completionTokens: 5, latencyMs: 1 } as any;
    }) as unknown as EvidenceChat;
    const cache = new EvidenceCache(path.join(tmpDirs[0] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-parse-')), 'cache.db'));
    const extractor = new EvidenceExtractor({ chat, cache });
    const attachment = await collectEvidence({
      query: 'How many days did we camp?',
      hits: [{ notePath: note, text: 'chunk' }],
      vaultPath: vault,
      options: { mode: 'always', maxSessions: 12, charCap: 6000 },
      extractor,
    });
    expect(attachment.status).toBe('skipped');
    expect(attachment.reason).toBe('extractor-parse-error');
    expect(calls).toBeLessThanOrEqual(3);
    expect(cache.stats().entries).toBe(0);
    cache.close();
  });

  it('explicit empty result: items=[] from the extractor is a legitimate ok result', async () => {
    const vault = tmpVault();
    const note = path.join(vault, 'a.md');
    fs.writeFileSync(note, '# A\n\nunrelated content');
    const chat = (async () => ({
      content: '{"items":[]}', promptTokens: 10, completionTokens: 2, latencyMs: 1,
    })) as unknown as EvidenceChat;
    const extractor = new EvidenceExtractor({ chat });
    const attachment = await collectEvidence({
      query: 'How many days did we camp?',
      hits: [{ notePath: note, text: 'chunk' }],
      vaultPath: vault,
      options: { mode: 'always', maxSessions: 12, charCap: 6000 },
      extractor,
    });
    expect(attachment.status).toBe('ok');
    expect(attachment.items).toEqual([]);
  });
});