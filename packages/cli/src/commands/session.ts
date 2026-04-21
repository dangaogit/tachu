import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { MemoryEntry } from "@tachu/core";
import { defineCommand } from "citty";
import { sanitizeSessionId } from "@tachu/extensions";
import { colorize, setNoColor } from "../renderer/color";
import {
  FsSessionStore,
  createEmptySession,
  type MessageCounter,
} from "../session-store/fs-session-store";
import { formatError } from "../errors";

/**
 * 根据 CWD 定位 `.tachu/sessions/` 并构建 `FsSessionStore`。
 *
 * 所有 `tachu session *` 子命令共享该存储——与 `tachu chat` / `tachu run` 的
 * 持久化路径一致，保证一个 session 可跨两种模式访问。
 */
const openStore = (): FsSessionStore => {
  const cwd = process.cwd();
  return new FsSessionStore(join(cwd, ".tachu", "sessions"));
};

/**
 * 不经过完整 engine 装配的消息数 counter —— 直接按文件行数估算 MemorySystem
 * 归档（`<persistDir>/<sid>.jsonl`）。用于 `session list` / `session resume`
 * 这类纯展示命令，避免为了显示消息数而启动 LLM / 工具栈。
 */
const buildFileCounter = (cwd: string, persistDir = ".tachu/memory"): MessageCounter => {
  const baseDir = isAbsolute(persistDir) ? persistDir : join(cwd, persistDir);
  return async (sessionId: string) => {
    const file = join(baseDir, `${sanitizeSessionId(sessionId)}.jsonl`);
    if (!existsSync(file)) return 0;
    try {
      const raw = await readFile(file, "utf8");
      return raw.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  };
};

/**
 * 读取 `<persistDir>/<sid>.jsonl` 的所有合法 `MemoryEntry`，用于 session export
 * 等需要完整消息体的命令。与 FsMemorySystem.readRaw 对齐解析规则。
 */
const readPersistedEntries = async (
  cwd: string,
  sessionId: string,
  persistDir = ".tachu/memory",
): Promise<MemoryEntry[]> => {
  const baseDir = isAbsolute(persistDir) ? persistDir : join(cwd, persistDir);
  const file = join(baseDir, `${sanitizeSessionId(sessionId)}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    const raw = await readFile(file, "utf8");
    const out: MemoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed.role === "user" ||
            parsed.role === "assistant" ||
            parsed.role === "system" ||
            parsed.role === "tool") &&
          typeof parsed.timestamp === "number"
        ) {
          out.push({
            role: parsed.role,
            content: parsed.content,
            timestamp: parsed.timestamp,
            anchored: Boolean(parsed.anchored),
          });
        }
      } catch {
        // ignore
      }
    }
    return out;
  } catch {
    return [];
  }
};
// readdir 只在未来需要扩展时引入 —— 当前保留导入静默避免 bun 删除。
void readdir;

/**
 * `tachu session list`：列出所有 session 元信息。
 *
 * 纯非交互命令；与 `tachu chat --history` 功能一致，提供更易写脚本的入口。
 */
const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "列出所有 session",
  },
  args: {
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
      const store = openStore();
      const metas = await store.list(buildFileCounter(process.cwd()));
      if (metas.length === 0) {
        console.log(colorize("暂无 session 记录。", "gray"));
        return;
      }
      for (const m of metas) {
        const date = new Date(m.lastActiveAt).toLocaleString();
        console.log(
          colorize(m.id, "cyan") +
            `  ${date}  ${m.messageCount} 条消息  ${m.tokenUsed} tokens`,
        );
      }
    } catch (err) {
      console.error(colorize(`错误：${formatError(err)}`, "red"));
      process.exit(1);
    }
  },
});

/**
 * `tachu session export <id> <path>`：导出指定 session 为 Markdown。
 */
const exportCommand = defineCommand({
  meta: {
    name: "export",
    description: "导出指定 session 到 Markdown",
  },
  args: {
    id: {
      type: "positional",
      description: "session ID",
      required: true,
    },
    path: {
      type: "positional",
      description: "输出 Markdown 文件路径",
      required: true,
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
      const store = openStore();
      const outputPath = resolve(args.path);
      const entries = await readPersistedEntries(process.cwd(), args.id);
      await store.export(args.id, outputPath, entries);
      console.log(colorize(`Session 已导出到：${outputPath}`, "green"));
    } catch (err) {
      console.error(colorize(`错误：${formatError(err)}`, "red"));
      process.exit(1);
    }
  },
});

/**
 * `tachu session resume <id>`：校验指定 session 存在并打印状态摘要。
 *
 * 仅做"可恢复性探活"：列出元信息、确认能被加载，不代替交互式 REPL。若要进入
 * 交互循环请继续使用 `tachu chat --session <id>` 或 `tachu chat --resume`。
 */
const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "探活指定 session 并打印元信息（仍需通过 chat 进入 REPL）",
  },
  args: {
    id: {
      type: "positional",
      description: "session ID",
      required: true,
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
      const store = openStore();
      const loaded = await store.load(args.id);
      if (!loaded) {
        console.error(colorize(`Session "${args.id}" 不存在。`, "red"));
        process.exit(1);
      }
      // `createEmptySession` 仅用于保证模块被打包 —— 不应影响 resume 逻辑：
      //
      // v1 的 resume 仅打印摘要；将 reference 明确标注以阻止 dead-code 打包剥离
      // 以及 linter 误报"未使用导入"。
      void createEmptySession;
      const date = new Date(loaded.lastActiveAt ?? Date.now()).toLocaleString();
      const messageCount = await buildFileCounter(process.cwd())(loaded.id);
      console.log(
        colorize(loaded.id, "cyan") +
          `  ${date}  ${messageCount} 条消息  ${loaded.budget.tokensUsed} tokens`,
      );
      console.log(
        colorize(
          `如需继续交互，请运行：tachu chat --session ${loaded.id}`,
          "gray",
        ),
      );
    } catch (err) {
      console.error(colorize(`错误：${formatError(err)}`, "red"));
      process.exit(1);
    }
  },
});

/**
 * `tachu session` 顶层命令。
 *
 * 与 `tachu chat --history/--export` 一期并存：
 * - 旧 flag 形式保留向后兼容；
 * - 新 `session list/export/resume` 子命令作为推荐的脚本化入口。
 */
export const sessionCommand = defineCommand({
  meta: {
    name: "session",
    description: "管理本地持久化的 chat session",
  },
  subCommands: {
    list: listCommand,
    export: exportCommand,
    resume: resumeCommand,
  },
});
