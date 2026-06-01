import {
  ProviderError,
  type AdapterCallContext,
  type VectorHit,
  type VectorIndexAdapter,
  type VectorPayloadFilter,
  type VectorPoint,
} from "@tachu/core";
import { QdrantClient } from "@qdrant/js-client-rest";

export interface QdrantVectorIndexAdapterOptions {
  url: string;
  apiKey?: string;
  collectionName: string;
  vectorSize: number;
}

/**
 * Qdrant pure vector index adapter (). No text embedding — vectors must be precomputed.
 */
export class QdrantVectorIndexAdapter implements VectorIndexAdapter {
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly vectorSize: number;
  private ensured = false;

  constructor(options: QdrantVectorIndexAdapterOptions) {
    this.client = new QdrantClient({
      url: options.url,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
    this.collectionName = options.collectionName;
    this.vectorSize = options.vectorSize;
  }

  async upsert(
    points: readonly VectorPoint[],
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    for (const point of points) {
      if (!Array.isArray(point.vector) || point.vector.length !== this.vectorSize) {
        throw new ProviderError(
          "PROVIDER_INVALID_REQUEST",
          `QdrantVectorIndexAdapter expects vectors of size ${this.vectorSize}`,
          { retryable: false },
        );
      }
    }
    try {
      await this.ensureCollection();
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        })),
      });
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant upsert 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  async searchVector(
    query: number[],
    topK: number,
    filters: VectorPayloadFilter,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    signal?.throwIfAborted();
    if (!Array.isArray(query) || query.some((value) => typeof value !== "number")) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "QdrantVectorIndexAdapter.searchVector requires a numeric query vector",
        { retryable: false },
      );
    }
    try {
      await this.ensureCollection();
      const filter =
        filters.must && Object.keys(filters.must).length > 0
          ? {
              must: Object.entries(filters.must).map(([key, val]) => ({
                key,
                match: { value: val },
              })),
            }
          : undefined;
      const result = await this.client.search(this.collectionName, {
        vector: query,
        limit: topK,
        with_payload: true,
        ...(filter !== undefined ? { filter } : {}),
      });
      return result.map((item) => ({
        id: String(item.id),
        score: item.score,
        metadata: (item.payload ?? {}) as Record<string, unknown>,
      }));
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant search 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  async delete(
    ids: readonly string[],
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (ids.length === 0) return;
    try {
      await this.ensureCollection();
      await this.client.delete(this.collectionName, { wait: true, points: [...ids] });
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant delete 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  private async ensureCollection(): Promise<void> {
    if (this.ensured) return;
    const exists = await this.client.collectionExists(this.collectionName);
    if (!exists.exists) {
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: this.vectorSize,
          distance: "Cosine",
        },
      });
    }
    this.ensured = true;
  }
}

/** @deprecated Use {@link QdrantVectorIndexAdapter} (). */
export { QdrantVectorIndexAdapter as QdrantVectorStore };
