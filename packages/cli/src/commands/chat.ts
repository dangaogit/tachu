import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "@tachu/core";
import { defineCommand } from "citty";
import { sanitizeSessionId } from "@tachu/extensions";
import { colorize, setNoColor } from "../renderer/color";
import { loadConfig } from "../config-loader/config-file";
import { scanDescriptors } from "../config-loader/descriptor-scanner";
import { createEngine } from "../engine-factory";
import { setupMcpServersFromConfig } from "../mcp";
import {
  FsSessionStore,
  loadAndMigrate,
  loadLatestAndMigrate,
  type MessageCounter,
} from "../session-store/fs-session-store";
import { runInteractiveChat } from "../interactive";
import { formatError } from "../errors";
import { applyProviderConnectionOverrides } from "../utils/provider-overrides";
import {
  attachCliDebugPrinter,
  buildCliObservability,
} from "../utils/cli-observability";

/**
 * `tachu chat` 命令实现。
 *
 * 交互式对话循环。支持 session 持久化、内置斜杠命令、SIGINT 双次策略。
 * `--history` / `--export` 为非交互模式。
 */
export const chatCommand = defineCommand({
  meta: {
    name: "chat",
    description:
      "进入交互式对话（TTY 默认 Ink 全屏流式界面；显式 --readline 使用传统行编辑）。支持 /help、session 与 SIGINT 策略",
  },
  args: {
    session: {
      type: "string",
      description: "指定 session ID",
      default: "",
    },
    resume: {
      type: "boolean",
      description: "恢复最近一次 session",
      default: false,
    },
    history: {
      type: "boolean",
      description: "列出已有 session（非交互模式）",
      default: false,
    },
    export: {
      type: "string",
      description: "导出指定 session 到 Markdown 文件（非交互模式，需配合 --session）",
      default: "",
    },
    model: {
      type: "string",
      description: "覆盖默认模型",
      default: "",
    },
    provider: {
      type: "string",
      description: "覆盖默认 Provider（openai | anthropic | mock）",
      default: "",
    },
    "api-base": {
      type: "string",
      description: "覆盖当前 provider 的 baseURL（如自建网关、Azure OpenAI、LiteLLM）",
      default: "",
    },
    "api-key": {
      type: "string",
      description: "覆盖当前 provider 的 apiKey（生产环境建议改用环境变量）",
      default: "",
    },
    organization: {
      type: "string",
      description: "覆盖 OpenAI organization ID",
      default: "",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "详细日志（phase 尾部附 duration_ms）",
      default: false,
    },
    debug: {
      type: "boolean",
      description:
        "调试模式：自动开启 verbose，并把引擎 observability 事件按颜色分类打到 stderr",
      default: false,
    },
    "no-color": {
      type: "boolean",
      description: "禁用彩色输出",
      default: false,
    },
    "plan-mode": {
      type: "boolean",
      description: "启用 Plan 模式",
      default: false,
    },
    readline: {
      type: "boolean",
      description:
        "使用 readline 行编辑替代默认 Ink 界面（脚本/非彩色终端可自动退回 readline；也可用 TACHU_INK=0 关闭 Ink）",
      default: false,
    },
  },
  async run({ args }) {
    if (args["no-color"]) {
      setNoColor(true);
    }

    const cwd = process.cwd();
    const tachyDir = join(cwd, ".tachu");
    const sessionsDir = join(tachyDir, "sessions");
    const store = new FsSessionStore(sessionsDir);

    // 非交互：--history
    if (args.history) {
      const counter = buildNonInteractiveCounter(cwd);
      const metas = await store.list(counter);
      if (metas.length === 0) {
        console.log(colorize("暂无 session 记录。", "gray"));
      } else {
        for (const m of metas) {
          const date = new Date(m.lastActiveAt).toLocaleString();
          console.log(
            colorize(m.id, "cyan") +
              `  ${date}  ${m.messageCount} 条消息  ${m.tokenUsed} tokens`,
          );
        }
      }
      return;
    }

    // 非交互：--export
    if (args.export) {
      const sessionId = args.session as string;
      if (!sessionId) {
        console.error(colorize("错误：--export 需要配合 --session <id> 使用", "red"));
        process.exit(1);
      }
      const outputPath = resolve(args.export as string);
      try {
        const entries = await readPersistedEntriesForChat(cwd, sessionId);
        await store.export(sessionId, outputPath, entries);
        console.log(colorize(`Session 已导出到：${outputPath}`, "green"));
      } catch (err) {
        console.error(colorize(`导出失败：${formatError(err)}`, "red"));
        process.exit(1);
      }
      return;
    }

    // 交互模式
    let config = await loadConfig(cwd);

    // 覆盖 provider
    if (args.provider) {
      const prov = args.provider as string;
      const modelArg = args.model as string | undefined;
      const modelName = modelArg && modelArg.length > 0 ? modelArg : "mock-chat";
      config = {
        ...config,
        models: {
          ...config.models,
          capabilityMapping: Object.fromEntries(
            Object.entries(config.models.capabilityMapping).map(([k]) => [
              k,
              { provider: prov, model: modelName },
            ]),
          ),
          providerFallbackOrder: [prov],
        },
      };
    } else if (args.model) {
      const existingRoute = config.models.capabilityMapping["high-reasoning"];
      const baseProvider = existingRoute?.provider ?? "mock";
      config = {
        ...config,
        models: {
          ...config.models,
          capabilityMapping: {
            ...config.models.capabilityMapping,
            "high-reasoning": {
              provider: baseProvider,
              model: args.model as string,
            },
          },
        },
      };
    }

    config = applyProviderConnectionOverrides(config, args);

    if (args["plan-mode"]) {
      config = { ...config, runtime: { ...config.runtime, planMode: true } };
    }

    const registry = await scanDescriptors(tachyDir);

    const debug = Boolean(args.debug);
    // 同 run.ts：MCP 装配与 engine 共用同一个 emitter，--debug 把事件透到 stderr。
    const observability = buildCliObservability(config, cwd);
    const detachDebug = debug ? attachCliDebugPrinter(observability) : null;

    // 装配 MCP servers（参数 cwd 用于解析 stdio.cwd 的相对路径）。`expandOnKeywordMatch`
    // 的 server 不会在此阶段进入 Registry，留给 interactive 循环每轮调用
    // `mcpMounted.activateForPrompt(line)` 再按输入决定是否展开。
    const mcpMounted = await setupMcpServersFromConfig(config, registry, {
      cwd,
      observability,
    });

    // 交互式 chat 默认开启 execution 期 delta 流式（与 tachu run + Ink 一致）；
    // 仍可用 TACHU_STREAM_DELTA=0 关闭（若将来引擎支持该覆盖）。
    const streamDeltaOff = process.env.TACHU_STREAM_DELTA?.trim().toLowerCase();
    const disableStreamDelta =
      streamDeltaOff === "0" || streamDeltaOff === "false" || streamDeltaOff === "off";
    if (!disableStreamDelta) {
      config = {
        ...config,
        runtime: { ...config.runtime, streamingOutput: true },
      };
    }

    const engine = createEngine(config, {
      cwd,
      registry,
      observability,
      extraToolExecutors: mcpMounted.executors,
    });
    const memorySystem = engine.getMemorySystem();

    // 确定初始 session（兼容老版 session 文件：自动把残留 messages 迁移到 MemorySystem）
    let initialSession = undefined;
    if (args.resume) {
      const result = await loadLatestAndMigrate(store, memorySystem);
      if (result.migrated > 0) {
        console.log(
          colorize(
            `[tachu] 已把 ${result.migrated} 条旧 session 历史迁移到 MemorySystem`,
            "gray",
          ),
        );
      }
      if (result.session) {
        initialSession = result.session;
      }
    } else if (args.session) {
      const result = await loadAndMigrate(store, memorySystem, args.session as string);
      if (result.migrated > 0) {
        console.log(
          colorize(
            `[tachu] 已把 ${result.migrated} 条旧 session 历史迁移到 MemorySystem`,
            "gray",
          ),
        );
      }
      if (result.session) {
        initialSession = result.session;
      } else {
        // 指定 ID 不存在，使用指定 ID 新建
        const { createEmptySession } = await import("../session-store/fs-session-store");
        initialSession = createEmptySession(args.session as string);
      }
    }

    try {
      await runInteractiveChat(engine, store, {
        ...(initialSession !== undefined ? { initialSession } : {}),
        verbose: Boolean(args.verbose) || debug,
        debug,
        planMode: Boolean(args["plan-mode"]),
        readline: Boolean(args.readline),
        mcpActivateForPrompt: mcpMounted.activateForPrompt,
        ...(args.provider ? { provider: args.provider as string } : {}),
        ...(args.model ? { model: args.model as string } : {}),
      });
    } catch (err) {
      console.error(colorize(`错误：${formatError(err)}`, "red"));
      process.exit(1);
    } finally {
      await engine.dispose();
      // 与 run.ts 对称：engine.dispose 后再断 MCP transport，避免 tool-use
      // 回收过程中因 transport 提前关闭导致的次级错误。
      await mcpMounted.disconnectAll();
      detachDebug?.();
    }
  },
});

