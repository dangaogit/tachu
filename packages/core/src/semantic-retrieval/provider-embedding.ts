import { ProviderError } from "../errors";
import type { ProviderAdapter } from "../modules/provider";
import type { AdapterCallContext } from "../types/context";
import type {
  EmbeddingRuntime,
  EmbeddingRuntimeProfile,
  SemanticEmbeddingRequest,
  SemanticEmbeddingResponse,
} from "./types";

export interface ProviderEmbeddingRuntimeAdapterOptions {
  provider: ProviderAdapter;
  model: string;
  dimensions?: number | undefined;
  maxBatchSize?: number | undefined;
  maxInputTokens?: number | undefined;
  normalized?: boolean | undefined;
}

export class ProviderEmbeddingRuntimeAdapter implements EmbeddingRuntime {
  constructor(private readonly options: ProviderEmbeddingRuntimeAdapterOptions) {}

 describe(): EmbeddingRuntimeProfile {
    return {
      providerId: this.options.provider.id,
      model: this.options.model,
      ...(this.options.dimensions !== undefined ? { dimensions: this.options.dimensions } : {}),
      ...(this.options.maxBatchSize !== undefined ? { maxBatchSize: this.options.maxBatchSize } : {}),
      ...(this.options.maxInputTokens !== undefined ? { maxInputTokens: this.options.maxInputTokens } : {}),
      ...(this.options.normalized !== undefined ? { normalized: this.options.normalized } : {}),
    };
  }

  async embed(
    req: SemanticEmbeddingRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<SemanticEmbeddingResponse> {
    if (!this.options.provider.embed) {
      throw ProviderError.unavailable(`${this.options.provider.id}.embed`);
    }
    const response = await this.options.provider.embed(
      {
        model: req.model || this.options.model,
        inputs: [...req.inputs],
        taskType: req.taskType,
        ...(req.outputDimensionality !== undefined
          ? { outputDimensionality: req.outputDimensionality }
          : {}),
        ...(req.providerOptions !== undefined
          ? { providerOptions: req.providerOptions }
          : {}),
      },
      ctx,
      signal,
    );
    return {
      embeddings: response.embeddings,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
    };
  }
}
