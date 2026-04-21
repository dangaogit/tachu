/**
 * 向量化输入。
 */
export interface VectorEmbeddingInput {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * 向量检索结果。
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * 向量存储抽象接口。
 *
 * `size()` 允许同步或异步返回：
 *   - **本地内存 / 文件型** 实现（InMemoryVectorStore、LocalFsVectorStore）持有精确
 *     的本地计数，返回 `number`；
 *   - **远程** 实现（QdrantVectorStore 等）需要向后端发出一次 count 请求，返回
 *     `Promise<number>`，以避免返回本地缓存导致"读到旧值"。
 *
 * 调用方通常用 `await Promise.resolve(store.size())` 或 `const n = await store.size()`
 * 统一处理两种形态。
 */
export interface VectorStore {
  /**
   * 对输入文本批量生成向量。
   *
   * 实现可是轻量哈希词袋（`InMemoryVectorStore` / `QdrantVectorStore` 的占位实现）或
   * 接真实 Embedder。生产部署请注入真实 embedder（见 `QdrantVectorStore.embed` 注释）。
   *
   * @param texts 待向量化的文本数组
   * @returns 与 `texts` 等长的向量数组
   */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * 写入 / 更新一条向量条目。
   *
   * 如传入 `string`，实现应内部调用 {@link VectorStore.embed} 先完成向量化。
   *
   * @param id 条目 ID（已有则覆盖）
   * @param vectorOrText 向量或原文本
   * @param metadata 关联元数据（会与向量一同持久化/检索）
   */
  upsert(
    id: string,
    vectorOrText: number[] | string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  /**
   * 按向量或文本检索 topK 最相似条目。
   *
   * @param query 查询向量或原文本（实现负责向量化）
   * @param topK 返回的最相似条目数量上限
   * @returns 按相似度降序排列的结果数组
   */
  search(query: number[] | string, topK: number): Promise<VectorSearchResult[]>;
  /** 删除指定 ID 条目；不存在时为 no-op。 */
  delete(id: string): Promise<void>;
  /** 清空所有条目。 */
  clear(): Promise<void>;
  /**
   * 返回当前条目数。
   *
   * 本地实现通常同步返回 `number`；远程实现（Qdrant 等）需要发请求，返回 `Promise<number>`。
   * 调用方使用 `await Promise.resolve(store.size())` 或 `const n = await store.size()`
   * 可兼容两种形态。
   */
  size(): number | Promise<number>;
}

