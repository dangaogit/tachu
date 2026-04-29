import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useInput, render } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { randomUUID } from "node:crypto";
import type { Engine, EngineOutput, MemoryEntry } from "@tachu/core";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "@tachu/core";
import { setInteractivePrompter } from "../approval";
import { colorize } from "../renderer/color";
import { renderMarkdownToAnsi } from "../renderer/markdown";
import { patchMarkdown } from "../renderer/patch-markdown";
import { loadConfig } from "../config-loader/config-file";
import { executeSlashCommand, type SlashContext } from "../interactive-slash";
import type { InteractiveChatOptions } from "../interactive";
import { buildTextToImageInputEnvelope } from "@tachu/core";
import { DEFAULT_IMAGE_CHAT_PROMPT, tryParseImageSlashCommand } from "../utils/image-slash-command";
import {
  DEFAULT_TEXT_TO_IMAGE_PROMPT,
  detectTextToImageIntent,
} from "../utils/text-to-image-slash-command";
import { loadMultimodalEnvelopeFromLocalImages } from "../utils/multimodal-local-images";
import { saveGeneratedImages } from "../utils/save-generated-images";
import type { FsSessionStore, PersistedSession } from "../session-store/fs-session-store";
import { createEmptySession } from "../session-store/fs-session-store";
import { InkStreamRenderer, type InkViewState } from "./ink-stream-renderer";
import { resetTerminalAnsi } from "./terminal-cleanup";
import { formatTokensK } from "../utils/format-tokens-k";
import { formatWallDisplay } from "../utils/format-wall-display";
/** 审批 prompter 与 Ink 之间的桥接（stderr 仍由 approval-prompt 写 info，这里只解析单行 question）。 */
class InkApprovalBridge {
  private pending: { query: string; resolve: (s: string) => void } | null = null;
  onPendingChange: (() => void) | null = null;

  request(query: string): Promise<string> {
    return new Promise((resolve) => {
      this.pending = { query, resolve };
      this.onPendingChange?.();
    });
  }

  getPending(): { query: string } | null {
    return this.pending ? { query: this.pending.query } : null;
  }

  submit(line: string): void {
    if (!this.pending) {
      return;
    }
    const r = this.pending.resolve;
    this.pending = null;
    r(line);
    this.onPendingChange?.();
  }

  clear(): void {
    this.pending = null;
    this.onPendingChange?.();
  }
}

type HistoryLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "slash"; text: string }
  | { kind: "system"; text: string };

/** 将历史与当前流式正文拼成一块，再在终端行数内取尾部（不画边框、不按「10 行」硬切）。 */
function buildBodySourceText(
  history: HistoryLine[],
  assistantRaw: string,
  renderMarkdown: boolean,
): string {
  const parts: string[] = [];
  for (const h of history) {
    if (h.kind === "user") {
      parts.push(`you> ${h.text}`);
    } else if (h.kind === "assistant") {
      const t = h.text.trim();
      if (t.length > 0) {
        parts.push(
          renderMarkdown
            ? renderMarkdownToAnsi(patchMarkdown(t), { force: true })
            : t,
        );
      }
    } else {
      parts.push(h.text.trimEnd());
    }
  }
  const cur = assistantRaw.trim();
  if (cur.length > 0) {
    parts.push(
      renderMarkdown
        ? renderMarkdownToAnsi(patchMarkdown(assistantRaw), { force: true })
        : assistantRaw,
    );
  }
  return parts.join("\n\n");
}

interface InkChatRootProps {
  engine: Engine;
  store: FsSessionStore;
  options: InteractiveChatOptions;
  bridge: InkApprovalBridge;
  onExit: () => void;
}

