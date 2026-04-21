import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render } from "ink";
import Spinner from "ink-spinner";
import type { EngineOutput, StreamChunk } from "@tachu/core";
import type { ChunkRenderer, StreamRendererOptions } from "../renderer/stream-renderer";
import { sanitizeUserText } from "../renderer/stream-renderer";
import { shouldDisableColor } from "../renderer/color";
import { renderMarkdownToAnsi } from "../renderer/markdown";
import { patchMarkdown } from "../renderer/patch-markdown";
import { createRenderScheduler } from "../renderer/render-scheduler";
import { takeTailLines } from "./windowed-text";
import { resetTerminalAnsi } from "./terminal-cleanup";
import { formatTokensK } from "../utils/format-tokens-k";

export type AgentUiState = "idle" | "thinking" | "typing" | "error";

export interface InkViewState {
  agent: AgentUiState;
  assistantRaw: string;
  logLines: string[];
  statusLine: string;
  doneSummary: string | undefined;
  currentPhase: string;
  /** 本轮 runStream 内 orchestrator 累计用量；用于底部详情条实时刷新，一轮结束后清空 */
  liveUsage: { tokens: number; toolCalls: number; wallTimeMs: number } | undefined;
}

const MAX_LOG_LINES = 24;

const isApprovalDenial = (text: string): boolean => {
  if (text.length === 0) {
    return false;
  }
  return /用户拒绝|审批(?:被|超时|回调)/.test(text);
};

function decorateProgressMessage(
  phaseStartedAt: Map<string, number>,
  phase: string,
  rawMessage: string,
): string {
  const startedSuffix = `${phase} started`;
  const finishedSuffix = `${phase} finished`;

  if (rawMessage === startedSuffix) {
    phaseStartedAt.set(phase, Date.now());
    return rawMessage;
  }
  if (rawMessage === finishedSuffix) {
    const startedAt = phaseStartedAt.get(phase);
    if (startedAt !== undefined) {
      const durationMs = Date.now() - startedAt;
      phaseStartedAt.delete(phase);
      return `${rawMessage} (${durationMs}ms)`;
    }
    return rawMessage;
  }
  return rawMessage;
}

export class InkStreamRenderer implements ChunkRenderer {
  private readonly verbose: boolean;
  private readonly debug: boolean;
  readonly renderMarkdown: boolean;
  private readonly scheduler = createRenderScheduler({ maxFps: 60 });
  private readonly phaseStartedAt = new Map<string, number>();
  private state: InkViewState = {
    agent: "idle",
    assistantRaw: "",
    logLines: [],
    statusLine: "",
    doneSummary: undefined,
    currentPhase: "",
    liveUsage: undefined,
  };
  private setReactState: ((s: InkViewState) => void) | null = null;
  private unmountFn: (() => void) | null = null;

  constructor(options: StreamRendererOptions = {}) {
    this.debug = options.debug ?? false;
    this.verbose = this.debug || (options.verbose ?? false);
    this.renderMarkdown = options.renderMarkdown ?? !shouldDisableColor();
  }

  connect(setState: (s: InkViewState) => void): void {
    this.setReactState = setState;
  }

  disconnect(): void {
    this.setReactState = null;
  }

  setUnmount(fn: () => void): void {
    this.unmountFn = fn;
  }

  getSnapshot(): InkViewState {
    return { ...this.state };
  }

  /**
   * 多轮对话：一轮结束后清空流式区，避免与上一轮内容叠加。
   */
  resetAfterTurn(): void {
    this.state.assistantRaw = "";
    this.state.logLines = [];
    this.state.statusLine = "";
    this.state.doneSummary = undefined;
    this.state.agent = "idle";
    this.state.currentPhase = "";
    this.state.liveUsage = undefined;
    this.phaseStartedAt.clear();
    this.push();
  }

  private push(): void {
    this.scheduler.schedule(() => {
      this.setReactState?.({ ...this.state });
    });
  }

