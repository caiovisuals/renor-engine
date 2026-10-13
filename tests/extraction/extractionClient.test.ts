import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExtractorClient,
  openExtractorClient,
  resolveExtractorClientConfig,
  isExtractorSpecificProvider,
} from '../../src/extraction/extractionClient';

/**
 * The write-path client must name a provider. No key, and a bare
 * OPENAI_API_KEY with no base URL, both return null so the lane stays
 * unarmed instead of calling api.openai.com.
 *
 * JSON mode is part of the request. The extractors send
 * response_format: { type: 'json_object' }. Ollama's OpenAI-compatible route
 * maps that field to its own format:"json". Dropping it is a silent no-op.
 * Evidence calls omit the field, and those request bodies stay without it.
 */

const EXTRACTOR_VARS = [
  'RENOR_EXTRACTOR_API_KEY',
  'RENOR_EXTRACTOR_API_KEYS',
  'RENOR_EXTRACTOR_BASE_URL',
  'OLLAMA_CLOUD_KEY_1',
  'OLLAMA_CLOUD_KEY_2',
  'OLLAMA_CLOUD_KEY_3',
  'OLLAMA_CLOUD_KEY_4',
  'OLLAMA_MAX_KEY',
  'OLLAMA_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'EMBEDDING_BASE_URL',
];

describe('extractionClient — provider resolution', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of EXTRACTOR_VARS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of EXTRACTOR_VARS) delete process.env[key];
    Object.assign(process.env, saved);
    vi.restoreAllMocks();
  });

  it('resolves Ollama Cloud keys to the Ollama base URL', () => {
    process.env.OLLAMA_CLOUD_KEY_1 = 'k1';
    process.env.OLLAMA_CLOUD_KEY_2 = 'k2';
    const config = resolveExtractorClientConfig(process.env, 'gemma4:31b');
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe('https://ollama.com/v1');
    expect(config!.keys).toEqual(['k1', 'k2']);
    expect(config!.model).toBe('gemma4:31b');
    expect(config!.keyEnvNames).toEqual(['OLLAMA_CLOUD_KEY_1', 'OLLAMA_CLOUD_KEY_2']);
    expect(JSON.stringify(config!.keyEnvNames)).not.toContain('k1');
    expect(config!.provider).toBe('ollama-cloud');
    expect(isExtractorSpecificProvider(config)).toBe(true);
  });

  it('returns null when no extractor provider is configured', () => {
    expect(resolveExtractorClientConfig(process.env, 'gemma4:31b')).toBeNull();
    expect(openExtractorClient('gemma4:31b', process.env)).toBeNull();
  });

  it('refuses a bare OPENAI_API_KEY with no base URL', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(resolveExtractorClientConfig(process.env, 'gemma4:31b')).toBeNull();
  });

  it('accepts an OpenAI-compatible provider only when a base URL is named', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    const config = resolveExtractorClientConfig(process.env, 'gemma4:31b');
    expect(config!.baseUrl).toBe('https://example.invalid/v1');
    expect(config!.keyEnvNames).toEqual(['OPENAI_API_KEY']);
    // The fallback is not one of the extractor-specific providers, so it is the
    // branch the legacy fact path keeps its own default model on.
    expect(config!.provider).toBe('openai-fallback');
    expect(isExtractorSpecificProvider(config)).toBe(false);
  });

  it('prefers the explicit extractor slot over the Ollama pool', () => {
    process.env.OLLAMA_CLOUD_KEY_1 = 'ollama';
    process.env.RENOR_EXTRACTOR_API_KEY = 'dedicated';
    process.env.RENOR_EXTRACTOR_BASE_URL = 'https://dedicated.invalid/v1';
    const config = resolveExtractorClientConfig(process.env, 'gemma4:31b');
    expect(config!.baseUrl).toBe('https://dedicated.invalid/v1');
    expect(config!.keys).toEqual(['dedicated']);
    expect(config!.provider).toBe('dedicated');
    expect(isExtractorSpecificProvider(config)).toBe(true);
  });
});

describe('extractionClient — request routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(calls: Array<{ url: string; init: RequestInit }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"facts":[{"value":"5","object":"km run"}]}' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        text: async () => '',
      } as unknown as Response;
    }));
  }

  it('forwards response_format json_object and does not add it when omitted', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    stubFetch(calls);

    const client = createExtractorClient({
      baseUrl: 'https://ollama.com/v1',
      keys: ['secret-key'],
      model: 'gemma4:31b',
      provider: 'ollama-cloud',
      keyEnvNames: ['OLLAMA_CLOUD_KEY_1'],
    });

    const response = await client.chat.completions.create({
      model: 'gemma4:31b',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'note body' },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ollama.com/v1/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      temperature: number;
      response_format?: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gemma4:31b');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(response.choices[0].message.content).toContain('"facts"');
    expect(response.usage.prompt_tokens).toBe(11);

    await client.chat.completions.create({
      model: 'gemma4:31b',
      messages: [{ role: 'user', content: 'evidence' }],
    });
    const plain = JSON.parse(String(calls[1].init.body)) as { response_format?: unknown };
    expect(plain.response_format).toBeUndefined();
  });

  it('does not retry a non-429 4xx', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => 'bad request',
      } as unknown as Response;
    }));

    const client = createExtractorClient({
      baseUrl: 'https://ollama.com/v1',
      keys: ['secret-key', 'second-key'],
      model: 'gemma4:31b',
      provider: 'ollama-cloud',
      keyEnvNames: ['OLLAMA_CLOUD_KEY_1'],
    });

    await expect(client.chat.completions.create({
      model: 'gemma4:31b',
      messages: [{ role: 'user', content: 'note' }],
    })).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });
});
