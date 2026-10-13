import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env.VAULT_PATH;
    delete process.env.DB_PATH;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CHUNK_MAX_TOKENS;
    delete process.env.CHUNK_OVERLAP_TOKENS;
    delete process.env.PRIORITY_PATHS;
    delete process.env.MEMORY_DIR;
    delete process.env.EMBEDDING_MODEL;
  });

  afterEach(() => {
    delete process.env.VAULT_PATH;
    delete process.env.DB_PATH;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CHUNK_MAX_TOKENS;
    delete process.env.CHUNK_OVERLAP_TOKENS;
    delete process.env.PRIORITY_PATHS;
    delete process.env.MEMORY_DIR;
    delete process.env.EMBEDDING_MODEL;
  });

  it('loads VAULT_PATH from env', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.DB_PATH = '/tmp/test.db';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(loadConfig().vaultPath).toBe('/tmp/vault');
  });

  it('throws when VAULT_PATH missing', () => {
    expect(() => loadConfig()).toThrow('VAULT_PATH');
  });

  it('has sensible defaults', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.DB_PATH = '/tmp/test.db';
    process.env.OPENAI_API_KEY = 'sk-test';
    const c = loadConfig();
    expect(c.embeddingProvider).toBe('openai');
    expect(c.chunkMaxTokens).toBe(400);
    expect(c.chunkOverlapTokens).toBe(50);
  });

  // embeddingProvider validation
  it('throws when EMBEDDING_PROVIDER is an invalid value', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.EMBEDDING_PROVIDER = 'cohere';
    expect(() => loadConfig()).toThrow('Invalid EMBEDDING_PROVIDER');
  });

  it('accepts EMBEDDING_PROVIDER "local" without OPENAI_API_KEY', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.EMBEDDING_PROVIDER = 'local';
    delete process.env.OPENAI_API_KEY;
    const config = loadConfig();
    expect(config.embeddingProvider).toBe('local');
  });

  // OPENAI_API_KEY validation (issue #5)
  it('throws when EMBEDDING_PROVIDER is "openai" and OPENAI_API_KEY is missing', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.EMBEDDING_PROVIDER = 'openai';
    expect(() => loadConfig()).toThrow('OPENAI_API_KEY');
  });

  it('throws when EMBEDDING_PROVIDER is "openai" and OPENAI_API_KEY is empty string', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';
    expect(() => loadConfig()).toThrow('OPENAI_API_KEY');
  });

  it('throws when EMBEDDING_PROVIDER is "openai" and OPENAI_API_KEY is whitespace only', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '   ';
    expect(() => loadConfig()).toThrow('OPENAI_API_KEY');
  });

  it('succeeds when EMBEDDING_PROVIDER is "openai" and OPENAI_API_KEY is provided', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-valid-key';
    const c = loadConfig();
    expect(c.openaiApiKey).toBe('sk-valid-key');
  });

  // chunkMaxTokens validation
  it('throws when CHUNK_MAX_TOKENS is NaN', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_MAX_TOKENS = 'not-a-number';
    expect(() => loadConfig()).toThrow('CHUNK_MAX_TOKENS must be a positive number');
  });

  it('throws when CHUNK_MAX_TOKENS is zero', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_MAX_TOKENS = '0';
    expect(() => loadConfig()).toThrow('CHUNK_MAX_TOKENS must be a positive number');
  });

  it('throws when CHUNK_MAX_TOKENS is negative', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_MAX_TOKENS = '-100';
    expect(() => loadConfig()).toThrow('CHUNK_MAX_TOKENS must be a positive number');
  });

  // chunkOverlapTokens validation
  it('throws when CHUNK_OVERLAP_TOKENS is NaN', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_OVERLAP_TOKENS = 'not-a-number';
    expect(() => loadConfig()).toThrow('CHUNK_OVERLAP_TOKENS must be a non-negative number');
  });

  it('allows CHUNK_OVERLAP_TOKENS to be zero (disables overlap)', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_OVERLAP_TOKENS = '0';
    expect(loadConfig().chunkOverlapTokens).toBe(0);
  });

  it('throws when CHUNK_OVERLAP_TOKENS is negative', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_OVERLAP_TOKENS = '-10';
    expect(() => loadConfig()).toThrow('CHUNK_OVERLAP_TOKENS must be a non-negative number');
  });

  // overlap < max constraint
  it('throws when CHUNK_OVERLAP_TOKENS equals CHUNK_MAX_TOKENS', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_MAX_TOKENS = '100';
    process.env.CHUNK_OVERLAP_TOKENS = '100';
    expect(() => loadConfig()).toThrow('CHUNK_OVERLAP_TOKENS must be less than CHUNK_MAX_TOKENS');
  });

  it('throws when CHUNK_OVERLAP_TOKENS exceeds CHUNK_MAX_TOKENS', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_MAX_TOKENS = '100';
    process.env.CHUNK_OVERLAP_TOKENS = '200';
    expect(() => loadConfig()).toThrow('CHUNK_OVERLAP_TOKENS must be less than CHUNK_MAX_TOKENS');
  });

  it('succeeds with valid chunk token values', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CHUNK_MAX_TOKENS = '400';
    process.env.CHUNK_OVERLAP_TOKENS = '50';
    const c = loadConfig();
    expect(c.chunkMaxTokens).toBe(400);
    expect(c.chunkOverlapTokens).toBe(50);
  });

  it('defaults PRIORITY_PATHS to empty array', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.PRIORITY_PATHS;
    const config = loadConfig();
    expect(config.priorityPaths).toEqual([]);
  });

  it('defaults MEMORY_DIR to Memory/Daily', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    const config = loadConfig();
    expect(config.memoryDir).toBe('Memory/Daily');
  });

  it('reads MEMORY_DIR from env', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.MEMORY_DIR = 'Notes/Journal';
    const config = loadConfig();
    expect(config.memoryDir).toBe('Notes/Journal');
  });

  it('reads EMBEDDING_MODEL from env', () => {
    process.env.VAULT_PATH = '/tmp/vault';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.EMBEDDING_MODEL = 'custom-model';
    const config = loadConfig();
    expect(config.embeddingModel).toBe('custom-model');
  });
});