  private appendLog(line: string): void {
    this.state.logLines.push(line);
    if (this.state.logLines.length > MAX_LOG_LINES) {
      this.state.logLines = this.state.logLines.slice(-MAX_LOG_LINES);
    }
  }

  render(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "usage": {
        this.state.liveUsage = {
          tokens: chunk.tokens,
          toolCalls: chunk.toolCalls,
          wallTimeMs: chunk.wallTimeMs,
        };
        this.push();
        break;
      }
      case "delta": {
        this.state.agent = "typing";
        this.state.assistantRaw += chunk.content;
        this.push();
        break;
      }
      case "progress": {
        const message = decorateProgressMessage(
          this.phaseStartedAt,
          chunk.phase,
          chunk.message,
        );
        if (this.verbose) {
          this.appendLog(`[phase: ${chunk.phase}] ${message}`);
        } else {
          const phaseText =
            chunk.phase !== this.state.currentPhase ? chunk.phase : "";
          this.state.currentPhase = chunk.phase;
          this.state.statusLine = phaseText
            ? `${phaseText}: ${message}`
            : message;
          this.state.agent = "thinking";
        }
        this.push();
        break;
      }
      case "artifact": {
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
        this.appendLog(`[artifact: ${chunk.artifact.name}] ${pathOrUrl}`);
        this.push();
        break;
      }
      case "plan-preview": {
        this.appendLog("── Plan Preview ──");
        this.appendLog(JSON.stringify(chunk.plan, null, 2));
        this.appendLog("──────────────────");
        this.push();
        break;
      }
      case "tool-loop-step": {
        const label = `🔁 思考中 (第 ${chunk.step}/${chunk.maxSteps} 轮)`;
        if (this.verbose) {
          this.appendLog(label);
        } else {
          this.state.statusLine = label;
          this.state.agent = "thinking";
        }
        this.push();
        break;
      }
      case "tool-call-start": {
        const sanitizedPreview = sanitizeUserText(chunk.argumentsPreview);
        this.appendLog(`→ 调用工具 ${chunk.tool}  ${sanitizedPreview}`);
        this.push();
        break;
      }
      case "tool-call-end": {
        if (chunk.success) {
          this.appendLog(`  ✓ ${chunk.tool} (${chunk.durationMs}ms)`);
        } else {
          const rawMessage = chunk.errorMessage ?? "";
          const sanitized = sanitizeUserText(rawMessage).trim();
          const isDenied =
            chunk.errorCode === "TOOL_LOOP_APPROVAL_DENIED" ||
            isApprovalDenial(sanitized);
          const headline = isDenied
            ? `  ✗ ${chunk.tool} 已拒绝 (${chunk.durationMs}ms)`
            : `  ✗ ${chunk.tool} 执行失败 (${chunk.durationMs}ms)`;
          this.appendLog(headline);
          if (sanitized.length > 0) {
            this.appendLog(`     原因: ${sanitized}`);
          }
        }
        this.push();
        break;
      }
      case "tool-loop-final": {
        if (this.verbose) {
          const label = chunk.success
            ? `工具循环完成（共 ${chunk.steps} 轮）`
            : `工具循环终止（共 ${chunk.steps} 轮）`;
          this.appendLog(label);
          this.push();
        }
        break;
      }
      case "error": {
        this.state.agent = "error";
        const errWithUser = chunk.error as { userMessage?: string };
        const rawText =
          typeof errWithUser.userMessage === "string" &&
          errWithUser.userMessage.trim().length > 0
            ? errWithUser.userMessage
            : chunk.error.message;
        this.appendLog(
          `[error:${chunk.error.code}] ${sanitizeUserText(rawText)}`,
        );
        this.push();
        break;
      }
      case "done": {
        this.state.agent = "idle";
        const { metadata } = chunk.output;
        const total = metadata.tokenUsage.total ?? 0;
        const cost = (total * 0.000002).toFixed(4);
        this.state.doneSummary = `[done:${chunk.output.status}] duration=${metadata.durationMs}ms tokens=${formatTokensK(total)} cost≈$${cost}`;
        this.push();
        break;
      }
      default: {
        break;
      }
    }
  }

  finalize(
    output: EngineOutput,
    outputFormat: "text" | "json" | "markdown" = "text",
  ): void {
    if (outputFormat === "json") {
      if (this.unmountFn) {
        const u = this.unmountFn;
        this.unmountFn = null;
        u();
      }
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      return;
    }

    const rawContent =
      typeof output.content === "string"
        ? output.content
        : JSON.stringify(output.content, null, 2);

    if (rawContent.length === 0) {
      return;
    }

    const sanitized = sanitizeUserText(rawContent);
    if (
      this.state.assistantRaw.trim().length > 0 &&
      sanitized === sanitizeUserText(this.state.assistantRaw)
    ) {
      return;
    }

    this.state.assistantRaw = sanitized;
    this.push();
  }

  async dispose(): Promise<void> {
    this.scheduler.cancel();
    if (this.unmountFn) {
      const u = this.unmountFn;
      this.unmountFn = null;
      u();
    }
    this.disconnect();
  }
}

