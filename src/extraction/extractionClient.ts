import { createOllamaChat } from '../evidence/ollamaChat';
import { collectOllamaKeys } from '../evidence/keyPool';

/**
 * Shared client for the optional write-path extractors (typed facts, chronicle
 * events, standing preferences). All three flags stay default off.
 *
 * `cli.ts` used to build `new OpenAI({ apiKey })` with no base URL. The SDK
 * then calls api.openai.com, so an Ollama model such as gemma4:31b never ran
 * and the lane looked empty. This resolves a provider from the environment by
 * name. No key means null: the lane stays unarmed instead of calling
 * api.openai.com. A bare OPENAI_API_KEY without a base URL is the same case.
 *
 * Keys are read by env-var name and are not logged here.
 *
 * Order: RENOR_EXTRACTOR_* , then the Ollama Cloud pool, then
 * OPENAI_API_KEY only when OPENAI_BASE_URL or EMBEDDING_BASE_URL is set.
 *
 * `provider` names which branch resolved. It is a fact about THIS module and not
 * about the remote endpoint: the dedicated slot and the Ollama pool are the
 * providers this repository names `FACTS_MODEL` for, while the OPENAI_API_KEY
 * fallback is keyed in the OpenAI namespace. Whether a user-configured
 * OPENAI_BASE_URL happens to serve `gemma4:31b` is not something this module can
 * observe, so nothing here claims it either way.
 */
export interface ExtractorClientConfig {
  baseUrl: string;
  keys: string[];
  model: string;
  /** Which provider branch resolved: the dedicated slot, the Ollama pool, or the generic OpenAI fallback. */
  provider: 'dedicated' | 'ollama-cloud' | 'openai-fallback';
  /** Env var names that supplied the keys. Never the values. */
  keyEnvNames: string[];
}

/**
 * Whether the resolved provider is one of the extractor-specific providers (the
 * dedicated RENOR_EXTRACTOR_* slot or the Ollama Cloud pool) rather than the
 * generic OPENAI_API_KEY fallback.
 *
 * The legacy `LLM_EXTRACTION` fact path reads this to choose its model id: it
 * names `FACTS_MODEL` only for an extractor-specific provider, and on the generic
 * fallback it keeps the fact extractor's own default, which is the model `main`
 * sent there. The structured-row lanes are NOT decided here — their extractors
 * name `FACTS_MODEL` on every provider branch, including the fallback, which is
 * also what `main` did. Changing that is a separate decision, recorded as a
 * finding in this branch's review packet, not a property this helper can fix.
 */
export function isExtractorSpecificProvider(config: ExtractorClientConfig | null): boolean {
  return !!config && config.provider !== 'openai-fallback';
}

const DEFAULT_BASE_URL = 'https://ollama.com/v1';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

function splitKeys(value: string | undefined): string[] {
  return (value ?? '').split(',').map(key => key.trim()).filter(Boolean);
}

export function resolveExtractorClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  model: string,
): ExtractorClientConfig | null {
  const dedicatedKeys = [
    ...splitKeys(env.RENOR_EXTRACTOR_API_KEYS),
    ...splitKeys(env.RENOR_EXTRACTOR_API_KEY),
  ];
  if (dedicatedKeys.length > 0) {
    return {
      baseUrl: nonEmpty(env.RENOR_EXTRACTOR_BASE_URL) ?? DEFAULT_BASE_URL,
      keys: dedicatedKeys,
      model,
      provider: 'dedicated',
      keyEnvNames: [
        ...(splitKeys(env.RENOR_EXTRACTOR_API_KEYS).length > 0 ? ['RENOR_EXTRACTOR_API_KEYS'] : []),
        ...(splitKeys(env.RENOR_EXTRACTOR_API_KEY).length > 0 ? ['RENOR_EXTRACTOR_API_KEY'] : []),
      ],
    };
  }

  const ollama = collectOllamaKeys(env);
  const ollamaKeys = ollama.keys;
  const usedOllamaNames = ollama.names;
  if (ollamaKeys.length > 0) {
    return {
      baseUrl: nonEmpty(env.RENOR_EXTRACTOR_BASE_URL) ?? DEFAULT_BASE_URL,
      keys: ollamaKeys,
      model,
      provider: 'ollama-cloud',
      keyEnvNames: usedOllamaNames,
    };
  }

  const fallbackBase = nonEmpty(env.OPENAI_BASE_URL) ?? nonEmpty(env.EMBEDDING_BASE_URL);
  const fallbackKey = nonEmpty(env.OPENAI_API_KEY);
  if (fallbackKey && fallbackBase) {
    return {
      baseUrl: fallbackBase,
      keys: splitKeys(env.OPENAI_API_KEY),
      model,
      provider: 'openai-fallback',
      keyEnvNames: ['OPENAI_API_KEY'],
    };
  }

  return null;
}

export interface ExtractorChatClient {
  chat: {
    completions: {
      create: (request: {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        temperature?: number;
        response_format?: { type: 'json_object' };
      }) => Promise<{
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

/**
 * OpenAI-shaped handle over the shared chat transport. Forwards
 * `response_format` when the extractor set it. Dropping that field made JSON
 * mode a silent no-op.
 */
export function createExtractorClient(config: ExtractorClientConfig): ExtractorChatClient {
  const chat = createOllamaChat({
    baseUrl: config.baseUrl,
    keys: config.keys,
    timeoutMs: Number(process.env.RENOR_EXTRACTOR_TIMEOUT_MS ?? 180_000),
    maxRetries: 3,
  });

  return {
    chat: {
      completions: {
        create: async (request) => {
          const messages = (request.messages ?? []).filter(
            message => message
              && (message.role === 'user' || message.role === 'system')
              && typeof message.content === 'string',
          );
          const response = await chat({
            model: request.model ?? config.model,
            messages: messages.map(message => ({
              role: message.role as 'user' | 'system',
              content: message.content,
            })),
            temperature: 0,
            ...(request.response_format?.type === 'json_object'
              ? { response_format: { type: 'json_object' as const } }
              : {}),
          });
          return {
            choices: [{ message: { content: response.content } }],
            usage: {
              prompt_tokens: response.promptTokens,
              completion_tokens: response.completionTokens,
            },
          };
        },
      },
    },
  };
}

export function openExtractorClient(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): { client: ExtractorChatClient; config: ExtractorClientConfig } | null {
  const config = resolveExtractorClientConfig(env, model);
  if (!config) return null;
  return { client: createExtractorClient(config), config };
}
