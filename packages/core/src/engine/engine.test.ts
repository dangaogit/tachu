import { describe, expect, test } from "bun:test";
import {
  Engine,
  type ChatRequest,
  type ChatResponse,
  type EngineConfig,
  type MemoryEntry,
  type MemorySystem,
  type ProviderAdapter,
} from "../index";
import { DescriptorRegistry } from "../registry";
import type { AdapterCallContext } from "../types/context";
import { InMemoryVectorStore } from "../vector";

const config: EngineConfig = {
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: { planMode: false, maxConcurrency: 2, defaultTaskTimeoutMs: 3000, failFast: false },
  memory: {
    contextTokenLimit: 2000,
    compressionThreshold: 0.8,
    headKeep: 2,
    tailKeep: 2,
    archivePath: ".tachu/archive/engine-test.jsonl",
    vectorIndexLimit: 1000,
  },
  budget: { maxTokens: 5000, maxToolCalls: 20, maxWallTimeMs: 60_000 },
  safety: {
    maxInputSizeBytes: 1024 * 1024,
    maxRecursionDepth: 4,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "noop", model: "dev-small" },
      planning: { provider: "noop", model: "dev-large" },
      "fast-cheap": { provider: "noop", model: "dev-small" },
      "high-reasoning": { provider: "noop", model: "dev-large" },
      validation: { provider: "noop", model: "dev-small" },
    },
    providerFallbackOrder: ["noop"],
  },
  observability: { enabled: true, maskSensitiveData: true },
  hooks: { writeHookTimeout: 1000, failureBehavior: "continue" },
};

