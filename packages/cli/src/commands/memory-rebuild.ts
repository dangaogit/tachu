/**
 * `tachu memory rebuild` 命令实现。
 *
 * ## 目的
 *
 * `FsMemorySystem` 在 alpha.7 之前未启用 ProjectionOutbox，导致老会话的 jsonl
 * 中存在 entry 但 vector store 没有对应索引。升级到 1.0.0-rc.1 后，host 注入
 * outbox + `ProjectionWorker` 接管后续投递，但**历史 entry 不会自动补齐**。
 *
 * 本命令做一次性扫盘：
 * 1. 遍历 `<persistDir>/*.jsonl` 中的全部 `MemoryEntry`
 * 2. 与 outbox `list(sid)` 比对，未跟踪的 entry → `outbox.enqueue()`
 * 3. 已 indexed 的 entry 直接 skip（幂等）
 *
 * 真正的 projection（embed + vector upsert）由现有 `ProjectionWorker.flush()`
 * 完成。本命令只负责"补齐 pending 队列"，**不**调用 worker —— 让 host 按既有
 * 节奏推进，避免 CLI 子命令引入 LLM 调用副作用。
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, basename, extname } from "node:path";
import { defineCommand } from "citty";
import { ProjectionOutbox, sanitizeSessionId } from "@tachu/extensions";
import { colorize, setNoColor } from "../renderer/color";
import { formatError } from "../errors";

export type RebuildEvent =
  | { type: "memory.rebuild.started"; sessionId: string; entryCount: number }
  | { type: "memory.rebuild.enqueued"; sessionId: string; ref: string }
  | {
      type: "memory.rebuild.completed";
      sessionId: string;
      enqueued: number;
      skipped: number;
    };

export interface RebuildOptions {
 /** Memory jsonl 持久化根目录（与 `config.memory.persistDir` 对齐）。 */
  persistDir: string;
 /** Projection outbox 根目录（默认 `<cwd>/.tachu/projections`）。 */
  projectionDir: string;
 /** 仅处理指定 session；省略时全量扫描。 */
  sessionId?: string | undefined;
 /** 事件回调；用于 CLI 渲染或测试断言。 */
  onEvent?: ((event: RebuildEvent) => void) | undefined;
}

export interface RebuildSummary {
  sessions: number;
  enqueued: number;
  skipped: number;
}

interface JsonlEntry {
  id: string;
}

