import {
  ProviderEmbeddingRuntimeAdapter,
  type EmbeddingRuntime,
  type EngineConfig,
  type ProviderAdapter,
} from "@tachu/core";

/**
 * Select embed-capable provider using `capabilityMapping.embedding.provider` when set.
 */
export function resolveEmbeddingProvider(
  config: EngineConfig,
  providers: readonly ProviderAdapter[],
): ProviderAdapter | undefined {
  const embeddingMapping = (
    config.models.capabilityMapping as Record<string, { provider?: string; model?: string } | undefined>
  ).embedding;
  const preferredId = embeddingMapping?.provider;
  if (preferredId) {
    const matched = providers.find((provider) => provider.id === preferredId);
    if (matched && typeof matched.embed === "function") {
      return matched;
    }
  }
  return providers.find((provider) => typeof provider.embed === "function");
}

export function resolveEmbeddingRuntime(
  config: EngineConfig,
  providers: readonly ProviderAdapter[],
): { runtime: EmbeddingRuntime; provider: ProviderAdapter; model: string } | undefined {
  const provider = resolveEmbeddingProvider(config, providers);
  if (!provider || typeof provider.embed !== "function") {
    return undefined;
  }
  const embeddingMapping = (
    config.models.capabilityMapping as Record<string, { model?: string } | undefined>
  ).embedding;
  const model = embeddingMapping?.model ?? "embedding-default";
  const runtime = new ProviderEmbeddingRuntimeAdapter({ provider, model });
  return { runtime, provider, model };
}
