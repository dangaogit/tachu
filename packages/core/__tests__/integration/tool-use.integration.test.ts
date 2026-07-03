import { describe, expect, test } from "bun:test";
import {
  DefaultObservabilityEmitter,
  DescriptorRegistry,
  Engine,
  InMemorySessionManager,
  InMemoryVectorStore,
  type AdapterCallContext,
  type ChatFinishReason,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type ChatUsage,
  type EngineConfig,
  type EngineEvent,
  type Message,
  type ModelInfo,
  type ProviderAdapter,
  type StreamChunk,
  type ToolCallRequest,
  type ToolDescriptor,
} from "../../src";

/**
 * 极简 MockProviderAdapter（测试内联，避免 @tachu/core 反向依赖 @tachu/extensions）。
 *
 * 行为与 `@tachu/extensions/providers/mock.ts` 中的脚本化 Provider 等价，按调用
 * 顺序依次消费 `replies`，用尽后退化为 `mock:<lastUserText>`。
 */
interface ScriptedReply {
  content?: string;
  toolCalls?: ToolCallRequest[];
  finishReason?: ChatFinishReason;
  usage?: ChatUsage;
}

class ScriptedMockProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly name = "ScriptedMock";
  private readonly replies: ScriptedReply[];
  private index = 0;

  constructor(replies: ScriptedReply[]) {
    this.replies = [...replies];
  }

  async listAvailableModels(): Promise<ModelInfo[]> {
    return [
      {
        modelName: "mock-chat",
        capabilities: {
          supportedModalities: ["text"],
          maxContextTokens: 8192,
          supportsStreaming: true,
          supportsFunctionCalling: true,
        },
      },
    ];
  }

  async chat(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const scripted = this.replies[this.index];
    if (scripted) {
      this.index += 1;
      return this.toResponse(scripted);
    }
    return this.defaultResponse(request);
  }

  async *chatStream(
    request: ChatRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const response = await this.chat(request, ctx, signal);
    for (const ch of response.content) yield { type: "text-delta", delta: ch };
    for (const call of response.toolCalls ?? []) {
      yield { type: "tool-call-complete", call };
    }
    yield {
      type: "finish",
      finishReason: response.finishReason ?? "stop",
      usage: response.usage,
    };
  }

  async countTokens(messages: Message[]): Promise<number> {
    return messages.reduce((sum, m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return sum + Math.ceil(text.length / 4);
    }, 0);
  }

  private toResponse(reply: ScriptedReply): ChatResponse {
    const content = reply.content ?? "";
    const toolCalls = reply.toolCalls && reply.toolCalls.length > 0 ? reply.toolCalls : undefined;
    const finishReason: ChatFinishReason =
      reply.finishReason ?? (toolCalls ? "tool_calls" : "stop");
    const usage: ChatUsage = reply.usage ?? {
      promptTokens: Math.ceil(content.length / 4),
      completionTokens: Math.ceil(content.length / 4),
      totalTokens: Math.ceil(content.length / 2),
    };
    return {
      content,
      ...(toolCalls ? { toolCalls } : {}),
      finishReason,
      usage,
    };
  }

  private defaultResponse(request: ChatRequest): ChatResponse {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const text =
      lastUser === undefined
        ? ""
        : typeof lastUser.content === "string"
          ? lastUser.content
          : lastUser.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    return {
      content: `mock:${text.trim()}`,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}

/**
 * Stage 2 集成测试：Engine.runStream → Agentic Loop → 最终文本。
 *
 * 本测试不经过 CLI 入口，直接驱动 @tachu/core 的 `Engine.runStream`，
 * 用 `MockProviderAdapter` 的 scripted 脚本逐阶段伺候 LLM 返回（ADR-0006 塌陷为
 * 深单 loop 后，不再有独立的 intent 分类 LLM 调用，`tool-use` loop 的第 1 轮
 * 就是整个 turn 的第 1 次 LLM 调用）：
 * 1. tool-use 第 1 轮：请求调用已注册的 `echo-tool`（finishReason=tool_calls）
 * 2. tool-use 第 2 轮：收到工具结果后给出终止文本（finishReason=stop）
 *
 * 注入的 fallback TaskExecutor 负责实际执行 `echo-tool`，模拟真实工具输出。
 *
 * 验收点：
 * - 流式事件中出现 `tool-loop-step` / `tool-call-start` / `tool-call-end`
 * - 最终 `EngineOutput.content` 为第 2 轮 LLM 的终止回复
 * - `EngineOutput.metadata.toolCalls` 包含 echo-tool 的调用记录
 * - `observability` 事件流里能看到 `tool_call_start` / `tool_call_end` / `phase_*`
 */

const createConfig = (): EngineConfig => ({
  registry: {
    descriptorPaths: [],
    enableVectorIndexing: false,
  },
  runtime: {
    planMode: false,
    maxConcurrency: 4,
    defaultTaskTimeoutMs: 10_000,
    failFast: false,
    toolLoop: {
      maxSteps: 4,
      parallelism: 2,
      requireApprovalGlobal: false,
    },
  },
  memory: {
    contextTokenLimit: 4_000,
    compressionThreshold: 0.8,
    headKeep: 4,
    tailKeep: 4,
    archivePath: ".tachu/archive/core-tool-use-integration.jsonl",
    vectorIndexLimit: 1_000,
  },
  budget: {
    maxTokens: 40_000,
    maxToolCalls: 20,
    maxWallTimeMs: 60_000,
  },
  safety: {
    maxInputSizeBytes: 1024 * 1024,
    maxRecursionDepth: 5,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: ["ignore previous instructions"],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "mock", model: "mock-chat" },
      planning: { provider: "mock", model: "mock-chat" },
      "fast-cheap": { provider: "mock", model: "mock-chat" },
      "high-reasoning": { provider: "mock", model: "mock-chat" },
      validation: { provider: "mock", model: "mock-chat" },
    },
    providerFallbackOrder: ["mock"],
  },
  observability: {
    enabled: true,
    maskSensitiveData: false,
  },
  hooks: {
    writeHookTimeout: 2_000,
    failureBehavior: "continue",
  },
});

