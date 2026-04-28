import * as readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import type { Engine, MemoryEntry } from "@tachu/core";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "@tachu/core";
import { setInteractivePrompter } from "./approval";
import { loadConfig } from "./config-loader/config-file";
import { colorize, shouldDisableColor } from "./renderer/color";
import { StreamRenderer } from "./renderer/stream-renderer";
import type { FsSessionStore, PersistedSession } from "./session-store/fs-session-store";
import { createEmptySession } from "./session-store/fs-session-store";
import { isTTY } from "./utils/tty";
import { buildTextToImageInputEnvelope } from "@tachu/core";
import { DEFAULT_IMAGE_CHAT_PROMPT, tryParseImageSlashCommand } from "./utils/image-slash-command";
import {
  DEFAULT_TEXT_TO_IMAGE_PROMPT,
  detectTextToImageIntent,
} from "./utils/text-to-image-slash-command";
import { loadMultimodalEnvelopeFromLocalImages } from "./utils/multimodal-local-images";
import { saveGeneratedImages } from "./utils/save-generated-images";
import { executeSlashCommand } from "./interactive-slash";
import { shouldUseInkForChat } from "./ui/ink-features";
import type {
  ActivationHooks,
  ActivationSummary,
} from "./mcp/setup";

/**
 * 交互式 chat 选项。
 */
export interface InteractiveChatOptions {
  /** 初始 session（undefined 时新建） */
  initialSession?: PersistedSession | undefined;
  /** 是否详细输出 */
  verbose?: boolean | undefined;
  /**
   * `--debug` 透传：打开后 StreamRenderer 会强制 verbose，并在每轮
   * MCP gated group 评估时把激活/注销情况打到 stderr。
   */
  debug?: boolean | undefined;
  /** 是否启用 plan 模式 */
  planMode?: boolean | undefined;
  /**
   * MCP gated 工具的每轮激活回调。`chat` 命令装配完 `setupMcpServersFromConfig`
   * 后会把 `activateForPrompt` 传入；每轮 `you>` 输入会在 runStream 前调用一次
   * 决定哪些 gated server 的工具可见。
   */
  mcpActivateForPrompt?:
    | ((input: unknown, hooks?: ActivationHooks) => Promise<ActivationSummary>)
    | undefined;
  /** 主 provider 名称（用于构建 context） */
  provider?: string | undefined;
  /** 覆盖模型名称 */
  model?: string | undefined;
  /**
   * 显式使用 readline 交互。默认在 TTY 且非禁色、非 plan-mode 时使用 Ink；
   * 可用 `TACHU_INK=0` 退回 readline。
   */
  readline?: boolean | undefined;
}

/**
 * 交互式 chat：默认 Ink（TTY），`readline: true` 或 `shouldUseInkForChat` 为假时走 readline。
 */
export async function runInteractiveChat(
  engine: Engine,
  store: FsSessionStore,
  options: InteractiveChatOptions = {},
): Promise<void> {
  const useInk = shouldUseInkForChat({
    readline: options.readline,
    noColor: shouldDisableColor(),
    planMode: Boolean(options.planMode),
  });
  if (useInk) {
    const { runInteractiveChatInk } = await import("./ui/ink-interactive-chat");
    return runInteractiveChatInk(engine, store, options);
  }
  return runInteractiveChatReadline(engine, store, options);
}

/**
 * 交互式 chat 循环（readline + 内置 slash 命令 + SIGINT 双次策略）。
 *
 * 内置命令：`/exit` `/reset` `/new` `/list` `/load <id>` `/save` `/export <path>`
 * `/history` `/stats` `/help`
 *
 * SIGINT 策略：
 * - 第一次：AbortController.abort() + engine.cancel()，回到提示符
 * - 1 秒内第二次：保存 session 并退出
 * - 第三次（1 秒外再次）：硬退出
 *
 * @param engine 已装配的引擎实例
 * @param store session 存储
 * @param options 交互选项
 */