async function readEntryIds(persistDir: string, sessionId: string): Promise<JsonlEntry[]> {
  const path = join(persistDir, `${sanitizeSessionId(sessionId)}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const out: JsonlEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown; timestamp?: unknown; role?: unknown };
      if (
        (parsed.role === "user" ||
          parsed.role === "assistant" ||
          parsed.role === "system" ||
          parsed.role === "tool") &&
        typeof parsed.timestamp === "number"
      ) {
        const id =
          typeof parsed.id === "string" && parsed.id.length > 0
            ? parsed.id
            : `${parsed.timestamp}-session`;
        out.push({ id });
      }
    } catch {
 // skip malformed line（与 FsMemorySystem 一致）
    }
  }
  return out;
}

async function listPersistedSessions(persistDir: string): Promise<string[]> {
  if (!existsSync(persistDir)) return [];
  const entries = await readdir(persistDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl")
    .map((entry) => basename(entry.name, ".jsonl"))
    .sort();
}

/**
 * 扫盘并把未跟踪 entry enqueue 进 outbox。
 *
 * 注：sessionId 在 jsonl 写入时已经过 {@link sanitizeSessionId} 规范化为文件名；
 * 这里读到的 jsonl basename 就是 sanitized id，再传给 outbox 作为 sessionId。
 * Outbox 与 FsMemorySystem 都以 sanitized id 为 key，无需二次映射。
 */
export async function rebuildMemoryProjections(
  options: RebuildOptions,
): Promise<RebuildSummary> {
  const outbox = new ProjectionOutbox({ dir: options.projectionDir });
  const sessions = options.sessionId
    ? [sanitizeSessionId(options.sessionId)]
    : await listPersistedSessions(options.persistDir);

  let totalEnqueued = 0;
  let totalSkipped = 0;
  let touchedSessions = 0;

  for (const sid of sessions) {
    const entries = await readEntryIds(options.persistDir, sid);
    if (entries.length === 0) continue;
    touchedSessions += 1;

    options.onEvent?.({
      type: "memory.rebuild.started",
      sessionId: sid,
      entryCount: entries.length,
    });

    const existing = await outbox.list(sid);
    const knownRefs = new Map(existing.map((rec) => [rec.ref, rec.state]));

    let enqueued = 0;
    let skipped = 0;
    for (const entry of entries) {
      const state = knownRefs.get(entry.id);
      if (state === "indexed") {
        skipped += 1;
        continue;
      }
      if (state === undefined) {
        await outbox.enqueue(sid, entry.id);
        enqueued += 1;
        options.onEvent?.({
          type: "memory.rebuild.enqueued",
          sessionId: sid,
          ref: entry.id,
        });
        continue;
      }
 // pending / retrying / failed / dead：已存在记录，由 worker 自然推进，
 // rebuild 不强制重置，避免擦掉重试计数。
      skipped += 1;
    }

    totalEnqueued += enqueued;
    totalSkipped += skipped;
    options.onEvent?.({
      type: "memory.rebuild.completed",
      sessionId: sid,
      enqueued,
      skipped,
    });
  }

  return {
    sessions: touchedSessions,
    enqueued: totalEnqueued,
    skipped: totalSkipped,
  };
}

const rebuildCommand = defineCommand({
  meta: {
    name: "rebuild",
    description:
      "扫描历史 memory jsonl，把未在 projection outbox 跟踪的 entry 入队，待 ProjectionWorker 后续投递（幂等，可重复执行）",
  },
  args: {
    session: {
      type: "string",
      description: "仅处理指定 session（默认全量扫描）",
      default: "",
    },
    "persist-dir": {
      type: "string",
      description: "Memory 持久化根目录（默认 .tachu/memory）",
      default: "",
    },
    "projection-dir": {
      type: "string",
      description: "Projection outbox 根目录（默认 .tachu/projections）",
      default: "",
    },
    "no-color": {
      type: "boolean",
      description: "禁用彩色输出",
      default: false,
    },
  },
  async run({ args }) {
    if (args["no-color"]) {
      setNoColor(true);
    }
    try {
      const cwd = process.cwd();
      const persistRaw = (args["persist-dir"] as string) || ".tachu/memory";
      const projectionRaw = (args["projection-dir"] as string) || ".tachu/projections";
      const persistDir = isAbsolute(persistRaw) ? persistRaw : join(cwd, persistRaw);
      const projectionDir = isAbsolute(projectionRaw)
        ? projectionRaw
        : join(cwd, projectionRaw);

      const summary = await rebuildMemoryProjections({
        persistDir,
        projectionDir,
        ...((args.session as string)
          ? { sessionId: args.session as string }
          : {}),
        onEvent: (event) => {
          if (event.type === "memory.rebuild.started") {
            console.log(
              colorize(
                `▶ ${event.sessionId}：扫描到 ${event.entryCount} 条 entry`,
                "cyan",
              ),
            );
          } else if (event.type === "memory.rebuild.completed") {
            console.log(
              colorize(
                `✓ ${event.sessionId}：入队 ${event.enqueued}，跳过 ${event.skipped}`,
                "green",
              ),
            );
          }
        },
      });
      console.log(
        colorize(
          `完成：${summary.sessions} session / 入队 ${summary.enqueued} / 跳过 ${summary.skipped}`,
          "green",
        ),
      );
    } catch (err) {
      console.error(colorize(`错误：${formatError(err)}`, "red"));
      process.exit(1);
    }
  },
});

/**
 * `tachu memory` 顶层命令。当前仅暴露 `rebuild` 子命令。
 */
export const memoryCommand = defineCommand({
  meta: {
    name: "memory",
    description: "管理 memory 持久化（projection outbox 维护）",
  },
  subCommands: {
    rebuild: rebuildCommand,
  },
});
