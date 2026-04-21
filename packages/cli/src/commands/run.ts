import * as readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { join } from "node:path";
import { defineCommand } from "citty";
import { colorize, setNoColor } from "../renderer/color";
import type { ChunkRenderer } from "../renderer/stream-renderer";
import { StreamRenderer } from "../renderer/stream-renderer";
import { createInkRunRenderer } from "../ui/ink-stream-renderer";
import { shouldUseInkCli } from "../ui/ink-features";
import { loadConfig } from "../config-loader/config-file";
import { scanDescriptors } from "../config-loader/descriptor-scanner";
import { createEngine } from "../engine-factory";
import { setupMcpServersFromConfig } from "../mcp";
import { FsSessionStore, createEmptySession } from "../session-store/fs-session-store";
import { isStdinTTY } from "../utils/tty";
import { formatError } from "../errors";
import { applyProviderConnectionOverrides } from "../utils/provider-overrides";
import {
  attachCliDebugPrinter,
  buildCliObservability,
} from "../utils/cli-observability";
import type { EngineOutput, InputEnvelope } from "@tachu/core";
import { buildTextToImageInputEnvelope } from "@tachu/core";
import {
  collectRepeatedArgvFlag,
  loadMultimodalEnvelopeFromLocalImages,
} from "../utils/multimodal-local-images";
import { DEFAULT_TEXT_TO_IMAGE_PROMPT } from "../utils/text-to-image-slash-command";
import { saveGeneratedImages } from "../utils/save-generated-images";

/**
 * `tachu run <prompt>` 命令实现。
 *
 * 单次执行 prompt，支持完整的流式渲染、session 持久化、plan 模式和 SIGINT 取消。
 */
