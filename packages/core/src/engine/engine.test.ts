import { describe, expect, test } from "bun:test";
import {
  Engine,
  type ChatRequest,
  type ChatResponse,
  type EngineConfig,
  type ProviderAdapter,
} from "../index";

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
      async chat(request: ChatRequest): Promise<ChatResponse> {
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content;
        return {
          content: `echo:${lastUser ?? ""}`,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async *chatStream(request: ChatRequest) {
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
});

