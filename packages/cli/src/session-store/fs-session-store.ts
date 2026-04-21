import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryEntry, MemorySystem } from "@tachu/core";

import { SessionStoreError } from "../errors";

/**
 * Session 元信息（不含完整消息体，用于列表展示）。
 *
 * `messageCount` 自 patch-02-session-persistence 起**不由 FsSessionStore 自动填充**
 * —— 会话历史的真相源已经迁移到 `MemorySystem`（默认 `FsMemorySystem`）。若需要
 * 显示消息数，调用方需要向 `list()` / `loadLatest()` 等方法额外传入一个
 * `MessageCounter` 回调（内部再去查 `memorySystem.getSize`）。未传时填 `0`。
 */
export interface SessionMeta {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  tokenUsed: number;
}

/**
 * 用于计数某个 session 当前持有多少条消息的回调。
 *
 * 典型实现：`async (id) => (await engine.getMemorySystem().getSize(id)).entries`
 */
export type MessageCounter = (sessionId: string) => Promise<number>;

/**
 * @deprecated 自 patch-02-session-persistence 起，会话消息由 `MemorySystem` 管理；
 * 本类型仅用于 `readLegacy()` / `migrateLegacyMessages()` 识别老版持久化文件内的
 * 残留字段，不再作为新 session 的一部分。
 */
export interface LegacySessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  timestamp: number;
}

/**
 * Session 预算计数（本地累计，用于 `/stats` 与跨进程展示）。
 */
export interface SessionBudget {
  tokensUsed: number;
  toolCallsUsed: number;
  wallTimeMs: number;
}

/**
 * 新版 session 持久化结构 —— 仅承载 meta + budget + checkpoint，**不含消息历史**。
 *
 * 消息历史由 `MemorySystem` 负责（默认 `FsMemorySystem`）。
 */
export interface PersistedSession {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  context: unknown;
  budget: SessionBudget;
  checkpoint: unknown;
  /**
   * 文件 schema 版本。当前为 `2`（patch-02-session-persistence）。
   *
   * 读取时若发现缺失或 < 2 的文件，会尝试执行 {@link migrateLegacyMessages} 把
   * 残留的 `messages` 字段迁移到 MemorySystem，然后写回 version=2。
   */
  version: 2;
}

/**
 * 完整的老版结构（schema < 2），带 `messages` 字段，用于迁移识别。
 *
 * @internal
 */
interface LegacyPersistedSession {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  messages?: LegacySessionMessage[];
  context?: unknown;
  budget?: Partial<SessionBudget>;
  checkpoint?: unknown;
  version?: number;
}

/**
 * 读取 session 文件时的"原始 + 迁移所需信息"快照。
 */
export interface LegacyReadResult {
  /** 已归一化为新版结构的 session（messages 字段已剥离） */
  session: PersistedSession;
  /** 老版残留消息；若 > 0 且 MemorySystem 侧不存在对应历史，调用方应迁移 */
  legacyMessages: LegacySessionMessage[];
}

/**
 * 基于文件系统的 Session 持久化存储（自 patch-02-session-persistence 起**仅管理
 * meta + budget**，消息历史交由 `MemorySystem`）。
 *
 * 存储路径：`.tachu/sessions/<sessionId>.json`
 *
 * @example
 * ```ts
 * const store = new FsSessionStore("/workspace/.tachu/sessions");
 * const result = await store.loadWithLegacy("some-id");
 * if (result && result.legacyMessages.length > 0) {
 *   await migrateLegacyMessages(engine.getMemorySystem(), result);
 *   await store.save(result.session);
 * }
 * ```
 */
export class FsSessionStore {
  private readonly sessionsDir: string;

  /**
   * @param sessionsDir sessions 目录绝对路径
   */
  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  /**
   * 确保 sessions 目录存在。
   */
  async ensureDir(): Promise<void> {
    if (!existsSync(this.sessionsDir)) {
      await mkdir(this.sessionsDir, { recursive: true });
    }
  }

