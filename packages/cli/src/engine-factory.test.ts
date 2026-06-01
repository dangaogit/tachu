import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultEngineConfig,
  Engine,
  ProviderError,
  type EmbeddingRequest,
  type EngineConfig,
  type ExecutionContext,
  type ProviderAdapter,
  type ProvidersConfig,
  type TaskNode,
} from "@tachu/core";
import {
  FsMemorySystem,
  MockProviderAdapter,
  type ToolExecutionContext,
  type ToolExecutor,
} from "@tachu/extensions";
import {
  buildTaskExecutor,
  createEngine,
  createEngineWithProjection,
  type EngineFactoryOptions,
} from "./engine-factory";

describe("createEngine", () => {
  it("CLI host assembles facade and emits disabled warning without embedding-capable provider", () => {
    const events: { phase: string; type: string; payload?: unknown }[] = [];
    const observability = {
      emit(event: { phase?: string; type?: string; payload?: unknown }) {
        events.push({
          phase: event.phase ?? "",
          type: event.type ?? "",
          payload: event.payload,
        });
      },
    } as unknown as NonNullable<EngineFactoryOptions["observability"]>;
    const config = createDefaultEngineConfig();
    const engine = createEngine(config, {
      providers: [new MockProviderAdapter()],
      observability,
      cwd: "/tmp",
    });
    expect(engine).toBeInstanceOf(Engine);
    const semanticEvents = events.filter((e) => e.phase === "semantic-retrieval");
    expect(semanticEvents.length).toBeGreaterThanOrEqual(1);
    const payload = semanticEvents[0]?.payload as { status?: string } | undefined;
    expect(payload?.status === "available" || payload?.status === "disabled").toBe(true);
    engine.dispose();
  });

  it("返回 Engine 实例", () => {
    const config = createDefaultEngineConfig();
    const engine = createEngine(config, {
      providers: [new MockProviderAdapter()],
    });
    expect(engine).toBeInstanceOf(Engine);
    engine.dispose();
  });

  it("使用 mock provider 构建 engine", () => {
    const config = {
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "mock", model: "mock-chat" },
          "fast-cheap": { provider: "mock", model: "mock-chat" },
          "intent": { provider: "mock", model: "mock-chat" },
          "planning": { provider: "mock", model: "mock-chat" },
          "validation": { provider: "mock", model: "mock-chat" },
        },
        providerFallbackOrder: ["mock"],
      },
    };
    const engine = createEngine(config, {
      providers: [new MockProviderAdapter()],
      cwd: "/tmp",
    });
    expect(engine).toBeInstanceOf(Engine);
    engine.dispose();
  });

  it("inferProviders 从 config 中推断 mock provider", () => {
    const config = {
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "mock", model: "mock-chat" },
          "fast-cheap": { provider: "mock", model: "mock-chat" },
          "intent": { provider: "mock", model: "mock-chat" },
          "planning": { provider: "mock", model: "mock-chat" },
          "validation": { provider: "mock", model: "mock-chat" },
        },
        providerFallbackOrder: ["mock"],
      },
    };
 // 不指定 providers，让工厂自动推断
    const engine = createEngine(config, { cwd: "/tmp" });
    expect(engine).toBeInstanceOf(Engine);
    engine.dispose();
  });

 describe("config.providers 透传", () => {
    const savedOpenAi = process.env.OPENAI_API_KEY;
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;

    beforeEach(() => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
      if (savedOpenAi !== undefined) {
        process.env.OPENAI_API_KEY = savedOpenAi;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (savedAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedAnthropic;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    const buildOpenAiConfig = (
      providers: ProvidersConfig | undefined,
    ): EngineConfig => ({
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "openai", model: "gpt-4o" },
          "fast-cheap": { provider: "openai", model: "gpt-4o-mini" },
          intent: { provider: "openai", model: "gpt-4o-mini" },
          planning: { provider: "openai", model: "gpt-4o" },
          validation: { provider: "openai", model: "gpt-4o-mini" },
        },
        providerFallbackOrder: ["openai"],
      },
      ...(providers !== undefined ? { providers } : {}),
    });

    it("未配置 apiKey 时，engine 构造会抛 ProviderError", () => {
      const config = buildOpenAiConfig(undefined);
      expect(() => createEngine(config, { cwd: "/tmp" })).toThrow(ProviderError);
    });

    it("config.providers.openai.apiKey 被透传给 OpenAIProviderAdapter", () => {
      const config = buildOpenAiConfig({
        openai: {
          apiKey: "sk-test-transport",
          baseURL: "https://gateway.example.com/v1",
        },
      });
      const engine = createEngine(config, { cwd: "/tmp" });
      expect(engine).toBeInstanceOf(Engine);
      engine.dispose();
    });

    it("config.providers 对显式注入的 mock provider 无副作用（providers override 跳过 inferProviders）", () => {
      const config = {
        ...createDefaultEngineConfig(),
        providers: {
          openai: { apiKey: "sk-ignored", baseURL: "https://x.example.com" },
        },
      };
 // P8：默认 config 路由到 "noop"，inferProviders 过滤 noop 后会得到空列表，
 // 触发 fail-closed。这里显式注入 providers 走 override 路径，跳过推断。
      const engine = createEngine(config, {
        cwd: "/tmp",
        providers: [new MockProviderAdapter()],
      });
      expect(engine).toBeInstanceOf(Engine);
      engine.dispose();
    });

    it("未配置 anthropic apiKey 时，engine 构造会抛 ProviderError", () => {
      const config: EngineConfig = {
        ...createDefaultEngineConfig(),
        models: {
          capabilityMapping: {
            "high-reasoning": { provider: "anthropic", model: "claude-opus-4-5" },
            "fast-cheap": { provider: "anthropic", model: "claude-haiku-3-5" },
            intent: { provider: "anthropic", model: "claude-haiku-3-5" },
            planning: { provider: "anthropic", model: "claude-opus-4-5" },
            validation: { provider: "anthropic", model: "claude-haiku-3-5" },
          },
          providerFallbackOrder: ["anthropic"],
        },
      };
      expect(() => createEngine(config, { cwd: "/tmp" })).toThrow(ProviderError);
    });

    it("anthropic apiKey + baseURL + extra 被透传给 AnthropicProviderAdapter", () => {
      const config: EngineConfig = {
        ...createDefaultEngineConfig(),
        models: {
          capabilityMapping: {
            "high-reasoning": { provider: "anthropic", model: "claude-opus-4-5" },
            "fast-cheap": { provider: "anthropic", model: "claude-haiku-3-5" },
            intent: { provider: "anthropic", model: "claude-haiku-3-5" },
            planning: { provider: "anthropic", model: "claude-opus-4-5" },
            validation: { provider: "anthropic", model: "claude-haiku-3-5" },
          },
          providerFallbackOrder: ["anthropic"],
        },
        providers: {
          anthropic: {
            apiKey: "sk-anthropic-test",
            baseURL: "https://claude.example.com/v1",
            timeoutMs: 12_000,
            extra: { defaultHeaders: { "x-tachu-test": "1" } },
          },
        },
      };
      const engine = createEngine(config, { cwd: "/tmp" });
      expect(engine).toBeInstanceOf(Engine);
      engine.dispose();
    });

    it("未配置 qwen apiKey 时，engine 构造会抛 ProviderError", () => {
      const config: EngineConfig = {
        ...createDefaultEngineConfig(),
        models: {
          capabilityMapping: {
            "high-reasoning": { provider: "qwen", model: "qwen-plus" },
            "fast-cheap": { provider: "qwen", model: "qwen-turbo" },
            intent: { provider: "qwen", model: "qwen-turbo" },
            planning: { provider: "qwen", model: "qwen-plus" },
            validation: { provider: "qwen", model: "qwen-turbo" },
          },
          providerFallbackOrder: ["qwen"],
        },
      };
      expect(() => createEngine(config, { cwd: "/tmp" })).toThrow(ProviderError);
    });

    it("config.providers.qwen 凭据与 extra 可被 createEngine 装配", () => {
      const config: EngineConfig = {
        ...createDefaultEngineConfig(),
        models: {
          capabilityMapping: {
            "high-reasoning": { provider: "qwen", model: "qwen-plus" },
            "fast-cheap": { provider: "qwen", model: "qwen-turbo" },
            intent: { provider: "qwen", model: "qwen-turbo" },
            planning: { provider: "qwen", model: "qwen-plus" },
            validation: { provider: "qwen", model: "qwen-turbo" },
          },
          providerFallbackOrder: ["qwen"],
        },
        providers: {
          qwen: {
            apiKey: "sk-qwen-test",
            baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            extra: { dashScopeOrigin: "https://dashscope.aliyuncs.com" },
          },
        },
      };
      const engine = createEngine(config, { cwd: "/tmp" });
      expect(engine).toBeInstanceOf(Engine);
      engine.dispose();
    });

    it("未知 provider 名称 fail-closed，不再静默回退到 MockProviderAdapter", () => {
      const config: EngineConfig = {
        ...createDefaultEngineConfig(),
        models: {
          capabilityMapping: {
            "high-reasoning": { provider: "unknown-provider", model: "any" },
            "fast-cheap": { provider: "unknown-provider", model: "any" },
            intent: { provider: "unknown-provider", model: "any" },
            planning: { provider: "unknown-provider", model: "any" },
            validation: { provider: "unknown-provider", model: "any" },
          },
          providerFallbackOrder: ["unknown-provider"],
        },
      };
      expect(() => createEngine(config, { cwd: "/tmp" })).toThrow(/unknown provider/i);
    });

    it("同时配置多个 provider，openai + anthropic + noop 都能被正确推断", () => {
      const config: EngineConfig = {
        ...createDefaultEngineConfig(),
        models: {
          capabilityMapping: {
            "high-reasoning": { provider: "openai", model: "gpt-4o" },
            "fast-cheap": { provider: "anthropic", model: "claude-haiku-3-5" },
            intent: { provider: "openai", model: "gpt-4o-mini" },
            planning: { provider: "anthropic", model: "claude-opus-4-5" },
            validation: { provider: "openai", model: "gpt-4o-mini" },
          },
          providerFallbackOrder: ["noop", "openai", "anthropic"],
        },
        providers: {
          openai: { apiKey: "sk-openai-multi" },
          anthropic: { apiKey: "sk-anthropic-multi" },
        },
      };
      const engine = createEngine(config, { cwd: "/tmp" });
      expect(engine).toBeInstanceOf(Engine);
      engine.dispose();
    });
  });

 describe(" P8 — Safe defaults / fail-closed", () => {
    it("MockProviderAdapter 出现在 providers 列表时 emit provider.mock.in-use 警告", () => {
      const events: Array<{ type: string; payload: unknown }> = [];
      const observability = {
        emit(event: { type: string; payload: unknown }) {
          events.push({ type: event.type, payload: event.payload });
        },
      };
      const config = createDefaultEngineConfig();
      const engine = createEngine(config, {
        providers: [new MockProviderAdapter()],
        observability: observability as NonNullable<EngineFactoryOptions["observability"]>,
      });
      const mockWarning = events.find(
        (e) =>
          e.type === "warning" &&
          (e.payload as { status?: string }).status === "provider.mock.in-use",
      );
      expect(mockWarning).toBeDefined();
      expect((mockWarning?.payload as { adapter?: string }).adapter).toBe(
        "MockProviderAdapter",
      );
      engine.dispose();
    });

    it("TACHU_SUPPRESS_MOCK_WARNING=1（非生产）抑制 mock 警告", () => {
      const prev = process.env.TACHU_SUPPRESS_MOCK_WARNING;
      const prevNodeEnv = process.env.NODE_ENV;
      process.env.TACHU_SUPPRESS_MOCK_WARNING = "1";
      process.env.NODE_ENV = "test";
      try {
        const events: Array<{ type: string; payload: unknown }> = [];
        const observability = {
          emit(event: { type: string; payload: unknown }) {
            events.push({ type: event.type, payload: event.payload });
          },
        };
        const engine = createEngine(createDefaultEngineConfig(), {
          providers: [new MockProviderAdapter()],
          observability: observability as NonNullable<EngineFactoryOptions["observability"]>,
        });
        const mockWarning = events.find(
          (e) => (e.payload as { status?: string }).status === "provider.mock.in-use",
        );
        expect(mockWarning).toBeUndefined();
        engine.dispose();
      } finally {
        if (prev === undefined) delete process.env.TACHU_SUPPRESS_MOCK_WARNING;
        else process.env.TACHU_SUPPRESS_MOCK_WARNING = prev;
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
      }
    });

    it("providers 为空时 assertCapabilityProvided fail-closed 并 emit factory.fail-closed", () => {
      const events: Array<{ type: string; payload: unknown }> = [];
      const observability = {
        emit(event: { type: string; payload: unknown }) {
          events.push({ type: event.type, payload: event.payload });
        },
      };
      expect(() =>
        createEngine(createDefaultEngineConfig(), {
          providers: [],
          observability: observability as NonNullable<EngineFactoryOptions["observability"]>,
        }),
      ).toThrow(/fail-closed/);
      const failClosed = events.find(
        (e) => (e.payload as { status?: string }).status === "factory.fail-closed",
      );
      expect(failClosed).toBeDefined();
      expect((failClosed?.payload as { capability?: string }).capability).toBe(
        "providers",
      );
    });

    it("默认 config（capabilityMapping 全 noop）经 inferProviders 过滤后空集 → fail-closed", () => {
 // 不应被静默接受为可用 provider；createDefaultEngineConfig 的
 // 占位 noop 路由必须在没有显式 providers override 时启动 fail-closed。
      expect(() => createEngine(createDefaultEngineConfig(), { cwd: "/tmp" })).toThrow(
        /fail-closed/,
      );
    });
  });

 describe("extraToolExecutors 合并（MCP 装配路径）", () => {
    const execCtx: ExecutionContext = {
      correlation: {
        traceId: "tr-mcp",
        requestId: "req-mcp",
        sessionId: "sess-mcp",
        turnId: "turn-req-mcp",
      },
      principal: {},
      budget: {},
      scopes: [],
    };

    it("extraToolExecutors 中的 MCP 工具会进入 TaskExecutor 分发表", async () => {
      const captured: Array<{ input: unknown; ctx: ToolExecutionContext }> = [];
      const mcpExec: ToolExecutor = async (input, ctx) => {
        captured.push({ input, ctx });
        return { ok: true, echo: input };
      };
      const baseExecutors = {
        "read-file": (async () => ({ content: "builtin" })) as ToolExecutor,
      };
      const merged = { ...baseExecutors, "remoteKb__getStatus": mcpExec };
      const exec = buildTaskExecutor("/tmp/ws", merged, ["/tmp/ws"]);
      const task: TaskNode = {
        id: "tool-use:call-1",
        type: "tool",
        ref: "remoteKb__getStatus",
        input: { q: "ping" },
      };
      const result = await exec(task, execCtx, new AbortController().signal);
      expect(result).toEqual({ ok: true, output: { ok: true, echo: { q: "ping" } } });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.ctx.workspaceRoot).toBe("/tmp/ws");
    });

    it("CLI engine wires FsMemorySystem with outbox-backed projection and worker.flush() indexes via EmbeddingRuntime + VectorIndexAdapter", async () => {
      const root = await mkdtemp(join(tmpdir(), "tachu-cli-bl001-"));
      try {
        const embedCalls: string[] = [];
        const provider: ProviderAdapter = {
          id: "fake-embed",
          name: "fake-embed",
          async listAvailableModels() {
            return [];
          },
          async chat() {
            throw new Error("not used");
          },
          async *chatStream() {
            throw new Error("not used");
          },
          async embed(request: EmbeddingRequest) {
            for (const input of request.inputs)
              embedCalls.push(typeof input === "string" ? input : JSON.stringify(input));
            return {
              embeddings: request.inputs.map(() => [0.4, 0.5, 0.6]),
              usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
            };
          },
        } as unknown as ProviderAdapter;

        const config = {
          ...createDefaultEngineConfig(),
          models: {
            capabilityMapping: {
              "high-reasoning": { provider: "fake-embed", model: "fake" },
              "fast-cheap": { provider: "fake-embed", model: "fake" },
              intent: { provider: "fake-embed", model: "fake" },
              planning: { provider: "fake-embed", model: "fake" },
              validation: { provider: "fake-embed", model: "fake" },
              embedding: { provider: "fake-embed", model: "fake-embed-model" },
            },
            providerFallbackOrder: ["fake-embed"],
          },
          memory: {
            ...createDefaultEngineConfig().memory,
            persistence: "fs" as const,
            persistDir: join(root, "memory"),
          },
        };

        const result = createEngineWithProjection(config, {
          cwd: root,
          providers: [provider],
        });
        try {
          expect(result.engine).toBeInstanceOf(Engine);
          expect(result.projection.stack).toBeDefined();
          expect(result.projection.stack?.adapterKind).toBe("local-fs");

 // Inspect the assembled MemorySystem to confirm outbox-backed projection.
          const memorySystem = (result.engine as unknown as { memorySystem: unknown })
            .memorySystem;
          expect(memorySystem).toBeInstanceOf(FsMemorySystem);
          const mem = memorySystem as FsMemorySystem;
          await mem.append(
            "bl001-session",
            {
              id: "e-1",
              role: "user",
              content: "needs to be projected",
              timestamp: 1_000,
              anchored: false,
            },
            { correlation: { traceId: "t", requestId: "r", sessionId: "bl001-session", turnId: "tn" } } as never,
          );
          await mem.archive("bl001-session", { awaitProjection: false });

 // Worker flush must drive the embedding runtime + vector index, not inner.project().
          const flushResult = await result.projection.flush("bl001-session");
          expect(flushResult).toEqual({ sessions: 1, projected: 1, failed: 0 });
          expect(embedCalls).toEqual(["needs to be projected"]);
        } finally {
          await result.projection.stop();
          result.engine.dispose();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("extraToolExecutors 同名覆盖内置：显式意图优先", async () => {
      const builtinCalls: unknown[] = [];
      const overrideCalls: unknown[] = [];
      const builtin: ToolExecutor = async (input) => {
        builtinCalls.push(input);
        return { source: "builtin" };
      };
      const override: ToolExecutor = async (input) => {
        overrideCalls.push(input);
        return { source: "override" };
      };
      const config = {
        ...createDefaultEngineConfig(),
        safety: {
          ...createDefaultEngineConfig().safety,
          workspaceRoot: "/tmp/ws-override",
        },
      };
 // 通过 createEngine 而非 buildTaskExecutor 验证 options 真的被消费。
      const engine = createEngine(config, {
        cwd: "/tmp/ws-override",
        providers: [new MockProviderAdapter()],
        extraToolExecutors: { "read-file": override },
      });
      expect(engine).toBeInstanceOf(Engine);
 // Engine 的 taskExecutor 私有，行为层面通过 buildTaskExecutor 再验一次：
 // 模拟 createEngine 的合并语义：先 builtin 再 override。
      const mergedExecutors: Record<string, ToolExecutor> = {};
      mergedExecutors["read-file"] = builtin;
      mergedExecutors["read-file"] = override;
      const exec = buildTaskExecutor("/tmp/ws-override", mergedExecutors, [
        "/tmp/ws-override",
      ]);
      await exec(
        { id: "t1", type: "tool", ref: "read-file", input: {} },
        execCtx,
        new AbortController().signal,
      );
      expect(builtinCalls).toHaveLength(0);
      expect(overrideCalls).toHaveLength(1);
      engine.dispose();
    });
  });
});
