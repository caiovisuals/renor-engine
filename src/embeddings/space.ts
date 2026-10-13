import type { EmbeddingProvider } from './types';

/**
 * Bump when the engine changes how it asks a model for the vectors it stores (the task type, a prefix,
 * normalization, truncation), so an index built the old way is not mixed with vectors written the new way.
 */
export const EMBEDDING_SPACE_VERSION = 1;

/**
 * The embedding space a provider's stored vectors live in: how the engine embeds documents, which provider
 * and model, and how many dimensions. A stored vector can stand in for a freshly embedded one only if the
 * two spaces are equal; mixing spaces in one index makes search compare numbers that mean different things.
 * A provider that declares no identity has no space, so nothing stored is ever reused for it.
 */
export function embeddingSpace(provider: Pick<EmbeddingProvider, 'identity' | 'dimensions'>): string | null {
  const identity = provider.identity;
  if (!identity) return null;
  return `v${EMBEDDING_SPACE_VERSION}|document|${identity.kind}|${identity.model}|${provider.dimensions}`;
}