const DEFAULT_MEMORY_DIR = ".tachu/memory";

function resolveMemoryFile(cwd: string, sessionId: string): string {
  const base = isAbsolute(DEFAULT_MEMORY_DIR)
    ? DEFAULT_MEMORY_DIR
    : join(cwd, DEFAULT_MEMORY_DIR);
  return join(base, `${sanitizeSessionId(sessionId)}.jsonl`);
}

/**
 * 非交互模式（`--history` / `--export`）下的 messageCount 计数器 —— 直接读
 * `<persistDir>/<sid>.jsonl` 的行数，避免为展示信息而装配完整 engine。
 */
function buildNonInteractiveCounter(cwd: string): MessageCounter {
  return async (sessionId: string) => {
    const file = resolveMemoryFile(cwd, sessionId);
    if (!existsSync(file)) return 0;
    try {
      const raw = await readFile(file, "utf8");
      return raw.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  };
}

/**
 * 非交互模式下的 `--export`：从 `<persistDir>/<sid>.jsonl` 还原 MemoryEntry 列表
 * 传给 `FsSessionStore.export()` 渲染 Markdown。
 */
async function readPersistedEntriesForChat(
  cwd: string,
  sessionId: string,
): Promise<MemoryEntry[]> {
  const file = resolveMemoryFile(cwd, sessionId);
  if (!existsSync(file)) return [];
  try {
    const raw = await readFile(file, "utf8");
    const entries: MemoryEntry[] = [];
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
          entries.push({
            role: parsed.role,
            content: parsed.content,
            timestamp: parsed.timestamp,
            anchored: Boolean(parsed.anchored),
          });
        }
      } catch {
        // 单行损坏跳过
      }
    }
    return entries;
  } catch {
    return [];
  }
}