export const runCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "单次执行 prompt（流式输出，支持 session 持久化）。可多次传入 --image <path> 附加本地图片（多模态）；图片 MIME 仅根据文件头魔数识别。--text-to-image 走文生图（需配置 capabilityMapping[\"text-to-image\"]）。TTY 下默认 Ink；可用 --no-ink 或 TACHU_INK=0 关闭",
  },
  args: {
    prompt: {
      type: "positional",
      description: "要执行的 prompt",
      required: false,
    },
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
    model: {
      type: "string",
      description: "覆盖默认模型（覆盖 capabilityMapping.high-reasoning）",
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
    input: {
      type: "string",
      description: "从文件读取 prompt",
      default: "",
    },
    json: {
      type: "boolean",
      description: "将 prompt 解析为 JSON",
      default: false,
    },
    "text-to-image": {
      type: "boolean",
      description:
        "文生图模式（需在 tachu.config 的 models.capabilityMapping 中配置 text-to-image，通常为 qwen + 万相 wanx-*）",
      default: false,
    },
    "save-image": {
      type: "string",
      description:
        "把文生图结果下载到本地（文件路径或目录）。目录时写成 generated-<n>.png；文件存在多图时自动追加 -<n> 后缀",
      default: "",
    },
    output: {
      type: "string",
      description: "输出格式（text | json | markdown，默认 text）",
      default: "text",
    },
    "no-validation": {
      type: "boolean",
      description: "跳过结果验证",
      default: false,
    },
    "plan-mode": {
      type: "boolean",
      description: "启用 Plan 模式（阶段 5 后暂停等待批准）",
      default: false,
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "详细日志（显示每个 phase 的 progress，phase 尾部附 duration_ms）",
      default: false,
    },
    debug: {
      type: "boolean",
      description:
        "调试模式：自动开启 verbose，并把引擎 observability 事件（phase / llm / tool / MCP）按颜色分类打到 stderr",
      default: false,
    },
    "no-color": {
      type: "boolean",
      description: "禁用彩色输出",
      default: false,
    },
    markdown: {
      type: "boolean",
      description:
        "在 --output text 下对正文启用 Markdown ANSI 渲染（TTY 下默认开启；显式 --no-markdown 关闭）",
    },
    ink: {
      type: "boolean",
      description:
        "使用 Ink 全屏渲染（TTY 下默认开启；--plan-mode 时自动回退标准终端；可用 TACHU_INK=0 关闭）",
      default: true,
    },
    timeout: {
      type: "string",
      description: "wall-time 上限（ms），覆盖 budget.maxWallTimeMs",
      default: "",
    },
  },
  async run({ args }) {
    if (args["no-color"]) {
      setNoColor(true);
    }

    const cwd = process.cwd();
    const debug = Boolean(args.debug);
    // `--debug` 是 `--verbose` 的超集：开启 debug 即自动打开 phase 级 progress 输出。
    const verbose = debug || Boolean(args.verbose);

    // 加载配置与描述符
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

    // --api-base / --api-key / --organization 覆盖当前 provider 连接配置
    config = applyProviderConnectionOverrides(config, args);

    // timeout 覆盖
    if (args.timeout) {
      const ms = parseInt(args.timeout as string, 10);
      if (!isNaN(ms)) {
        config = { ...config, budget: { ...config.budget, maxWallTimeMs: ms } };
      }
    }

    // plan mode
    if (args["plan-mode"]) {
      config = { ...config, runtime: { ...config.runtime, planMode: true } };
    }

    const tachyDir = join(cwd, ".tachu");
    const sessionsDir = join(tachyDir, "sessions");
    const store = new FsSessionStore(sessionsDir);

    // 确定 session
    let sessionId: string;
    if (args.resume) {
      const latest = await store.loadLatest();
      sessionId = latest?.id ?? randomUUID();
    } else if (args.session) {
      sessionId = args.session as string;
    } else {
      sessionId = randomUUID();
    }

    // 确定 prompt 内容
    let promptContent: unknown;
    const positionalPrompt = args.prompt as string | undefined;

    if (positionalPrompt) {
      promptContent = args.json ? JSON.parse(positionalPrompt) : positionalPrompt;
    } else if (args.input) {
      const raw = await readFile(resolve(args.input as string), "utf8");
      promptContent = args.json ? JSON.parse(raw) : raw;
    } else if (!isStdinTTY()) {
      // stdin pipe
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      promptContent = args.json ? JSON.parse(raw) : raw;
    } else {
      const fromArgv = collectRepeatedArgvFlag(process.argv, "--image");
      const textToImageOnly = Boolean(args["text-to-image"]);
      if (fromArgv.length === 0 && !textToImageOnly) {
        console.error(colorize("错误：需要提供 prompt（位置参数、--input 或 stdin 管道）", "red"));
        process.exit(1);
      }
      promptContent =
        fromArgv.length > 0
          ? "请描述这张图片的主要内容。"
          : DEFAULT_TEXT_TO_IMAGE_PROMPT;
    }

    const imagePaths = collectRepeatedArgvFlag(process.argv, "--image");
    if (args.json && imagePaths.length > 0) {
      console.error(colorize("错误：--json 与 --image 不能同时使用", "red"));
      process.exit(1);
    }
    if (args.json && args["text-to-image"]) {
      console.error(colorize("错误：--json 与 --text-to-image 不能同时使用", "red"));
      process.exit(1);
    }
    if (args["text-to-image"] && imagePaths.length > 0) {
      console.error(colorize("错误：--text-to-image 与 --image 不能同时使用", "red"));
      process.exit(1);
    }

    // 扫描描述符
    const registry = await scanDescriptors(tachyDir);

    // 统一 Observability：MCP 装配、engine 主干、--debug printer 共用同一个
    // emitter 实例。这样 events.jsonl 能保留一条完整的轨迹，且 --debug 能把
    // MCP 连接失败等"engine 外"事件也订阅到。
    const observability = buildCliObservability(config, cwd);
    const detachDebug = debug ? attachCliDebugPrinter(observability) : null;

    // 装配 MCP servers（若 tachu.config.ts 声明了 mcpServers）。生产语义：
    //  - 单个 server 失败不阻塞主流程
    //  - 远端工具以 `<serverId>__<tool>` 形态进入 Registry 并对 LLM 可见
    //  - `expandOnKeywordMatch` 的 server 不会在此阶段注册，留给下面的
    //    `activateForPrompt(prompt)` 按本轮输入决定是否展开
    //  - finally 分支里必须调用 disconnectAll() 断开全部 adapter
    const mcpMounted = await setupMcpServersFromConfig(config, registry, {
      cwd,
      observability,
    });

    // 按当轮输入评估 gated groups：命中任一 keyword 的 server 会把其工具
    // 注册进 Registry；否则这些工具对 LLM 完全不可见，以压缩 prompt。
    const activation = await mcpMounted.activateForPrompt(promptContent, {
      ...(debug
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
        : {}),
    });
    if (debug && activation.groups.length > 0) {
      process.stderr.write(
        colorize(
          `[tachu][mcp] gated summary: ${activation.groups.length} group(s), ` +
            `+${activation.activated.length} −${activation.deactivated.length}\n`,
          "gray",
        ),
      );
    }

    const inkCli = typeof args.ink === "boolean" ? args.ink : true;
    const useInk = shouldUseInkCli({
      ink: inkCli,
      noColor: Boolean(args["no-color"]),
      planMode: Boolean(args["plan-mode"]),
    });
    const wouldUseInkWithoutPlan = shouldUseInkCli({
      ink: inkCli,
      noColor: Boolean(args["no-color"]),
      planMode: false,
    });
    if (Boolean(args["plan-mode"]) && wouldUseInkWithoutPlan) {
      process.stderr.write(
        colorize(
          "[tachu] --plan-mode 与 Ink 不兼容，已使用标准终端渲染。\n",
          "yellow",
        ),
      );
    }

    let configForEngine = config;
    if (useInk || process.env.TACHU_STREAM_DELTA === "1") {
      configForEngine = {
        ...config,
        runtime: { ...config.runtime, streamingOutput: true },
      };
    }

    // 构建 engine（把 MCP executors 合并进 toolExecutor 映射；observability
    // 复用同一个实例）
    const engine = createEngine(configForEngine, {
      cwd,
      registry,
      observability,
      extraToolExecutors: mcpMounted.executors,
    });

    // args.markdown 是 citty 的可选布尔：
    // - 命令行未出现 `--markdown` / `--no-markdown` 时为 undefined → StreamRenderer 自动推断（TTY 开、非 TTY 关）
    // - 显式 `--markdown` 为 true、`--no-markdown` 为 false → 透传给 renderer
    const renderMarkdown =
      typeof args.markdown === "boolean" ? args.markdown : undefined;

    let renderer: ChunkRenderer;
    if (useInk) {
      renderer = createInkRunRenderer({ verbose, debug, renderMarkdown }).renderer;
    } else {
      renderer = new StreamRenderer({ verbose, debug, renderMarkdown });
    }
    const controller = new AbortController();

    // SIGINT：POSIX 约定"被 SIGINT 终止"的退出码为 128+SIGINT(2)=130
    // - 第一次：取消当前流式执行；后续在 finally 后若未出 finalOutput 以 130 退出
    // - 第二次：立即以 130 硬退出
    let sigintFired = false;
    const handleSigint = () => {
      if (!sigintFired) {
        sigintFired = true;
        controller.abort();
        engine.cancel(sessionId).catch(() => {
          /* cancel 失败不应阻塞第一次 SIGINT 的响应，最终由 finally 兜底 */
        });
        process.stderr.write(colorize("\n已取消。\n", "gray"));
      } else {
        process.exit(130);
      }
    };
    process.on("SIGINT", handleSigint);

    let exitCode = 0;
    let finalOutput: EngineOutput | undefined;

    try {
      const context = {
        requestId: randomUUID(),
        sessionId,
        traceId: randomUUID(),
        principal: {},
        budget: {},
        scopes: ["*"],
        startedAt: Date.now(),
      };

      let input: InputEnvelope;
      if (args["text-to-image"]) {
        const raw =
          typeof promptContent === "string"
            ? promptContent
            : String(promptContent ?? "");
        const t = raw.trim();
        input = buildTextToImageInputEnvelope(
          t.length > 0 ? t : DEFAULT_TEXT_TO_IMAGE_PROMPT,
          "cli-run",
        );
      } else if (imagePaths.length > 0) {
        const text =
          typeof promptContent === "string"
            ? promptContent
            : String(promptContent ?? "");
        try {
          input = await loadMultimodalEnvelopeFromLocalImages({
            cwd,
            config,
            imagePaths,
            text,
            defaultText: "请描述这张图片的主要内容。",
            source: "cli-run",
          });
        } catch (err) {
          console.error(colorize(`错误：${(err as Error).message}`, "red"));
          exitCode = 1;
          return;
        }
      } else {
        input = {
          content: promptContent,
          metadata: { modality: "text", source: "cli-run" },
        };
      }

      for await (const chunk of engine.runStream(input, context)) {
        if (controller.signal.aborted) {
          break;
        }

        // plan-preview 需要额外处理（等待用户确认）
        if (chunk.type === "plan-preview" && args["plan-mode"]) {
          renderer.render(chunk);
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(
            colorize("是否批准此 Plan？(y/N/修改) ", "yellow"),
          );
          rl.close();
          if (answer.toLowerCase() !== "y") {
            controller.abort();
            engine.cancel(sessionId);
            process.stdout.write(colorize("Plan 已拒绝。\n", "yellow"));
            exitCode = 1;
            break;
          }
        } else {
          renderer.render(chunk);
        }

        if (chunk.type === "done") {
          finalOutput = chunk.output;
        }
        if (chunk.type === "error") {
          exitCode = 1;
        }
      }

      if (finalOutput) {
        const outputFormat = (args.output as "text" | "json" | "markdown") || "text";
        renderer.finalize(finalOutput, outputFormat);

        const saveImageTarget = (args["save-image"] as string | undefined) ?? "";
        const generatedImages = finalOutput.metadata.generatedImages ?? [];
        if (saveImageTarget.length > 0) {
          if (generatedImages.length === 0) {
            process.stderr.write(
              colorize(
                "[tachu] --save-image 已指定，但本轮未产生任何图片（metadata.generatedImages 为空）。\n",
                "yellow",
              ),
            );
          } else {
            try {
              const records = await saveGeneratedImages({
                cwd,
                images: generatedImages,
                target: saveImageTarget,
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
                  exitCode = 1;
                } else {
                  process.stdout.write(
                    colorize(
                      `[tachu] 已保存：${rec.path}（${rec.bytes} bytes，来源 ${rec.source}）\n`,
                      "green",
                    ),
                  );
                }
              }
            } catch (err) {
              process.stderr.write(
                colorize(
                  `[tachu] --save-image 失败：${(err as Error).message}\n`,
                  "red",
                ),
              );
              exitCode = 1;
            }
          }
        }

        // 持久化 session meta —— 消息历史由 engine 内部 phases 自动 append
        // 到 MemorySystem（默认 FsMemorySystem，跨进程可恢复），这里只累加
        // budget / lastActive 等 meta。
        const persisted = await store.load(sessionId) ?? createEmptySession(sessionId);
        persisted.budget.tokensUsed += finalOutput.metadata.tokenUsage.total;
        persisted.budget.toolCallsUsed += finalOutput.metadata.toolCalls.length;
        persisted.budget.wallTimeMs += finalOutput.metadata.durationMs;
        persisted.lastActiveAt = Date.now();
        await store.save(persisted);
      }
    } catch (err) {
      if (!sigintFired) {
        process.stderr.write(colorize(`错误：${formatError(err)}\n`, "red"));
        exitCode = 1;
      }
    } finally {
      await renderer.dispose();
      await engine.dispose();
      // engine.dispose 之后再断 MCP adapter：engine 里的 tool-use 子流程
      // 可能仍在回收进行中工具调用；先让 engine 主动结束它们，再关 transport。
      await mcpMounted.disconnectAll();
      detachDebug?.();
      process.removeListener("SIGINT", handleSigint);
    }

    // 第一次 SIGINT 未出 finalOutput 的场景：按 POSIX 语义以 130 退出
    if (sigintFired && !finalOutput) {
      exitCode = 130;
    }

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  },
});
