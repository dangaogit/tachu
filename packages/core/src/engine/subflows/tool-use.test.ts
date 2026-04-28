import { describe, expect, test } from "bun:test";
import { ToolLoopError } from "../../errors";
import { DefaultModelRouter } from "../../modules/model-router";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import { InMemoryMemorySystem } from "../../modules/memory";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ProviderAdapter,
} from "../../modules/provider";
import { DescriptorRegistry } from "../../registry";
import { createTiktokenTokenizer } from "../../prompt";
import type { EngineConfig, Message } from "../../types";
import type { AdapterCallContext } from "../../types/context";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import { createDefaultEngineConfig } from "../../utils";
import { InMemoryVectorStore } from "../../vector";
import { executeToolUse, TOOL_USE_CONSTANTS, type ToolUseContext } from "./tool-use";

/**
 * 脚手架：按顺序返回预设响应的 Provider，用于驱动 Agentic Loop。
 *
 * 每次 `chat()` 调用会弹出 `responses` 中的下一条；不支持 stream（tool-use 仅走 chat）。
 */
const createScriptedProvider = (responses: ChatResponse[]): {
  adapter: ProviderAdapter;
  calls: Array<{ messages: Message[]; toolsCount: number }>;
} => {
  const calls: Array<{ messages: Message[]; toolsCount: number }> = [];
  let cursor = 0;
  const adapter: ProviderAdapter = {
    id: "scripted",
    name: "scripted",
    async listAvailableModels() {
      return [
        {
          modelName: "scripted-chat",
          capabilities: {
            supportedModalities: ["text"],
            maxContextTokens: 128_000,
            supportsStreaming: true,
            supportsFunctionCalling: true,
          },
        },
      ];
    },
    async chat(req: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
      calls.push({
        messages: req.messages.map((m) => ({ ...m })),
        toolsCount: req.tools?.length ?? 0,
      });
      const response = responses[cursor];
      if (!response) {
        throw new Error(`scripted provider 没有更多响应 (已用 ${cursor})`);
      }
      cursor += 1;
      return response;
    },
    async *chatStream(
      _req: ChatRequest,
      _ctx: AdapterCallContext,
    ): AsyncIterable<ChatStreamChunk> {
      yield { type: "finish", finishReason: "stop" };
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  };
  return { adapter, calls };
};

/**
 * 创建一个带 `high-reasoning` 映射的最小 EngineConfig。
 */
const baseConfig = (overrides?: Partial<EngineConfig["runtime"]["toolLoop"]>): EngineConfig => {
  const config = createDefaultEngineConfig();
  config.models.capabilityMapping = {
    "high-reasoning": { provider: "scripted", model: "scripted-model" },
    intent: { provider: "scripted", model: "scripted-model" },
    "fast-cheap": { provider: "scripted", model: "scripted-model" },
  };
  config.runtime.toolLoop = {
    maxSteps: 3,
    parallelism: 2,
    requireApprovalGlobal: false,
    ...overrides,
  };
  return config;
};

const noopUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * 构造完整的 `ToolUseContext`；`taskExecutorOverride` 允许测试注入自定义执行器。
 */
const buildCtx = (args: {
  config: EngineConfig;
  provider: ProviderAdapter;
  toolSet?: Array<{
    name: string;
    description?: string;
    timeout?: number;
    requiresApproval?: boolean;
    sideEffect?: "readonly" | "write" | "irreversible";
  }>;
  taskExecutor: ToolUseContext["taskExecutor"];
  abortSignal?: AbortSignal;
  onToolLoopEvent?: ToolUseContext["onToolLoopEvent"];
  onToolCall?: ToolUseContext["onToolCall"];
}): ToolUseContext => {
  const { config, provider, taskExecutor } = args;
  const providers = new Map([[provider.id, provider]]);
  const modelRouter = new DefaultModelRouter(config);
  const vectorStore = new InMemoryVectorStore({
    indexLimit: config.memory.vectorIndexLimit,
  });
  const registry = new DescriptorRegistry({ vectorStore });
  for (const tool of args.toolSet ?? []) {
    void registry.register({
      kind: "tool",
      name: tool.name,
      description: tool.description ?? `${tool.name} 测试用工具`,
      sideEffect: tool.sideEffect ?? "readonly",
      idempotent: true,
      requiresApproval: tool.requiresApproval ?? false,
      timeout: tool.timeout ?? 5_000,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      execute: "<test-stub>",
    });
  }
  const tokenizer = createTiktokenTokenizer("gpt-4o-mini");
  const memorySystem = new InMemoryMemorySystem(
    config,
    tokenizer,
    modelRouter,
    providers,
    vectorStore,
  );
  const observability = new DefaultObservabilityEmitter();
  const signal = args.abortSignal ?? new AbortController().signal;
  return {
    config,
    providers,
    modelRouter,
    memorySystem,
    observability,
    registry,
    taskExecutor,
    executionContext: {
      requestId: "req-1",
      sessionId: "session-1",
      traceId: "trace-1",
      principal: {},
      budget: {},
      scopes: [],
    },
    signal,
    traceId: "trace-1",
    sessionId: "session-1",
    adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    prebuiltPrompt: {
      messages: [
        { role: "system", content: "[assembler] global system instruction" },
        { role: "user", content: "帮我列一下当前目录并告诉我最重要的文件" },
      ],
      tools: (args.toolSet ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? `${t.name} 测试用工具`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      })),
      tokenCount: 0,
      appliedCuts: [],
    },
    onProviderUsage: () => {},
    ...(args.onToolLoopEvent ? { onToolLoopEvent: args.onToolLoopEvent } : {}),
    ...(args.onToolCall ? { onToolCall: args.onToolCall } : {}),
  };
};

