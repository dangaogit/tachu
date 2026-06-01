import type { AdapterCallContext } from "../types/context";

/**
 * 向量检索结果。
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** {@link VectorSearchResult} 的语义别名（与设计文档 VectorHit 对齐）。 */
export type VectorHit = VectorSearchResult;

/**
 * 单次向量检索请求（合并原 `search(query, topK)` 参数）。
 */
export interface VectorSearchQuery {
  query: number[];
  topK: number;
}

/** 稀疏向量（例如 BM25／SPLADE 等非稠密表征）。 */
export interface SparseVector {
  indices: number[];
  values: number[];
}

/** hybridSearch 阶段的 payload 过滤意向（具体语义由远端实现解释）。 */
export interface VectorPayloadFilter {
  must?: Record<string, unknown>;
  should?: Record<string, unknown>;
}

/**
 * 轻量向量存储抽象接口。
 *
 * `size()` 允许同步或异步返回：
 * - 本地内存实现持有精确的本地计数，返回 `number`；
 * - 远程实现可能需要向后端发出 count 请求，返回 `Promise<number>`。
 *
 * 调用方通常用 `await Promise.resolve(store.size())` 或 `const n = await store.size()`
 * 统一处理两种形态。
 *
 * numeric vector。文本到向量必须由
 * `EmbeddingRuntime` 或明确的 test/dev fixture 完成，不能隐藏在 store 内部。
 */
export interface VectorStore {
 /**
 * 写入 / 更新一条向量条目。
 *
 * @param id 条目 ID（已有则覆盖）
 * @param vector 预计算向量
 * @param metadata 关联元数据（会与向量一同持久化/检索）
 */
  upsert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void>;
 /**
 * 按向量检索 topK 最相似条目。
 *
 * @param query 检索请求（必须是预计算查询向量）
 * @param ctx 租户 / 链路上下文（适配器可用于隔离与 span 维度）
 */
  search(
    query: VectorSearchQuery,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]>;

 /**
 * 稠密 + 稀疏混合检索（可选能力；不支持时可抛错）。
 *
 * @param denseVector 稠密查询向量
 * @param sparseVector 稀疏分支；null 表示仅稠密路径
 */
  hybridSearch(
    denseVector: number[],
    sparseVector: SparseVector | null,
    k: number,
    filters: VectorPayloadFilter,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]>;
 /** 删除指定 ID 条目；不存在时为 no-op。 */
  delete(id: string): Promise<void>;
 /** 清空所有条目。 */
  clear(): Promise<void>;
 /**
 * 返回当前条目数。
 *
 * 本地实现通常同步返回 `number`；远程实现可能需要发请求，返回 `Promise<number>`。
 * 调用方使用 `await Promise.resolve(store.size())` 或 `const n = await store.size()`
 * 可兼容两种形态。
 */
  size(): number | Promise<number>;
}
