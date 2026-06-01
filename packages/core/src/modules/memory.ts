import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EngineConfig, Message } from "../types";
import type { ResourceReference } from "../types/resource";
import type { AdapterCallContext } from "../types/context";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import type { ModelRouter } from "./model-router";
import type { ProviderAdapter } from "./provider";
import type { Tokenizer } from "../prompt/tokenizer";
import type { VectorStore } from "../vector";
import { buildLlmCallAbortSignal, resolveLlmTimeouts } from "../engine/llm-timeouts";

/**
 * 记忆条目。
 */
export interface MemoryEntry {
 /** 条目唯一标识，由 `append()` 自动生成（ */
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  timestamp: number;
  anchored: boolean;
 /**
 * 与本条目**同生命周期**持久化的旁路 Resource Pool。
 *
 * 正文（`content`）以 `[[ref:<kind>:<key>]]` 占位 token 引用之；引用与文本同存亡，
 * 非 session 级全局池。仅新 session 写新格式，旧 JSONL 不迁移（一刀切）。
 */
  resources?: ResourceReference[] | undefined;
}

/**
 * 上下文窗口。
 */
export interface ContextWindow {
  entries: MemoryEntry[];
  tokenCount: number;
  limit: number;
}

export interface MemorySummary {
  id: string;
  sessionId: string;
  sourceEntryIds: string[];
  sourceRange: { fromTs: number; toTs: number };
  content: string;
  method: "llm" | "head-middle-tail" | "manual";
  model?: string | undefined;
  createdAt: number;
}

export interface ArchiveRef {
  id: string;
  path?: string | undefined;
  entryIds: string[];
  createdAt: number;
}

export type ProjectionStatus =
  | { kind: "pending"; ref: string; reason: string; createdAt: number }
  | { kind: "indexed"; ref: string; indexedAt: number; adapter: string }
  | {
      kind: "failed";
      ref: string;
      error: string;
      retryable: boolean;
      attempts: number;
    }
  | { kind: "stale"; ref: string; reason: string };

export interface SessionBudget {
  tokenLimit?: number | undefined;
  tokenUsed?: number | undefined;
}

export interface SessionCheckpoint {
  id: string;
  createdAt: number;
  state?: unknown | undefined;
}

export interface SessionMeta {
  id: string;
  updatedAt: number;
  entryCount: number;
}

export interface SessionMemorySnapshot {
  meta: SessionMeta;
  hotLog: MemoryEntry[];
  summaries: MemorySummary[];
  archiveRefs: ArchiveRef[];
  projectionStatus: ProjectionStatus[];
  budget: SessionBudget;
  checkpoint?: SessionCheckpoint | undefined;
}

export type MemoryViewKind =
  | "hot-log"
  | "summary"
  | "export"
  | "recall-corpus"
  | "sub-agent-slice";

export interface MemoryViewRequest {
  kind: MemoryViewKind;
  limit?: number | undefined;
  since?: number | undefined;
  includeArchived?: boolean | undefined;
}

export interface MemoryView {
  kind: MemoryViewKind;
  entries: MemoryEntry[];
  summaries: MemorySummary[];
  projectionStatus: ProjectionStatus[];
}

export interface AppendResult {
  appended: number;
  projectionStatus: ProjectionStatus[];
}

export interface CompactionPolicy {
  targetTokens?: number | undefined;
  method?: "llm" | "head-middle-tail" | "manual" | undefined;
}

export interface CompactionResult {
  summaries: MemorySummary[];
  archiveRefs: ArchiveRef[];
}

export interface MemoryProjectionResult {
  ref: string;
  vectorId: string;
}

export interface DurableSessionMemory {
  loadSession(sessionId: string, ctx: AdapterCallContext): Promise<SessionMemorySnapshot>;
  appendEntries(
    sessionId: string,
    entries: MemoryEntry[],
    ctx: AdapterCallContext,
  ): Promise<AppendResult>;
  compact(
    sessionId: string,
    policy: CompactionPolicy,
    ctx: AdapterCallContext,
  ): Promise<CompactionResult>;
  loadView(
    sessionId: string,
    view: MemoryViewRequest,
    ctx: AdapterCallContext,
  ): Promise<MemoryView>;
  checkpoint(
    sessionId: string,
    checkpoint: SessionCheckpoint,
    ctx: AdapterCallContext,
  ): Promise<void>;
  clear(sessionId: string, ctx?: AdapterCallContext): Promise<void>;
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
 * 返回会话全部记忆条目（不分页、不过滤），用于语义索引召回路径。
 *
 * @param sessionId 会话 ID
 * @returns 全量记忆条目
 */
  loadFull(sessionId: string): Promise<MemoryEntry[]>;
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
 * 将会话当前窗口归档到本地文件。
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
              id: `summary-${Date.now()}`,
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
  private idCounter = 0;

  constructor(
    private readonly config: EngineConfig,
    private readonly tokenizer: Tokenizer,
    private readonly modelRouter: ModelRouter,
    private readonly providers: Map<string, ProviderAdapter>,
    _vectorStore: VectorStore,
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
    const stored: MemoryEntry = entry.id
      ? entry
      : { ...entry, id: `${entry.timestamp}-${this.idCounter++}` };
    window.entries.push(stored);
    const counted = this.tokenizer.count(String(stored.content));
    window.tokenCount += counted;

    if (window.tokenCount > window.limit * this.config.memory.compressionThreshold) {
      await this.compress(sessionId);
    }
  }