const ok = (output: unknown) => ({ ok: true as const, output });

const echoToolDescriptor: ToolDescriptor = {
  kind: "tool",
  name: "echo-tool",
  description: "把给定的 text 原样回显。",
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 3_000,
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  execute: "echo",
};

/**
 * 校验 StreamChunk 序列中 tool-call-start / tool-call-end 按 callId 严格配对，
 * 且在 `lifecycle`（turnStop enter，即 loop 结束、进入 post-guard 的公共分界）
 * 与首个 `done` 之前不得残留未闭合的 callId；所有 `tool-call-end` 必须出现在
 * `done` 之前。
 */
const assertToolCallStreamChunksWellFormed = (chunks: StreamChunk[]): void => {
  const open = new Map<string, string>();
  const doneIndex = chunks.findIndex((c) => c.type === "done");
  expect(doneIndex).toBeGreaterThanOrEqual(0);

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (c.type === "lifecycle" && c.point === "turnStop" && c.status === "enter") {
      expect(open.size).toBe(0);
    }
    if (c.type === "tool-call-start") {
      expect(open.has(c.callId)).toBe(false);
      open.set(c.callId, c.tool);
    }
    if (c.type === "tool-call-end") {
      expect(open.has(c.callId)).toBe(true);
      open.delete(c.callId);
      expect(i < doneIndex).toBe(true);
    }
  }
  expect(open.size).toBe(0);
};

