import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import { LocalEmbeddingProvider } from '../../src/embeddings/local';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { MetadataVertexEmbeddingProvider } from './benchmark-embed-vertex';
import { resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import type { EmbeddingProvider } from '../../src/embeddings/types';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { safeEndpoint } from '../../src/eval/artifacts';
import { resolveRunLedgerPath, RUN_LEDGER_ENV, RunRefusedError } from '../../src/eval/runLedger';
import { LME_V2_DOMAINS, LME_V2_TIERS, type LmeV2Domain, type LmeV2Tier } from './longmemeval-v2/data';
import { httpChat, readIdsFile, runQaStage, runRetrievalStage, scoreQaRuns, stubChat } from './longmemeval-v2/runner';

/**
 * LongMemEval-V2 adapter. Protocol and commands: docs/evals/LONGMEMEVAL-V2.md.
 *
 *   npm run eval:longmem:v2 -- retrieve --data-root <dir> --tier small --domain web --output <dir>
 *   npm run eval:longmem:v2 -- qa --run <retrieval dir> --output <dir>
 *   npm run eval:longmem:v2 -- dry-run --data-root tests/fixtures/longmemeval-v2 --output <dir>
 *   npm run eval:longmem:v2:score -- --qa <web qa dir> --qa <enterprise qa dir> --output report.json
 */

function makeProvider(kind: string, modelArg?: string): { provider: EmbeddingProvider; meta: Record<string, unknown> } {
  if (kind === 'hash') {
    const provider = new EvalHashEmbeddingProvider();
    return { provider, meta: { kind: 'hash', model: provider.identity.model, dimensions: provider.dimensions } };
  }
  if (kind === 'local') {
    const model = modelArg ?? process.env.RENOR_EVAL_MODEL ?? 'Xenova/multilingual-e5-base';
    const provider = new LocalEmbeddingProvider(model);
    return { provider, meta: { kind: 'local', model, dimensions: provider.dimensions } };
  }
  if (kind === 'vertex') {
    const provider = new VertexEmbeddingProvider();
    return { provider, meta: { kind: 'vertex', model: provider.model, dimensions: provider.dimensions, location: provider.describe().location } };
  }
  if (kind === 'metadata') {
    // Benchmark sweep VM only: the same Vertex model through the instance's service account (no key file). The
    // retrieval stage still wraps it in the embedding cache, so a cached text makes no call; a miss is billed, so
    // RENOR_EVAL_MAX_EMBED_TOKENS bounds it.
    const provider = new MetadataVertexEmbeddingProvider({
      project: process.env.RENOR_EVAL_VERTEX_PROJECT ?? '',
      location: process.env.RENOR_EVAL_VERTEX_LOCATION ?? '',
      maxInputTokens: Number(process.env.RENOR_EVAL_MAX_EMBED_TOKENS ?? 80_000_000),
    });
    return { provider, meta: { kind: 'metadata-vertex', model: provider.identity.model, dimensions: provider.dimensions, location: process.env.RENOR_EVAL_VERTEX_LOCATION ?? '' } };
  }
  if (kind === 'openai') {
    const keys = (process.env.RENOR_EVAL_EMBEDDING_API_KEY ?? process.env.MVP_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? '')
      .split(',').map(value => value.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error('OpenAI-compatible eval provider requires RENOR_EVAL_EMBEDDING_API_KEY, MVP_EMBEDDING_API_KEY, or OPENAI_API_KEY');
    const model = modelArg ?? process.env.RENOR_EVAL_MODEL ?? 'voyage-4-large';
    const baseURL = safeEndpoint(process.env.RENOR_EVAL_EMBEDDING_BASE_URL ?? process.env.MVP_EMBEDDING_BASE_URL ?? 'https://api.voyageai.com/v1');
    const dimensions = Number(process.env.RENOR_EVAL_EMBEDDING_DIMS ?? 1024);
    if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 8192) throw new Error('RENOR_EVAL_EMBEDDING_DIMS must be an integer between 8 and 8192');
    return { provider: new OpenAIEmbeddingProvider(keys, model, baseURL, dimensions), meta: { kind: 'openai', model, dimensions, baseURL } };
  }
  throw new Error(`Unknown provider ${kind}; expected vertex, local, openai or hash`);
}

function int(value: string, flag: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${flag} must be an integer >= ${min}`);
  return parsed;
}

function optionalPositiveInt(value: string | undefined, flag: string): number | undefined {
  return value === undefined ? undefined : int(value, flag, 1);
}

function tierOf(value: string): LmeV2Tier {
  if (!LME_V2_TIERS.includes(value as LmeV2Tier)) throw new Error('--tier must be small or medium');
  return value as LmeV2Tier;
}

function domainOf(value: string): LmeV2Domain {
  if (!LME_V2_DOMAINS.includes(value as LmeV2Domain)) throw new Error('--domain must be web or enterprise');
  return value as LmeV2Domain;
}

const program = new Command().name('run-longmemeval-v2');

program.command('retrieve')
  .description('ingest each haystack into an isolated Renor workspace and retrieve context for every question')
  .requiredOption('--data-root <dir>', 'LongMemEval-V2 data root (questions.jsonl, trajectories.jsonl, haystacks/); kept outside git')
  .requiredOption('--domain <domain>', 'web or enterprise (upstream runs each domain separately)')
  .option('--tier <tier>', 'haystack tier: small or medium', 'small')
  .option('--provider <kind>', 'embedding provider: vertex (default, cached), metadata (benchmark sweep VM: the instance service account, cached), local, openai, or hash (no network, no quality claim)', process.env.RENOR_EVAL_PROVIDER ?? 'vertex')
  .option('--model <name>', 'embedding model override')
  .option('--top-k <n>', 'retrieval depth', '20')
  .option('--limit <n>', 'maximum selected questions; 0 = all', '20')
  .option('--offset <n>', 'skip selected questions before limit', '0')
  .option('--ids-file <path>', 'run only the question ids listed in this file (one per line; # comments ok)')
  .option('--max-state-chars <n>', 'cap each state\'s page text at N characters when rendering trajectories; 0 = whole', '0')
  .option('--output <dir>', 'artifact directory; default .eval-runs/lme-v2-<domain>-<tier>-<timestamp>')
  .option('--keep-workdirs', 'preserve the temporary workspaces for debugging')
  .option('--rerun-reason <text>', `run even though this exact configuration is already on the run ledger (${RUN_LEDGER_ENV}); the reason is recorded`)
  .action(async (o: Record<string, string | boolean | undefined>) => {
    const domain = domainOf(String(o.domain));
    const tier = tierOf(String(o.tier));
    const { provider, meta } = makeProvider(String(o.provider), o.model as string | undefined);
    const concurrency = Number(process.env.RENOR_EVAL_INDEX_CONCURRENCY ?? 4);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid index concurrency');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await runRetrievalStage({
      dataRoot: String(o.dataRoot),
      tier,
      domain,
      outputDir: (o.output as string | undefined) ?? path.join('.eval-runs', `lme-v2-${domain}-${tier}-${timestamp}`),
      provider,
      providerMeta: meta,
      embeddingCachePath: resolveEmbeddingCachePath(),
      topK: int(String(o.topK), '--top-k', 1),
      limit: int(String(o.limit), '--limit', 0),
      offset: int(String(o.offset), '--offset', 0),
      ids: o.idsFile ? readIdsFile(String(o.idsFile)) : undefined,
      maxStateChars: int(String(o.maxStateChars), '--max-state-chars', 0),
      indexConcurrency: concurrency,
      keepWorkdirs: Boolean(o.keepWorkdirs),
      ledgerPath: resolveRunLedgerPath(process.env),
      rerunReason: o.rerunReason as string | undefined,
    });
    console.log(JSON.stringify({ outputDir: result.outputDir, summary: result.summary }, null, 2));
  });

program.command('qa')
  .description('answer every retrieved question with the upstream reader prompt and score it with the upstream eval functions')
  .requiredOption('--run <dir>', 'completed LongMemEval-V2 retrieval run directory')
  .requiredOption('--output <dir>', 'QA run output directory (re-invoke with the same directory to resume)')
  .option('--answer-model <id>', 'reader model identifier', process.env.RENOR_QA_ANSWER_MODEL ?? 'deepseek-v4.1-flash')
  .option('--judge-model <id>', 'judge model for the abstention and gotchas eval functions', process.env.RENOR_QA_JUDGE_MODEL ?? 'gemma4:31b')
  .option('--base-url <url>', 'OpenAI-compatible endpoint for the reader (and judge unless --judge-base-url)', process.env.RENOR_QA_BASE_URL ?? 'https://ollama.com/v1')
  .option('--api-key-env <name>', 'env var holding the reader API key', 'OLLAMA_API_KEY')
  .option('--judge-base-url <url>', 'OpenAI-compatible endpoint for the judge (defaults to --base-url)')
  .option('--judge-api-key-env <name>', 'env var holding the judge API key (defaults to --api-key-env)')
  .option('--max-context-tokens <n>', 'memory context token cap built from the retrieved hits', '8000')
  .option('--answer-max-tokens <n>', 'max completion tokens for reader calls; omit to let the provider cap apply')
  .option('--judge-max-tokens <n>', 'max completion tokens for judge calls; omit to let the provider cap apply')
  .option('--temperature <t>', 'sampling temperature for both models', '0')
  .option('--retries <n>', 'per-call retry attempts', '5')
  .option('--concurrency <n>', 'max concurrent questions', '3')
  .option('--ids-file <path>', 'run only the question ids listed in this file')
  .option('--rerun-reason <text>', `run even though this exact configuration is already on the run ledger (${RUN_LEDGER_ENV}); the reason is recorded`)
  .action(async (o: Record<string, string | undefined>) => {
    const apiKey = process.env[String(o.apiKeyEnv)];
    if (!apiKey) throw new Error(`API key env ${o.apiKeyEnv} is not set`);
    const judgeKey = process.env[o.judgeApiKeyEnv ?? String(o.apiKeyEnv)];
    if (!judgeKey) throw new Error(`Judge API key env ${o.judgeApiKeyEnv ?? o.apiKeyEnv} is not set`);
    const judgeBaseUrl = o.judgeBaseUrl ?? String(o.baseUrl);
    const temperature = Number(o.temperature);
    if (!Number.isFinite(temperature) || temperature < 0) throw new Error('--temperature must be a non-negative number');
    const result = await runQaStage({
      runDir: String(o.run),
      outputDir: String(o.output),
      chat: httpChat({ reader: { baseUrl: String(o.baseUrl), apiKey }, judge: { baseUrl: judgeBaseUrl, apiKey: judgeKey } }, { retries: int(String(o.retries), '--retries', 1) }),
      reader: { model: String(o.answerModel), baseUrl: String(o.baseUrl) },
      judge: { model: String(o.judgeModel), baseUrl: judgeBaseUrl },
      maxContextTokens: int(String(o.maxContextTokens), '--max-context-tokens', 1),
      answerMaxTokens: optionalPositiveInt(o.answerMaxTokens, '--answer-max-tokens'),
      judgeMaxTokens: optionalPositiveInt(o.judgeMaxTokens, '--judge-max-tokens'),
      temperature,
      concurrency: int(String(o.concurrency), '--concurrency', 1),
      ids: o.idsFile ? readIdsFile(o.idsFile) : undefined,
      preflight: true,
      stub: false,
      ledgerPath: resolveRunLedgerPath(process.env),
      rerunReason: o.rerunReason,
    });
    console.log(JSON.stringify({ outputDir: result.outputDir, summary: result.summary.overall, byCategory: result.summary.byCategory }, null, 2));
  });

program.command('dry-run')
  .description('both stages and the score on a data root with hash embeddings and a stub model: no network, no key, no run-ledger record')
  .requiredOption('--data-root <dir>', 'data root, e.g. tests/fixtures/longmemeval-v2 (synthetic)')
  .requiredOption('--output <dir>', 'new directory for retrieval/, qa/ and report.json')
  .option('--domain <domain>', 'web or enterprise', 'web')
  .option('--tier <tier>', 'small or medium', 'small')
  .option('--limit <n>', 'maximum selected questions; 0 = all', '0')
  .action(async (o: Record<string, string>) => {
    const outputDir = path.resolve(o.output);
    const { provider, meta } = makeProvider('hash');
    const retrieval = await runRetrievalStage({
      dataRoot: o.dataRoot, tier: tierOf(o.tier), domain: domainOf(o.domain), outputDir: path.join(outputDir, 'retrieval'),
      provider, providerMeta: meta, embeddingCachePath: null, topK: 20, limit: int(o.limit, '--limit', 0), offset: 0,
      maxStateChars: 0, indexConcurrency: 2, ledgerPath: null,
    });
    await runQaStage({
      runDir: retrieval.outputDir, outputDir: path.join(outputDir, 'qa'), chat: stubChat,
      reader: { model: 'stub', baseUrl: 'stub:' }, judge: { model: 'stub', baseUrl: 'stub:' },
      maxContextTokens: 8000, temperature: 0, concurrency: 1, preflight: false, stub: true, ledgerPath: null,
    });
    const report = scoreQaRuns([path.join(outputDir, 'qa')]);
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    const { failures: _failures, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
  });

program.parseAsync(process.argv).catch(error => {
  console.error(error instanceof RunRefusedError ? error.message : error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
