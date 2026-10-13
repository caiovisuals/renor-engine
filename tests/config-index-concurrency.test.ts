import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const ORIGINAL = process.env.INDEX_CONCURRENCY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INDEX_CONCURRENCY;
  else process.env.INDEX_CONCURRENCY = ORIGINAL;
  delete process.env.VAULT_PATH;
  delete process.env.OPENAI_API_KEY;
});

function loadWith(value: string) {
  process.env.VAULT_PATH = '/tmp/vault';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.INDEX_CONCURRENCY = value;
  return loadConfig();
}

describe('INDEX_CONCURRENCY validation', () => {
  it.each(['not-a-number', '1.5', '0', '-1', '21'])(
    'rejects invalid value %s instead of leaking an unusable concurrency',
    (value) => {
      expect(() => loadWith(value)).toThrow('INDEX_CONCURRENCY must be an integer between 1 and 20');
    },
  );

  it.each(['1', '5', '20'])('accepts valid value %s', (value) => {
    expect(loadWith(value).indexConcurrency).toBe(Number(value));
  });
});
