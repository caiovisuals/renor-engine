import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OLLAMA_KEY_ENV_NAMES, collectOllamaKeys, splitKeyList } from '../../src/evidence/keyPool';
import { resolveEvidenceToolOptions } from '../../src/evidence/options';
import { resolveExtractorClientConfig } from '../../src/extraction/extractionClient';

/**
 * The evidence second pass and the write-path extractor read the SAME Ollama
 * Cloud key namespace, and they used to disagree: the extractor named six env
 * vars, the evidence path named three.
 *
 * That drift is not cosmetic. Measured 2026-09-30 (issue #222): `KEY_1..3` had
 * all reached their MONTHLY ceiling, so the evidence extractor's pool was dead
 * while `KEY_4` / `OLLAMA_MAX_KEY` / `OLLAMA_API_KEY` were healthy. The evidence
 * pass is deliberately fail-open, so the last 77 of a 500-case run were
 * answered with the evidence layer silently absent — and the manifest reported
 * full coverage. Two hand-maintained copies of one list was the actual defect,
 * so these tests fail if either module starts re-listing names again.
 */

const OLLAMA_NAMES = [...OLLAMA_KEY_ENV_NAMES];
const ALL_VARS = [
  ...OLLAMA_NAMES,
  'RENOR_EVIDENCE_API_KEY',
  'RENOR_EVIDENCE_API_KEYS',
  'RENOR_EVIDENCE_BASE_URL',
  'RENOR_EXTRACTOR_API_KEY',
  'RENOR_EXTRACTOR_API_KEYS',
  'RENOR_EXTRACTOR_BASE_URL',
];

describe('Ollama key pool — one source of truth', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of ALL_VARS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ALL_VARS) delete process.env[key];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });

  it('collects every healthy name, in the declared order, and reports which ones supplied keys', () => {
    process.env.OLLAMA_CLOUD_KEY_2 = 'k2';
    process.env.OLLAMA_CLOUD_KEY_4 = 'k4';
    process.env.OLLAMA_MAX_KEY = 'km';
    const { keys, names } = collectOllamaKeys(process.env);
    expect(keys).toEqual(['k2', 'k4', 'km']);
    expect(names).toEqual(['OLLAMA_CLOUD_KEY_2', 'OLLAMA_CLOUD_KEY_4', 'OLLAMA_MAX_KEY']);
  });

  it('splits comma-separated values and drops blanks, the way the extractor always has', () => {
    process.env.OLLAMA_CLOUD_KEY_1 = ' a , b ,, c ';
    expect(splitKeyList(process.env.OLLAMA_CLOUD_KEY_1)).toEqual(['a', 'b', 'c']);
    expect(collectOllamaKeys(process.env).keys).toEqual(['a', 'b', 'c']);
    expect(collectOllamaKeys(process.env).names).toEqual(['OLLAMA_CLOUD_KEY_1']);
  });

  it('is the list BOTH readers see — evidence and extractor resolve the same six names', () => {
    // Only the last three names are set: exactly the shape of the #222 incident,
    // where the first three were exhausted and the healthy keys were the tail.
    process.env.OLLAMA_CLOUD_KEY_4 = 'k4';
    process.env.OLLAMA_MAX_KEY = 'km';
    process.env.OLLAMA_API_KEY = 'ka';

    const evidence = resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, process.env);
    expect(evidence.chat).toBeDefined();

    const extractor = resolveExtractorClientConfig(process.env, 'gemma4:31b');
    expect(extractor).not.toBeNull();
    expect(extractor!.provider).toBe('ollama-cloud');
    expect(extractor!.keyEnvNames).toEqual([
      'OLLAMA_CLOUD_KEY_4',
      'OLLAMA_MAX_KEY',
      'OLLAMA_API_KEY',
    ]);
  });

  it('keeps the evidence pass armed when ONLY a non-1..3 name carries a key (the #222 regression)', () => {
    process.env.OLLAMA_MAX_KEY = 'only-healthy-key';
    const evidence = resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, process.env);
    expect(evidence.chat, 'evidence extractor must still be armed on OLLAMA_MAX_KEY alone').toBeDefined();
  });

  it('still honours the dedicated evidence key when no Ollama name is set', () => {
    process.env.RENOR_EVIDENCE_API_KEY = 'dedicated';
    const evidence = resolveEvidenceToolOptions({ dbPath: '/tmp/x/product.db' }, process.env);
    expect(evidence.chat).toBeDefined();
    expect(collectOllamaKeys(process.env).keys).toEqual([]);
  });

  it('never re-lists an Ollama name in the two reader modules (drift guard)', () => {
    // The mechanism that broke was two hand-written copies of one list. This is
    // the check that catches the NEXT copy: neither module may name the Ollama
    // key namespace in code — not a literal name, and not a template built from
    // one (`OLLAMA_CLOUD_KEY_${i}` is exactly how the 3-name list was written
    // the first time), so the guard matches the whole `OLLAMA_` prefix.
    const root = path.resolve(__dirname, '../..');
    for (const rel of ['src/evidence/options.ts', 'src/extraction/extractionClient.ts']) {
      const source = readFileSync(path.join(root, rel), 'utf8');
      const offenders = source
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => {
          const t = line.trimStart();
          return !t.startsWith('*') && !t.startsWith('//') && line.includes('OLLAMA_');
        });
      expect(offenders, `${rel} must import collectOllamaKeys, not name the key namespace`)
        .toEqual([]);
    }
  });
});
