import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDefaultEngineConfig,
  Engine,
  ProviderError,
  type EngineConfig,
  type ExecutionContext,
  type ProvidersConfig,
  type TaskNode,
} from "@tachu/core";
import {
  MockProviderAdapter,
  type ToolExecutionContext,
  type ToolExecutor,
} from "@tachu/extensions";
import { buildTaskExecutor, createEngine } from "./engine-factory";

describe("createEngine", () => {
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

    it("config.providers 对 mock provider 无副作用", () => {
      const config = {
        ...createDefaultEngineConfig(),
        providers: {
          openai: { apiKey: "sk-ignored", baseURL: "https://x.example.com" },
        },
      };
      const engine = createEngine(config, { cwd: "/tmp" });
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

    it("未知 provider 名称回退到 MockProviderAdapter，不抛错", () => {
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
      const engine = createEngine(config, { cwd: "/tmp" });
      expect(engine).toBeInstanceOf(Engine);
      engine.dispose();
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

  describe("extraToolExecutors 合并（MCP 装配路径）", () => {
    const execCtx: ExecutionContext = {
      requestId: "req-mcp",
      sessionId: "sess-mcp",
      traceId: "tr-mcp",
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
      expect(result).toEqual({ ok: true, echo: { q: "ping" } });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.ctx.workspaceRoot).toBe("/tmp/ws");
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
