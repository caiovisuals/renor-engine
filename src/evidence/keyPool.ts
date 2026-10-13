import { DEFAULT_CHAT_BASE_URL } from './ollamaChat';

/**
 * ONE source of truth for the Ollama Cloud key pool.
 *
 * WHY THIS FILE EXISTS
 *   Two modules read the same env namespace and they disagreed. The write-path
 *   extractor (`extraction/extractionClient.ts`) resolved SIX names; the
 *   evidence second pass (`evidence/options.ts`) resolved THREE, and the three
 *   it named were the first three of the other list. On 2026-09-30 that drift
 *   cost a 500-case product run: `OLLAMA_CLOUD_KEY_1..3` had all hit their
 *   MONTHLY ceiling (429) while `OLLAMA_CLOUD_KEY_4`, `OLLAMA_MAX_KEY` and
 *   `OLLAMA_API_KEY` were healthy, so the evidence extractor exhausted its pool
 *   and — because `attachSearchEvidence` is deliberately fail-open — the last 77
 *   of 500 cases were answered with the evidence layer silently absent. The run
 *   manifest reported full coverage and zero `evid*` keys: a run that lost its
 *   evidence layer for 15% of cases was byte-indistinguishable from one where it
 *   held. See issue #222.
 *
 * The defect was not a missing key. It was two hand-maintained copies of one
 * list. Keys are read by env-var NAME; values are never logged here.
 */
export const OLLAMA_KEY_ENV_NAMES = [
  'OLLAMA_CLOUD_KEY_1',
  'OLLAMA_CLOUD_KEY_2',
  'OLLAMA_CLOUD_KEY_3',
  'OLLAMA_CLOUD_KEY_4',
  'OLLAMA_MAX_KEY',
  'OLLAMA_API_KEY',
] as const;

/** Comma-separated env value -> trimmed, non-empty keys. */
export function splitKeyList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(key => key.trim()).filter(Boolean);
}

/**
 * Collect every configured Ollama key, in the fixed name order above, together
 * with the names that supplied them. `names` is safe to report; `keys` is not.
 */
export function collectOllamaKeys(
  env: NodeJS.ProcessEnv = process.env,
): { keys: string[]; names: string[] } {
  const keys: string[] = [];
  const names: string[] = [];
  for (const name of OLLAMA_KEY_ENV_NAMES) {
    const found = splitKeyList(env[name]);
    if (found.length > 0) {
      keys.push(...found);
      names.push(name);
    }
  }
  return { keys, names };
}

/**
 * Whether `baseUrl` is Ollama Cloud, the only issuer these keys belong to:
 * https on ollama.com or a subdomain of it. Blank means the transport default,
 * which is Ollama Cloud. A look-alike host, plain http or an unparseable URL is
 * not.
 */
export function isOllamaCloudEndpoint(baseUrl: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || DEFAULT_CHAT_BASE_URL);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (host === 'ollama.com' || host.endsWith('.ollama.com'));
}

/**
 * The Ollama pool for a client that will call `baseUrl`: every key when that
 * is Ollama Cloud, none otherwise.
 *
 * The evidence client used to append this pool to whatever endpoint
 * RENOR_EVIDENCE_BASE_URL named, so pointing the extractor at another provider
 * sent every leftover OLLAMA_* key there too: a credential leak, and a 401 on
 * each search whose turn in the rotation fell on an Ollama key.
 */
export function ollamaKeysForEndpoint(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { keys: string[]; names: string[] } {
  return isOllamaCloudEndpoint(baseUrl) ? collectOllamaKeys(env) : { keys: [], names: [] };
}