function InkChatRoot({
  engine,
  store,
  options,
  bridge,
  onExit,
}: InkChatRootProps): React.ReactElement {
  const sessionHolder = useRef<{ session: PersistedSession }>({
    session: options.initialSession ?? createEmptySession(randomUUID()),
  });
  const [sessionView, setSessionView] = useState(() => sessionHolder.current.session.id);
  const [, forceApproval] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    bridge.onPendingChange = () => {
      forceApproval();
    };
    return () => {
      bridge.onPendingChange = null;
    };
  }, [bridge]);

  const memorySystem = engine.getMemorySystem();

  const saveSession = useCallback(async (): Promise<void> => {
    const s = sessionHolder.current.session;
    s.lastActiveAt = Date.now();
    await store.save(s);
  }, [store]);

  const loadHistory = useCallback(
    async (id: string): Promise<MemoryEntry[]> => {
      try {
        const window = await memorySystem.load(id, DEFAULT_ADAPTER_CALL_CONTEXT);
        return [...window.entries];
      } catch {
        return [];
      }
    },
    [memorySystem],
  );

  const messageCountFor = useCallback(
    async (id: string): Promise<number> => {
      try {
        const size = await memorySystem.getSize(id);
        return size.entries;
      } catch {
        return 0;
      }
    },
    [memorySystem],
  );

  const debug = options.debug ?? false;
  const renderer = useMemo(
    () =>
      new InkStreamRenderer({
        verbose: debug || (options.verbose ?? false),
        debug,
      }),
    [debug, options.verbose],
  );

  const [viewState, setViewState] = useState<InkViewState>(() => renderer.getSnapshot());
  const [history, setHistory] = useState<HistoryLine[]>([]);
  const [input, setInput] = useState("");
  /** 正文窗口相对尾部的向上偏移（行），用于 PgUp/PgDn 查看更早内容；0 表示贴底随流式更新 */
  const [scrollOffset, setScrollOffset] = useState(0);
  /** 会话 budget 变更时 bump，触发详情条重绘 */
  const [, bumpSessionMeta] = useReducer((n: number) => n + 1, 0);
  const [running, setRunning] = useState(false);
  /** 本轮用户发起到引擎结束的起点时间（与 `runOneTurn` 内 `startTime` 一致），用于底部耗时近实时刷新 */
  const turnStartAtRef = useRef(0);
  const [wallTick, setWallTick] = useState(0);
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const sigintCountRef = useRef(0);
  const lastSigintTimeRef = useRef(0);

  useEffect(() => {
    renderer.connect(setViewState);
    return () => {
      void renderer.dispose();
    };
  }, [renderer]);

  useEffect(() => {
    setInteractivePrompter((q) => bridge.request(q));
    return () => {
      setInteractivePrompter(null);
      bridge.clear();
    };
  }, [bridge]);

  const [dims, setDims] = useState({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  });

  useEffect(() => {
    const onResize = (): void => {
      setDims({
        rows: process.stdout.rows ?? 24,
        cols: process.stdout.columns ?? 80,
      });
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const pendingApproval = bridge.getPending();

  const handleSigint = useCallback(async (): Promise<void> => {
    const now = Date.now();
    sigintCountRef.current++;
    const sigintCount = sigintCountRef.current;

    if (runningRef.current && controllerRef.current) {
      controllerRef.current.abort();
      engine.cancel(sessionHolder.current.session.id);
      runningRef.current = false;
      setRunning(false);
      setHistory((h) => [...h, { kind: "system", text: "已取消当前请求。" }]);
      sigintCountRef.current = 1;
      lastSigintTimeRef.current = now;
      return;
    }

    if (sigintCount >= 2 && now - lastSigintTimeRef.current < 1000) {
      try {
        await saveSession();
      } catch {
        /* ignore */
      }
      onExit();
      process.exit(130);
    }

    if (sigintCount >= 3) {
      process.exit(130);
    }

    lastSigintTimeRef.current = now;
    setHistory((h) => [...h, { kind: "system", text: "再按一次 Ctrl+C 保存并退出。" }]);
  }, [engine, onExit, saveSession]);

  const scrollRef = useRef({ maxScroll: 0, step: 3 });

  useInput(
    (inputKey, key) => {
      const pend = bridge.getPending();
      /** 正文翻阅：PgUp/PgDn；↑/↓ 在 ink-text-input 中不移动光标，可复用为滚动 */
      const bumpScrollUp = (): void => {
        setScrollOffset((o) => Math.min(scrollRef.current.maxScroll, o + scrollRef.current.step));
      };
      const bumpScrollDown = (): void => {
        setScrollOffset((o) => Math.max(0, o - scrollRef.current.step));
      };
      if (key.pageUp) {
        bumpScrollUp();
        return;
      }
      if (key.pageDown) {
        bumpScrollDown();
        return;
      }
      if (key.upArrow) {
        bumpScrollUp();
        return;
      }
      if (key.downArrow) {
        bumpScrollDown();
        return;
      }
      if (key.ctrl && inputKey === "c") {
        if (pend) {
          bridge.submit("");
          return;
        }
        void handleSigint();
        return;
      }
      if (pend) {
        if (inputKey === "y" || inputKey === "Y") {
          bridge.submit("y");
        } else if (inputKey === "n" || inputKey === "N") {
          bridge.submit("n");
        } else if (key.return) {
          bridge.submit("n");
        }
      }
    },
    { isActive: true },
  );

  useEffect(() => {
    process.on("SIGINT", handleSigint);
    return () => {
      process.removeListener("SIGINT", handleSigint);
    };
  }, [handleSigint]);

  const runOneTurn = useCallback(
    async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      sigintCountRef.current = 0;

      const imageSlash = tryParseImageSlashCommand(trimmed);
      if (imageSlash) {
        setHistory((h) => [...h, { kind: "user", text: trimmed }]);

        if (options.mcpActivateForPrompt) {
          try {
            await options.mcpActivateForPrompt(
              trimmed,
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

        const startTime = Date.now();
        turnStartAtRef.current = startTime;
        controllerRef.current = new AbortController();
        runningRef.current = true;
        setRunning(true);

        const context = {
          requestId: randomUUID(),
          sessionId: sessionHolder.current.session.id,
          traceId: randomUUID(),
          principal: {},
          budget: {},
          scopes: ["*"],
          startedAt: startTime,
        };

        try {
          const chatCwd = process.cwd();
          const chatConfig = await loadConfig(chatCwd);
          const inputPayload = await loadMultimodalEnvelopeFromLocalImages({
            cwd: chatCwd,
            config: chatConfig,
            imagePaths: [imageSlash.rawPath],
            text: imageSlash.prompt,
            defaultText: DEFAULT_IMAGE_CHAT_PROMPT,
            source: "cli-chat",
          });

          let finalOutput: EngineOutput | undefined;
          for await (const chunk of engine.runStream(inputPayload, context)) {
            renderer.render(chunk);
            if (chunk.type === "done") {
              finalOutput = chunk.output;
            }
          }

          if (finalOutput) {
            renderer.finalize(finalOutput, "text");
            const s = sessionHolder.current.session;
            s.budget.tokensUsed += finalOutput.metadata.tokenUsage.total;
            s.budget.toolCallsUsed += finalOutput.metadata.toolCalls.length;
            s.budget.wallTimeMs += finalOutput.metadata.durationMs;

            const snap = renderer.getSnapshot();
            const body = snap.assistantRaw.trim();
            if (body.length > 0) {
              setHistory((h) => [...h, { kind: "assistant", text: body }]);
            }
            renderer.resetAfterTurn();
          }
        } catch (err) {
          runningRef.current = false;
          setRunning(false);
          process.stderr.write(colorize(`错误：${(err as Error).message}\n`, "red"));
          setHistory((h) => [
            ...h,
            { kind: "system", text: `错误：${(err as Error).message}` },
          ]);
        } finally {
          runningRef.current = false;
          setRunning(false);
          controllerRef.current = null;
          await saveSession();
          bumpSessionMeta();
        }
        return;
      }

      const textToImageIntent = detectTextToImageIntent(trimmed);
      if (textToImageIntent) {
        setHistory((h) => [...h, { kind: "user", text: trimmed }]);
        if (textToImageIntent.source !== "slash") {
          setHistory((h) => [
            ...h,
            {
              kind: "system",
              text: `识别为文生图请求（${textToImageIntent.source}），已路由到 capabilityMapping["text-to-image"]。若误判请改写描述或使用 /ask 前缀。`,
            },
          ]);
        }

        if (options.mcpActivateForPrompt) {
          try {
            await options.mcpActivateForPrompt(
              trimmed,
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

        const prompt =
          textToImageIntent.prompt.trim().length > 0
            ? textToImageIntent.prompt.trim()
            : DEFAULT_TEXT_TO_IMAGE_PROMPT;
        const savePath = textToImageIntent.savePath?.trim();
        const inputPayload = buildTextToImageInputEnvelope(prompt, "cli-chat");

        const startTime = Date.now();
        turnStartAtRef.current = startTime;
        controllerRef.current = new AbortController();
        runningRef.current = true;
        setRunning(true);

        const context = {
          requestId: randomUUID(),
          sessionId: sessionHolder.current.session.id,
          traceId: randomUUID(),
          principal: {},
          budget: {},
          scopes: ["*"],
          startedAt: startTime,
        };

        try {
          let finalOutput: EngineOutput | undefined;
          for await (const chunk of engine.runStream(inputPayload, context)) {
            renderer.render(chunk);
            if (chunk.type === "done") {
              finalOutput = chunk.output;
            }
          }

          if (finalOutput) {
            renderer.finalize(finalOutput, "text");
            const s = sessionHolder.current.session;
            s.budget.tokensUsed += finalOutput.metadata.tokenUsage.total;
            s.budget.toolCallsUsed += finalOutput.metadata.toolCalls.length;
            s.budget.wallTimeMs += finalOutput.metadata.durationMs;

            const snap = renderer.getSnapshot();
            const body = snap.assistantRaw.trim();
            if (body.length > 0) {
              setHistory((h) => [...h, { kind: "assistant", text: body }]);
            }
            renderer.resetAfterTurn();

            if (savePath && savePath.length > 0) {
              const images = finalOutput.metadata.generatedImages ?? [];
              if (images.length === 0) {
                setHistory((h) => [
                  ...h,
                  {
                    kind: "system",
                    text: `未生成任何图片，--save/保存路径 '${savePath}' 已忽略。`,
                  },
                ]);
              } else {
                try {
                  const records = await saveGeneratedImages({
                    cwd: process.cwd(),
                    images,
                    target: savePath,
                    signal: controllerRef.current?.signal ?? undefined,
                  });
                  for (const rec of records) {
                    if (rec.error) {
                      setHistory((h) => [
                        ...h,
                        {
                          kind: "system",
                          text: `保存失败：${rec.source} → ${rec.path}（${rec.error}）`,
                        },
                      ]);
                    } else {
                      setHistory((h) => [
                        ...h,
                        {
                          kind: "system",
                          text: `已保存：${rec.path}（${rec.bytes} bytes）`,
                        },
                      ]);
                    }
                  }
                } catch (err) {
                  setHistory((h) => [
                    ...h,
                    {
                      kind: "system",
                      text: `保存图片失败：${(err as Error).message}`,
                    },
                  ]);
                }
              }
            }
          }
        } catch (err) {
          runningRef.current = false;
          setRunning(false);
          process.stderr.write(colorize(`错误：${(err as Error).message}\n`, "red"));
          setHistory((h) => [
            ...h,
            { kind: "system", text: `错误：${(err as Error).message}` },
          ]);
        } finally {
          runningRef.current = false;
          setRunning(false);
          controllerRef.current = null;
          await saveSession();
          bumpSessionMeta();
        }
        return;
      }

      if (trimmed.startsWith("/")) {
        const ctx: SlashContext = {
          sessionHolder: sessionHolder.current,
          store,
          memorySystem,
          messageCountFor,
          loadHistory,
          saveSession,
        };
        const slashLines: string[] = [];
        const sink = {
          emit: (text: string) => {
            slashLines.push(text);
          },
        };
        const result = await executeSlashCommand(trimmed, ctx, sink);
        setSessionView(sessionHolder.current.session.id);
        bumpSessionMeta();
        if (slashLines.length > 0) {
          setHistory((h) => [
            ...h,
            { kind: "slash", text: slashLines.join("") },
          ]);
        }
        if (result === "exit") {
          try {
            await saveSession();
          } catch {
            /* ignore */
          }
          onExit();
        }
        return;
      }

      setHistory((h) => [...h, { kind: "user", text: trimmed }]);

      if (options.mcpActivateForPrompt) {
        try {
          await options.mcpActivateForPrompt(
            trimmed,
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

      const startTime = Date.now();
      turnStartAtRef.current = startTime;
      controllerRef.current = new AbortController();
      runningRef.current = true;
      setRunning(true);

      const context = {
        requestId: randomUUID(),
        sessionId: sessionHolder.current.session.id,
        traceId: randomUUID(),
        principal: {},
        budget: {},
        scopes: ["*"],
        startedAt: startTime,
      };

      const inputPayload = {
        content: trimmed,
        metadata: { modality: "text", source: "cli-chat" },
      };

      let finalOutput: EngineOutput | undefined;

      try {
        for await (const chunk of engine.runStream(inputPayload, context)) {
          renderer.render(chunk);
          if (chunk.type === "done") {
            finalOutput = chunk.output;
          }
        }

        if (finalOutput) {
          renderer.finalize(finalOutput, "text");
          const s = sessionHolder.current.session;
          s.budget.tokensUsed += finalOutput.metadata.tokenUsage.total;
          s.budget.toolCallsUsed += finalOutput.metadata.toolCalls.length;
          s.budget.wallTimeMs += finalOutput.metadata.durationMs;

          const snap = renderer.getSnapshot();
          const body = snap.assistantRaw.trim();
          if (body.length > 0) {
            setHistory((h) => [...h, { kind: "assistant", text: body }]);
          }
          renderer.resetAfterTurn();
        }
      } catch (err) {
        runningRef.current = false;
        setRunning(false);
        if ((err as Error)?.name === "AbortError" || (err as { aborted?: boolean }).aborted) {
          return;
        }
        process.stderr.write(colorize(`错误：${(err as Error).message}\n`, "red"));
        setHistory((h) => [
          ...h,
          { kind: "system", text: `错误：${(err as Error).message}` },
        ]);
      } finally {
        runningRef.current = false;
        setRunning(false);
        controllerRef.current = null;
        await saveSession();
        bumpSessionMeta();
      }
    },
    [
      debug,
      engine,
      loadHistory,
      memorySystem,
      messageCountFor,
      options.mcpActivateForPrompt,
      renderer,
      saveSession,
      store,
      onExit,
    ],
  );

  const onSubmitLine = useCallback(
    (value: string) => {
      void runOneTurn(value);
      setInput("");
    },
    [runOneTurn],
  );

  const renderMd = renderer.renderMarkdown;

  const progressLogLines = useMemo(() => viewState.logLines.slice(-5), [viewState.logLines]);

  const bodySource = useMemo(
    () => buildBodySourceText(history, viewState.assistantRaw, renderMd),
    [history, viewState.assistantRaw, renderMd],
  );

  const bodyLines = useMemo(() => bodySource.split("\n"), [bodySource]);

  /**
   * 估算 footer 行数（用于正文 slice），与真实渲染接近；Ink 里不用固定 height 撑 footer，避免中间留白。
   */
  const footerBudgetRows = useMemo(() => {
    const logRows = Math.min(progressLogLines.length, 5);
    const intrinsic =
      1 +
      logRows +
      (progressLogLines.length > 0 ? 1 : 0) +
      (viewState.agent === "error" ? 1 : 0) +
      1 +
      (pendingApproval ? 1 : 0) +
      2 +
      1;
    return Math.min(24, Math.max(6, Math.min(intrinsic, dims.rows - 6)));
  }, [
    dims.rows,
    progressLogLines.length,
    viewState.agent,
    pendingApproval,
  ]);

  const bodyHeightRows = useMemo(
    () => Math.max(6, dims.rows - footerBudgetRows),
    [dims.rows, footerBudgetRows],
  );

  const bodyMaxLines = bodyHeightRows;

  const maxScroll = Math.max(0, bodyLines.length - bodyMaxLines);
  const clampedOffset = Math.min(scrollOffset, maxScroll);
  const windowStart = Math.max(0, bodyLines.length - bodyMaxLines - clampedOffset);
  const bodyDisplay = useMemo(
    () => bodyLines.slice(windowStart, windowStart + bodyMaxLines).join("\n"),
    [bodyLines, windowStart, bodyMaxLines],
  );

  const scrollStep = Math.max(3, Math.floor(bodyMaxLines / 3));

  useLayoutEffect(() => {
    scrollRef.current = { maxScroll, step: scrollStep };
  }, [maxScroll, scrollStep]);

  useEffect(() => {
    setScrollOffset((o) => Math.min(o, maxScroll));
  }, [maxScroll]);

  useEffect(() => {
    if (running) {
      setScrollOffset(0);
    }
  }, [running]);

  /** 运行中每 100ms 刷新一次，使底部耗时条近实时递增 */
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => {
      setWallTick((t) => t + 1);
    }, 100);
    return () => {
      clearInterval(id);
    };
  }, [running]);

  const showSpinner = viewState.agent === "thinking" && !viewState.doneSummary;
  const progressSpinActive = running || showSpinner;

  const sessionBudget = sessionHolder.current.session.budget;

  const detailBarLine = useMemo(() => {
    const prov = options.provider ?? "route";
    const model = options.model ?? "default";
    const live = viewState.liveUsage;
    const useLive = running && live !== undefined;
    const tok = useLive ? sessionBudget.tokensUsed + live.tokens : sessionBudget.tokensUsed;
    const tools = useLive
      ? sessionBudget.toolCallsUsed + live.toolCalls
      : sessionBudget.toolCallsUsed;
    const wallMs = running
      ? Math.max(0, Date.now() - turnStartAtRef.current)
      : sessionBudget.wallTimeMs;
    const wallLabel = formatWallDisplay(wallMs);
    return `Tachu · ${prov} / ${model} · tok ${formatTokensK(tok)} · tools ${tools} · ${wallLabel}`;
  }, [
    options.provider,
    options.model,
    sessionBudget.tokensUsed,
    sessionBudget.toolCallsUsed,
    sessionBudget.wallTimeMs,
    running,
    viewState.liveUsage,
    wallTick,
  ]);

  const hintLine = useMemo(() => {
    const sid = sessionView.length > 12 ? `${sessionView.slice(0, 8)}…` : sessionView;
    return `session ${sid} · Ctrl+C 取消/连按退出 · ↑/↓ 或 PgUp/PgDn 翻阅上文（终端内无鼠标滚轮） · /help · --readline`;
  }, [sessionView]);

  const inputFocused = !running && !pendingApproval;

  return (
    <Box flexDirection="column" width={dims.cols} height={dims.rows}>
      {/* body：占满 footer 之上的空间，底对齐；行数预算由 bodyHeightRows 与 slice 对齐 */}
      <Box
        flexDirection="column"
        justifyContent="flex-end"
        flexGrow={1}
        flexShrink={1}
        minHeight={6}
        paddingX={0}
      >
        <Text wrap="wrap">{bodyDisplay}</Text>
      </Box>

      {/* footer：自然高度，禁止在列内 flexGrow 占位（此前会在进度与详情条间出现大块空白） */}
      <Box flexDirection="column" flexShrink={0}>
        {/* 块 1：左侧 spin + 阶段与日志（可占多行） */}
        <Box flexDirection="row" flexShrink={0} paddingX={0} alignItems="flex-start">
          <Box marginRight={1} flexShrink={0} minWidth={2}>
            {progressSpinActive ? (
              <Text color="gray">
                <Spinner type="dots" />
              </Text>
            ) : (
              <Text> </Text>
            )}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {showSpinner ? (
              <Text color="gray">{viewState.statusLine || "…"}</Text>
            ) : (
              <Text color="cyan" dimColor>
                {viewState.doneSummary ?? viewState.statusLine ?? " "}
              </Text>
            )}
            {progressLogLines.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                {progressLogLines.map((line, i) => (
                  <Text key={i} color="gray" wrap="wrap">
                    {line}
                  </Text>
                ))}
              </Box>
            ) : null}
            {viewState.agent === "error" ? (
              <Text color="red">状态：error</Text>
            ) : null}
          </Box>
        </Box>

        {/* 块 2：详情条（参考 IDE 底部状态：模型 / token / 耗时） */}
        <Box flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1} marginTop={0}>
          <Text dimColor wrap="truncate">
            {detailBarLine}
          </Text>
        </Box>

        {/* 块 3：审批 + 输入 */}
        <Box flexDirection="column" flexShrink={0} marginTop={0}>
          {pendingApproval ? (
            <Box marginBottom={0} paddingX={0}>
              <Text color="yellow">{pendingApproval.query.trimEnd()}</Text>
              <Text dimColor> [y/N]</Text>
            </Box>
          ) : null}
          <Box flexDirection="row" flexWrap="wrap">
            <Text bold color="cyan">
              you{running ? " (运行中…)" : ""}
              {"> "}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmitLine}
              focus={inputFocused}
              placeholder="输入消息或 /help"
            />
          </Box>
        </Box>

        {/* 块 4：快捷键提示 */}
        <Box flexShrink={0} marginTop={0} paddingX={0}>
          <Text dimColor wrap="wrap">
            {hintLine}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Ink 全屏交互式 chat（默认路径，TTY 下）。
 */
export async function runInteractiveChatInk(
  engine: Engine,
  store: FsSessionStore,
  options: InteractiveChatOptions = {},
): Promise<void> {
  const bridge = new InkApprovalBridge();

  await new Promise<void>((resolveExit) => {
    const { unmount } = render(
      <InkChatRoot
        engine={engine}
        store={store}
        options={options}
        bridge={bridge}
        onExit={() => {
          unmount();
          resetTerminalAnsi();
          resolveExit();
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
