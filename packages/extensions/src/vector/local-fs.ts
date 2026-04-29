import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  InMemoryVectorStore,
  type AdapterCallContext,
  type VectorHit,
  type VectorPayloadFilter,
  type VectorSearchQuery,
  type VectorStore,
  type SparseVector,
} from "@tachu/core";

interface LocalFsVectorStoreOptions {
  filePath?: string;
  persistDebounceMs?: number;
  indexLimit?: number;
}

interface PersistedEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

interface PersistedPayload {
  entries: PersistedEntry[];
}

/**
 * 本地文件持久化 VectorStore（基于 InMemoryVectorStore）。
 */
export class LocalFsVectorStore implements VectorStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly persistDebounceMs: number;
  private readonly store: InMemoryVectorStore;
  private readonly entries = new Map<string, PersistedEntry>();
  private readonly initPromise: Promise<void>;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting = Promise.resolve();

  /**
   * 创建本地向量存储。
   *
   * @param options 配置项
   */
  constructor(options: LocalFsVectorStoreOptions = {}) {
    this.filePath = options.filePath ?? ".tachu/vectors.json";
    this.lockPath = `${this.filePath}.lock`;
    this.persistDebounceMs = options.persistDebounceMs ?? 500;
    this.store = new InMemoryVectorStore({
      ...(options.indexLimit !== undefined ? { indexLimit: options.indexLimit } : {}),
    });
    this.initPromise = this.loadFromDisk();
  }

  /**
   * 文本向量化。
   *
   * @param texts 文本列表
   * @returns 向量列表
   */
  async embed(texts: string[]): Promise<number[][]> {
    await this.initPromise;
    return this.store.embed(texts);
  }

  /**
   * 写入或更新向量条目。
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
    await this.initPromise;
    const vector =
      typeof vectorOrText === "string" ? (await this.store.embed([vectorOrText]))[0] ?? [] : vectorOrText;
    await this.store.upsert(id, vector, metadata);
    this.entries.set(id, { id, vector, metadata });
    this.schedulePersist();
  }

  /**
   * 相似度检索。
   *
   * @param query 查询请求
   * @param ctx 链路上下文
   * @param signal 取消信号
   * @returns 检索结果
   */
  async search(
    query: VectorSearchQuery,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    await this.initPromise;
    return this.store.search(query, ctx, signal);
  }

  /**
   * @inheritdoc
   */
  async hybridSearch(
    denseVector: number[],
    sparseVector: SparseVector | null,
    k: number,
    filters: VectorPayloadFilter,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    await this.initPromise;
    return this.store.hybridSearch(denseVector, sparseVector, k, filters, ctx, signal);
  }

  /**
   * 删除条目。
   *
   * @param id 条目 ID
   */
  async delete(id: string): Promise<void> {
    await this.initPromise;
    await this.store.delete(id);
    this.entries.delete(id);
    this.schedulePersist();
  }

  /**
   * 清空向量库。
   */
  async clear(): Promise<void> {
    await this.initPromise;
    await this.store.clear();
    this.entries.clear();
    this.schedulePersist();
  }

  /**
   * 返回当前条目数。
   *
   * @returns 条目数量
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * 手动导出快照文件。
   *
   * @param path 快照路径
   */
  async snapshot(path: string): Promise<void> {
    await this.initPromise;
    const payload: PersistedPayload = { entries: [...this.entries.values()] };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persisting = this.persisting.then(() => this.persistToDisk());
    }, this.persistDebounceMs);
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw) {
      return;
    }
    const payload = JSON.parse(raw) as PersistedPayload;
    for (const entry of payload.entries ?? []) {
      await this.store.upsert(entry.id, entry.vector, entry.metadata);
      this.entries.set(entry.id, entry);
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await mkdir(dirname(this.lockPath), { recursive: true });
        const handle = await open(this.lockPath, "wx");
        return async () => {
          await handle.close().catch(() => undefined);
          await rm(this.lockPath, { force: true }).catch(() => undefined);
        };
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    throw new Error(`无法获取文件锁: ${this.lockPath}`);
  }

  private async persistToDisk(): Promise<void> {
    const release = await this.acquireLock();
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      const payload: PersistedPayload = { entries: [...this.entries.values()] };
      await writeFile(tempPath, JSON.stringify(payload), "utf8");
      await rename(tempPath, this.filePath);
    } finally {
      await release();
    }
  }
}