 /**
 * @inheritdoc
 */
  async loadFull(sessionId: string): Promise<MemoryEntry[]> {
    const window = this.windows.get(sessionId);
    return window ? [...window.entries] : [];
  }

 /**
 *
 * 典型使用方：`@tachu/extensions` 的 `FsMemorySystem` 在启动 hydrate 时，把
 * `.tachu/memory/<sid>.jsonl` 读回的条目一次性塞回进程内 memory。
 *
 * 与 `append()` 的关键差异：
 * - **旁路 per-entry compression 触发**：多条 entries 之间不会触发 `compress()`
 * 中的 LLM 摘要调用（否则 hydrate 大 session 时会产生大量 provider 请求）
 * - 注入完成后**仅一次**检查阈值；若越线则触发一次 compress，与正常运行时语义
 * 保持一致
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
    void sessionId;
    void query;
    void topK;
    return [];
  }

 /**
 * @inheritdoc
 */
  async archive(sessionId: string): Promise<void> {
    const window = await this.load(sessionId, this.resolveAdapterContext(sessionId));
    if (window.entries.length === 0) {
      return;
    }
    await this.archiveSource(sessionId);
  }

  async archiveSource(sessionId: string): Promise<void> {
    const window = await this.load(sessionId, this.resolveAdapterContext(sessionId));
    if (window.entries.length === 0) {
      return;
    }
    const archivePath = this.config.memory.archivePath;
    await mkdir(dirname(archivePath), { recursive: true });
    for (const entry of window.entries) {
      const line = JSON.stringify({ sessionId, ...entry });
      await appendFile(archivePath, `${line}\n`, "utf8");
    }
  }

 /**
 * @deprecated decision 8 retired in-memory text projection. Use a
 * host-wired ProjectionWorker with EmbeddingRuntime + VectorIndexAdapter.
 */
  async project(sessionId: string, refs?: readonly string[]): Promise<MemoryProjectionResult[]> {
    void sessionId;
    void refs;
    throw new Error(
      "InMemoryMemorySystem.project was retired; use ProjectionWorker",
    );
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
          id: `summary-${Date.now()}`,
          role: "system",
          content: `中段摘要: ${summary}`,
          timestamp: Date.now(),
          anchored: true,
        }
      : {
          id: `summary-${Date.now()}`,
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
      id: `summary-${Date.now()}`,
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
      const llmTimeouts = resolveLlmTimeouts(this.config, "memory");
      const signal = buildLlmCallAbortSignal(
        new AbortController().signal,
        llmTimeouts.llmStreamingMs,
        "streaming",
      );
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
        signal,
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
    const flattened = entries.map((entry) => this.flattenEntryContentForTokenEstimate(entry)).join("\n");
    return this.tokenizer.count(flattened);
  }

 /** Image refs use a fixed estimate; avoid counting base64-sized blobs (). */
  private flattenEntryContentForTokenEstimate(entry: MemoryEntry): string {
    const { content } = entry;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return String(content ?? "");
    }
    const parts = content as Array<{ type: string; text?: string; file?: { mimeType?: string; uri?: string } }>;
    return parts
      .map((part) => {
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        if (part.type === "file" && part.file?.mimeType?.startsWith("image/")) {
          return "[image-ref]";
        }
        if (part.type === "image_url") {
          return "[image-inline]";
        }
        return "";
      })
      .join("\n");
  }
}

let _msgEntryCounter = 0;

/**
 * 从 Message 生成 MemoryEntry。
 *
 * @param message 统一消息结构
 * @returns 对应的记忆条目
 */
export const messageToMemoryEntry = (message: Message): MemoryEntry => ({
  id: `${Date.now()}-${_msgEntryCounter++}`,
  role: message.role,
  content: message.content,
  timestamp: Date.now(),
  anchored: false,
  ...(message.resources !== undefined ? { resources: message.resources } : {}),
});

const isMessageContentPartArray = (value: unknown): value is Message["content"] & unknown[] =>
  Array.isArray(value) &&
  value.every(
    (p) =>
      p !== null &&
      typeof p === "object" &&
      "type" in p &&
      typeof (p as { type: unknown }).type === "string",
  );

/**
 * MemoryEntry → Message；仅 user / assistant / system。
 * 保留结构化 `MessageContentPart[]`（ / JSON.stringify。
 */
export const memoryEntryToMessage = (entry: MemoryEntry): Message | null => {
  if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "system") {
    return null;
  }
  const withResources = (content: Message["content"]): Message => ({
    role: entry.role as Message["role"],
    content,
    ...(entry.resources !== undefined ? { resources: entry.resources } : {}),
  });
  if (typeof entry.content === "string") {
    return withResources(entry.content);
  }
  if (isMessageContentPartArray(entry.content)) {
    return withResources(entry.content);
  }
  return withResources(String(entry.content ?? ""));
};
