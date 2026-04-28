import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineConfig, Message } from "../types";
import type { AdapterCallContext } from "../types/context";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import type { ModelRouter } from "./model-router";
import type { ProviderAdapter } from "./provider";
import type { Tokenizer } from "../prompt/tokenizer";
import type { VectorStore } from "../vector";

/**
 * 记忆条目。
 */
export interface MemoryEntry {
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  timestamp: number;
  anchored: boolean;
}

/**
 * 上下文窗口。
 */
export interface ContextWindow {
  entries: MemoryEntry[];
  tokenCount: number;
  limit: number;
}

/**
 * 压缩策略接口。
 */
export interface CompressionStrategy {
  compress(entries: MemoryEntry[], targetTokens: number): Promise<MemoryEntry[]>;
}

/**
 * 记忆系统接口。
 */
export interface MemorySystem {
  /**
   * 加载会话对应的上下文窗口。
   *
   * @param sessionId 会话 ID
   * @param ctx 租户 / 链路上下文（适配器侧隔离与可观测性）
   * @returns 会话当前上下文窗口
   */
  load(sessionId: string, ctx: AdapterCallContext): Promise<ContextWindow>;
  /**
   * 向会话追加一条记忆条目，并在达到阈值时触发压缩。
   *
   * @param sessionId 会话 ID
   * @param entry 新增记忆条目
   * @param ctx 租户 / 链路上下文
   */
  append(sessionId: string, entry: MemoryEntry, ctx: AdapterCallContext): Promise<void>;
  /**
   * 对会话上下文执行压缩。
   *
   * @param sessionId 会话 ID
   */
  compress(sessionId: string): Promise<void>;
  /**
   * 从长期记忆中召回内容。
   *
   * @param sessionId 会话 ID
   * @param query 检索查询
   * @param topK 返回条数上限
   * @returns 召回到的记忆条目
   */
  recall(sessionId: string, query: string, topK?: number): Promise<MemoryEntry[]>;
  /**
   * 将会话当前窗口归档到本地文件与向量索引。
   *
   * @param sessionId 会话 ID
   */
  archive(sessionId: string): Promise<void>;
  /**
   * 获取会话上下文当前尺寸。
   *
   * @param sessionId 会话 ID
   * @returns `entries` 为消息数量，`tokens` 为估算 token 总数。
   */
  getSize(sessionId: string): Promise<{ entries: number; tokens: number }>;
  /**
   * 将会话上下文裁剪至保留头部 / 尾部指定数量的消息。
   *
   * 未提供任何选项时使用配置中的 `memory.headKeep` / `memory.tailKeep`。
   *
   * @param sessionId 会话 ID
   * @param options 保留头部 / 尾部消息数
   */
  trim(
    sessionId: string,
    options?: { keepHead?: number; keepTail?: number },
  ): Promise<void>;
  /**
   * 清空会话在 MemorySystem 中的所有内容。
   *
   * - 纯内存实现：删除 `windows` 中的对应 sessionId
   * - 持久化实现（如 `FsMemorySystem`）：同时删除磁盘上对应的持久化文件
   *
   * 用于 CLI 的 `/reset` `/clear` 斜杠命令 / 服务端会话过期清理等场景。实现
   * 需保证幂等：目标不存在时不抛。
   *
   * @param sessionId 会话 ID
   */
  clear(sessionId: string): Promise<void>;
}

/**
 * 默认 H-M-T 压缩策略。
 */
export class HeadMiddleTailCompression implements CompressionStrategy {
  constructor(
    private readonly headKeep: number,
    private readonly tailKeep: number,
  ) {}