  /**
   * 保存 session 到文件（原子写入：临时文件 + rename）。
   *
   * @param session 待保存的 session（新版 schema）
   * @throws SessionStoreError 写入失败时抛出
   */
  async save(session: PersistedSession): Promise<void> {
    await this.ensureDir();
    const filePath = this.filePath(session.id);
    const tmpPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmpPath, JSON.stringify(session, null, 2), "utf8");
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {
        /* 清理临时文件失败不影响主错误传播 */
      });
      throw new SessionStoreError(`保存 session 失败：${session.id}`, err);
    }
  }

  /**
   * 从文件加载 session，自动把老版文件归一化为新版（messages 字段剥离到
   * `LegacyReadResult.legacyMessages`，调用方按需迁移到 MemorySystem）。
   *
   * @param id session ID
   * @returns 包含新版 session 与残留消息的结果；不存在时返回 null
   * @throws SessionStoreError 读取失败时抛出
   */
  async loadWithLegacy(id: string): Promise<LegacyReadResult | null> {
    const filePath = this.filePath(id);
    if (!existsSync(filePath)) {
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      throw new SessionStoreError(`加载 session 失败：${id}`, err);
    }
    let parsed: LegacyPersistedSession;
    try {
      parsed = JSON.parse(raw) as LegacyPersistedSession;
    } catch (err) {
      throw new SessionStoreError(`解析 session JSON 失败：${id}`, err);
    }
    return normalizeLegacy(parsed);
  }

  /**
   * 仅加载 session 的新版 schema（自动丢弃老版 messages 字段）。
   *
   * 注意：如果老版文件中有未迁移的 messages，调用本方法**不会自动迁移**，
   * 信息会丢失。需要迁移时请调用 `loadWithLegacy` + `migrateLegacyMessages`。
   *
   * @param id session ID
   * @returns PersistedSession 或 null（不存在时）
   */
  async load(id: string): Promise<PersistedSession | null> {
    const result = await this.loadWithLegacy(id);
    return result?.session ?? null;
  }

  /**
   * 删除 session 文件（幂等）。
   *
   * @param id session ID
   * @throws SessionStoreError 删除失败时抛出
   */
  async delete(id: string): Promise<void> {
    const filePath = this.filePath(id);
    if (!existsSync(filePath)) {
      return;
    }
    try {
      await unlink(filePath);
    } catch (err) {
      throw new SessionStoreError(`删除 session 失败：${id}`, err);
    }
  }

  /**
   * 列出所有 session 元信息，按 lastActiveAt 倒序排列。
   *
   * @param counter 可选回调，用于填充 `messageCount`（典型调用
   * `engine.getMemorySystem().getSize(id).then((s) => s.entries)`）。未提供时
   * `messageCount` 填 `0`（避免强制依赖 MemorySystem，便于 CLI fallback）。
   * @returns SessionMeta 列表
   */
  async list(counter?: MessageCounter): Promise<SessionMeta[]> {
    if (!existsSync(this.sessionsDir)) {
      return [];
    }
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch (err) {
      throw new SessionStoreError("列举 session 失败", err);
    }

    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const id = entry.slice(0, -5);
      try {
        const loaded = await this.loadWithLegacy(id);
        if (!loaded) continue;
        const count = counter
          ? await counter(loaded.session.id).catch(() => loaded.legacyMessages.length)
          : loaded.legacyMessages.length;
        metas.push({
          id: loaded.session.id,
          createdAt: loaded.session.createdAt,
          lastActiveAt: loaded.session.lastActiveAt,
          messageCount: count,
          tokenUsed: loaded.session.budget.tokensUsed,
        });
      } catch {
        // 损坏文件跳过
      }
    }
    return metas.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * 加载最近一次 session（按 lastActiveAt 倒序取第一个，带 legacy 信息）。
   */
  async loadLatestWithLegacy(): Promise<LegacyReadResult | null> {
    const metas = await this.list();
    if (metas.length === 0) {
      return null;
    }
    return this.loadWithLegacy(metas[0]!.id);
  }

  /**
   * 加载最近一次 session（仅返回新版 schema，legacy messages 被丢弃）。
   */
  async loadLatest(): Promise<PersistedSession | null> {
    const result = await this.loadLatestWithLegacy();
    return result?.session ?? null;
  }

  /**
   * 将 session 导出为 Markdown 文件。
   *
   * 因为 FsSessionStore 已不承载消息体，必须由调用方显式传入 entries（通常来自
   * `engine.getMemorySystem().load(id)`）。未传或空数组则导出仅含 meta 的简表。
   *
   * @param id session ID
   * @param outputPath 导出文件绝对路径
   * @param messages 要渲染为 Markdown 的消息条目列表（可来自 MemorySystem）
   * @throws SessionStoreError session 不存在或写入失败时抛出
   */
  async export(
    id: string,
    outputPath: string,
    messages: readonly MemoryEntry[] = [],
  ): Promise<void> {
    const session = await this.load(id);
    if (!session) {
      throw new SessionStoreError(`导出失败：session ${id} 不存在`);
    }
    const lines: string[] = [
      `# Session ${id}`,
      ``,
      `- Created: ${new Date(session.createdAt).toISOString()}`,
      `- Last Active: ${new Date(session.lastActiveAt).toISOString()}`,
      `- Token Used: ${session.budget.tokensUsed}`,
      ``,
      `## Messages`,
      ``,
    ];
    if (messages.length === 0) {
      lines.push(`_（本 session 无消息历史，或未向 export 传入 MemorySystem 消息快照。）_`);
      lines.push(``);
    } else {
      for (const msg of messages) {
        const role = msg.role.toUpperCase();
        const content =
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push(`### ${role}`, ``, content, ``);
      }
    }
    try {
      await writeFile(outputPath, lines.join("\n"), "utf8");
    } catch (err) {
      throw new SessionStoreError(`导出 session 失败：${outputPath}`, err);
    }
  }

  private filePath(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }
}

