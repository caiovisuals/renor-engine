export interface Config {
  vaultPath: string;
  dbPath: string;
  embeddingProvider: 'none' | 'openai' | 'local' | 'eval-hash';
  openaiApiKey?: string;
  embeddingModel?: string;
  embeddingBaseURL?: string;
  embeddingDims?: number;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  priorityPaths: string[];
  memoryDir: string;
  memoryLedger: string;
  llmExtraction: boolean;
  indexConcurrency: number;
}

export function loadConfig(): Config {
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH environment variable is required');

  const rawProvider = process.env.EMBEDDING_PROVIDER ?? 'none';
  if (rawProvider !== 'none' && rawProvider !== 'openai' && rawProvider !== 'local' && rawProvider !== 'eval-hash') {
    throw new Error(`Invalid EMBEDDING_PROVIDER "${rawProvider}": must be "none", "openai", "local", or "eval-hash"`);
  }
  // eval-hash: deterministic lexical embeddings for evaluation smoke/contract
  // runs through the public CLI surface (offline, no model download, no
  // semantic-quality claim). Same provider CI already uses for RenorBench smoke.
  const embeddingProvider = rawProvider as Config['embeddingProvider'];

  if (embeddingProvider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key.trim() === '') {
      throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER is "openai"');
    }
  }

  const chunkMaxTokens = Number(process.env.CHUNK_MAX_TOKENS ?? 400);
  if (!Number.isFinite(chunkMaxTokens) || chunkMaxTokens <= 0) {
    throw new Error('CHUNK_MAX_TOKENS must be a positive number');
  }

  const chunkOverlapTokens = Number(process.env.CHUNK_OVERLAP_TOKENS ?? 50);
  if (!Number.isFinite(chunkOverlapTokens) || chunkOverlapTokens < 0) {
    throw new Error('CHUNK_OVERLAP_TOKENS must be a non-negative number');
  }

  if (chunkOverlapTokens >= chunkMaxTokens) {
    throw new Error('CHUNK_OVERLAP_TOKENS must be less than CHUNK_MAX_TOKENS');
  }

  const indexConcurrency = Number(process.env.INDEX_CONCURRENCY ?? 5);
  if (!Number.isInteger(indexConcurrency) || indexConcurrency < 1 || indexConcurrency > 20) {
    throw new Error('INDEX_CONCURRENCY must be an integer between 1 and 20');
  }

  const rawPriorityPaths = process.env.PRIORITY_PATHS ?? '';
  const priorityPaths = rawPriorityPaths ? rawPriorityPaths.split(',').map(p => p.trim()).filter(Boolean) : [];

  return {
    vaultPath,
    dbPath: process.env.DB_PATH ?? `${vaultPath}/.semantic-memory/index.db`,
    embeddingProvider,
    openaiApiKey: process.env.OPENAI_API_KEY,
    embeddingModel: process.env.EMBEDDING_MODEL,
    embeddingBaseURL: process.env.EMBEDDING_BASE_URL,
    embeddingDims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
    chunkMaxTokens,
    chunkOverlapTokens,
    priorityPaths,
    memoryDir: process.env.MEMORY_DIR ?? 'Memory/Daily',
    memoryLedger: process.env.MEMORY_LEDGER ?? 'System/Memory Events Ledger.md',
    llmExtraction: process.env.LLM_EXTRACTION === 'true',
    indexConcurrency,
  };
}