describe("engine integration: tool-use agentic loop", () => {
 test("complex intent + 已注册工具 → tool-use 子流程跑完多轮后返回终止文本", async () => {
    const provider = new ScriptedMockProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-echo-1",
            name: "echo-tool",
            arguments: { text: "hello" },
          },
        ],
        finishReason: "tool_calls",
      },
      {
        content: "收到工具结果：echoed:hello。任务完成。",
        finishReason: "stop",
      },
    ]);

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register(echoToolDescriptor);

    const events: EngineEvent[] = [];
    const observability = new DefaultObservabilityEmitter();
    observability.on("*", (event) => events.push(event));

    const sessions = new InMemorySessionManager();

 // fallback TaskExecutor：type=tool 且 ref=echo-tool 时真实执行
    const fallbackExecutor = async (task: {
      type: string;
      ref: string;
      input: unknown;
    }) => {
      if (task.type === "tool" && task.ref === "echo-tool") {
        const args = (task.input ?? {}) as { text?: string };
        return ok({ text: `echoed:${args.text ?? ""}` });
      }
      throw new Error(`unexpected task: ${task.type}:${task.ref}`);
    };

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability,
      sessionManager: sessions,
      taskExecutor: fallbackExecutor,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of engine.runStream(
      {
        content: "请用 echo 工具回显 hello",
        metadata: { modality: "text", size: 64 },
      },
      {
        correlation: {
          traceId: "trace-tool-use",
          requestId: "req-tool-use",
          sessionId: "session-tool-use",
          turnId: "turn-req-tool-use",
        },
        principal: { role: "tester" },
        budget: { maxTokens: 5_000, maxDurationMs: 10_000 },
        scopes: ["*"],
      },
    )) {
      chunks.push(chunk);
      if (chunk.type === "error") {
        throw chunk.error;
      }
    }

 // 终止 chunk 必然存在
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (!done || done.type !== "done") throw new Error("expected done chunk");

 // 1. Agentic Loop 特有事件依序出现
    const loopStepChunks = chunks.filter((c) => c.type === "tool-loop-step");
    expect(loopStepChunks.length).toBeGreaterThanOrEqual(1);

    const toolStart = chunks.find(
      (c) => c.type === "tool-call-start" && c.tool === "echo-tool",
    );
    expect(toolStart).toBeDefined();

    const toolEnd = chunks.find(
      (c) => c.type === "tool-call-end" && c.tool === "echo-tool",
    );
    expect(toolEnd).toBeDefined();
    if (toolEnd && toolEnd.type === "tool-call-end") {
      expect(toolEnd.success).toBe(true);
    }

 // 2. 最终输出就是脚本第 3 轮的终止文本
    expect(typeof done.output.content).toBe("string");
    expect(done.output.content).toContain("任务完成");
    expect(done.output.content).toContain("echoed:hello");

 // 3. 工具调用记录回流到 metadata.toolCalls
    const echoCall = done.output.metadata.toolCalls.find(
      (record) => record.tool === "echo-tool",
    );
    expect(echoCall).toBeDefined();
    if (echoCall) {
      expect(echoCall.success).toBe(true);
    }

 // 4. Observability：loop_step_enter / loop_step_exit + tool_call_start / tool_call_end
    expect(events.some((e) => e.type === "loop_step_enter")).toBe(true);
    expect(events.some((e) => e.type === "loop_step_exit")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_end")).toBe(true);

    await engine.dispose();
  });

 test("工具执行失败但模型给出兜底文本 → stream 暴露失败 chunk 且 turn 标记 degraded", async () => {
    const provider = new ScriptedMockProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-fail-1",
            name: "unstable-tool",
            arguments: { path: "/tmp/missing" },
          },
        ],
        finishReason: "tool_calls",
      },
      {
        content: "工具失败；我会基于已知信息降级回答。",
        finishReason: "stop",
      },
      {
        content: "最终降级回答：无法读取目标路径，但可以先确认路径和权限。",
        finishReason: "stop",
      },
    ]);

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register({
      kind: "tool",
      name: "unstable-tool",
      description: "模拟失败的工具。",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 3_000,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
      execute: "unstable",
    });

    const events: EngineEvent[] = [];
    const observability = new DefaultObservabilityEmitter();
    observability.on("*", (event) => events.push(event));

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability,
      sessionManager: new InMemorySessionManager(),
      taskExecutor: async (task) => {
        if (task.type === "tool" && task.ref === "unstable-tool") {
          return {
            ok: false,
            error: {
              code: "TEST_TOOL_FAILED",
              message: "disk is full",
              retryable: false,
              source: "tool" as const,
            },
          };
        }
        throw new Error(`unexpected task: ${task.type}:${task.ref}`);
      },
    });

    const correlation = {
      traceId: "trace-tool-failure",
      requestId: "req-tool-failure",
      sessionId: "session-tool-failure",
      turnId: "turn-req-tool-failure",
    };
    const subject = {
      tenant: "tenant-a",
      userId: "user-a",
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of engine.runStream(
      {
        content: "请读取 /tmp/missing",
        metadata: { modality: "text", size: 64 },
      },
      {
        correlation,
        subject,
        principal: { role: "tester" },
        budget: { maxTokens: 5_000, maxDurationMs: 10_000 },
        scopes: ["*"],
      },
    )) {
      chunks.push(chunk);
      if (chunk.type === "error") {
        throw chunk.error;
      }
    }

    for (const chunk of chunks) {
      expect(chunk.correlation).toEqual(correlation);
      expect(chunk.subject).toEqual(subject);
    }
    for (const event of events) {
      expect(event.correlation).toEqual(correlation);
      expect(event.subject).toEqual(subject);
    }

    const toolEnd = chunks.find(
      (c) => c.type === "tool-call-end" && c.callId === "call-fail-1",
    );
    expect(toolEnd).toBeDefined();
    if (!toolEnd || toolEnd.type !== "tool-call-end") {
      throw new Error("expected failed tool-call-end");
    }
    expect(toolEnd.tool).toBe("unstable-tool");
    expect(toolEnd.success).toBe(false);
    expect(toolEnd.durationMs).toBeGreaterThanOrEqual(0);
    expect(toolEnd.parentStepId).toBeDefined();
    expect(toolEnd.error).toEqual({
      code: "TEST_TOOL_FAILED",
      message: "disk is full",
      retryable: false,
    });

    const failedStepEnd = chunks.find(
      (c) =>
        c.type === "tool-loop-step-end" &&
        c.success === false &&
        c.selectedTools?.includes("unstable-tool"),
    );
    expect(failedStepEnd).toBeDefined();
    if (failedStepEnd?.type === "tool-loop-step-end") {
      expect(failedStepEnd.failureReason).toBe("disk is full");
      expect(failedStepEnd.retryCount).toBe(0);
      expect(failedStepEnd.error?.code).toBe("TEST_TOOL_FAILED");
    }

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (!done || done.type !== "done") throw new Error("expected done chunk");
    expect(done.output.metadata.outcome).toBe("degraded");
    expect(done.output.metadata.errors).toEqual([
      {
        code: "TEST_TOOL_FAILED",
        message: "disk is full",
        source: "tool",
        toolName: "unstable-tool",
        callId: "call-fail-1",
        retryable: false,
      },
    ]);
    expect(done.output.content).toContain("最终降级回答");

    const record = done.output.metadata.toolCalls.find(
      (item) => item.callId === "call-fail-1",
    );
    expect(record).toBeDefined();
    expect(record?.tool).toBe("unstable-tool");
    expect(record?.success).toBe(false);
    expect(record?.error?.code).toBe("TEST_TOOL_FAILED");

    const stepStartEvent = events.find((event) => event.type === "tool_loop_step_start");
    expect(stepStartEvent?.payload.retryCount).toBe(0);
    const stepEndEvent = events.find(
      (event) =>
        event.type === "tool_loop_step_end" &&
        Array.isArray(event.payload.selectedTools) &&
        event.payload.selectedTools.includes("unstable-tool"),
    );
    expect(stepEndEvent).toBeDefined();
    expect(stepEndEvent?.payload.failureReason).toBe("disk is full");
    expect(stepEndEvent?.payload.argumentsPreview).toContain("/tmp/missing");
    const toolEndEvent = events.find(
      (event) =>
        event.type === "tool_call_end" &&
        event.payload.callId === "call-fail-1" &&
        event.payload.success === false,
    );
    expect(toolEndEvent).toBeDefined();
    expect(toolEndEvent?.payload.error).toEqual({
      code: "TEST_TOOL_FAILED",
      message: "disk is full",
      retryable: false,
      source: "tool",
    });

    await engine.dispose();
  });

 test("同一轮 LLM 内两次工具调用（同名不同 callId）→ 每个 callId 在 turnStop 里程碑与 done 前均有对偶 end", async () => {
    const provider = new ScriptedMockProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-echo-a",
            name: "echo-tool",
            arguments: { text: "first" },
          },
          {
            id: "call-echo-b",
            name: "echo-tool",
            arguments: { text: "second" },
          },
        ],
        finishReason: "tool_calls",
      },
      {
        content: "两次 echo 均已完成。",
        finishReason: "stop",
      },
    ]);

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register(echoToolDescriptor);

    const observability = new DefaultObservabilityEmitter();
    const sessions = new InMemorySessionManager();

    const fallbackExecutor = async (task: {
      type: string;
      ref: string;
      input: unknown;
    }) => {
      if (task.type === "tool" && task.ref === "echo-tool") {
        const args = (task.input ?? {}) as { text?: string };
        return ok({ text: `echoed:${args.text ?? ""}` });
      }
      throw new Error(`unexpected task: ${task.type}:${task.ref}`);
    };

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability,
      sessionManager: sessions,
      taskExecutor: fallbackExecutor,
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of engine.runStream(
      {
        content: "请连续两次用 echo-tool 回显 first 与 second",
        metadata: { modality: "text", size: 64 },
      },
      {
        correlation: {
          traceId: "trace-dual-echo",
          requestId: "req-dual-echo",
          sessionId: "session-dual-echo",
          turnId: "turn-req-dual-echo",
        },
        principal: { role: "tester" },
        budget: { maxTokens: 5_000, maxDurationMs: 10_000 },
        scopes: ["*"],
      },
    )) {
      chunks.push(chunk);
      if (chunk.type === "error") {
        throw chunk.error;
      }
    }

    assertToolCallStreamChunksWellFormed(chunks);

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (!done || done.type !== "done") throw new Error("expected done");

    const doneIndex = chunks.findIndex((c) => c.type === "done");
    const endAIndex = chunks.findIndex(
      (c) => c.type === "tool-call-end" && c.callId === "call-echo-a",
    );
    const endBIndex = chunks.findIndex(
      (c) => c.type === "tool-call-end" && c.callId === "call-echo-b",
    );
    const loopDoneIndex = chunks.findIndex(
      (c) => c.type === "lifecycle" && c.point === "turnStop" && c.status === "enter",
    );
    expect(endAIndex).toBeGreaterThanOrEqual(0);
    expect(endBIndex).toBeGreaterThanOrEqual(0);
    expect(endBIndex).toBeLessThan(doneIndex);
    const lastToolEndIndex = Math.max(endAIndex, endBIndex);
    expect(loopDoneIndex).toBeGreaterThan(lastToolEndIndex);

    await engine.dispose();
  });

 test("registry 无工具 → 深单 loop 零 tool_call 直接产出终止文本(ADR-0006 D1:subsumes 原 direct-answer)", async () => {
    const provider = new ScriptedMockProvider([
      {
        content: "这里是一首短诗：海天相接处，风起千帆动。",
        finishReason: "stop",
      },
    ]);

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });

    const sessions = new InMemorySessionManager();
    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      sessionManager: sessions,
    });

    let done: StreamChunk | undefined;
    const chunks: StreamChunk[] = [];
    for await (const chunk of engine.runStream(
      {
        content: "构思一首关于海天相接的短诗",
        metadata: { modality: "text", size: 32 },
      },
      {
        correlation: {
          traceId: "trace-fallback",
          requestId: "req-fallback",
          sessionId: "session-fallback",
          turnId: "turn-req-fallback",
        },
        principal: { role: "tester" },
        budget: { maxTokens: 5_000, maxDurationMs: 10_000 },
        scopes: ["*"],
      },
    )) {
      chunks.push(chunk);
      if (chunk.type === "done") done = chunk;
      if (chunk.type === "error") throw chunk.error;
    }

    expect(done).toBeDefined();
    if (!done || done.type !== "done") throw new Error("expected done");

 // 深单 loop 恒经过 tool-use 子流程(即便零工具可见)：仍会 emit tool-loop-step，
 // 但因模型第 1 轮就直接给出终止文本，不会有任何 tool-call-*。
    expect(chunks.some((c) => c.type === "tool-loop-step")).toBe(true);
    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(false);

    expect(typeof done.output.content).toBe("string");
    expect(done.output.content).toContain("海天相接处");

    await engine.dispose();
  });
});
