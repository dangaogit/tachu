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
  terms: string[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "to",
  "in",
  "for",
  "on",
  "with",
  "is",
  "are",
  "be",
  "was",
  "were",
  "or",
  "as",
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));

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
  private readonly vocabulary = new Map<string, number>();

  constructor(options?: { indexLimit?: number; onWarning?: (message: string) => void }) {
    this.indexLimit = options?.indexLimit ?? 10_000;
    this.onWarning = options?.onWarning;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.toVector(tokenize(text)));
  }

  async upsert(
    id: string,
    vectorOrText: number[] | string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const exists = this.entries.has(id);
    if (!exists && this.entries.size >= this.indexLimit) {
      this.onWarning?.(
        `vector index 达到上限 ${this.indexLimit}，忽略新增条目: ${id}`,
      );
      return;
    }

    if (typeof vectorOrText === "string") {
      const terms = tokenize(vectorOrText);
      const vector = this.toVector(terms);
      this.entries.set(id, { vector, metadata, terms });
      return;
    }

    this.entries.set(id, { vector: vectorOrText, metadata, terms: [] });
  }

  async search(
    query: VectorSearchQuery,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    signal?.throwIfAborted();
    const { query: raw, topK } = query;
    const queryVector = typeof raw === "string" ? this.toVector(tokenize(raw)) : raw;

    return [...this.entries.entries()]
      .map(([id, entry]) => ({
        id,
        score: cosineSimilarity(queryVector, entry.vector),
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
    this.vocabulary.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private toVector(terms: string[]): number[] {
    const counts = new Map<string, number>();
    for (const term of terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      if (!this.vocabulary.has(term)) {
        this.vocabulary.set(term, this.vocabulary.size);
      }
    }

    const vector = new Array(this.vocabulary.size).fill(0);
    let norm = 0;
    for (const [term, count] of counts.entries()) {
      const index = this.vocabulary.get(term);
      if (index === undefined) {
        continue;
      }
      vector[index] = count;
      norm += count * count;
    }

    if (norm === 0) {
      return vector;
    }
    const normalized = Math.sqrt(norm);
    return vector.map((value) => value / normalized);
  }
}