describe("executeToolUse (ADR-0002 Agentic Loop)", () => {
  test("第一轮直接 stop → 返回模型回复文本", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "  这是第一轮就给出的最终回复  ",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => {
        throw new Error("taskExecutor 不应被调用");
      },
    });
    const result = await executeToolUse({ prompt: "...prompt..." }, ctx);
    expect(result).toBe("这是第一轮就给出的最终回复");
    expect(calls.length).toBe(1);
    expect(calls[0]?.toolsCount).toBe(1);
  });

  test("两轮循环：tool_calls → 工具执行 → 终止 stop", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-1",
            name: "list-dir",
            arguments: { path: "." },
          },
        ],
        usage: noopUsage,
      },
      {
        content: "我已经列出目录，核心文件是 package.json。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const executed: Array<{ ref: string; input: unknown }> = [];
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async (task) => {
        executed.push({ ref: task.ref, input: task.input });
        return { entries: ["package.json", "README.md"] };
      },
    });

    const events: string[] = [];
    const toolCalls: Array<{ name: string; success: boolean }> = [];
    ctx.onToolLoopEvent = (chunk): void => {
      events.push(chunk.type);
    };
    ctx.onToolCall = (record): void => {
      toolCalls.push({ name: record.name, success: record.success });
    };

    const result = await executeToolUse({ prompt: "列目录" }, ctx);
    expect(result).toBe("我已经列出目录，核心文件是 package.json。");
    expect(calls.length).toBe(2);
    expect(executed.length).toBe(1);
    expect(executed[0]?.ref).toBe("list-dir");

    // tool 消息应作为第二轮的对话上下文之一
    const secondCall = calls[1];
    expect(secondCall).toBeDefined();
    const toolMessages = secondCall!.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0]?.toolCallId).toBe("call-1");

    // 事件序列（顺序无关紧要但必须都出现）
    expect(events).toContain("tool-loop-step");
    expect(events).toContain("tool-call-start");
    expect(events).toContain("tool-call-end");
    expect(events).toContain("tool-loop-final");
    expect(toolCalls).toEqual([{ name: "list-dir", success: true }]);
  });

  test("LLM 请求未注册的工具 → 不中断，把错误作为 tool message 回传", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c-1", name: "non-existent-tool", arguments: {} },
        ],
        usage: noopUsage,
      },
      {
        content: "该工具不可用，改为基于通用知识回答：xxx。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => {
        throw new Error("未注册工具不应进入 taskExecutor");
      },
    });
    const onToolCallRecords: Array<{ name: string; errorCode?: string }> = [];
    ctx.onToolCall = (record) => {
      onToolCallRecords.push({
        name: record.name,
        ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      });
    };

    const result = await executeToolUse({ prompt: "x" }, ctx);
    expect(result).toContain("该工具不可用");
    expect(calls.length).toBe(2);
    // 第二轮 tool message content 里带错误提示
    const toolMessage = calls[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(typeof toolMessage?.content === "string" && toolMessage.content).toContain(
      "未在 registry 中注册",
    );
    expect(onToolCallRecords).toEqual([
      { name: "non-existent-tool", errorCode: "TOOL_LOOP_UNKNOWN_TOOL" },
    ]);
  });

  test("taskExecutor 抛错 → tool message 含错误提示，不中断循环", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "list-dir", arguments: {} }],
        usage: noopUsage,
      },
      {
        content: "工具失败；已降级回答。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => {
        throw new Error("disk is full");
      },
    });

    const result = await executeToolUse({ prompt: "x" }, ctx);
    expect(result).toBe("工具失败；已降级回答。");
    expect(calls.length).toBe(2);
    const toolMessage = calls[1]?.messages.find((m) => m.role === "tool");
    expect(typeof toolMessage?.content === "string" && toolMessage.content).toContain(
      "disk is full",
    );
  });

  test("超过 maxSteps → 抛 TOOL_LOOP_STEPS_EXHAUSTED", async () => {
    // 每一轮都返回 tool_calls，never stop。
    const { adapter } = createScriptedProvider(
      Array.from({ length: 5 }, (_, i) => ({
        content: "",
        finishReason: "tool_calls" as const,
        toolCalls: [{ id: `c-${i}`, name: "list-dir", arguments: {} }],
        usage: noopUsage,
      })),
    );
    const ctx = buildCtx({
      config: baseConfig({ maxSteps: 2 }),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => ({ ok: true }),
    });

    await expect(executeToolUse({ prompt: "x" }, ctx)).rejects.toMatchObject({
      code: "TOOL_LOOP_STEPS_EXHAUSTED",
    });
  });

  test("首轮空 content 且无 toolCalls → TOOL_LOOP_PROVIDER_NO_RESPONSE", async () => {
    const { adapter } = createScriptedProvider([
      { content: "", finishReason: "stop", usage: noopUsage },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => ({}),
    });

    await expect(executeToolUse({ prompt: "x" }, ctx)).rejects.toMatchObject({
      code: "TOOL_LOOP_PROVIDER_NO_RESPONSE",
    });
  });

  test("非首轮空 content → TOOL_LOOP_EMPTY_TERMINAL_RESPONSE", async () => {
    const { adapter } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c", name: "list-dir", arguments: {} }],
        usage: noopUsage,
      },
      { content: "", finishReason: "stop", usage: noopUsage },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => "ok",
    });

    await expect(executeToolUse({ prompt: "x" }, ctx)).rejects.toMatchObject({
      code: "TOOL_LOOP_EMPTY_TERMINAL_RESPONSE",
    });
  });

  test("provider.chat 抛错 → emit tool-use warning + tool-loop-final(success=false) 后重抛", async () => {
    // 模拟 gateway 返回 HTTP 402 / 401 / 429 等失败：adapter.chat 直接抛错。
    // 诉求：错误必须先进 observability（让 `.tachu/events.jsonl` 能定位根因），
    // 再冒泡到上层，避免 output phase 只能给出含糊 fallback。
    const failingAdapter: ProviderAdapter = {
      id: "scripted",
      name: "scripted",
      async listAvailableModels() {
        return [
          {
            modelName: "scripted-model",
            capabilities: {
              supportedModalities: ["text"],
              maxContextTokens: 128_000,
              supportsStreaming: true,
              supportsFunctionCalling: true,
            },
          },
        ];
      },
      async chat(_req: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
        throw new Error("402 status code (no body)");
      },
      async *chatStream(
        _req: ChatRequest,
        _ctx: AdapterCallContext,
      ): AsyncIterable<ChatStreamChunk> {
        yield { type: "finish", finishReason: "stop" };
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const ctx = buildCtx({
      config: baseConfig(),
      provider: failingAdapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => "ok",
    });

    const emitted: Array<{
      phase: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    ctx.observability.on("*", (event) => {
      emitted.push({ phase: event.phase, type: event.type, payload: event.payload });
    });
    const loopEvents: Array<{ type: string; success?: boolean }> = [];
    ctx.onToolLoopEvent = (chunk) => {
      loopEvents.push({
        type: chunk.type,
        ...(chunk.type === "tool-loop-final" ? { success: chunk.success } : {}),
      });
    };

    await expect(executeToolUse({ prompt: "x" }, ctx)).rejects.toThrow(
      "402 status code (no body)",
    );

    const warning = emitted.find(
      (e) => e.phase === "tool-use" && e.type === "warning",
    );
    expect(warning).toBeDefined();
    expect(warning?.payload).toMatchObject({
      provider: "scripted",
      step: 1,
      errorName: "Error",
    });
    expect(String(warning?.payload.message)).toContain("402");
    expect(String(warning?.payload.reason)).toContain("tool-use LLM call failed");

    // 失败也要合成一个 success=false 的 tool-loop-final（让上层能对账）
    const final = loopEvents.find((e) => e.type === "tool-loop-final");
    expect(final).toBeDefined();
    expect(final?.success).toBe(false);
  });

  test("并发 parallelism=2 正确分批多工具", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", name: "list-dir", arguments: { a: 1 } },
          { id: "c2", name: "list-dir", arguments: { a: 2 } },
          { id: "c3", name: "list-dir", arguments: { a: 3 } },
        ],
        usage: noopUsage,
      },
      { content: "三个工具全部完成。", finishReason: "stop", usage: noopUsage },
    ]);
    let concurrent = 0;
    let maxConcurrent = 0;
    const ctx = buildCtx({
      config: baseConfig({ parallelism: 2 }),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return "ok";
      },
    });

    const result = await executeToolUse({ prompt: "x" }, ctx);
    expect(result).toBe("三个工具全部完成。");
    expect(calls.length).toBe(2);
    expect(maxConcurrent).toBe(2);
    // 第二轮里必须有 3 条 tool message，且顺序与 toolCalls 对应
    const toolMsgs = calls[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(3);
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
  });

  test("input.prompt 缺失 → 抛显式错误（非 ToolLoopError）", async () => {
    const { adapter } = createScriptedProvider([]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => ({}),
    });

    await expect(
      executeToolUse({ prompt: "" } as never, ctx),
    ).rejects.toThrow(/缺少必填字段 input.prompt/);
  });

  test("prebuiltPrompt.messages 为空时走 fallback 组装，仍能单轮 stop", async () => {
    const { adapter, calls } = createScriptedProvider([
      { content: "OK", finishReason: "stop", usage: noopUsage },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => ({}),
    });
    ctx.prebuiltPrompt = {
      messages: [],
      tools: ctx.prebuiltPrompt.tools,
      tokenCount: 0,
      appliedCuts: [],
    };

    const result = await executeToolUse({ prompt: "fallback-test" }, ctx);
    expect(result).toBe("OK");
    expect(calls.length).toBe(1);
    // fallback 组装会塞入 system + user；确认 user 消息是本轮 prompt
    const userMsg = calls[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("fallback-test");
  });

  test("ToolLoopError 可从 errors 模块导入并匹配错误码", () => {
    // 保证 barrel 导出路径正确（防止重构时漏掉 ToolLoopError）
    expect(ToolLoopError.stepsExhausted(3).code).toBe("TOOL_LOOP_STEPS_EXHAUSTED");
    expect(ToolLoopError.emptyTerminalResponse().code).toBe(
      "TOOL_LOOP_EMPTY_TERMINAL_RESPONSE",
    );
    expect(ToolLoopError.unknownTool("t").code).toBe("TOOL_LOOP_UNKNOWN_TOOL");
    expect(ToolLoopError.toolExecutionFailed("t").code).toBe(
      "TOOL_LOOP_TOOL_EXECUTION_FAILED",
    );
    expect(ToolLoopError.providerNoResponse().code).toBe(
      "TOOL_LOOP_PROVIDER_NO_RESPONSE",
    );
    expect(ToolLoopError.approvalDenied("t", "user").code).toBe(
      "TOOL_LOOP_APPROVAL_DENIED",
    );
  });

  test("approval: 描述符 requiresApproval=true 触发回调 → 通过后正常执行", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "write-file", arguments: { path: "/tmp/x" } }],
        usage: noopUsage,
      },
      {
        content: "写入完成。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const approvalSeen: string[] = [];
    let executed = false;
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "write-file", requiresApproval: true, sideEffect: "write" }],
      taskExecutor: async () => {
        executed = true;
        return { ok: true };
      },
    });
    ctx.onBeforeToolCall = async (request) => {
      approvalSeen.push(request.triggeredBy);
      expect(request.tool).toBe("write-file");
      expect(request.sideEffect).toBe("write");
      expect(request.requiresApproval).toBe(true);
      return { type: "approve" };
    };

    const result = await executeToolUse({ prompt: "写文件" }, ctx);
    expect(result).toBe("写入完成。");
    expect(approvalSeen).toEqual(["descriptor"]);
    expect(executed).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("approval: 回调 deny → 合成拒绝 tool message；errorCode = TOOL_LOOP_APPROVAL_DENIED", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "dangerous", arguments: {} }],
        usage: noopUsage,
      },
      {
        content: "好的，我改用只读方式描述结果。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "dangerous", requiresApproval: true, sideEffect: "irreversible" }],
      taskExecutor: async () => {
        throw new Error("被拒绝的工具不应进入 taskExecutor");
      },
    });
    const toolCallEvents: Array<{ success: boolean; errorMessage?: string }> = [];
    ctx.onToolLoopEvent = (chunk) => {
      if (chunk.type === "tool-call-end") {
        toolCallEvents.push({
          success: chunk.success,
          ...(chunk.errorMessage !== undefined
            ? { errorMessage: chunk.errorMessage }
            : {}),
        });
      }
    };
    const toolCallRecords: Array<{ name: string; errorCode?: string }> = [];
    ctx.onToolCall = (record) => {
      toolCallRecords.push({
        name: record.name,
        ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      });
    };
    ctx.onBeforeToolCall = async () => ({
      type: "deny",
      reason: "该操作过于危险，请改用只读方式",
    });

    const result = await executeToolUse({ prompt: "do danger" }, ctx);
    expect(result).toBe("好的，我改用只读方式描述结果。");
    expect(calls.length).toBe(2);

    const secondCall = calls[1];
    expect(secondCall).toBeDefined();
    const toolMsg = secondCall!.messages.find((m) => m.role === "tool");
    expect(typeof toolMsg?.content === "string" && toolMsg.content).toContain(
      "已被用户拒绝",
    );
    expect(typeof toolMsg?.content === "string" && toolMsg.content).toContain(
      "该操作过于危险",
    );

    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]?.success).toBe(false);
    expect(toolCallRecords).toEqual([
      { name: "dangerous", errorCode: "TOOL_LOOP_APPROVAL_DENIED" },
    ]);
  });

  test("approval: 全局 requireApprovalGlobal=true 即使描述符未要求也会触发", async () => {
    const { adapter } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "list-dir", arguments: {} }],
        usage: noopUsage,
      },
      { content: "列好了。", finishReason: "stop", usage: noopUsage },
    ]);
    const ctx = buildCtx({
      config: baseConfig({ requireApprovalGlobal: true }),
      provider: adapter,
      toolSet: [{ name: "list-dir", requiresApproval: false }],
      taskExecutor: async () => ({ ok: true }),
    });
    const seen: Array<{ trigger: string; requiresApproval: boolean }> = [];
    ctx.onBeforeToolCall = async (req) => {
      seen.push({ trigger: req.triggeredBy, requiresApproval: req.requiresApproval });
      return { type: "approve" };
    };
    const result = await executeToolUse({ prompt: "x" }, ctx);
    expect(result).toBe("列好了。");
    expect(seen).toEqual([{ trigger: "global", requiresApproval: false }]);
  });

  test("approval: 未注入回调时默认批准（保持旧行为）", async () => {
    const { adapter } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "list-dir", arguments: {} }],
        usage: noopUsage,
      },
      { content: "默认批准走通。", finishReason: "stop", usage: noopUsage },
    ]);
    let executed = false;
    const ctx = buildCtx({
      config: baseConfig({ requireApprovalGlobal: true }),
      provider: adapter,
      toolSet: [{ name: "list-dir", requiresApproval: true }],
      taskExecutor: async () => {
        executed = true;
        return { ok: true };
      },
    });
    const result = await executeToolUse({ prompt: "x" }, ctx);
    expect(result).toBe("默认批准走通。");
    expect(executed).toBe(true);
  });

  test("approval: 回调抛异常 → 视作拒绝", async () => {
    const { adapter } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "dangerous", arguments: {} }],
        usage: noopUsage,
      },
      { content: "已放弃。", finishReason: "stop", usage: noopUsage },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "dangerous", requiresApproval: true }],
      taskExecutor: async () => {
        throw new Error("不应被调用");
      },
    });
    ctx.onBeforeToolCall = async () => {
      throw new Error("prompt IO 崩了");
    };
    const result = await executeToolUse({ prompt: "x" }, ctx);
    expect(result).toBe("已放弃。");
  });

  test("approval 通过后 → 把 approvalGranted=true 写入 TaskNode.metadata", async () => {
    const { adapter } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c-1", name: "write-file", arguments: { path: "/tmp/x" } },
        ],
        usage: noopUsage,
      },
      { content: "写入完成。", finishReason: "stop", usage: noopUsage },
    ]);
    const capturedMetadata: Array<Record<string, unknown> | undefined> = [];
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "write-file", requiresApproval: true, sideEffect: "write" }],
      taskExecutor: async (task) => {
        capturedMetadata.push(task.metadata);
        return { ok: true };
      },
    });
    ctx.onBeforeToolCall = async () => ({ type: "approve" });

    await executeToolUse({ prompt: "写文件" }, ctx);
    expect(capturedMetadata).toHaveLength(1);
    expect(capturedMetadata[0]).toEqual({ approvalGranted: true });
  });

  test("无需审批的工具 → TaskNode.metadata 不应携带 approvalGranted", async () => {
    const { adapter } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "list-dir", arguments: {} }],
        usage: noopUsage,
      },
      { content: "列好了。", finishReason: "stop", usage: noopUsage },
    ]);
    const capturedMetadata: Array<Record<string, unknown> | undefined> = [];
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir", requiresApproval: false, sideEffect: "readonly" }],
      taskExecutor: async (task) => {
        capturedMetadata.push(task.metadata);
        return { ok: true };
      },
    });

    await executeToolUse({ prompt: "x" }, ctx);
    expect(capturedMetadata).toHaveLength(1);
    expect(capturedMetadata[0]?.approvalGranted).toBeUndefined();
  });

  test("tool output 超过 MAX_TOOL_OUTPUT_CHARS → 自动截断并追加截断提示", async () => {
    const oversized = "A".repeat(TOOL_USE_CONSTANTS.MAX_TOOL_OUTPUT_CHARS + 5_000);
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "fetch-url", arguments: { url: "https://x" } }],
        usage: noopUsage,
      },
      {
        content: "基于抓到的内容给出摘要。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "fetch-url" }],
      taskExecutor: async () => oversized,
    });

    const result = await executeToolUse({ prompt: "summarise" }, ctx);
    expect(result).toBe("基于抓到的内容给出摘要。");

    // 第二轮 chat 里，tool role message 的 content 必须被截断到 MAX_TOOL_OUTPUT_CHARS + 提示长度
    const secondCall = calls[1];
    expect(secondCall).toBeDefined();
    const toolMsg = secondCall!.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(typeof toolMsg!.content === "string").toBe(true);
    const content = toolMsg!.content as string;
    expect(content.length).toBeGreaterThan(TOOL_USE_CONSTANTS.MAX_TOOL_OUTPUT_CHARS);
    expect(content.length).toBeLessThanOrEqual(
      TOOL_USE_CONSTANTS.MAX_TOOL_OUTPUT_CHARS + 200,
    );
    expect(content).toContain("[工具输出已截断");
    expect(content).toContain(String(oversized.length));
    expect(content.startsWith("A")).toBe(true);
  });

  test("tool output 为对象且 JSON.stringify 后超限 → 同样按字符上限裁剪", async () => {
    const bigJsonPayload = { items: Array.from({ length: 5_000 }, (_, i) => `item-${i}-xxxxxxxx`) };
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "list-items", arguments: {} }],
        usage: noopUsage,
      },
      {
        content: "这是摘要。",
        finishReason: "stop",
        usage: noopUsage,
      },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-items" }],
      taskExecutor: async () => bigJsonPayload,
    });

    const result = await executeToolUse({ prompt: "list" }, ctx);
    expect(result).toBe("这是摘要。");

    const secondCall = calls[1];
    expect(secondCall).toBeDefined();
    const toolMsg = secondCall!.messages.find((m) => m.role === "tool");
    const content = toolMsg!.content as string;
    expect(content.length).toBeLessThanOrEqual(
      TOOL_USE_CONSTANTS.MAX_TOOL_OUTPUT_CHARS + 200,
    );
    expect(content).toContain("[工具输出已截断");
    // 截断前半段必须是合法的 JSON 前缀（以 `{` 开头，包含 items 关键字）
    expect(content.startsWith("{")).toBe(true);
    expect(content).toContain('"items"');
  });

  test("tool output 小于上限 → 原样透传（无截断提示）", async () => {
    const { adapter, calls } = createScriptedProvider([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c-1", name: "list-dir", arguments: {} }],
        usage: noopUsage,
      },
      { content: "done.", finishReason: "stop", usage: noopUsage },
    ]);
    const ctx = buildCtx({
      config: baseConfig(),
      provider: adapter,
      toolSet: [{ name: "list-dir" }],
      taskExecutor: async () => ({ entries: ["a.txt", "b.ts"] }),
    });
    await executeToolUse({ prompt: "ls" }, ctx);

    const secondCall = calls[1];
    const toolMsg = secondCall!.messages.find((m) => m.role === "tool");
    const content = toolMsg!.content as string;
    expect(content).not.toContain("[工具输出已截断");
    expect(content).toContain("a.txt");
    expect(content).toContain("b.ts");
  });
});
