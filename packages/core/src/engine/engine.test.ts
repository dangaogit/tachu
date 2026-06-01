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
const ok = (output: unknown) => ({ ok: true as const, output });

describe("Engine", () => {
 test("run returns final output", async () => {
    const engine = new Engine(config);
    const output = await engine.run(
      { content: "hello", metadata: { modality: "text", size: 5 } },
      {
        correlation: {
          traceId: "t",
          requestId: "r",
          sessionId: "s",
          turnId: "turn-r",
        },
        principal: {},
        budget: { maxTokens: 1000, maxDurationMs: 5000 },
        scopes: ["*"],
      },
    );
    expect(output.type).toBe("text");
    expect(output.metadata.outcome).toBe("completed");
    engine.cancel("s");
    await engine.dispose();
  });

 test("runStream emits progress and done chunks", async () => {
    const engine = new Engine(config);
    const chunkTypes: string[] = [];
    for await (const chunk of engine.runStream(
      { content: "请给我步骤并且解释原因", metadata: { modality: "text", size: 30 } },
      {
        correlation: {
          traceId: "t-stream",
          requestId: "r-stream",
          sessionId: "s-stream",
          turnId: "turn-r-stream",
        },
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
          return ok({ title: "news" });
        },
      },
    );

    const iterator = engine.runStream(
      { content: "今日新闻 https://example.com/news", metadata: { modality: "text", size: 34 } },
      {
        correlation: {
          traceId: "t-tool-live",
          requestId: "r-tool-live",
          sessionId: "s-tool-live",
          turnId: "turn-r-tool-live",
        },
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
        correlation: {
          traceId: "t-phase",
          requestId: "r-phase",
          sessionId: "s-phase",
          turnId: "turn-r-phase",
        },
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
          const timer = setTimeout(() => resolve(ok("finished")), 120);
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
        correlation: {
          traceId: "t-cancel",
          requestId: "r-cancel",
          sessionId: "s-cancel",
          turnId: "turn-r-cancel",
        },
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
          correlation: {
            traceId: "t-dispose",
            requestId: "r-dispose",
            sessionId: "s-dispose",
            turnId: "turn-r-dispose",
          },
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
            return ok({ ref: task.ref, output: "tool-ok" });
          }
          throw new Error(`不支持的任务类型：${task.type}`);
        },
      },
    );

    const output = await engine.run(
      { content: "hi", metadata: { modality: "text", size: 2 } },
      {
        correlation: {
          traceId: "t-layered",
          requestId: "r-layered",
          sessionId: "s-layered",
          turnId: "turn-r-layered",
        },
        principal: {},
        budget: { maxTokens: 1_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    );

    expect(output.metadata.outcome).toBe("completed");
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
        correlation: {
          traceId: "t-usage",
          requestId: "r-usage",
          sessionId: "s-usage",
          turnId: "turn-r-usage",
        },
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
        correlation: {
          traceId: "t-scope-model",
          requestId: "r-scope-model",
          sessionId: "s-scope-model",
          turnId: "turn-r-scope-model",
        },
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
      async loadFull() {
        return [];
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
        correlation: {
          traceId: "t-mem-order",
          requestId: "r-mem-order",
          sessionId: "s-mem-order",
          turnId: "turn-r-mem-order",
        },
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
        correlation: {
          traceId: "t-scope-rules",
          requestId: "r-scope-rules",
          sessionId: "s-scope-rules",
          turnId: "turn-r-scope-rules",
        },
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
        correlation: {
          traceId: "t-scope-sys",
          requestId: "r-scope-sys",
          sessionId: "s-scope-sys",
          turnId: "turn-r-scope-sys",
        },
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

 test(" P1 δ: maxTurnRetries>0 时 retry/next-plan outcome 把 previousAttempt 注入下一轮 PlanningPhase", async () => {
    const { ValidationRuleRegistry, buildDefaultValidationRuleRegistry } = await import(
      "./phases/validation"
    );
    const baseRegistry = buildDefaultValidationRuleRegistry();
    const customRegistry = new ValidationRuleRegistry();
    for (const r of baseRegistry.list()) customRegistry.register(r);
    let evalCount = 0;
    customRegistry.register({
      id: "test.force-retry-once",
      kind: "deterministic",
      evaluate: () => {
        evalCount += 1;
        if (evalCount === 1) {
          return [
            {
              ruleId: "test.force-retry-once",
              kind: "deterministic",
              severity: "error",
              retryable: true,
              code: "force.retry.next-plan",
              message: "force retry once",
            },
          ];
        }
        return [];
      },
    });

    const events: Array<{ phase?: string; type?: string; payload?: unknown }> = [];
    const recordingObs = {
      emit: (e: { phase?: string; type?: string; payload?: unknown }) => {
        events.push(e);
      },
      on: () => {},
      off: () => {},
    };

    const cfg: EngineConfig = {
      ...config,
      runtime: { ...config.runtime, maxTurnRetries: 2 },
    };
    const engine = new Engine(cfg, {
      validationRuleRegistry: customRegistry,
      observability: recordingObs as never,
    });
    await engine.run(
      { content: "trigger retry", metadata: { modality: "text", size: 14 } },
      {
        correlation: {
          traceId: "t-retry",
          requestId: "r-retry",
          sessionId: "s-retry",
          turnId: "turn-r-retry",
        },
        principal: {},
        budget: { maxTokens: 2000, maxDurationMs: 5000 },
        scopes: ["*"],
      },
    );

    const injected = events.filter(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { reason?: string })?.reason === "previous-attempt-injected",
    );
    expect(injected.length).toBeGreaterThanOrEqual(1);
    const payload = injected[0]?.payload as {
      previousAttempt?: { retryCount: number; lastOutcomeKind: string; target?: string };
    };
    expect(payload.previousAttempt?.retryCount).toBe(1);
    expect(payload.previousAttempt?.lastOutcomeKind).toBe("retry");
    expect(payload.previousAttempt?.target).toBe("next-plan");

    const retryDecisions = events.filter(
      (e) =>
        e.phase === "validation" &&
        e.type === "warning" &&
        (e.payload as { turnRetryDecision?: string })?.turnRetryDecision === "continue",
    );
    expect(retryDecisions.length).toBeGreaterThanOrEqual(1);

    expect(evalCount).toBeGreaterThanOrEqual(2);

    await engine.dispose();
  });

 test("runStream yields final-answer deltas during candidate-answer before validation", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "tool",
      name: "echo-tool",
      description: "echo",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      execute: "echo",
    });

    let chatCalls = 0;
    const provider: ProviderAdapter = {
      id: "final-answer-streamer",
      name: "FinalAnswerStreamer",
      async listAvailableModels() {
        return [];
      },
      async chat(request): Promise<ChatResponse> {
        chatCalls += 1;
        const systemText =
          typeof request.messages[0]?.content === "string" ? request.messages[0].content : "";
        if (systemText.includes("final answer writer")) {
          return {
            content: "SHOULD-NOT-USE-CHAT",
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        if (chatCalls === 1) {
          return {
            content: JSON.stringify({
              complexity: "complex",
              intent: "echo hello",
              contextRelevance: "related",
            }),
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        if (chatCalls === 2) {
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "echo-1", name: "echo-tool", arguments: { text: "hello" } }],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        return {
          content: "tool loop terminal draft",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async *chatStream(request) {
        const systemText =
          typeof request.messages[0]?.content === "string" ? request.messages[0].content : "";
        if (systemText.includes("final answer writer")) {
          yield { type: "text-delta", delta: "FINAL-" };
          yield { type: "text-delta", delta: "STREAM" };
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
          };
          return;
        }
        const response = await provider.chat!(request, {} as never);
        for (const ch of response.content) {
          yield { type: "text-delta", delta: ch };
        }
        for (const call of response.toolCalls ?? []) {
          yield { type: "tool-call-complete", call };
        }
        yield {
          type: "finish",
          finishReason: response.finishReason ?? "stop",
          usage: response.usage,
        };
      },
    };

    const engine = new Engine(
      {
        ...config,
        runtime: {
          ...config.runtime,
          streamingOutput: true,
          toolLoop: { maxSteps: 4, parallelism: 1, requireApprovalGlobal: false },
        },
        models: {
          capabilityMapping: {
            intent: { provider: "final-answer-streamer", model: "streamer" },
            planning: { provider: "final-answer-streamer", model: "streamer" },
            validation: { provider: "final-answer-streamer", model: "streamer" },
            "fast-cheap": { provider: "final-answer-streamer", model: "streamer" },
            "high-reasoning": { provider: "final-answer-streamer", model: "streamer" },
          },
          providerFallbackOrder: ["final-answer-streamer"],
        },
      },
      {
        providers: [provider],
        registry,
        taskExecutor: async (task) => {
          if (task.type === "tool" && task.ref === "echo-tool") {
            return ok({ text: "echoed:hello" });
          }
          throw new Error(`unexpected task ${task.type}:${task.ref}`);
        },
      },
    );

    const chunks: Array<{ type: string; phase?: string; content?: string }> = [];
    for await (const chunk of engine.runStream(
      { content: "请用 echo 工具回显 hello", metadata: { modality: "text", size: 32 } },
      {
        correlation: {
          traceId: "t-final-stream",
          requestId: "r-final-stream",
          sessionId: "s-final-stream",
          turnId: "turn-r-final-stream",
        },
        principal: {},
        budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
        scopes: ["*"],
      },
    )) {
      if (chunk.type === "error") {
        throw chunk.error;
      }
      chunks.push(
        chunk.type === "delta"
          ? { type: chunk.type, content: chunk.content }
          : chunk.type === "phase-enter" || chunk.type === "phase-exit"
            ? { type: chunk.type, phase: chunk.phase }
            : { type: chunk.type },
      );
    }

    const execExitIndex = chunks.findIndex(
      (chunk) => chunk.type === "phase-exit" && chunk.phase === "execution",
    );
    const validationEnterIndex = chunks.findIndex(
      (chunk) => chunk.type === "phase-enter" && chunk.phase === "validation",
    );
    const firstFinalDeltaIndex = chunks.findIndex(
      (chunk) => chunk.type === "delta" && chunk.content?.includes("FINAL-"),
    );

    expect(execExitIndex).toBeGreaterThanOrEqual(0);
    expect(validationEnterIndex).toBeGreaterThan(execExitIndex);
    expect(firstFinalDeltaIndex).toBeGreaterThan(execExitIndex);
    expect(firstFinalDeltaIndex).toBeLessThan(validationEnterIndex);

    await engine.dispose();
  });
});