describe("Engine", () => {
  test("run returns final output", async () => {
    const engine = new Engine(config);
    const output = await engine.run(
      { content: "hello", metadata: { modality: "text", size: 5 } },
      {
        requestId: "r",
        sessionId: "s",
        traceId: "t",
        principal: {},
        budget: { maxTokens: 1000, maxDurationMs: 5000 },
        scopes: ["*"],
      },
    );
    expect(output.type).toBe("text");
    expect(output.status === "success" || output.status === "partial").toBe(true);
    engine.cancel("s");
    await engine.dispose();
  });

  test("runStream emits progress and done chunks", async () => {
    const engine = new Engine(config);
    const chunkTypes: string[] = [];
    for await (const chunk of engine.runStream(
      { content: "请给我步骤并且解释原因", metadata: { modality: "text", size: 30 } },
      {
        requestId: "r-stream",
        sessionId: "s-stream",
        traceId: "t-stream",
        principal: {},
        budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    )) {
      chunkTypes.push(chunk.type);
      if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    expect(chunkTypes).toContain("progress");
    expect(chunkTypes.at(-1)).toBe("done");
    await engine.dispose();
  });

  test("runStream emits tool-use tool-call-start before the tool finishes", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "tool",
      name: "fetch-news",
      description: "fetch news",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      execute: "fetchNews",
    });

    let chatCalls = 0;
    let streamCalls = 0;
    const provider: ProviderAdapter = {
      id: "streamer",
      name: "Streamer",
      async listAvailableModels() {
        return [];
      },
      async chat(): Promise<ChatResponse> {
        chatCalls += 1;
        if (chatCalls === 1) {
          return {
            content: JSON.stringify({
              complexity: "complex",
              intent: "fetch current news",
              contextRelevance: "unrelated",
              textToImage: false,
            }),
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        if (chatCalls === 2) {
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "news-call-1", name: "fetch-news", arguments: { topic: "today" } },
            ],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        return {
          content: "done",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async *chatStream() {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool-call-complete",
            call: { id: "news-call-1", name: "fetch-news", arguments: { topic: "today" } },
          } as const;
          yield {
            type: "finish",
            finishReason: "tool_calls",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          } as const;
          return;
        }
        yield { type: "text-delta", delta: "done" } as const;
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        } as const;
      },
    };

    let releaseTool!: () => void;
    let toolReleased = false;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = () => {
        toolReleased = true;
        resolve();
      };
    });

    const engine = new Engine(
      {
        ...config,
        runtime: { ...config.runtime, streamingOutput: true },
        models: {
          capabilityMapping: {
            intent: { provider: "streamer", model: "streamer-chat" },
            planning: { provider: "streamer", model: "streamer-chat" },
            validation: { provider: "streamer", model: "streamer-chat" },
            "fast-cheap": { provider: "streamer", model: "streamer-chat" },
            "high-reasoning": { provider: "streamer", model: "streamer-chat" },
          },
          providerFallbackOrder: ["streamer"],
        },
      },
      {
        providers: [provider],
        registry,
        taskExecutor: async (task) => {
          if (task.ref !== "fetch-news") {
            throw new Error(`unexpected task ${task.ref}`);
          }
          await toolGate;
          return { title: "news" };
        },
      },
    );

    const iterator = engine.runStream(
      { content: "今日新闻 https://example.com/news", metadata: { modality: "text", size: 34 } },
      {
        requestId: "r-tool-live",
        sessionId: "s-tool-live",
        traceId: "t-tool-live",
        principal: {},
        budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    )[Symbol.asyncIterator]();

    let sawStartBeforeToolFinished = false;
    const chunkTypes: string[] = [];
    let pendingError: unknown;
    try {
      for (let i = 0; i < 30 && !sawStartBeforeToolFinished; i += 1) {
        const result = await Promise.race([
          iterator.next(),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
        ]);
        if (result === "timeout") {
          break;
        }
        if (result.done) {
          break;
        }
        const chunk = result.value;
        chunkTypes.push(chunk.type);
        if (chunk.type === "error") {
          throw chunk.error;
        }
        if (chunk.type === "tool-call-start") {
          sawStartBeforeToolFinished = !toolReleased;
        }
      }
    } catch (error) {
      pendingError = error;
    } finally {
      releaseTool();
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          break;
        }
        chunkTypes.push(result.value.type);
        if (result.value.type === "error") {
          pendingError = result.value.error;
          break;
        }
        if (result.value.type === "done") {
          break;
        }
      }
      await engine.dispose();
    }
    if (pendingError !== undefined) {
      throw pendingError;
    }

    expect(sawStartBeforeToolFinished).toBe(true);
    expect(chunkTypes.filter((type) => type === "tool-call-start")).toHaveLength(1);
    expect(chunkTypes.filter((type) => type === "tool-call-end")).toHaveLength(1);
  });

  test("runStream emits structured phase-enter / phase-exit per 9-phase pipeline", async () => {
    const engine = new Engine(config);
    const phaseEnters: string[] = [];
    const phaseExits: { phase: string; ok: boolean }[] = [];
    for await (const chunk of engine.runStream(
      { content: "ping", metadata: { modality: "text", size: 4 } },
      {
        requestId: "r-phase",
        sessionId: "s-phase",
        traceId: "t-phase",
        principal: {},
        budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    )) {
      if (chunk.type === "phase-enter") {
        phaseEnters.push(chunk.phase);
      } else if (chunk.type === "phase-exit") {
        phaseExits.push({ phase: chunk.phase, ok: chunk.ok });
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    // 9 阶段全部进入且全部以 ok=true 退出
    expect(phaseEnters).toEqual([
      "session",
      "safety",
      "intent",
      "precheck",
      "planning",
      "graph-check",
      "execution",
      "validation",
      "output",
    ]);
    expect(phaseExits.map((p) => p.phase)).toEqual(phaseEnters);
    expect(phaseExits.every((p) => p.ok === true)).toBe(true);
    await engine.dispose();
  });

  test("cancel interrupts active run", async () => {
    const engine = new Engine(config, {
      taskExecutor: async (_task, _ctx, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("finished"), 120);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("task aborted"));
            },
            { once: true },
          );
        }),
    });

    let gotError = false;
    for await (const chunk of engine.runStream(
      { content: "multi step workflow", metadata: { modality: "text", size: 20 } },
      {
        requestId: "r-cancel",
        sessionId: "s-cancel",
        traceId: "t-cancel",
        principal: {},
        budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    )) {
      if (chunk.type === "progress" && chunk.phase === "execution") {
        engine.cancel("s-cancel");
      }
      if (chunk.type === "error") {
        gotError = true;
      }
    }
    expect(gotError).toBe(true);
    await engine.dispose();
  });

  test("dispose prevents further runs", async () => {
    const engine = new Engine(config);
    await engine.dispose();
    await expect(
      engine.run(
        { content: "after dispose", metadata: { modality: "text", size: 12 } },
        {
          requestId: "r-dispose",
          sessionId: "s-dispose",
          traceId: "t-dispose",
          principal: {},
          budget: {},
          scopes: ["*"],
        },
      ),
    ).rejects.toThrow("Engine has been disposed");
  });

  test("internal sub-flow tasks always route through the engine, even when a custom taskExecutor is injected", async () => {
    // 回归守护：业务注入的 taskExecutor 只应该收到自己的类型（tool/agent/业务 sub-flow），
    // 内置 Sub-flow（如 direct-answer）必须由引擎的 InternalSubflowRegistry 接管。
    // 该用例验证 Phase 5 simple 路径 → direct-answer → Phase 7 成功执行 → Phase 8 passed → 最终 status=success。
    const toolTaskRefs: string[] = [];
    const echoProvider: ProviderAdapter = {
      id: "echo",
      name: "EchoProvider",
      async listAvailableModels() {
        return [];
      },
      async chat(request: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content;
        return {
          content: `echo:${lastUser ?? ""}`,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async *chatStream(request: ChatRequest, _ctx: AdapterCallContext) {
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content;
        const text = typeof lastUser === "string" ? lastUser : "";
        yield { type: "text-delta", delta: `echo:${text}` };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const engine = new Engine(
      {
        ...config,
        models: {
          capabilityMapping: {
            intent: { provider: "echo", model: "echo-chat" },
            planning: { provider: "echo", model: "echo-chat" },
            validation: { provider: "echo", model: "echo-chat" },
            "fast-cheap": { provider: "echo", model: "echo-chat" },
            "high-reasoning": { provider: "echo", model: "echo-chat" },
          },
          providerFallbackOrder: ["echo"],
        },
      },
      {
        providers: [echoProvider],
        taskExecutor: async (task) => {
          // 业务 executor 只处理 tool，其它类型一律失败 —— 模拟 @tachu/cli 当前实现
          if (task.type === "tool") {
            toolTaskRefs.push(task.ref);
            return { ref: task.ref, output: "tool-ok" };
          }
          throw new Error(`不支持的任务类型：${task.type}`);
        },
      },
    );

    const output = await engine.run(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        requestId: "r-layered",
        sessionId: "s-layered",
        traceId: "t-layered",
        principal: {},
        budget: { maxTokens: 1_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    );

    expect(output.status).toBe("success");
    expect(typeof output.content === "string" ? output.content : "").toContain("echo:");
    // 业务 executor 不应该被 direct-answer 触发过 —— 层级分发把 sub-flow 完全拦在引擎内
    expect(toolTaskRefs).toEqual([]);

    await engine.dispose();
  });

  test("tokenUsage uses provider usage and does not include assembled prompt estimate", async () => {
    const vectorStore = new InMemoryVectorStore({ indexLimit: config.memory.vectorIndexLimit });
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register({
      kind: "tool",
      name: "huge-tool",
      description: "x".repeat(20_000),
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: {
        type: "object",
        properties: {
          payload: { type: "string", description: "y".repeat(20_000) },
        },
      },
      execute: "hugeTool",
    });

    let calls = 0;
    const usageProvider: ProviderAdapter = {
      id: "usage",
      name: "UsageProvider",
      async listAvailableModels() {
        return [];
      },
      async chat(): Promise<ChatResponse> {
        calls += 1;
        if (calls === 1) {
          return {
            content: JSON.stringify({
              complexity: "simple",
              intent: "say hi",
              contextRelevance: "related",
              textToImage: false,
            }),
            usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          };
        }
        return {
          content: "hi",
          finishReason: "stop",
          usage: {
            promptTokens: 200,
            completionTokens: 20,
            totalTokens: 220,
            cachedPromptTokens: 80,
          },
        };
      },
      async *chatStream() {
        throw new Error("streaming should be disabled in this test");
      },
    };

    const engine = new Engine(
      {
        ...config,
        runtime: { ...config.runtime, streamingOutput: false },
        budget: { ...config.budget, maxTokens: 500_000 },
        models: {
          capabilityMapping: {
            intent: { provider: "usage", model: "usage-chat" },
            planning: { provider: "usage", model: "usage-chat" },
            validation: { provider: "usage", model: "usage-chat" },
            "fast-cheap": { provider: "usage", model: "usage-chat" },
            "high-reasoning": { provider: "usage", model: "usage-chat" },
          },
          providerFallbackOrder: ["usage"],
        },
      },
      { providers: [usageProvider], registry },
    );

    const output = await engine.run(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        requestId: "r-usage",
        sessionId: "s-usage",
        traceId: "t-usage",
        principal: {},
        budget: {},
        scopes: ["*"],
      },
    );

    expect(output.metadata.tokenUsage).toEqual({
      input: 300,
      output: 30,
      total: 330,
      cached: 80,
    });
    await engine.dispose();
  });

  test("runStream forwards scope.modelOverride.all so provider is called with overridden model", async () => {
    const capturedModels: string[] = [];
    const captureProvider: ProviderAdapter = {
      id: "capture",
      name: "CaptureProvider",
      async listAvailableModels() {
        return [];
      },
      async chat(request: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
        capturedModels.push(request.model);
        return {
          content: "ok",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async *chatStream(_request: ChatRequest, _ctx: AdapterCallContext) {
        yield { type: "text-delta", delta: "ok" } as const;
        yield { type: "finish", finishReason: "stop" } as const;
      },
    };

    const engine = new Engine(
      {
        ...config,
        runtime: { ...config.runtime, streamingOutput: false },
        models: {
          capabilityMapping: {
            intent: { provider: "capture", model: "default-model" },
            planning: { provider: "capture", model: "default-model" },
            validation: { provider: "capture", model: "default-model" },
            "fast-cheap": { provider: "capture", model: "default-model" },
            "high-reasoning": { provider: "capture", model: "default-model" },
          },
          providerFallbackOrder: ["capture"],
        },
      },
      { providers: [captureProvider] },
    );

    for await (const chunk of engine.runStream(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        requestId: "r-scope-model",
        sessionId: "s-scope-model",
        traceId: "t-scope-model",
        principal: {},
        budget: {},
        scopes: ["*"],
      },
      {
        modelOverride: {
          all: { provider: "capture", model: "OVERRIDE-MODEL-A2" },
        },
      },
    )) {
      if (chunk.type === "error") throw chunk.error;
    }

    // 所有调用——含 intent 分类、direct-answer 答复——都应使用 override 的 model。
    expect(capturedModels.length).toBeGreaterThan(0);
    expect(capturedModels.every((m) => m === "OVERRIDE-MODEL-A2")).toBe(true);

    await engine.dispose();
  });

  test("memorySystem.append for the assistant reply happens BEFORE yield {type:'done'} so consumers that break on done still persist the turn", async () => {
    const appendedRoles: string[] = [];
    const trackingMemory: MemorySystem = {
      async load() {
        return { entries: [], tokenCount: 0, limit: 2000 };
      },
      async append(_sessionId: string, entry: MemoryEntry, _ctx: AdapterCallContext) {
        appendedRoles.push(entry.role);
      },
      async compress() {},
      async recall() {
        return [];
      },
      async archive() {},
      async getSize() {
        return { entries: 0, tokens: 0 };
      },
      async trim() {},
      async clear() {},
    };

    const provider: ProviderAdapter = {
      id: "noop2",
      name: "Noop2",
      async listAvailableModels() {
        return [];
      },
      async chat(_request: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
        return {
          content: "answer",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async *chatStream(_request: ChatRequest, _ctx: AdapterCallContext) {
        yield { type: "text-delta", delta: "answer" } as const;
        yield { type: "finish", finishReason: "stop" } as const;
      },
    };

    const engine = new Engine(
      {
        ...config,
        runtime: { ...config.runtime, streamingOutput: false },
        models: {
          capabilityMapping: {
            intent: { provider: "noop2", model: "m" },
            planning: { provider: "noop2", model: "m" },
            validation: { provider: "noop2", model: "m" },
            "fast-cheap": { provider: "noop2", model: "m" },
            "high-reasoning": { provider: "noop2", model: "m" },
          },
          providerFallbackOrder: ["noop2"],
        },
      },
      { providers: [provider], memorySystem: trackingMemory },
    );

    // 关键场景：消费方一拿到 done 就 break；此前 assistant append 必须已经发生。
    let appendedRolesAtDone: string[] = [];
    for await (const chunk of engine.runStream(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        requestId: "r-mem-order",
        sessionId: "s-mem-order",
        traceId: "t-mem-order",
        principal: {},
        budget: {},
        scopes: ["*"],
      },
    )) {
      if (chunk.type === "done") {
        appendedRolesAtDone = [...appendedRoles];
        break;
      }
      if (chunk.type === "error") throw chunk.error;
    }

    // user 在 session phase 必入；assistant 必须在 done 之前已经 append。
    expect(appendedRolesAtDone).toContain("user");
    expect(appendedRolesAtDone).toContain("assistant");

    await engine.dispose();
  });

  test("runStream merges scope.additionalRules with registry rules and forwards them to the assembler (union semantics)", async () => {
    const capturedSystemContents: string[] = [];
    const captureProvider: ProviderAdapter = {
      id: "capture",
      name: "CaptureProvider",
      async listAvailableModels() {
        return [];
      },
      async chat(request: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
        for (const m of request.messages) {
          if (m.role === "system" && typeof m.content === "string") {
            capturedSystemContents.push(m.content);
          }
        }
        return {
          content: "ok",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async *chatStream(_request: ChatRequest, _ctx: AdapterCallContext) {
        yield { type: "text-delta", delta: "ok" } as const;
        yield { type: "finish", finishReason: "stop" } as const;
      },
    };

    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "rule",
      name: "registry-baseline-rule",
      description: "from registry",
      type: "rule",
      scope: ["*"],
      content: "REGISTRY-BASELINE-MARKER",
    });

    const engine = new Engine(
      {
        ...config,
        runtime: { ...config.runtime, streamingOutput: false },
        models: {
          capabilityMapping: {
            intent: { provider: "capture", model: "capture-chat" },
            planning: { provider: "capture", model: "capture-chat" },
            validation: { provider: "capture", model: "capture-chat" },
            "fast-cheap": { provider: "capture", model: "capture-chat" },
            "high-reasoning": { provider: "capture", model: "capture-chat" },
          },
          providerFallbackOrder: ["capture"],
        },
      },
      { providers: [captureProvider], registry },
    );

    for await (const chunk of engine.runStream(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        requestId: "r-scope-rules",
        sessionId: "s-scope-rules",
        traceId: "t-scope-rules",
        principal: {},
        budget: {},
        scopes: ["*"],
      },
      {
        additionalRules: [
          {
            kind: "rule",
            name: "session-extra-rule",
            description: "from session scope",
            type: "rule",
            scope: ["*"],
            content: "SESSION-EXTRA-MARKER",
          },
        ],
      },
    )) {
      if (chunk.type === "error") throw chunk.error;
    }

    // 并集语义：assembler 渲染的 system 段必须同时出现 registry baseline 与 session-extra。
    const hasRegistry = capturedSystemContents.some((c) =>
      c.includes("REGISTRY-BASELINE-MARKER"),
    );
    const hasSession = capturedSystemContents.some((c) =>
      c.includes("SESSION-EXTRA-MARKER"),
    );
    expect(hasRegistry).toBe(true);
    expect(hasSession).toBe(true);

    await engine.dispose();
  });

  test("runStream forwards scope.systemInstruction so PromptAssembler injects it into the assembled system message", async () => {
    const capturedSystemContents: string[] = [];
    const captureProvider: ProviderAdapter = {
      id: "capture",
      name: "CaptureProvider",
      async listAvailableModels() {
        return [];
      },
      async chat(request: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
        for (const m of request.messages) {
          if (m.role === "system" && typeof m.content === "string") {
            capturedSystemContents.push(m.content);
          }
        }
        return {
          content: "ok",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async *chatStream(_request: ChatRequest, _ctx: AdapterCallContext) {
        yield { type: "text-delta", delta: "ok" } as const;
        yield { type: "finish", finishReason: "stop" } as const;
      },
    };

    const engine = new Engine(
      {
        ...config,
        runtime: { ...config.runtime, streamingOutput: false },
        models: {
          capabilityMapping: {
            intent: { provider: "capture", model: "capture-chat" },
            planning: { provider: "capture", model: "capture-chat" },
            validation: { provider: "capture", model: "capture-chat" },
            "fast-cheap": { provider: "capture", model: "capture-chat" },
            "high-reasoning": { provider: "capture", model: "capture-chat" },
          },
          providerFallbackOrder: ["capture"],
        },
      },
      { providers: [captureProvider] },
    );

    const MARKER = "MARKER-SYS-A1-XYZ";
    for await (const chunk of engine.runStream(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        requestId: "r-scope-sys",
        sessionId: "s-scope-sys",
        traceId: "t-scope-sys",
        principal: {},
        budget: {},
        scopes: ["*"],
      },
      { systemInstruction: MARKER },
    )) {
      if (chunk.type === "error") throw chunk.error;
    }

    // direct-answer 子流程使用 assembler 预组装的 prompt；assembler 把 systemInstruction
    // 渲染到 system 消息开头。Intent 阶段不使用 assembler，其 system 消息不会包含 MARKER。
    const hasMarker = capturedSystemContents.some((c) => c.includes(MARKER));
    expect(hasMarker).toBe(true);

    await engine.dispose();
  });
});