export async function runInteractiveChatReadline(
  engine: Engine,
  store: FsSessionStore,
  options: InteractiveChatOptions = {},
): Promise<void> {
  const sessionHolder: { session: PersistedSession } = {
    session: options.initialSession ?? createEmptySession(randomUUID()),
  };
  let controller = new AbortController();
  let running = false;
  let sigintCount = 0;
  let lastSigintTime = 0;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY(),
  });

  // 把 rl.question 注册为进程级的审批 prompter，工具审批走这条路径，不会
  // 再在 process.stdin 上反复 createInterface/close —— 避免 Node 在
  // `Interface.close()` 里调用 `input.pause()` 把主循环的 readline 拖死。
  setInteractivePrompter((query) => rl.question(query));

  const debug = options.debug ?? false;
  const renderer = new StreamRenderer({
    verbose: debug || (options.verbose ?? false),
    debug,
  });

  const memorySystem = engine.getMemorySystem();

  const saveSession = async (): Promise<void> => {
    const s = sessionHolder.session;
    s.lastActiveAt = Date.now();
    await store.save(s);
  };

  const loadHistory = async (id: string): Promise<MemoryEntry[]> => {
    try {
      const window = await memorySystem.load(id, DEFAULT_ADAPTER_CALL_CONTEXT);
      return [...window.entries];
    } catch {
      return [];
    }
  };

  const messageCountFor = async (id: string): Promise<number> => {
    try {
      const size = await memorySystem.getSize(id);
      return size.entries;
    } catch {
      return 0;
    }
  };

  const handleSigint = async (): Promise<void> => {
    const now = Date.now();
    sigintCount++;

    if (running) {
      // 第一次：取消当前执行
      controller.abort();
      engine.cancel(sessionHolder.session.id);
      running = false;
      process.stdout.write("\n" + colorize("已取消当前请求。\n", "gray"));
      sigintCount = 1;
      lastSigintTime = now;
      return;
    }

    if (sigintCount >= 2 && now - lastSigintTime < 1000) {
      // 连续两次在 1 秒内：保存并退出（POSIX 约定 SIGINT 终止进程的退出码为 130）
      process.stdout.write("\n" + colorize("正在保存 session 并退出...\n", "gray"));
      try {
        await saveSession();
      } catch {
        // ignore
      }
      rl.close();
      process.exit(130);
    }

    if (sigintCount >= 3) {
      // 第三次：硬退出，同样遵循 POSIX 130 语义
      process.exit(130);
    }

    lastSigintTime = now;
    process.stdout.write("\n" + colorize("再按一次 Ctrl+C 保存并退出。\n", "gray"));
  };

  process.on("SIGINT", handleSigint);

  process.stdout.write(
    colorize(`Tachu Chat  session:${sessionHolder.session.id}\n`, "blue") +
      colorize(`输入 /help 查看内置命令，Ctrl+C 两次退出。\n\n`, "gray"),
  );

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question(colorize("you> ", "bold"));
      } catch {
        // readline closed
        break;
      }

      line = line.trim();
      if (!line) continue;

      // 重置 sigint 计数（用户主动输入）
      sigintCount = 0;

      const imageSlash = tryParseImageSlashCommand(line);
      if (imageSlash) {
        const chatCwd = process.cwd();
        try {
          const chatConfig = await loadConfig(chatCwd);
          const input = await loadMultimodalEnvelopeFromLocalImages({
            cwd: chatCwd,
            config: chatConfig,
            imagePaths: [imageSlash.rawPath],
            text: imageSlash.prompt,
            defaultText: DEFAULT_IMAGE_CHAT_PROMPT,
            source: "cli-chat",
          });

          controller = new AbortController();
          running = true;
          const startTime = Date.now();
          const context = {
            requestId: randomUUID(),
            sessionId: sessionHolder.session.id,
            traceId: randomUUID(),
            principal: {},
            budget: {},
            scopes: ["*"],
            startedAt: startTime,
          };

          let finalOutput: import("@tachu/core").EngineOutput | undefined;
          for await (const chunk of engine.runStream(input, context)) {
            renderer.render(chunk);
            if (chunk.type === "done") {
              finalOutput = chunk.output;
            }
          }
          running = false;
          if (finalOutput) {
            renderer.finalize(finalOutput, "text");
            const b = sessionHolder.session.budget;
            b.tokensUsed += finalOutput.metadata.tokenUsage.total;
            b.toolCallsUsed += finalOutput.metadata.toolCalls.length;
            b.wallTimeMs += finalOutput.metadata.durationMs;
          }
          process.stdout.write("\n");
        } catch (err) {
          running = false;
          process.stderr.write(colorize(`错误：${(err as Error).message}\n`, "red"));
        }
        await saveSession();
        continue;
      }

      const textToImageIntent = detectTextToImageIntent(line);
      if (textToImageIntent) {
        const prompt =
          textToImageIntent.prompt.trim().length > 0
            ? textToImageIntent.prompt.trim()
            : DEFAULT_TEXT_TO_IMAGE_PROMPT;
        const savePath = textToImageIntent.savePath?.trim();
        if (textToImageIntent.source !== "slash") {
          process.stderr.write(
            colorize(
              `[tachu] 识别为文生图请求（${textToImageIntent.source}），已路由到 capabilityMapping["text-to-image"]。` +
                `如判断有误，请用 /ask 前缀或改为普通描述。\n`,
              "gray",
            ),
          );
        }
        const input = buildTextToImageInputEnvelope(prompt, "cli-chat");

        controller = new AbortController();
        running = true;
        const startTime = Date.now();
        const context = {
          requestId: randomUUID(),
          sessionId: sessionHolder.session.id,
          traceId: randomUUID(),
          principal: {},
          budget: {},
          scopes: ["*"],
          startedAt: startTime,
        };

        try {
          let finalOutput: import("@tachu/core").EngineOutput | undefined;
          for await (const chunk of engine.runStream(input, context)) {
            renderer.render(chunk);
            if (chunk.type === "done") {
              finalOutput = chunk.output;
            }
          }
          running = false;
          if (finalOutput) {
            renderer.finalize(finalOutput, "text");
            const b = sessionHolder.session.budget;
            b.tokensUsed += finalOutput.metadata.tokenUsage.total;
            b.toolCallsUsed += finalOutput.metadata.toolCalls.length;
            b.wallTimeMs += finalOutput.metadata.durationMs;

            if (savePath && savePath.length > 0) {
              const images = finalOutput.metadata.generatedImages ?? [];
              if (images.length === 0) {
                process.stderr.write(
                  colorize(
                    `[tachu] 未生成任何图片，--save/保存路径 '${savePath}' 已忽略。\n`,
                    "yellow",
                  ),
                );
              } else {
                try {
                  const records = await saveGeneratedImages({
                    cwd: process.cwd(),
                    images,
                    target: savePath,
                    signal: controller.signal,
                  });
                  for (const rec of records) {
                    if (rec.error) {
                      process.stderr.write(
                        colorize(
                          `[tachu] 保存失败：${rec.source} → ${rec.path}（${rec.error}）\n`,
                          "red",
                        ),
                      );
                    } else {
                      process.stdout.write(
                        colorize(
                          `[tachu] 已保存：${rec.path}（${rec.bytes} bytes）\n`,
                          "green",
                        ),
                      );
                    }
                  }
                } catch (err) {
                  process.stderr.write(
                    colorize(
                      `[tachu] 保存图片失败：${(err as Error).message}\n`,
                      "red",
                    ),
                  );
                }
              }
            }
          }
          process.stdout.write("\n");
        } catch (err) {
          running = false;
          process.stderr.write(colorize(`错误：${(err as Error).message}\n`, "red"));
        }
        await saveSession();
        continue;
      }

      if (line.startsWith("/")) {
        const result = await executeSlashCommand(
          line,
          {
            sessionHolder,
            store,
            memorySystem,
            messageCountFor,
            loadHistory,
            saveSession,
          },
          { emit: (text) => process.stdout.write(text) },
        );
        if (result === "exit") {
          break;
        }
        continue;
      }

      // 普通对话 —— 历史由 engine 内部 session phase 自动 append 到 MemorySystem，
      // 这里只需要 kick off runStream。

      // 按当轮输入评估 MCP gated 工具（若有）。命中 keyword 的 server 工具
      // 会被动态注册进 Registry，否则从 Registry 移除以压缩本轮 prompt。
      // 失败仅在 --debug 下可见，不阻塞对话。
      if (options.mcpActivateForPrompt) {
        try {
          const activation = await options.mcpActivateForPrompt(
            line,
            debug
              ? {
                  onGroupEvaluated: (evt) => {
                    process.stderr.write(
                      colorize(
                        `[tachu][mcp] gated ${evt.serverId} matched=${evt.matched} ` +
                          `activated=${evt.activatedCount} deactivated=${evt.deactivatedCount} ` +
                          `keywords=${evt.keywords.join("|")}\n`,
                        "gray",
                      ),
                    );
                  },
                }
              : undefined,
          );
          if (debug && activation.groups.length > 0) {
            process.stderr.write(
              colorize(
                `[tachu][mcp] gated summary: ${activation.groups.length} group(s), ` +
                  `+${activation.activated.length} −${activation.deactivated.length}\n`,
                "gray",
              ),
            );
          }
        } catch (err) {
          if (debug) {
            process.stderr.write(
              colorize(
                `[tachu][mcp] activateForPrompt failed: ${(err as Error).message}\n`,
                "yellow",
              ),
            );
          }
        }
      }

      controller = new AbortController();
      running = true;
      const startTime = Date.now();

      try {
        const context = {
          requestId: randomUUID(),
          sessionId: sessionHolder.session.id,
          traceId: randomUUID(),
          principal: {},
          budget: {},
          scopes: ["*"],
          startedAt: startTime,
        };

        const input = {
          content: line,
          metadata: { modality: "text", source: "cli-chat" },
        };

        let finalOutput: import("@tachu/core").EngineOutput | undefined;

        for await (const chunk of engine.runStream(input, context)) {
          renderer.render(chunk);
          if (chunk.type === "done") {
            finalOutput = chunk.output;
          }
        }

        running = false;

        if (finalOutput) {
          // 把最终答复正文打印出来；Engine 目前不 yield delta 片段，
          // content 只能从 EngineOutput 里取出再统一渲染。
          renderer.finalize(finalOutput, "text");

          // 消息体由 engine 内部 phases 自动 append 到 MemorySystem，无需 CLI 介入。
          // session 只累加 budget / 耗时等 meta。
          const b = sessionHolder.session.budget;
          b.tokensUsed += finalOutput.metadata.tokenUsage.total;
          b.toolCallsUsed += finalOutput.metadata.toolCalls.length;
          b.wallTimeMs += finalOutput.metadata.durationMs;
        }
        process.stdout.write("\n");
      } catch (err) {
        running = false;
        if ((err as Error)?.name === "AbortError" || (err as { aborted?: boolean }).aborted) {
          // 已通过 SIGINT 处理
        } else {
          process.stderr.write(colorize(`错误：${(err as Error).message}\n`, "red"));
        }
      }

      // 每轮对话后自动保存
      await saveSession();
    }
  } finally {
    // 无论怎么退出（/exit、readline 关闭、异常 throw），都要把进程级 prompter
    // 注销掉，避免下一个 runInteractiveChat 或任何后续工具审批引用到失效的 rl。
    setInteractivePrompter(null);
    await renderer.dispose();
    rl.close();
    process.removeListener("SIGINT", handleSigint);
    try {
      await saveSession();
    } catch {
      // 退出时 ignore
    }
  }
}
