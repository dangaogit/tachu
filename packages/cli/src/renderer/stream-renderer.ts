import type { EngineOutput, StreamChunk } from "@tachu/core";
import { formatTokensK } from "../utils/format-tokens-k";
import { colorize, shouldDisableColor } from "./color";
import { renderMarkdownToAnsi } from "./markdown";
import { Spinner } from "./spinner";

/**
 * CLI 侧内部术语脱敏黑名单。
 *
 * 背景（patch-01-fallback）：
 *   Core 的 `ensureFallbackText` + `EngineError.userMessage` 已经禁止产出这些术语；
 *   但 CLI 作为**最后一道屏蔽防线**，必须对 `finalize()` 与 `error` chunk 的正文
 *   再过一次扫描 —— 兜住任何上游未捕获的术语泄漏回归。
 *
 * 命中即替换；不做启发式上下文判断（简单、可预测、误杀可控）。
 */
const CLI_INTERNAL_TERMS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btask-tool-\d+\b/gi, "某个内部步骤"],
  [/\btask-direct-answer\b/gi, "兜底回答"],
  [/\btask-tool-use\b/gi, "工具循环"],
  [/\bPhase\s*\d+\b/gi, "执行阶段"],
  [/direct-answer\s*子流程/gi, "兜底回答"],
  [/tool-use\s*子流程/gi, "工具循环"],
  [/capability\s*路由/gi, "能力路由"],
  [/Tool\s*\/\s*Agent\s*描述符/gi, "工具描述"],
];

/**
 * 将任意文本中的内部术语脱敏。
 *
 * 仅用于面向终端用户的渲染路径（`finalize()` / `error` chunk / tool-result 预览）。
 * JSON 输出模式 (`finalize("json")`) 跳过脱敏 —— 那是给程序消费的，需要保留原信息。
 */
