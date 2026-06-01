import {
  DefaultRetrievalPolicyRegistry,
  DefaultSemanticRetrievalFacade,
  type EngineConfig,
  type ObservabilityEmitter,
  type ProviderAdapter,
  type SemanticRetrievalFacade,
} from "@tachu/core";
import { ENGINE_INIT_CORRELATION } from "./constants";
import { resolveEmbeddingRuntime } from "./resolve-embedding-runtime";

export interface ResolveSemanticRetrievalFacadeResult {
  facade: SemanticRetrievalFacade;
}

/**
 * 装配 SemanticRetrievalFacade 并 emit 标准 init 事件。
 */
export function resolveSemanticRetrievalFacade(
  config: EngineConfig,
  providers: readonly ProviderAdapter[],
  observability: ObservabilityEmitter,
): ResolveSemanticRetrievalFacadeResult {
  const resolved = resolveEmbeddingRuntime(config, providers);

  if (resolved) {
    const facade = new DefaultSemanticRetrievalFacade({
      policy: new DefaultRetrievalPolicyRegistry(),
      embedding: resolved.runtime,
    });
    observability.emit({
      timestamp: Date.now(),
      correlation: ENGINE_INIT_CORRELATION,
      phase: "semantic-retrieval",
      type: "progress",
      payload: {
        status: "available",
        providerId: resolved.provider.id,
        model: resolved.model,
        strategy: "embedding_runtime",
        reason:
          "provider exposes embed(); host wired DefaultSemanticRetrievalFacade with ProviderEmbeddingRuntimeAdapter",
      },
    });
    return { facade };
  }

  const facade = new DefaultSemanticRetrievalFacade({
    policy: new DefaultRetrievalPolicyRegistry(),
  });
  observability.emit({
    timestamp: Date.now(),
    correlation: ENGINE_INIT_CORRELATION,
    phase: "semantic-retrieval",
    type: "warning",
    payload: {
      status: "disabled",
      reason:
        "no registered provider implements embed(); semantic retrieval falls back to local_scan or bypass per RetrievalPolicy",
    },
  });
  return { facade };
}