  async compress(entries: MemoryEntry[], _targetTokens: number): Promise<MemoryEntry[]> {
    if (entries.length <= this.headKeep + this.tailKeep) {
      return entries;
    }

    const anchored = entries.filter((entry) => entry.anchored);
    const nonAnchored = entries.filter((entry) => !entry.anchored);

    const head = nonAnchored.slice(0, this.headKeep);
    const tail =
      this.tailKeep > 0 ? nonAnchored.slice(Math.max(nonAnchored.length - this.tailKeep, 0)) : [];
    const middle = nonAnchored.slice(this.headKeep, nonAnchored.length - this.tailKeep);
    const summaryText = middle
      .map((entry) => `${entry.role}: ${String(entry.content)}`)
      .join("\n")
      .slice(0, 2_000);

    const summary: MemoryEntry[] =
      middle.length > 0
        ? [
            {
              role: "system",
              content: `中段摘要: ${summaryText}`,
              timestamp: Date.now(),
              anchored: true,
            },
          ]
        : [];

    return [...anchored, ...head, ...summary, ...tail].sort((a, b) => a.timestamp - b.timestamp);
  }
}

/**
 * 内存记忆系统。
 */
export class InMemoryMemorySystem implements MemorySystem {
  private readonly windows = new Map<string, ContextWindow>();
  private readonly adapterCtxBySession = new Map<string, AdapterCallContext>();
  private readonly fallbackCompressor: CompressionStrategy;

  constructor(
    private readonly config: EngineConfig,
    private readonly tokenizer: Tokenizer,
    private readonly modelRouter: ModelRouter,
    private readonly providers: Map<string, ProviderAdapter>,
    private readonly vectorStore: VectorStore,
  ) {
    this.fallbackCompressor = new HeadMiddleTailCompression(
      config.memory.headKeep,
      config.memory.tailKeep,
    );
  }

  /**
   * 返回最近一次 `load`/`append` 写入的适配器上下文；供持久化实现或内部压缩路径复用。
   */
  resolveAdapterContext(sessionId: string): AdapterCallContext {
    return this.adapterCtxBySession.get(sessionId) ?? DEFAULT_ADAPTER_CALL_CONTEXT;
  }

  /**
   * @inheritdoc
   */
  async load(sessionId: string, ctx: AdapterCallContext): Promise<ContextWindow> {
    this.adapterCtxBySession.set(sessionId, ctx);
    const existing = this.windows.get(sessionId);
    if (existing) {
      return existing;
    }
    const window: ContextWindow = {
      entries: [],
      tokenCount: 0,
      limit: this.config.memory.contextTokenLimit,
    };
    this.windows.set(sessionId, window);
    return window;
  }

  /**
   * @inheritdoc
   */
  async append(sessionId: string, entry: MemoryEntry, ctx: AdapterCallContext): Promise<void> {
    const window = await this.load(sessionId, ctx);
    window.entries.push(entry);
    const counted = this.tokenizer.count(String(entry.content));
    window.tokenCount += counted;

    if (window.tokenCount > window.limit * this.config.memory.compressionThreshold) {
      await this.compress(sessionId);
    }
  }