/**
 * 归一化老版 session 文件：剥离 messages 字段、补默认值。
 *
 * @internal
 */
function normalizeLegacy(raw: LegacyPersistedSession): LegacyReadResult {
  const legacyMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const budget: SessionBudget = {
    tokensUsed: raw.budget?.tokensUsed ?? 0,
    toolCallsUsed: raw.budget?.toolCallsUsed ?? 0,
    wallTimeMs: raw.budget?.wallTimeMs ?? 0,
  };
  const session: PersistedSession = {
    id: raw.id,
    createdAt: raw.createdAt,
    lastActiveAt: raw.lastActiveAt,
    context: raw.context ?? null,
    budget,
    checkpoint: raw.checkpoint ?? null,
    version: 2,
  };
  return { session, legacyMessages };
}

/**
 * 创建空 session 对象（新版 schema，v2）。
 *
 * @param id session ID
 * @returns PersistedSession
 */
export function createEmptySession(id: string): PersistedSession {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    lastActiveAt: now,
    context: null,
    budget: { tokensUsed: 0, toolCallsUsed: 0, wallTimeMs: 0 },
    checkpoint: null,
    version: 2,
  };
}

/**
 * 把老版 session 文件里的 `messages` 字段迁移到 MemorySystem。
 *
 * 幂等条件：调用方应先检查 `memorySystem.getSize(id).entries === 0`，避免重复
 * 写入。迁移完成后建议立即 `store.save(result.session)` 把剥离版本写回盘。
 *
 * @param memorySystem 目标 MemorySystem（通常由 `engine.getMemorySystem()` 提供）
 * @param result 来自 `FsSessionStore.loadWithLegacy()` 的结果
 * @returns 实际迁移的条目数
 */
export async function migrateLegacyMessages(
  memorySystem: MemorySystem,
  result: LegacyReadResult,
): Promise<number> {
  if (result.legacyMessages.length === 0) {
    return 0;
  }
  const { id } = result.session;
  const size = await memorySystem.getSize(id).catch(() => ({ entries: 0, tokens: 0 }));
  if (size.entries > 0) {
    return 0;
  }
  let migrated = 0;
  for (const msg of result.legacyMessages) {
    const entry: MemoryEntry = {
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      anchored: false,
    };
    await memorySystem.append(id, entry);
    migrated += 1;
  }
  return migrated;
}

/**
 * 便捷方法：加载 + 自动迁移 legacy messages + 写回 v2 session。
 *
 * 典型在 CLI `chat --resume` / `run --session <id>` 启动时调用一次，确保老
 * 用户升级到新版本无感知恢复历史。
 *
 * @param store FsSessionStore 实例
 * @param memorySystem engine 的 MemorySystem
 * @param id session ID
 * @returns 归一化后的新版 session（若不存在则 null）；第二个元素为迁移条目数
 */
export async function loadAndMigrate(
  store: FsSessionStore,
  memorySystem: MemorySystem,
  id: string,
): Promise<{ session: PersistedSession | null; migrated: number }> {
  const result = await store.loadWithLegacy(id);
  if (!result) {
    return { session: null, migrated: 0 };
  }
  const migrated = await migrateLegacyMessages(memorySystem, result);
  if (migrated > 0 || result.legacyMessages.length > 0) {
    await store.save(result.session);
  }
  return { session: result.session, migrated };
}

/**
 * 便捷方法：加载最近 session + 自动迁移 legacy messages。
 *
 * 行为与 `loadAndMigrate` 对齐，但针对 `--resume` 场景（取最近活跃 session）。
 */
export async function loadLatestAndMigrate(
  store: FsSessionStore,
  memorySystem: MemorySystem,
): Promise<{ session: PersistedSession | null; migrated: number }> {
  const result = await store.loadLatestWithLegacy();
  if (!result) {
    return { session: null, migrated: 0 };
  }
  const migrated = await migrateLegacyMessages(memorySystem, result);
  if (migrated > 0 || result.legacyMessages.length > 0) {
    await store.save(result.session);
  }
  return { session: result.session, migrated };
}