function InkRunRoot({
  controller,
}: {
  controller: InkStreamRenderer;
}): React.ReactElement {
  const [state, setState] = useState<InkViewState>(() => controller.getSnapshot());
  const [dims, setDims] = useState({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  });

  useEffect(() => {
    controller.connect(setState);
    const onResize = (): void => {
      setDims({
        rows: process.stdout.rows ?? 24,
        cols: process.stdout.columns ?? 80,
      });
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
      controller.disconnect();
    };
  }, [controller]);

  const displayText = useMemo(() => {
    const patched = patchMarkdown(state.assistantRaw);
    return controller.renderMarkdown
      ? renderMarkdownToAnsi(patched, { force: true })
      : patched;
  }, [state.assistantRaw, controller.renderMarkdown]);

  const viewportLines = Math.max(4, dims.rows - 6);
  const logLines = useMemo(() => state.logLines.slice(-8), [state.logLines]);
  const assistantViewportLines = useMemo(() => {
    const statusReserve = 1;
    const usedByLogs = logLines.length;
    return Math.max(2, viewportLines - statusReserve - usedByLogs);
  }, [viewportLines, logLines.length]);

  const assistantTailMax = useMemo(
    () => Math.min(500, Math.max(assistantViewportLines, 40, Math.floor(viewportLines * 0.55))),
    [assistantViewportLines, viewportLines],
  );

  const clipped = useMemo(
    () => takeTailLines(displayText, assistantTailMax),
    [displayText, assistantTailMax],
  );

  const showSpinner =
    state.agent === "thinking" && !state.doneSummary;

  return (
    <Box flexDirection="column" width={dims.cols}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        <Box flexShrink={0} marginBottom={logLines.length > 0 ? 1 : 0}>
          {showSpinner ? (
            <Text color="gray">
              <Spinner type="dots" /> {state.statusLine || "…"}
            </Text>
          ) : (
            <Text color="cyan" dimColor>
              {state.doneSummary ?? state.statusLine}
            </Text>
          )}
        </Box>
        {logLines.length > 0 ? (
          <Box flexDirection="column" marginBottom={1} flexShrink={0}>
            {logLines.map((line, i) => (
              <Text key={i} color="gray" wrap="wrap">
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1} minHeight={assistantViewportLines}>
          <Text wrap="wrap">{clipped}</Text>
        </Box>
        {state.agent === "error" ? (
          <Box marginTop={1} flexShrink={0}>
            <Text color="red">状态：error</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function createInkRunRenderer(options: StreamRendererOptions = {}): {
  renderer: InkStreamRenderer;
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
} {
  const renderer = new InkStreamRenderer(options);
  const { waitUntilExit, unmount } = render(<InkRunRoot controller={renderer} />, {
    exitOnCtrlC: false,
  });
  renderer.setUnmount(() => {
    unmount();
    resetTerminalAnsi();
  });
  return { renderer, waitUntilExit, unmount };
}
