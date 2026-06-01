import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  InMemoryMemorySystem,
  type AdapterCallContext,
  type ContextWindow,
  type MemoryEntry,
  type MemorySystem,
} from "@tachu/core";
import { ProjectionOutbox } from "./projection-outbox";
import { ProjectionWorker } from "./projection-worker";

/**
 * `FsMemorySystem` 构造依赖（来自 `@tachu/core` 的 `MemorySystemFactoryDeps`）。
 *
 * 解耦设计：extensions 不强依赖 core 的 `MemorySystemFactoryDeps` 类型签名变动，
 * 内部自描述只取真正需要的字段。
 */
export interface FsMemorySystemOptions {
 /**
 * 持久化根目录，每个 session 对应 `<persistDir>/<sanitizedId>.jsonl`。
 */
  persistDir: string;
 /**
 * 内部组合的 `InMemoryMemorySystem` 实例。由调用方（通常为 engine-factory
 * 通过 core 的 factory 回调）构造好后传入，以复用 core 的 tokenizer /
 * modelRouter / providers / vectorStore 等运行时依赖。
 */
  inner: InMemoryMemorySystem;
 /**
 * 压缩触发阈值（0-1）。默认读 `config.memory.compressionThreshold`。
 * 超过 `contextTokenLimit * threshold` 时在 `append` 中触发 `compress`。
 */
  compressionThreshold: number;
 /**
 * 可选的 projection outbox。若提供，`archive()` 会通过 outbox
 * 跟踪每条投递的状态（pending/retrying/indexed/failed/dead），`pendingProjection`
 * 返回真实状态而非常量模板；启动时自动 `recover()` 陈旧 retrying 项。
 * 不提供时退化到旧的"始终 pending"行为，保持向后兼容。
 */
  projectionOutbox?: ProjectionOutbox | undefined;
 /**
 * optional embed+vector projection callback for {@link ProjectionWorker}.
 * When set, {@link createProjectionWorker} uses this instead of `inner.project`.
 */
  projectionProject?: (
    sessionId: string,
    refs: readonly string[],
    signal: AbortSignal,
  ) => Promise<import("./projection-worker").ProjectionWorkerProjectResult[] | void>;
}

export interface FsArchiveOptions {
  awaitProjection?: boolean | undefined;
}