  /**
   * **批量**注入一组历史 entries 到指定 session 的 context window。
   *
   * 典型使用方：`@tachu/extensions` 的 `FsMemorySystem` 在启动 hydrate 时，把
   * `.tachu/memory/<sid>.jsonl` 读回的条目一次性塞回进程内 memory。
   *
   * 与 `append()` 的关键差异：
   * - **旁路 per-entry compression 触发**：多条 entries 之间不会触发 `compress()`
   *   中的 LLM 摘要调用（否则 hydrate 大 session 时会产生大量 provider 请求）
   * - 注入完成后**仅一次**检查阈值；若越线则触发一次 compress，与正常运行时语义
   *   保持一致
   * - 按 `timestamp` 升序稳定注入（若 entries 未排序，这里会排）
   * - tokenCount 统一由 `computeTokenCount` 重算，避免 per-entry 估算误差累积
   *
   * @param sessionId 会话 ID
   * @param entries 历史条目（通常来自持久化存储的反序列化结果）
   */
  async hydrate(sessionId: string, entries: MemoryEntry[], ctx?: AdapterCallContext): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const window = await this.load(sessionId, ctx ?? DEFAULT_ADAPTER_CALL_CONTEXT);
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    for (const entry of sorted) {
      window.entries.push(entry);
    }
    window.tokenCount = await this.computeTokenCount(window.entries);
    if (window.tokenCount > window.limit * this.config.memory.compressionThreshold) {
      await this.compress(sessionId);
    }
  }

  /**
   * @inheritdoc
   */
  async clear(sessionId: string): Promise<void> {
    this.windows.delete(sessionId);
    this.adapterCtxBySession.delete(sessionId);
  }

  /**
   * @inheritdoc
   */
  async compress(sessionId: string): Promise<void> {
    const window = await this.load(sessionId, this.resolveAdapterContext(sessionId));
    if (window.entries.length === 0) {
      return;
    }

    await this.archive(sessionId);
    window.entries = await this.compressEntries(sessionId, window.entries, window.limit);
    window.tokenCount = await this.computeTokenCount(window.entries);
  }

  /**
   * @inheritdoc
   */
  async recall(sessionId: string, query: string, topK = 5): Promise<MemoryEntry[]> {
    const results = await this.vectorStore.search(
      { query, topK },
      this.resolveAdapterContext(sessionId),
    );
    return results.map((item) => ({
      role: "system",
      content: item.metadata.content ?? "",
      timestamp:
        typeof item.metadata.timestamp === "number" ? item.metadata.timestamp : Date.now(),
      anchored: true,
    }));
  }

  /**
   * @inheritdoc
   */
  async archive(sessionId: string): Promise<void> {
    const window = await this.load(sessionId, this.resolveAdapterContext(sessionId));
    if (window.entries.length === 0) {
      return;
    }

    const archivePath = this.config.memory.archivePath;
    await mkdir(dirname(archivePath), { recursive: true });

    for (const entry of window.entries) {
      const line = JSON.stringify({ sessionId, ...entry });
      await appendFile(archivePath, `${line}\n`, "utf8");
      await this.vectorStore.upsert(
        `${sessionId}-${entry.timestamp}`,
        String(entry.content),
        {
          sessionId,
          role: entry.role,
          timestamp: entry.timestamp,
          content: entry.content,
        },
      );
    }
  }

  /**
   * @inheritdoc
   */
  async getSize(sessionId: string): Promise<{ entries: number; tokens: number }> {
    const window = await this.load(sessionId, this.resolveAdapterContext(sessionId));
    return { entries: window.entries.length, tokens: window.tokenCount };
  }

  /**
   * @inheritdoc
   *
   * 按 `keepHead` / `keepTail` 保留头尾消息（其余进入中段摘要或被丢弃）。
   * 未提供选项时回落到配置 `memory.headKeep` / `memory.tailKeep`。
   */
  async trim(
    sessionId: string,
    options?: { keepHead?: number; keepTail?: number },
  ): Promise<void> {
    const window = await this.load(sessionId, this.resolveAdapterContext(sessionId));
    if (window.entries.length === 0) {
      return;
    }
    const keepHead = Math.max(0, options?.keepHead ?? this.config.memory.headKeep);
    const keepTail = Math.max(0, options?.keepTail ?? this.config.memory.tailKeep);
    if (window.entries.length <= keepHead + keepTail) {
      return;
    }
    window.entries = await this.trimEntries(sessionId, window.entries, keepHead, keepTail);
    window.tokenCount = await this.computeTokenCount(window.entries);
  }

  private async trimEntries(
    sessionId: string,
    entries: MemoryEntry[],
    keepHead: number,
    keepTail: number,
  ): Promise<MemoryEntry[]> {
    const anchored = entries.filter((entry) => entry.anchored);
    const nonAnchored = entries.filter((entry) => !entry.anchored);
    const head = nonAnchored.slice(0, keepHead);
    const tail = keepTail > 0 ? nonAnchored.slice(Math.max(nonAnchored.length - keepTail, 0)) : [];
    const middle = nonAnchored.slice(keepHead, nonAnchored.length - keepTail);

    if (middle.length === 0) {
      return [...anchored, ...head, ...tail].sort((a, b) => a.timestamp - b.timestamp);
    }
    const summary = await this.summarizeMiddleWithProvider(sessionId, middle);
    const summaryEntry: MemoryEntry = summary
      ? {
          role: "system",
          content: `中段摘要: ${summary}`,
          timestamp: Date.now(),
          anchored: true,
        }
      : {
          role: "system",
          content: `中段摘要: ${middle
            .map((entry) => `${entry.role}: ${String(entry.content)}`)
            .join("\n")
            .slice(0, 2_000)}`,
          timestamp: Date.now(),
          anchored: true,
        };
    return [...anchored, ...head, summaryEntry, ...tail].sort((a, b) => a.timestamp - b.timestamp);
  }

  private async compressEntries(
    sessionId: string,
    entries: MemoryEntry[],
    targetTokens: number,
  ): Promise<MemoryEntry[]> {
    if (entries.length <= this.config.memory.headKeep + this.config.memory.tailKeep) {
      return entries;
    }

    const anchored = entries.filter((entry) => entry.anchored);
    const nonAnchored = entries.filter((entry) => !entry.anchored);
    const head = nonAnchored.slice(0, this.config.memory.headKeep);
    const tail =
      this.config.memory.tailKeep > 0
        ? nonAnchored.slice(Math.max(nonAnchored.length - this.config.memory.tailKeep, 0))
        : [];
    const middle = nonAnchored.slice(
      this.config.memory.headKeep,
      nonAnchored.length - this.config.memory.tailKeep,
    );

    if (middle.length === 0) {
      return [...anchored, ...head, ...tail].sort((a, b) => a.timestamp - b.timestamp);
    }

    const summary = await this.summarizeMiddleWithProvider(sessionId, middle);
    if (!summary) {
      return this.fallbackCompressor.compress(entries, targetTokens);
    }

    const summaryEntry: MemoryEntry = {
      role: "system",
      content: `中段摘要: ${summary}`,
      timestamp: Date.now(),
      anchored: true,
    };
    return [...anchored, ...head, summaryEntry, ...tail].sort((a, b) => a.timestamp - b.timestamp);
  }

  private async summarizeMiddleWithProvider(
    sessionId: string,
    middle: MemoryEntry[],
  ): Promise<string | null> {
    const route =
      this.tryResolveModelRoute("compress") ??
      this.tryResolveModelRoute("fast-cheap");
    if (!route) {
      return null;
    }

    const provider = this.providers.get(route.provider);
    if (!provider) {
      return null;
    }

    const middleText = middle
      .map((entry) => `${entry.role}: ${String(entry.content)}`)
      .join("\n")
      .slice(0, 8_000);
    if (!middleText) {
      return null;
    }

    try {
      const response = await provider.chat(
        {
          model: route.model,
          messages: [
            {
              role: "system",
              content:
                "你是记忆压缩器。请将会话中段压缩为最多 180 字的事实摘要，保留目标、关键决策、约束与未完成事项，不要编造内容。",
            },
            {
              role: "user",
              content: middleText,
            },
          ],
          temperature: 0,
          maxTokens: 256,
        },
        this.resolveAdapterContext(sessionId),
      );
      const content = response.content.trim();
      return content.length > 0 ? content.slice(0, 2_000) : null;
    } catch {
      return null;
    }
  }

  private tryResolveModelRoute(tag: string): { provider: string; model: string } | null {
    try {
      const route = this.modelRouter.resolve(tag);
      return { provider: route.provider, model: route.model };
    } catch {
      return null;
    }
  }

  private async computeTokenCount(entries: MemoryEntry[]): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }
    const flattened = entries.map((entry) => String(entry.content)).join("\n");
    return this.tokenizer.count(flattened);
  }
}

/**
 * 从 Message 生成 MemoryEntry。
 *
 * @param message 统一消息结构
 * @returns 对应的记忆条目
 */
export const messageToMemoryEntry = (message: Message): MemoryEntry => ({
  role: message.role,
  content: message.content,
  timestamp: Date.now(),
  anchored: false,
});

