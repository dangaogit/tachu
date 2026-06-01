import type { AdapterCallContext } from "../types/context";
import type { VectorHit, VectorPayloadFilter } from "../vector/vector-store";

export type RetrievalCaller = "skill" | "tool" | "memory";

export interface SemanticEmbeddingRequest {
  model: string;
  inputs: ReadonlyArray<string>;
  taskType:
    | "RETRIEVAL_QUERY"
    | "RETRIEVAL_DOCUMENT"
    | "SEMANTIC_SIMILARITY"
    | string;
  outputDimensionality?: number | undefined;
  providerOptions?: Record<string, unknown> | undefined;
}

export interface SemanticEmbeddingResponse {
  embeddings: number[][];
  usage?: unknown | undefined;
}

export interface EmbeddingRuntimeProfile {
  providerId: string;
  model: string;
  dimensions?: number | undefined;
  maxBatchSize?: number | undefined;
  maxInputTokens?: number | undefined;
  normalized?: boolean | undefined;
}

export interface EmbeddingRuntime {
  embed(
    req: SemanticEmbeddingRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<SemanticEmbeddingResponse>;
 describe(): EmbeddingRuntimeProfile;
}

export interface RetrievalPolicy {
  topK: number;
  minScoreThreshold?: number | undefined;
  staleFallback: "allow_stale" | "local_scan" | "bypass_semantic" | "throw_error";
  rerankProfile?: string | undefined;
}

export interface RetrievalPolicyRegistry {
  get(caller: RetrievalCaller, namespace: string): RetrievalPolicy;
}

export interface SemanticRetrievalRequest {
  caller: RetrievalCaller;
  namespace: string;
  query: string;
  corpus?: ReadonlyArray<{ id: string; text: string }> | undefined;
}

export interface SemanticRetrievalHit {
  id: string;
  score: number;
}

export interface SemanticRetrievalResult {
  caller: RetrievalCaller;
  namespace: string;
  strategy: "embedding_runtime" | "vector_index" | "local_scan" | "bypass";
  hits: SemanticRetrievalHit[];
  degraded: boolean;
  profile?: EmbeddingRuntimeProfile | undefined;
}

/** Precomputed vector point for {@link VectorIndexAdapter}. */
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/**
 * Pure vector index adapter (). Accepts only precomputed vectors — no text embedding.
 */
export interface VectorIndexAdapter {
  upsert(
    points: readonly VectorPoint[],
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<void>;
  searchVector(
    query: number[],
    topK: number,
    filters: VectorPayloadFilter,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]>;
  delete(
    ids: readonly string[],
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface SemanticRetrievalFacade {
  retrieve(
    request: SemanticRetrievalRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<SemanticRetrievalResult>;
}
