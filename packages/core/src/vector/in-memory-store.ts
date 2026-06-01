import type { AdapterCallContext } from "../types/context";
import type {
  VectorHit,
  VectorPayloadFilter,
  VectorSearchQuery,
  VectorSearchResult,
  VectorStore,
  SparseVector,
} from "./vector-store";

interface StoreEntry {
  vector: number[];
  metadata: Record<string, unknown>;
}

const payloadMatchesMust = (
  metadata: Record<string, unknown>,
  must: Record<string, unknown>,
): boolean => {
  for (const [key, value] of Object.entries(must)) {
    if (metadata[key] !== value) {
      return false;
    }
  }
  return true;
};

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    aNorm += ai * ai;
    bNorm += bi * bi;
  }
  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
};

/**
 * 轻量内存向量存储，适合本地开发和测试。
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly indexLimit: number;
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(options?: { indexLimit?: number; onWarning?: (message: string) => void }) {
    this.indexLimit = options?.indexLimit ?? 10_000;
    this.onWarning = options?.onWarning;
  }

  async upsert(
    id: string,
    vector: number[],
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const exists = this.entries.has(id);
    if (!exists && this.entries.size >= this.indexLimit) {
      this.onWarning?.(
        `vector index 达到上限 ${this.indexLimit}，忽略新增条目: ${id}`,
      );
      return;
    }

    if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
      throw new Error("InMemoryVectorStore.upsert requires a precomputed numeric vector");
    }

    this.entries.set(id, { vector: [...vector], metadata });
  }

  async search(
    query: VectorSearchQuery,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    signal?.throwIfAborted();
    const { query: raw, topK } = query;
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== "number")) {
      throw new Error("InMemoryVectorStore.search requires a precomputed numeric query vector");
    }

    return [...this.entries.entries()]
      .map(([id, entry]) => ({
        id,
        score: cosineSimilarity(raw, entry.vector),
        metadata: entry.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, topK));
  }

  async hybridSearch(
    denseVector: number[],
    sparseVector: SparseVector | null,
    k: number,
    filters: VectorPayloadFilter,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    signal?.throwIfAborted();
    if (sparseVector !== null) {
      throw new Error("InMemoryVectorStore 尚未实现稀疏分支 hybridSearch");
    }
    const must = filters.must ?? {};
    const rows = [...this.entries.entries()].filter(([, entry]) =>
      payloadMatchesMust(entry.metadata, must),
    );
    const ranked = rows
      .map(([id, entry]) => ({
        id,
        score: cosineSimilarity(denseVector, entry.vector),
        metadata: entry.metadata,
      }))
      .sort((a, b) => b.score - a.score);
    return ranked.slice(0, Math.max(0, k));
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
