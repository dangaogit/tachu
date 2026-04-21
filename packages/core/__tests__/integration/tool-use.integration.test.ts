import { describe, expect, test } from "bun:test";
import {
  DefaultObservabilityEmitter,
  DescriptorRegistry,
  Engine,
  InMemorySessionManager,
  InMemoryVectorStore,
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

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
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
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const response = await this.chat(request, signal);
    for (const ch of response.content) yield { type: "text-delta", delta: ch };
    yield { type: "finish", finishReason: response.finishReason ?? "stop", usage: response.usage };
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
 * ADR-0002 Stage 2 集成测试：Engine.runStream → Agentic Loop → 最终文本。
 *
 * 本测试不经过 CLI 入口，直接驱动 @tachu/core 的 `Engine.runStream`，
 * 用 `MockProviderAdapter` 的 scripted 脚本逐阶段伺候 LLM 返回：
 *   1. intent 阶段：返回 `{intent, complexity: "complex"}` 的分类 JSON
 *   2. tool-use 第 1 轮：请求调用已注册的 `echo-tool`（finishReason=tool_calls）
 *   3. tool-use 第 2 轮：收到工具结果后给出终止文本（finishReason=stop）
 *
 * 注入的 fallback TaskExecutor 负责实际执行 `echo-tool`，模拟真实工具输出。
 *
 * 验收点：
 *   - 流式事件中出现 `tool-loop-step` / `tool-call-start` / `tool-call-end`
 *   - 最终 `EngineOutput.content` 为第 2 轮 LLM 的终止回复
 *   - `EngineOutput.metadata.toolCalls` 包含 echo-tool 的调用记录
 *   - `observability` 事件流里能看到 `tool_call_start` / `tool_call_end` / `phase_*`
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

describe("engine integration: tool-use agentic loop", () => {
  test("complex intent + 已注册工具 → tool-use 子流程跑完多轮后返回终止文本", async () => {
    const provider = new ScriptedMockProvider([
      {
        content:
          '{"intent":"调用 echo 工具回显 hello","complexity":"complex","contextRelevance":"related"}',
        finishReason: "stop",
      },
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
    }): Promise<unknown> => {
      if (task.type === "tool" && task.ref === "echo-tool") {
        const args = (task.input ?? {}) as { text?: string };
        return { text: `echoed:${args.text ?? ""}` };
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
        requestId: "req-tool-use",
        sessionId: "session-tool-use",
        traceId: "trace-tool-use",
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
      (record) => record.name === "echo-tool",
    );
    expect(echoCall).toBeDefined();
    if (echoCall) {
      expect(echoCall.success).toBe(true);
    }

    // 4. Observability：phase_enter / phase_exit + tool_call_start / tool_call_end
    expect(events.some((e) => e.type === "phase_enter")).toBe(true);
    expect(events.some((e) => e.type === "phase_exit")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_end")).toBe(true);

    await engine.dispose();
  });

  test("complex intent 但 registry 无工具 → 降级到 direct-answer", async () => {
    const provider = new ScriptedMockProvider([
      {
        content:
          '{"intent":"写一段短诗","complexity":"complex","contextRelevance":"related"}',
        finishReason: "stop",
      },
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
        content: "写一首短诗",
        metadata: { modality: "text", size: 20 },
      },
      {
        requestId: "req-fallback",
        sessionId: "session-fallback",
        traceId: "trace-fallback",
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

    // 无工具路径，tool-loop-* 事件应当为空
    expect(chunks.some((c) => c.type === "tool-loop-step")).toBe(false);
    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(false);

    // 最终文本应来自 direct-answer
    expect(typeof done.output.content).toBe("string");
    expect(done.output.content).toContain("海天相接处");

    await engine.dispose();
  });
});
