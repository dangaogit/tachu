import { ProviderError, type VectorSearchResult, type VectorStore } from "@tachu/core";
import { QdrantClient } from "@qdrant/js-client-rest";

interface QdrantVectorStoreOptions {
  url: string;
  apiKey?: string;
  collectionName: string;
  vectorSize?: number;
}

const DEFAULT_VECTOR_SIZE = 256;

const hashToken = (token: string, size: number): number => {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
  }
  return hash % size;
};

const embedText = (text: string, size: number): number[] => {
  const vector = new Array(size).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return vector;
  }
  for (const token of tokens) {
    const idx = hashToken(token, size);
    vector[idx] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
};

/**
 * Qdrant 远程向量存储适配器。
 */
export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly vectorSize: number;
  private ensured = false;
  private entryCount = 0;

  /**
   * 创建 Qdrant 向量存储。
   *
   * @param options Qdrant 连接配置
   */
  constructor(options: QdrantVectorStoreOptions) {
    this.client = new QdrantClient({
      url: options.url,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
    this.collectionName = options.collectionName;
    this.vectorSize = options.vectorSize ?? DEFAULT_VECTOR_SIZE;
  }

  /**
   * 文本向量化（**开发/占位实现**，基于哈希词袋）。
   *
   * ⚠️ **生产部署请务必注入真实 embedder**：
   *
   *   - 本方法采用简易哈希词袋（Hashing Trick）把文本投影到 `vectorSize` 维空间，
   *     仅用于早期集成与开发环境跑通流程，**无法**刻画词序、语义相似度、跨语言对齐；
   *   - 在真实的召回与排序场景（跨 session 记忆、多文档检索、向量知识库）下会产生
   *     大量误召和漏召。
   *
   * **推荐做法**（v1.0 起）：
   *
   *   1. 由 Provider 层（OpenAI `text-embedding-3-*` / Anthropic 尚未官方支持，可
   *      桥接第三方）生成向量；
   *   2. 宿主侧在 `MemorySystem` 调用前统一用真实 embedder 计算向量，再调
   *      `upsert(id, vector, metadata)` 这条显式向量分支；
   *   3. 或者继承 `QdrantVectorStore` 并覆盖 `embed`，直接接入业务自选 embedding 服务。
   *
   * 参见 `D1-LOW-06`：该占位实现的 QPS 基准与精度限制已记录在 benchmarks 目录。
   *
   * @param texts 文本数组
   * @returns 向量数组（单位向量，维度为 `vectorSize`）
   */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedText(text, this.vectorSize));
  }

  /**
   * 写入或更新向量。
   *
   * @param id 条目 ID
   * @param vectorOrText 向量或文本
   * @param metadata 元数据
   */
  async upsert(
    id: string,
    vectorOrText: number[] | string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.ensureCollection();
      const vector =
        typeof vectorOrText === "string" ? embedText(vectorOrText, this.vectorSize) : vectorOrText;
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [{ id, vector, payload: metadata }],
      });
      this.entryCount += 1;
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant upsert 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  /**
   * 相似度搜索。
   *
   * @param query 查询向量或文本
   * @param topK 结果数量
   * @returns 搜索结果
   */
  async search(query: number[] | string, topK: number): Promise<VectorSearchResult[]> {
    try {
      await this.ensureCollection();
      const vector = typeof query === "string" ? embedText(query, this.vectorSize) : query;
      const result = await this.client.search(this.collectionName, {
        vector,
        limit: topK,
        with_payload: true,
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

  /**
   * 删除条目。
   *
   * @param id 条目 ID
   */
  async delete(id: string): Promise<void> {
    try {
      await this.ensureCollection();
      await this.client.delete(this.collectionName, { wait: true, points: [id] });
      this.entryCount = Math.max(0, this.entryCount - 1);
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant delete 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  /**
   * 清空集合。
   */
  async clear(): Promise<void> {
    try {
      const exists = await this.client.collectionExists(this.collectionName);
      if (exists.exists) {
        await this.client.deleteCollection(this.collectionName);
      }
      this.ensured = false;
      this.entryCount = 0;
      await this.ensureCollection();
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant clear 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  /**
   * 返回集合内条目数量。
   *
   * 远程实现对 `client.count(...)` 发起一次真值查询（`exact: true`），避免本地缓存
   * 漂移导致读到旧值（D1-LOW-07）。collection 不存在等异常会被包装成 `ProviderError`。
   *
   * @returns 条目数（远程真值）
   */
  async size(): Promise<number> {
    try {
      await this.ensureCollection();
      const response = await this.client.count(this.collectionName, { exact: true });
      const remoteCount =
        typeof response?.count === "number" ? response.count : this.entryCount;
      this.entryCount = remoteCount;
      return remoteCount;
    } catch (error) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "Qdrant count 失败", {
        cause: error,
        retryable: true,
      });
    }
  }

  private async ensureCollection(): Promise<void> {
    if (this.ensured) {
      return;
    }
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
