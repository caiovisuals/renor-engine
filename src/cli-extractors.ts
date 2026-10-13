import OpenAI from 'openai';
import { extractFacts } from './extraction/factExtractor';
import { openExtractorClient, isExtractorSpecificProvider } from './extraction/extractionClient';
import { extractNumericFacts, typedFactsEnabled, FACTS_MODEL } from './extraction/typedFacts';
import { chronicleEnabled, extractEvents } from './extraction/eventExtractor';
import { prefsEnabled, extractPreferences } from './extraction/preferenceExtractor';

export interface WritePathConfig {
  llmExtraction: boolean;
  openaiApiKey?: string;
}

export interface WritePathExtractors {
  factExtractor?: (title: string, body: string) => ReturnType<typeof extractFacts>;
  numericFactExtractor?: (title: string, body: string) => ReturnType<typeof extractNumericFacts>;
  eventExtractor?: (title: string, body: string) => ReturnType<typeof extractEvents>;
  preferenceExtractor?: (title: string, body: string) => ReturnType<typeof extractPreferences>;
}

/**
 * Structured-row lanes use only a named extractor provider. A bare
 * OPENAI_API_KEY does not arm them. LLM_EXTRACTION is the older fact path:
 * when that flag is on and no named provider exists, it keeps the OpenAI
 * client main already built from that key.
 *
 * The legacy fact path asks for `FACTS_MODEL` only when the resolved provider is
 * one of the extractor-specific providers. On the generic OPENAI_API_KEY +
 * OPENAI_BASE_URL fallback it keeps the fact extractor's own `gpt-4o-mini`
 * default, which is the model `main` sent there. See
 * `isExtractorSpecificProvider`.
 */
export function buildWritePathExtractors(
  config: WritePathConfig,
  env: NodeJS.ProcessEnv = process.env,
): WritePathExtractors {
  const resolved = openExtractorClient(FACTS_MODEL, env);
  const extractorClient = resolved?.client ?? null;
  const legacyFactClient = config.llmExtraction && !extractorClient && config.openaiApiKey
    ? new OpenAI({ apiKey: config.openaiApiKey })
    : null;
  const factClient = (extractorClient ?? legacyFactClient) as Parameters<typeof extractFacts>[0] | null;
  return {
    factExtractor: config.llmExtraction && factClient
      ? (title, body) => extractFacts(
          factClient,
          title,
          body,
          isExtractorSpecificProvider(resolved?.config ?? null) ? FACTS_MODEL : 'gpt-4o-mini',
        )
      : undefined,
    numericFactExtractor: typedFactsEnabled(env) && extractorClient
      ? (title, body) => extractNumericFacts(extractorClient, title, body)
      : undefined,
    eventExtractor: chronicleEnabled(env) && extractorClient
      ? (title, body) => extractEvents(extractorClient, title, body)
      : undefined,
    preferenceExtractor: prefsEnabled(env) && extractorClient
      ? (title, body) => extractPreferences(extractorClient, title, body)
      : undefined,
  };
}
