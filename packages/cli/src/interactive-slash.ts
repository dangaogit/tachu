import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemorySystem } from "@tachu/core";
import { colorize, type Color } from "./renderer/color";
import type { FsSessionStore, PersistedSession } from "./session-store/fs-session-store";
import { createEmptySession } from "./session-store/fs-session-store";

/**
 * 斜杠命令输出：与 readline / Ink 解耦，由宿主决定如何展示（stdout 或 React state）。
 */
export type SlashSink = {
  emit: (text: string) => void;
};

export interface SlashContext {
  sessionHolder: { session: PersistedSession };
  store: FsSessionStore;
  memorySystem: MemorySystem;
  messageCountFor: (id: string) => Promise<number>;
  loadHistory: (id: string) => Promise<MemoryEntry[]>;
  saveSession: () => Promise<void>;
}

function out(sink: SlashSink, text: string, color?: Color): void {
  sink.emit(color ? colorize(text, color) : text);
}

/**
 * 处理单行 `/command ...`，返回是否退出主循环。
 */
export async function executeSlashCommand(
  line: string,
  ctx: SlashContext,
  sink: SlashSink,
): Promise<"exit" | "continue"> {
  const parts = line.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const { sessionHolder, store, memorySystem, messageCountFor, loadHistory, saveSession } =
    ctx;

  switch (cmd) {
    case "exit":
      return "exit";

    case "reset":
    case "clear": {
      await memorySystem.clear(sessionHolder.session.id).catch(() => {
        /* 幂等 */
      });
      sessionHolder.session.budget = { tokensUsed: 0, toolCallsUsed: 0, wallTimeMs: 0 };
      await saveSession();
      out(sink, "Session 已重置。\n", "green");
      return "continue";
    }

    case "new": {
      await saveSession();
      sessionHolder.session = createEmptySession(randomUUID());
      out(sink, `已开启新 session：${sessionHolder.session.id}\n`, "green");
      return "continue";
    }

    case "list": {
      const metas = await store.list(messageCountFor);
      if (metas.length === 0) {
        out(sink, "暂无 session 记录。\n", "gray");
      } else {
        for (const m of metas) {
          const date = new Date(m.lastActiveAt).toLocaleString();
          out(
            sink,
            `${m.id}  ${date}  ${m.messageCount} 条消息  ${m.tokenUsed} tokens\n`,
            "cyan",
          );
        }
      }
      return "continue";
    }

    case "load": {
      const id = parts[1];
      if (!id) {
        out(sink, "用法：/load <session-id>\n", "yellow");
        return "continue";
      }
      const loaded = await store.load(id);
      if (!loaded) {
        out(sink, `Session "${id}" 不存在。\n`, "red");
      } else {
        await saveSession();
        sessionHolder.session = loaded;
        out(sink, `已切换到 session：${sessionHolder.session.id}\n`, "green");
      }
      return "continue";
    }

    case "save": {
      await saveSession();
      out(sink, "Session 已保存。\n", "green");
      return "continue";
    }

    case "export": {
      const path = parts[1];
      if (!path) {
        out(sink, "用法：/export <path>\n", "yellow");
        return "continue";
      }
      const history = await loadHistory(sessionHolder.session.id);
      await store.export(sessionHolder.session.id, path, history);
      out(sink, `Session 已导出到：${path}\n`, "green");
      return "continue";
    }

    case "history": {
      const history = await loadHistory(sessionHolder.session.id);
      if (history.length === 0) {
        out(sink, "当前 session 无历史记录。\n", "gray");
      } else {
        for (const msg of history) {
          const role = msg.role.toUpperCase();
          const content =
            typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          sink.emit(colorize(`[${role}] `, "bold") + content.slice(0, 200) + "\n");
        }
      }
      return "continue";
    }

    case "stats": {
      const size = await memorySystem.getSize(sessionHolder.session.id).catch(() => ({
        entries: 0,
        tokens: 0,
      }));
      out(
        sink,
        `Session: ${sessionHolder.session.id}\n` +
          `消息数: ${size.entries}\n` +
          `Token 用量: ${sessionHolder.session.budget.tokensUsed}\n` +
          `工具调用: ${sessionHolder.session.budget.toolCallsUsed}\n` +
          `耗时: ${sessionHolder.session.budget.wallTimeMs}ms\n`,
        "cyan",
      );
      return "continue";
    }

    case "help": {
      out(
        sink,
        "/exit           退出\n" +
          "/reset, /clear  清空当前 session 记忆\n" +
          "/new            开启新 session\n" +
          "/list           列出所有 session\n" +
          "/load <id>      切换到指定 session\n" +
          "/save           手动保存 session\n" +
          "/export <p>     导出为 Markdown\n" +
          "/history        查看本 session 历史\n" +
          "/stats          查看统计信息\n" +
          "/image <path>   附加本地图片（可跟文字说明）；MIME 仅根据文件头识别\n" +
          "/draw …         文生图（同 /text-to-image、/text2image；需 text-to-image 映射）\n" +
          "/help           显示此帮助\n",
        "gray",
      );
      return "continue";
    }

    default: {
      out(sink, `未知命令：/${cmd}。输入 /help 查看帮助。\n`, "yellow");
      return "continue";
    }
  }
}