const JSONL_SEP = "\n";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseMemoryEntry(raw: unknown): MemoryEntry | null {
  if (!isObject(raw)) return null;
  const { id, role, content, timestamp, anchored } = raw as Record<string, unknown>;
  if (
    (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }
  return {
    id: typeof id === "string" && id.length > 0 ? id : `fs-${timestamp}`,
    role,
    content: content as MemoryEntry["content"],
    timestamp,
    anchored: Boolean(anchored),
  };
}

/**
 * 将任意 session ID 标准化为文件名安全形式。
 *
 * 规则：
 * - 仅保留 `[A-Za-z0-9._-]`，其余一律替换为 `_`
 * - 首位不允许为 `.`（防止写隐藏文件 / 触发 shell 点号展开）
 * - 空串兜底为 `default`
 * - 超长截断到 120 字符（绝大多数 UUID / nanoid 场景足够）
 */
export function sanitizeSessionId(raw: string): string {
  const replaced = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const stripped = replaced.replace(/^\.+/, "_");
  const bounded = stripped.length > 120 ? stripped.slice(0, 120) : stripped;
  return bounded.length === 0 ? "default" : bounded;
}

/**
 * 基于文件系统的 `MemorySystem` 实现 —— `@tachu/core` `MemorySystem` 抽象的
 * **跨进程持久化** 参考实现（patch-02-session-persistence）。
 *
 * ## 职责
 *
 * - 每次 `append` 先把单条 entry 以 append-only JSON line 写入
 * `<persistDir>/<sid>.jsonl`（crash-safe），再同步进内部
 * `InMemoryMemorySystem` 的运行时 window
 * - 首次 `load(sid)` 命中时从磁盘 hydrate 上次进程遗留的历史，注入内部
 * `InMemoryMemorySystem`（走 public `hydrate()`，旁路 per-entry compress 触发）
 * - `compress()` 完成后 atomic rewrite 持久化文件，保证"盘 = 内存"一致
 * - `recall` / `archive` / `getSize` / `trim` 全部代理内部 `InMemoryMemorySystem`
 * （只要 load 阶段已 hydrate，这些读路径天然拿到跨进程数据）
 *
 * ## 并发
 *
 * 单 session 上的 `load` / `append` / `compress` / `trim` 通过 per-session promise
 * chain 串行化，避免两个 runStream 并发交错写出错乱 jsonl。跨 session 完全独立。
 *
 * ## 与 `archivePath` 的职责分离
 *
 * - `config.memory.persistDir`（本类）= 热路径：每次 append 即落盘，用于跨进程 `--resume`
 * - `config.memory.archivePath`（内部 `InMemoryMemorySystem` 拥有）= 冷路径：
 * 仅在 `compress()` 时一次性追加到单个大 jsonl，供长期记忆向量召回
 *
 * 两者**不重叠**，保留现有 archivePath 语义不动。
 */
export type FsProjectionStatus =
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

export interface FsMemorySummary {
  id: string;
  sessionId: string;
  sourceEntryIds: string[];
  sourceRange: { fromTs: number; toTs: number };
  content: string;
  method: "llm" | "head-middle-tail" | "manual";
  model?: string | undefined;
  createdAt: number;
}

export interface FsSessionCheckpoint {
  id: string;
  createdAt: number;
  state?: unknown | undefined;
}

export interface FsSessionMemorySnapshot {
  meta: { id: string; updatedAt: number; entryCount: number };
  hotLog: MemoryEntry[];
  summaries: FsMemorySummary[];
  archiveRefs: Array<{ id: string; path?: string | undefined; entryIds: string[]; createdAt: number }>;
  projectionStatus: FsProjectionStatus[];
  budget: { tokenLimit?: number | undefined; tokenUsed?: number | undefined };
  checkpoint?: FsSessionCheckpoint | undefined;
}

export interface FsMemoryViewRequest {
  kind: "hot-log" | "summary" | "export" | "recall-corpus" | "sub-agent-slice";
  limit?: number | undefined;
  since?: number | undefined;
  includeArchived?: boolean | undefined;
}

export interface FsMemoryView {
  kind: FsMemoryViewRequest["kind"];
  entries: MemoryEntry[];
  summaries: FsMemorySummary[];
  projectionStatus: FsProjectionStatus[];
}

export class FsMemorySystem implements MemorySystem {
  private readonly persistDir: string;
  private readonly inner: InMemoryMemorySystem;
  private readonly compressionThreshold: number;
  private readonly hydrated = new Set<string>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly checkpoints = new Map<string, FsSessionCheckpoint>();
  private readonly outbox?: ProjectionOutbox | undefined;
  private readonly projectionProject?: FsMemorySystemOptions["projectionProject"];
  private readonly recovered = new Set<string>();

 /**
 * 构造文件持久化 MemorySystem。
 *
 * @param options 参见 {@link FsMemorySystemOptions}
 */
  constructor(options: FsMemorySystemOptions) {
    this.persistDir = options.persistDir;
    this.inner = options.inner;
    this.compressionThreshold = options.compressionThreshold;
    this.outbox = options.projectionOutbox;
    this.projectionProject = options.projectionProject;
  }

 /**
 * @inheritdoc
 */
  async load(sessionId: string, ctx: AdapterCallContext): Promise<ContextWindow> {
    return this.serialize(sessionId, async () => {
      await this.hydrateIfNeeded(sessionId);
      return this.inner.load(sessionId, ctx);
    });
  }

 /**
 * @inheritdoc
 *
 * 流程：
 * 1. 确保 session 已 hydrate（使 window 与磁盘一致）
 * 2. append-only 将 entry 序列化为单行 JSON 落盘（崩溃安全；即便本次进程 crash，
 * 磁盘文件仍是合法 jsonl 的前缀）
 * 3. 将 entry 通过 `inner.hydrate()` 注入内存 window（旁路 per-entry compress）
 * 4. 手动检查 tokenCount 是否越过阈值；若越线：
 * - `inner.compress(sid)` 触发 LLM 摘要
 * - atomic rewrite jsonl，保持盘与内存一致
 */
  async append(sessionId: string, entry: MemoryEntry, ctx: AdapterCallContext): Promise<void> {
    await this.serialize(sessionId, async () => {
      await this.hydrateIfNeeded(sessionId);
      await this.writeJsonlLine(sessionId, entry);
      await this.inner.hydrate(sessionId, [entry]);
      const window = await this.inner.load(sessionId, ctx);
      if (window.tokenCount > window.limit * this.compressionThreshold) {
        await this.inner.compress(sessionId);
        await this.rewriteJsonl(sessionId);
      }
    });
  }

  async appendEntries(
    sessionId: string,
    entries: MemoryEntry[],
    ctx: AdapterCallContext,
  ): Promise<{ appended: number; projectionStatus: FsProjectionStatus[] }> {
    for (const entry of entries) {
      await this.append(sessionId, entry, ctx);
    }
    return {
      appended: entries.length,
      projectionStatus: entries.map((entry) => this.pendingProjection(entry.id)),
    };
  }

 /**
 * @inheritdoc
 */
  async compress(sessionId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      await this.hydrateIfNeeded(sessionId);
      await this.inner.compress(sessionId);
      await this.rewriteJsonl(sessionId);
    });
  }

 /**
 * @inheritdoc
 */
  async recall(
    sessionId: string,
    query: string,
    topK?: number,
  ): Promise<MemoryEntry[]> {
    await this.hydrateIfNeeded(sessionId);
    return topK === undefined
      ? this.inner.recall(sessionId, query)
      : this.inner.recall(sessionId, query, topK);
  }

 /**
 * @inheritdoc
 */
  async loadFull(sessionId: string): Promise<MemoryEntry[]> {
    await this.hydrateIfNeeded(sessionId);
    return this.inner.loadFull(sessionId);
  }

  async loadSession(
    sessionId: string,
    ctx: AdapterCallContext,
  ): Promise<FsSessionMemorySnapshot> {
    const window = await this.load(sessionId, ctx);
    const entries = [...window.entries].sort((left, right) => left.timestamp - right.timestamp);
    const updatedAt =
      entries.length > 0 ? Math.max(...entries.map((entry) => entry.timestamp)) : Date.now();
    const archiveRefs = await this.readArchiveRefs(sessionId);
    const outboxByRef = await this.snapshotOutboxByRef(sessionId);
    return {
      meta: {
        id: sessionId,
        updatedAt,
        entryCount: entries.length,
      },
      hotLog: entries,
      summaries: this.extractSummaries(sessionId, entries),
      archiveRefs,
      projectionStatus: entries.map((entry) =>
        this.projectionStatusFor(entry.id, outboxByRef),
      ),
      budget: {
        tokenLimit: window.limit,
        tokenUsed: window.tokenCount,
      },
      ...(this.checkpoints.has(sessionId)
        ? { checkpoint: this.checkpoints.get(sessionId)! }
        : {}),
    };
  }

  async loadView(
    sessionId: string,
    view: FsMemoryViewRequest,
    ctx: AdapterCallContext,
  ): Promise<FsMemoryView> {
    const snapshot = await this.loadSession(sessionId, ctx);
    const since = view.since ?? Number.NEGATIVE_INFINITY;
    const entries = snapshot.hotLog
      .filter((entry) => entry.timestamp >= since)
      .slice(view.limit !== undefined ? -view.limit : 0);
    if (view.kind === "summary") {
      return {
        kind: view.kind,
        entries: [],
        summaries: snapshot.summaries,
        projectionStatus: snapshot.projectionStatus,
      };
    }
    return {
      kind: view.kind,
      entries,
      summaries: snapshot.summaries,
      projectionStatus: snapshot.projectionStatus,
    };
  }

  async compact(
    sessionId: string,
    _policy: { targetTokens?: number; method?: "llm" | "head-middle-tail" | "manual" },
    _ctx: AdapterCallContext,
  ): Promise<{ summaries: FsMemorySummary[]; archiveRefs: FsSessionMemorySnapshot["archiveRefs"] }> {
    await this.compress(sessionId);
    const entries = await this.loadFull(sessionId);
 // archiveRefs 持久化。compact 生成一条 ref 描述本次压缩涉及的 entry 集合，
 // 落盘到 `<persistDir>/<sid>.archive.json`，确保跨进程 `loadSession` 能正确回放。
    const existing = await this.readArchiveRefs(sessionId);
    const next: FsSessionMemorySnapshot["archiveRefs"] = [
      ...existing,
      {
        id: `compact-${Date.now()}`,
        entryIds: entries.map((entry) => entry.id),
        createdAt: Date.now(),
      },
    ];
    await this.writeArchiveRefs(sessionId, next);
    return {
      summaries: this.extractSummaries(sessionId, entries),
      archiveRefs: next,
    };
  }

  async checkpoint(
    sessionId: string,
    checkpoint: FsSessionCheckpoint,
    _ctx: AdapterCallContext,
  ): Promise<void> {
    this.checkpoints.set(sessionId, checkpoint);
  }

 /**
 * @inheritdoc
 *
 * 当 host 注入 `projectionOutbox` 时，每条 entry 走 outbox 状态机
 * （pending → retrying → indexed/failed/dead），并在首次 archive 该 session 时
 * 自动 `recover()` 残留的陈旧 retrying 项。
 *
 * `awaitProjection=false` 时只写冷归档并入队 projection，由 `ProjectionWorker`
 * 后台 flush；默认保持旧同步语义，等待本轮 projection 完成后返回。
 */
  async archive(sessionId: string, options: FsArchiveOptions = {}): Promise<void> {
    await this.hydrateIfNeeded(sessionId);
    if (!this.outbox) {
      await this.inner.archive(sessionId);
      return;
    }
    if (!this.recovered.has(sessionId)) {
      await this.outbox.recover(sessionId);
      this.recovered.add(sessionId);
    }
    const entries = await this.inner.loadFull(sessionId);
    if (entries.length === 0) return;
    for (const entry of entries) {
      await this.outbox.enqueue(sessionId, entry.id);
    }
    await this.inner.archiveSource(sessionId);
    if (options.awaitProjection !== false) {
      await this.createProjectionWorker().flush(sessionId);
    }
  }

 /**
 * Construct a {@link ProjectionWorker} that drains the outbox via the
 * host-injected `projectionProject` callback.
 *
 * **Fail-closed contract:** when `projectionOutbox` is
 * enabled, `projectionProject` MUST be provided. The legacy fallback to
 * `InMemoryMemorySystem.project()` (which forwarded raw `string` content
 * straight to `VectorStore.upsert(id, text, { content })` and bypassed the
 * `EmbeddingRuntime` / `VectorIndexAdapter` stack) has been removed — any
 * production host that forgets to wire the projector now crashes loudly
 * instead of silently re-introducing the deprecated text-embed path.
 */
  createProjectionWorker(options?: { intervalMs?: number | undefined }): ProjectionWorker {
    if (!this.outbox) {
      throw new Error("ProjectionWorker requires FsMemorySystem.projectionOutbox");
    }
    if (!this.projectionProject) {
      throw new Error(
        "ProjectionWorker requires FsMemorySystem.projectionProject when projectionOutbox is enabled. " +
          "Inject an embedding-runtime + vector-index backed projector via host-defaults' " +
          "resolveProjectionStack(); the legacy inner.project() fallback has been retired.",
      );
    }
    return new ProjectionWorker({
      outbox: this.outbox,
      ...(options?.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      project: this.projectionProject,
    });
  }

 /**
 * @inheritdoc
 */
  async getSize(sessionId: string): Promise<{ entries: number; tokens: number }> {
    await this.hydrateIfNeeded(sessionId);
    return this.inner.getSize(sessionId);
  }

 /**
 * @inheritdoc
 */
  async trim(
    sessionId: string,
    options?: { keepHead?: number; keepTail?: number },
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      await this.hydrateIfNeeded(sessionId);
      await this.inner.trim(sessionId, options);
      await this.rewriteJsonl(sessionId);
    });
  }

 /**
 * @inheritdoc
 *
 * 先清内存 window，再幂等删除磁盘 jsonl。未找到文件视为 no-op。
 */
  async clear(sessionId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      this.hydrated.delete(sessionId);
      this.checkpoints.delete(sessionId);
      await this.inner.clear(sessionId);
      const path = this.pathFor(sessionId);
      try {
        await rm(path, { force: true });
      } catch {
 // ignore
      }
    });
  }

  private pendingProjection(ref: string): FsProjectionStatus {
    return {
      kind: "pending",
      ref,
      reason: "awaiting semantic projection",
      createdAt: Date.now(),
    };
  }

  private async snapshotOutboxByRef(
    sessionId: string,
  ): Promise<Map<string, FsProjectionStatus> | undefined> {
    if (!this.outbox) return undefined;
    const records = await this.outbox.list(sessionId);
    const map = new Map<string, FsProjectionStatus>();
    for (const rec of records) {
      switch (rec.state) {
        case "indexed":
          map.set(rec.ref, {
            kind: "indexed",
            ref: rec.ref,
            indexedAt: rec.updatedAt,
            adapter: "vector-store",
          });
          break;
        case "failed":
        case "retrying":
        case "dead":
          map.set(rec.ref, {
            kind: "failed",
            ref: rec.ref,
            error: rec.lastError ?? "unknown",
            retryable: rec.state !== "dead",
            attempts: rec.attempts,
          });
          break;
        case "pending":
        default:
          map.set(rec.ref, {
            kind: "pending",
            ref: rec.ref,
            reason: "awaiting semantic projection",
            createdAt: rec.createdAt,
          });
      }
    }
    return map;
  }

  private projectionStatusFor(
    ref: string,
    outboxByRef: Map<string, FsProjectionStatus> | undefined,
  ): FsProjectionStatus {
    if (outboxByRef) {
      const status = outboxByRef.get(ref);
      if (status) return status;
    }
    return this.pendingProjection(ref);
  }

 /** archiveRefs 持久化路径。 */
  private archiveRefsPathFor(sessionId: string): string {
    return join(this.persistDir, `${sanitizeSessionId(sessionId)}.archive.json`);
  }

  private async readArchiveRefs(
    sessionId: string,
  ): Promise<FsSessionMemorySnapshot["archiveRefs"]> {
    const path = this.archiveRefsPathFor(sessionId);
    if (!existsSync(path)) return [];
    try {
      const text = await readFile(path, "utf8");
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof (item as { id: unknown }).id === "string" &&
          Array.isArray((item as { entryIds: unknown }).entryIds) &&
          typeof (item as { createdAt: unknown }).createdAt === "number",
      ) as FsSessionMemorySnapshot["archiveRefs"];
    } catch {
      return [];
    }
  }

  private async writeArchiveRefs(
    sessionId: string,
    refs: FsSessionMemorySnapshot["archiveRefs"],
  ): Promise<void> {
    const path = this.archiveRefsPathFor(sessionId);
    await mkdir(this.persistDir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(refs, null, 2), "utf8");
    await rename(tmp, path);
  }

  private extractSummaries(sessionId: string, entries: MemoryEntry[]): FsMemorySummary[] {
    return entries
      .filter(
        (entry) =>
          entry.role === "system" &&
          typeof entry.content === "string" &&
          entry.content.includes("摘要"),
      )
      .map((entry) => ({
        id: entry.id,
        sessionId,
        sourceEntryIds: [],
        sourceRange: { fromTs: entry.timestamp, toTs: entry.timestamp },
        content: entry.content as string,
        method: "head-middle-tail",
        createdAt: entry.timestamp,
      }));
  }

 /**
 * 获取某 session 的持久化文件绝对 / 相对路径（便于外层 CLI 做迁移、/history 展示）。
 */
  pathFor(sessionId: string): string {
    return join(this.persistDir, `${sanitizeSessionId(sessionId)}.jsonl`);
  }

 /**
 * 从磁盘读取 session 的原始 entries 快照（不经 inner hydrate）。
 *
 * 外层 CLI 可借此在 `/history` / `/export` 命令中直接列出原始条目顺序，
 * 不必先 `load` 触发 hydrate 副作用。
 */
  async readRaw(sessionId: string): Promise<MemoryEntry[]> {
    const path = this.pathFor(sessionId);
    if (!existsSync(path)) {
      return [];
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    return this.parseJsonl(raw);
  }

  private parseJsonl(raw: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    for (const line of raw.split(JSONL_SEP)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const entry = parseMemoryEntry(parsed);
        if (entry) entries.push(entry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  private async hydrateIfNeeded(sessionId: string): Promise<void> {
    if (this.hydrated.has(sessionId)) return;
    this.hydrated.add(sessionId);

    const entries = await this.readRaw(sessionId);
    if (entries.length === 0) return;
    await this.inner.hydrate(sessionId, entries);
  }

  private async writeJsonlLine(sessionId: string, entry: MemoryEntry): Promise<void> {
    await mkdir(this.persistDir, { recursive: true });
    const line = `${JSON.stringify(entry)}${JSONL_SEP}`;
    await appendFile(this.pathFor(sessionId), line, "utf8");
  }

  private async rewriteJsonl(sessionId: string): Promise<void> {
    const window = await this.inner.load(sessionId, this.inner.resolveAdapterContext(sessionId));
    const path = this.pathFor(sessionId);
    const tmp = `${path}.tmp`;
    await mkdir(this.persistDir, { recursive: true });
    const body = window.entries.length === 0
      ? ""
      : window.entries.map((entry) => JSON.stringify(entry)).join(JSONL_SEP) + JSONL_SEP;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  }

 /**
 * 串行化某 session 的关键操作 —— 通过 promise chain 保证同一 sessionId 上的
 * load / append / compress / trim 不交错。
 *
 * 失败不阻塞队列：下一个 task 无论前一个 resolve 还是 reject 都会启动。
 */
  private async serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.pending.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.pending.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(sessionId) === next) {
        this.pending.delete(sessionId);
      }
    }
  }
}
