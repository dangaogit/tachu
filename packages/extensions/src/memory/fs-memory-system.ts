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
  type ContextWindow,
  type MemoryEntry,
  type MemorySystem,
} from "@tachu/core";

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
}

const JSONL_SEP = "\n";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseMemoryEntry(raw: unknown): MemoryEntry | null {
  if (!isObject(raw)) return null;
  const { role, content, timestamp, anchored } = raw as Record<string, unknown>;
  if (
    (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }
  return {
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
 *   `<persistDir>/<sid>.jsonl`（crash-safe），再同步进内部
 *   `InMemoryMemorySystem` 的运行时 window
 * - 首次 `load(sid)` 命中时从磁盘 hydrate 上次进程遗留的历史，注入内部
 *   `InMemoryMemorySystem`（走 public `hydrate()`，旁路 per-entry compress 触发）
 * - `compress()` 完成后 atomic rewrite 持久化文件，保证"盘 = 内存"一致
 * - `recall` / `archive` / `getSize` / `trim` 全部代理内部 `InMemoryMemorySystem`
 *   （只要 load 阶段已 hydrate，这些读路径天然拿到跨进程数据）
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
 *   仅在 `compress()` 时一次性追加到单个大 jsonl，供长期记忆向量召回
 *
 * 两者**不重叠**，保留现有 archivePath 语义不动。
 */
export class FsMemorySystem implements MemorySystem {
  private readonly persistDir: string;
  private readonly inner: InMemoryMemorySystem;
  private readonly compressionThreshold: number;
  private readonly hydrated = new Set<string>();
  private readonly pending = new Map<string, Promise<unknown>>();

  /**
   * 构造文件持久化 MemorySystem。
   *
   * @param options 参见 {@link FsMemorySystemOptions}
   */
  constructor(options: FsMemorySystemOptions) {
    this.persistDir = options.persistDir;
    this.inner = options.inner;
    this.compressionThreshold = options.compressionThreshold;
  }

  /**
   * @inheritdoc
   */
  async load(sessionId: string): Promise<ContextWindow> {
    return this.serialize(sessionId, async () => {
      await this.hydrateIfNeeded(sessionId);
      return this.inner.load(sessionId);
    });
  }

  /**
   * @inheritdoc
   *
   * 流程：
   * 1. 确保 session 已 hydrate（使 window 与磁盘一致）
   * 2. append-only 将 entry 序列化为单行 JSON 落盘（崩溃安全；即便本次进程 crash，
   *    磁盘文件仍是合法 jsonl 的前缀）
   * 3. 将 entry 通过 `inner.hydrate()` 注入内存 window（旁路 per-entry compress）
   * 4. 手动检查 tokenCount 是否越过阈值；若越线：
   *    - `inner.compress(sid)` 触发 LLM 摘要
   *    - atomic rewrite jsonl，保持盘与内存一致
   */
  async append(sessionId: string, entry: MemoryEntry): Promise<void> {
    await this.serialize(sessionId, async () => {
      await this.hydrateIfNeeded(sessionId);
      await this.writeJsonlLine(sessionId, entry);
      await this.inner.hydrate(sessionId, [entry]);
      const window = await this.inner.load(sessionId);
      if (window.tokenCount > window.limit * this.compressionThreshold) {
        await this.inner.compress(sessionId);
        await this.rewriteJsonl(sessionId);
      }
    });
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
  async archive(sessionId: string): Promise<void> {
    await this.hydrateIfNeeded(sessionId);
    await this.inner.archive(sessionId);
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
      await this.inner.clear(sessionId);
      const path = this.pathFor(sessionId);
      try {
        await rm(path, { force: true });
      } catch {
        // ignore
      }
    });
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
    const window = await this.inner.load(sessionId);
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