export const sanitizeUserText = (text: string): string => {
  let result = text;
  for (const [pattern, replacement] of CLI_INTERNAL_TERMS_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

/**
 * 判断 `tool-call-end` 的 errorMessage 是否来自审批拒绝。
 *
 * 依据：`tool-use` 在拒绝时合成的文案里含"用户拒绝"或"审批"字样。
 */
const isApprovalDenial = (text: string): boolean => {
  if (text.length === 0) return false;
  return /用户拒绝|审批(?:被|超时|回调)/.test(text);
};

/**
 * 流式块渲染器接口。
 */
export interface ChunkRenderer {
  /**
   * 渲染单个流式块。
   *
   * @param chunk 流式块
   */
  render(chunk: StreamChunk): void;
  /**
   * 最终输出格式化。
   *
   * @param output 引擎最终输出
   * @param outputFormat 输出格式
   */
  finalize(output: EngineOutput, outputFormat?: "text" | "json" | "markdown"): void;
  /**
   * 释放渲染器资源（停止 spinner 等）。
   */
  dispose(): Promise<void>;
}

/**
 * StreamRenderer 配置。
 */
export interface StreamRendererOptions {
  /** 是否输出详细日志（progress chunk） */
  verbose?: boolean | undefined;
  /**
   * 是否对 `finalize("text")` / `finalize("markdown")` 的正文启用 Markdown ANSI 渲染。
   *
   * - `undefined`（默认）：根据 `shouldDisableColor()` 自动推断——彩色可用时开启，
   *   NO_COLOR / non-TTY / `--no-color` 下关闭并输出原文。
   * - `true`：始终启用。
   * - `false`：始终关闭，正文按原始文本直写。
   *
   * 注意 `finalize("markdown")` 语义为"用户显式选择 Markdown 输出"，
   * 会忽略此开关始终尝试渲染（禁色环境仍会退化为原文，见 `renderMarkdownToAnsi`）。
   */
  renderMarkdown?: boolean | undefined;
  /**
   * `--debug` 开关。打开后自动把 `verbose` 提升为 `true`，并在渲染时追加额外
   * 诊断信息（例如 tool-call 的参数预览、tool-call-end 的耗时一并着色）；
   * observability 层的事件订阅由 `attachCliDebugPrinter` 负责，此处只控制
   * stream chunk 的渲染详细程度。
   */
  debug?: boolean | undefined;
}

/**
 * 标准流式渲染器：将 StreamChunk 类型化渲染到终端。
 *
 * 颜色规则：
 * - progress → 灰色（verbose 模式下显示，非 verbose 只 spinner）
 * - tool-call → 黄色
 * - tool-result → 青色
 * - artifact → 绿色
 * - plan-preview → 蓝色
 * - error → 红色
 * - done → 蓝色
 * - delta/text → 白色直写
 *
 * @example
 * ```ts
 * const renderer = new StreamRenderer({ verbose: false });
 * for await (const chunk of engine.runStream(input, ctx)) {
 *   renderer.render(chunk);
 * }
 * renderer.finalize(output);
 * await renderer.dispose();
 * ```
 */
export class StreamRenderer implements ChunkRenderer {
  private readonly verbose: boolean;
  private readonly debug: boolean;
  private readonly spinner: Spinner;
  private readonly renderMarkdown: boolean;
  private currentPhase = "";
  /**
   * 每个 phase 的开始时间戳。键是 phase 名，值是 `Date.now()`；遇到
   * `${phase} finished` 时用来计算 duration_ms 并附加到 phase 尾部。
   *
   * 使用 Map 而非单一变量，避免同一流里 phase 交织时相互覆盖（例如 tool-use
   * 子流程在 execution phase 期间还会发自己的内部 progress）。
   */
  private readonly phaseStartedAt = new Map<string, number>();
  /** 流式 delta 累积；与 finalize 正文一致时可跳过重复打印。 */
  private streamedBody = "";

  constructor(options: StreamRendererOptions = {}) {
    this.debug = options.debug ?? false;
    // `--debug` 是 verbose 的超集：debug=true 时强制打开 verbose；否则沿用用户显式值。
    this.verbose = this.debug || (options.verbose ?? false);
    // 自动推断：彩色可用 → 启用 Markdown ANSI 渲染；NO_COLOR / non-TTY / --no-color → 关闭。
    this.renderMarkdown = options.renderMarkdown ?? !shouldDisableColor();
    this.spinner = new Spinner();
  }

  /**
   * 渲染流式块。
   *
   * @param chunk 流式块
   */
  render(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "usage": {
        break;
      }
      case "delta": {
        this.spinner.stop();
        this.streamedBody += chunk.content;
        process.stdout.write(chunk.content);
        break;
      }
      case "progress": {
        // phase 边界检测：按照 `Engine.emitPhaseStart/emitPhaseEnd` 的约定，
        // 进入阶段时 `message === "<phase> started"`、离开时 `message === "<phase> finished"`。
        // 我们在 renderer 这一层记录起止时间，向用户输出"phase 结束 + duration"，
        // 不依赖 core 给 chunk 塞新字段，升级兼容性最佳（core / CLI 可独立推进）。
        const message = this.decorateProgressMessage(chunk.phase, chunk.message);

        if (this.verbose) {
          this.spinner.stop();
          process.stdout.write(
            colorize(`[phase: ${chunk.phase}] ${message}\n`, "gray"),
          );
        } else {
          const phaseText = chunk.phase !== this.currentPhase ? chunk.phase : "";
          this.currentPhase = chunk.phase;
          const text = phaseText ? `${phaseText}: ${message}` : message;
          this.spinner.update(colorize(text, "gray"));
          if (!this.spinner["active"]) {
            this.spinner.start(colorize(text, "gray"));
          }
        }
        break;
      }
      case "artifact": {
        this.spinner.stop();
        const artifactContent = chunk.artifact.content;
        const pathOrUrl =
          artifactContent !== null &&
          artifactContent !== undefined &&
          typeof artifactContent === "object" &&
          "path" in artifactContent &&
          typeof (artifactContent as Record<string, unknown>)["path"] === "string"
            ? String((artifactContent as Record<string, unknown>)["path"])
            : artifactContent !== null &&
                artifactContent !== undefined &&
                typeof artifactContent === "object" &&
                "url" in artifactContent
              ? String((artifactContent as Record<string, unknown>)["url"])
              : "";
        process.stdout.write(
          colorize(`[artifact: ${chunk.artifact.name}] ${pathOrUrl}\n`, "green"),
        );
        break;
      }
      case "plan-preview": {
        this.spinner.stop();
        process.stdout.write(colorize(`\n── Plan Preview ──\n`, "blue"));
        process.stdout.write(colorize(JSON.stringify(chunk.plan, null, 2) + "\n", "blue"));
        process.stdout.write(colorize(`──────────────────\n`, "blue"));
        break;
      }
      case "tool-loop-step": {
        // Agentic Loop 每一轮思考开始：非 verbose 模式下用 spinner 提示。
        this.spinner.stop();
        const label = `🔁 思考中 (第 ${chunk.step}/${chunk.maxSteps} 轮)`;
        if (this.verbose) {
          process.stdout.write(colorize(`${label}\n`, "gray"));
        } else {
          this.spinner.update(colorize(label, "gray"));
          if (!this.spinner["active"]) {
            this.spinner.start(colorize(label, "gray"));
          }
        }
        break;
      }
      case "tool-call-start": {
        this.spinner.stop();
        const sanitizedPreview = sanitizeUserText(chunk.argumentsPreview);
        process.stdout.write(
          colorize(`→ 调用工具 ${chunk.tool}  ${sanitizedPreview}\n`, "yellow"),
        );
        break;
      }
      case "tool-call-end": {
        this.spinner.stop();
        if (chunk.success) {
          process.stdout.write(
            colorize(`  ✓ ${chunk.tool} (${chunk.durationMs}ms)\n`, "green"),
          );
        } else {
          const rawMessage = chunk.errorMessage ?? "";
          const sanitized = sanitizeUserText(rawMessage).trim();
          const isDenied =
            chunk.errorCode === "TOOL_LOOP_APPROVAL_DENIED" ||
            isApprovalDenial(sanitized);
          const headline = isDenied
            ? `  ✗ ${chunk.tool} 已拒绝 (${chunk.durationMs}ms)`
            : `  ✗ ${chunk.tool} 执行失败 (${chunk.durationMs}ms)`;
          process.stdout.write(colorize(`${headline}\n`, "red"));
          if (sanitized.length > 0) {
            process.stdout.write(
              colorize(`     原因: ${sanitized}\n`, "gray"),
            );
          }
        }
        break;
      }
      case "tool-loop-final": {
        // 不再输出额外内容，finalize() 会展示最终答案；留给 verbose 观察。
        if (this.verbose) {
          this.spinner.stop();
          const label = chunk.success
            ? `工具循环完成（共 ${chunk.steps} 轮）`
            : `工具循环终止（共 ${chunk.steps} 轮）`;
          process.stdout.write(colorize(`${label}\n`, "gray"));
        }
        break;
      }
      case "error": {
        this.spinner.stop();
        // patch-01-fallback：error chunk 的 message 面向用户，必须过脱敏。
        // 若 Engine 的 EngineError 已经携带 userMessage，优先使用（内容已保证无内部术语）；
        // 否则 fallback 到 message（开发者文案），再过一道脱敏双保险。
        const errWithUser = chunk.error as { userMessage?: string };
        const rawText =
          typeof errWithUser.userMessage === "string" &&
          errWithUser.userMessage.trim().length > 0
            ? errWithUser.userMessage
            : chunk.error.message;
        process.stderr.write(
          colorize(`[error:${chunk.error.code}] ${sanitizeUserText(rawText)}\n`, "red"),
        );
        break;
      }
      case "done": {
        this.spinner.stop();
        const { metadata } = chunk.output;
        const total = metadata.tokenUsage.total ?? 0;
        const cost = (total * 0.000002).toFixed(4);
        process.stdout.write(
          colorize(
            `\n[done:${chunk.output.status}] duration=${metadata.durationMs}ms tokens=${formatTokensK(total)} cost≈$${cost}\n`,
            "blue",
          ),
        );
        break;
      }
      default: {
        // 未知 chunk 类型静默忽略
        break;
      }
    }
  }

  /**
   * 根据输出格式格式化最终结果并写入 stdout。
   *
   * - `text`（默认）：把 `output.content` 当作最终答复正文写出。构造时 `renderMarkdown=true`
   *   （或自动推断为启用）会把正文按 Markdown 渲染成 ANSI 着色；否则原样直写。
   *   这是 `run` / `chat` 的默认路径，**必须输出**，否则用户看不到答复——
   *   因为 Engine 目前并未对外 yield `delta` 片段，正文只会出现在最终的
   *   `EngineOutput.content` 里。
   * - `json`：整份 `EngineOutput` 的格式化 JSON，跳过 Markdown 渲染。
   * - `markdown`：将正文作为 Markdown 渲染输出（显式选择此模式会忽略 `renderMarkdown` 开关，
   *   但禁色环境下 `renderMarkdownToAnsi` 会自动退化为原文）。
   *
   * @param output 引擎最终输出
   * @param outputFormat 输出格式（text | json | markdown）
   */
  finalize(output: EngineOutput, outputFormat: "text" | "json" | "markdown" = "text"): void {
    if (outputFormat === "json") {
      // JSON 模式给程序消费，不过脱敏 —— 保留完整内部字段。
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      return;
    }

    const rawContent =
      typeof output.content === "string"
        ? output.content
        : JSON.stringify(output.content, null, 2);

    if (rawContent.length === 0) return;

    // patch-01-fallback：text/markdown 模式面向终端用户，必须先过脱敏再进入 Markdown 渲染。
    // Core 的 ensureFallbackText 已经做过一道；CLI 侧再做一道，兜住任何上游未捕获的术语泄漏。
    const content = sanitizeUserText(rawContent);

    if (
      this.streamedBody.length > 0 &&
      content === sanitizeUserText(this.streamedBody.trim())
    ) {
      return;
    }

    const body =
      outputFormat === "markdown" || this.renderMarkdown
        ? renderMarkdownToAnsi(content)
        : content;

    const needsLeadingNewline = !body.startsWith("\n");
    const prefix = needsLeadingNewline ? "\n" : "";
    const suffix = body.endsWith("\n") ? "" : "\n";
    process.stdout.write(prefix + body + suffix);
  }

  /**
   * 根据 `<phase> started` / `<phase> finished` 约定追踪 phase 计时。
   *
   * - `started`：记录开始时间戳（若同名 phase 多次开始，以最后一次为准——
   *   这符合 tool-loop 子流程在 `execution` phase 内多轮重入的现实）
   * - `finished`：查出对应的 started 时间并计算 delta，以 `finished (Nms)`
   *   形式替换原始消息；缺失 start 时回退为不带耗时的原文
   * - 其他 progress 消息：原样返回
   */
  private decorateProgressMessage(phase: string, rawMessage: string): string {
    const startedSuffix = `${phase} started`;
    const finishedSuffix = `${phase} finished`;

    if (rawMessage === startedSuffix) {
      this.phaseStartedAt.set(phase, Date.now());
      return rawMessage;
    }
    if (rawMessage === finishedSuffix) {
      const startedAt = this.phaseStartedAt.get(phase);
      if (startedAt !== undefined) {
        const durationMs = Date.now() - startedAt;
        this.phaseStartedAt.delete(phase);
        return `${rawMessage} (${durationMs}ms)`;
      }
      return rawMessage;
    }
    return rawMessage;
  }

  /**
   * 释放资源（停止 spinner）。
   */
  async dispose(): Promise<void> {
    this.spinner.stop();
  }
}
