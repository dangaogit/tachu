import { describe, expect, test } from "bun:test";

import { DefaultObservabilityEmitter } from "../../modules/observability";
import { InMemoryRuntimeState } from "../../modules/runtime-state";
import { DefaultModelRouter } from "../../modules/model-router";
import { NoopProvider } from "../../modules/provider";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ProviderAdapter,
} from "../../modules/provider";
import type { MemorySystem, ContextWindow, MemoryEntry } from "../../modules/memory";
import type { EngineConfig, EngineEvent, ExecutionContext, InputEnvelope } from "../../types";
import { buildTextToImageInputEnvelope } from "../../utils/multimodal-envelope";

import { runIntentPhase, __testing as intentInternals } from "./intent";
import type { PhaseEnvironment } from "./index";
import type { SafetyPhaseOutput } from "./safety";

// ---- shared fixtures -------------------------------------------------------

const buildConfig = (): EngineConfig => ({
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: { planMode: false, maxConcurrency: 2, defaultTaskTimeoutMs: 3_000, failFast: false },
  memory: {
    contextTokenLimit: 2_000,
    compressionThreshold: 0.8,
    headKeep: 2,
    tailKeep: 2,
    archivePath: ".tachu/archive/intent-test.jsonl",
    vectorIndexLimit: 500,
  },
  budget: { maxTokens: 5_000, maxToolCalls: 10, maxWallTimeMs: 60_000 },
  safety: {
    maxInputSizeBytes: 1_024 * 1_024,
    maxRecursionDepth: 4,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "mock", model: "mock-intent" },
      planning: { provider: "mock", model: "mock-planning" },
      validation: { provider: "mock", model: "mock-validation" },
      "fast-cheap": { provider: "mock", model: "mock-fast" },
      "high-reasoning": { provider: "mock", model: "mock-large" },
    },
    providerFallbackOrder: ["mock"],
  },
  observability: { enabled: true, maskSensitiveData: false },
  hooks: { writeHookTimeout: 500, failureBehavior: "continue" },
});

const buildSafetyState = (content: string, sessionId = "s-intent"): SafetyPhaseOutput => {
  const input: InputEnvelope = {
    content,
    metadata: { modality: "text", size: content.length },
  };
  const context: ExecutionContext = {
    requestId: "r-intent",
    sessionId,
    traceId: "t-intent",
    principal: {},
    budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
    scopes: ["*"],
  };
  return { input, context, violations: [] };
};

/**
 * 最小 MemorySystem 实现 —— 只需要 `load` 返回一个带 entries 的窗口。
 */
const buildMemoryStub = (history: MemoryEntry[] = []): MemorySystem => {
  const window: ContextWindow = {
    entries: history,
    tokenCount: 0,
    limit: 2_000,
  };
  return {
    async load() {
      return window;
    },
    async append() {
      /* no-op */
    },
    async compress() {
      /* no-op */
    },
    async recall() {
      return [];
    },
    async archive() {
      /* no-op */
    },
    async getSize() {
      return { entries: 0, tokens: 0 };
    },
    async trim() {
      /* no-op */
    },
    async clear() {
      /* no-op */
    },
  };
};

class StubProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly name = "StubProvider";
  constructor(private readonly impl: (req: ChatRequest, signal?: AbortSignal) => Promise<ChatResponse>) {}

  async listAvailableModels() {
    return [];
  }

  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.impl(request, signal);
  }

  async *chatStream(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<ChatStreamChunk> {
    /* not used by intent phase */
    yield { type: "finish", finishReason: "stop" };
  }
}

const buildEnv = (
  provider: ProviderAdapter,
  history: MemoryEntry[] = [],
  signal: AbortSignal = new AbortController().signal,
): {
  env: PhaseEnvironment;
  events: EngineEvent[];
} => {
  const config = buildConfig();
  const observability = new DefaultObservabilityEmitter();
  const events: EngineEvent[] = [];
  observability.on("*", (e) => events.push(e));
  const env: PhaseEnvironment = {
    config,
    registry: {} as never,
    sessionManager: {} as never,
    memorySystem: buildMemoryStub(history),
    runtimeState: new InMemoryRuntimeState(),
    modelRouter: new DefaultModelRouter(config),
    providers: new Map<string, ProviderAdapter>([[provider.id, provider]]),
    safetyModule: {} as never,
    observability,
    hooks: {} as never,
    scheduler: {} as never,
    activeAbortSignal: signal,
  };
  return { env, events };
};

// ---- tests -----------------------------------------------------------------

describe("runIntentPhase (Phase 3 — Intent Analysis, pure classification)", () => {
  test("system prompt 强约束：只分类、禁写 directAnswer、覆盖 complex 示例", async () => {
    let capturedSystemPrompt = "";
    const provider = new StubProvider(async (req) => {
      const firstContent = req.messages[0]?.content ?? "";
      capturedSystemPrompt =
        typeof firstContent === "string"
          ? firstContent
          : firstContent
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
      return {
        content: JSON.stringify({
          complexity: "simple",
          intent: "noop",
          contextRelevance: "unrelated",
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });
    const { env } = buildEnv(provider);
    await runIntentPhase(buildSafetyState("ping"), env);

    expect(capturedSystemPrompt).toContain("真实工具");
    expect(capturedSystemPrompt).toContain("仅仅是分类");
    expect(capturedSystemPrompt).toContain("direct-answer");
    expect(capturedSystemPrompt).toContain("不要");
    expect(capturedSystemPrompt).toContain("directAnswer / answer / reply");
    expect(capturedSystemPrompt).toContain("convert TS package to Go");
  });

  test("LLM 返回合法 JSON → 按 3 字段 schema 解析（不含 directAnswer）", async () => {
    const provider = new StubProvider(async (req) => {
      expect(req.model).toBe("mock-intent");
      expect(req.messages[0]?.role).toBe("system");
      expect(req.messages.at(-1)?.role).toBe("user");
      return {
        content: JSON.stringify({
          complexity: "simple",
          intent: "问候",
          contextRelevance: "unrelated",
        }),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    });
    const { env, events } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("你好"), env);

    expect(out.intent.complexity).toBe("simple");
    expect(out.intent.intent).toBe("问候");
    expect(out.intent.contextRelevance).toBe("unrelated");
    expect(Object.prototype.hasOwnProperty.call(out.intent, "directAnswer")).toBe(false);
    expect(events.some((e) => e.type === "llm_call_start" && e.phase === "intent")).toBe(true);
    expect(events.some((e) => e.type === "llm_call_end" && e.phase === "intent")).toBe(true);
  });

  test("LLM 返回 textToImage:true → 写入信封 metadata 并保留 intent.textToImage", async () => {
    const provider = new StubProvider(async () => ({
      content: JSON.stringify({
        complexity: "simple",
        intent: "text-to-image: cat",
        contextRelevance: "unrelated",
        textToImage: true,
      }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const { env } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("生成一只小猫"), env);
    expect(out.intent.textToImage).toBe(true);
    expect(out.input.metadata?.textToImage).toBe(true);
  });

  test("显式文生图信封（explicitTextToImage）跳过 Intent LLM", async () => {
    let calls = 0;
    const provider = new StubProvider(async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          complexity: "simple",
          intent: "noop",
          contextRelevance: "unrelated",
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });
    const { env } = buildEnv(provider);
    const base = buildSafetyState("");
    const out = await runIntentPhase(
      {
        ...base,
        input: buildTextToImageInputEnvelope("一只猫", "test-skip-intent"),
      },
      env,
    );
    expect(calls).toBe(0);
    expect(out.intent.textToImage).toBe(true);
    expect(out.input.metadata?.explicitTextToImage).toBe(true);
  });

  test("LLM 返回 complex JSON → 不触发任何 directAnswer 相关字段", async () => {
    const provider = new StubProvider(async () => ({
      content: JSON.stringify({
        complexity: "complex",
        intent: "重构整个模块",
        contextRelevance: "related",
      }),
      usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
    }));
    const { env } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("请帮我把 A 重构成 B，然后加测试"), env);

    expect(out.intent.complexity).toBe("complex");
    expect(Object.prototype.hasOwnProperty.call(out.intent, "directAnswer")).toBe(false);
  });

  test("JSON 包在 ```json 围栏 里也能解析", async () => {
    const provider = new StubProvider(async () => ({
      content: "解析如下：\n```json\n{\"complexity\":\"simple\",\"intent\":\"qa\",\"contextRelevance\":\"related\"}\n```",
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    }));
    const { env } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("生命的意义是什么？"), env);

    expect(out.intent.complexity).toBe("simple");
    expect(out.intent.intent).toBe("qa");
  });

  test("LLM 给出自然语言但未遵守 JSON 协议 → 吸收为 simple 意图摘要，交由 direct-answer 兜底", async () => {
    // 关键语义：raw text 只作为 intent 摘要（≤200 字符），不再塞 directAnswer 字段。
    // 最终答复由后续 Phase 7 的 direct-answer Sub-flow 以同样的 raw text 作为 prompt 重新生成。
    const naturalText = "这是一个关于 Bun 的小笑话……";
    const provider = new StubProvider(async () => ({
      content: naturalText,
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    }));
    const { env, events } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("讲个笑话"), env);

    expect(out.intent.complexity).toBe("simple");
    expect(out.intent.intent.length).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(out.intent, "directAnswer")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "llm_call_end" &&
          e.phase === "intent" &&
          (e.payload as { parsed?: boolean }).parsed === false &&
          (e.payload as { acceptedRawText?: boolean }).acceptedRawText === true,
      ),
    ).toBe(true);
  });

  test("LLM 返回空串 → 走启发式兜底，intent 摘要回落为原始输入前缀", async () => {
    const provider = new StubProvider(async () => ({
      content: "   ",
      usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
    }));
    const { env, events } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("你好"), env);

    expect(out.intent.complexity).toBe("simple");
    expect(out.intent.intent).toBe("你好");
    expect(Object.prototype.hasOwnProperty.call(out.intent, "directAnswer")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "llm_call_end" &&
          e.phase === "intent" &&
          (e.payload as { parsed?: boolean }).parsed === false &&
          (e.payload as { acceptedRawText?: boolean }).acceptedRawText === false,
      ),
    ).toBe(true);
  });

  test("Provider 抛错 → 启发式兜底，intent 摘要为原始输入前缀", async () => {
    const provider = new StubProvider(async () => {
      throw new Error("gateway timeout");
    });
    const { env, events } = buildEnv(provider);
    const out = await runIntentPhase(buildSafetyState("hi"), env);

    expect(out.intent.complexity).toBe("simple");
    expect(out.intent.intent).toBe("hi");
    expect(
      events.some(
        (e) =>
          e.type === "warning" &&
          e.phase === "intent" &&
          typeof (e.payload as { message?: string }).message === "string" &&
          (e.payload as { message: string }).message.includes("gateway timeout"),
      ),
    ).toBe(true);
  });

  test("provider 未注册时回退到启发式（不阻塞主干）", async () => {
    const orphan = new NoopProvider();
    const config = buildConfig();
    const observability = new DefaultObservabilityEmitter();
    const events: EngineEvent[] = [];
    observability.on("*", (e) => events.push(e));
    const env: PhaseEnvironment = {
      config,
      registry: {} as never,
      sessionManager: {} as never,
      memorySystem: buildMemoryStub(),
      runtimeState: new InMemoryRuntimeState(),
      modelRouter: new DefaultModelRouter(config),
      providers: new Map<string, ProviderAdapter>([[orphan.id, orphan]]),
      safetyModule: {} as never,
      observability,
      hooks: {} as never,
      scheduler: {} as never,
      activeAbortSignal: new AbortController().signal,
    };

    const out = await runIntentPhase(buildSafetyState("这是一个拆分成多个步骤的复杂任务"), env);
    expect(out.intent.complexity).toBe("complex");
    expect(
      events.some(
        (e) =>
          e.type === "warning" &&
          e.phase === "intent" &&
          String((e.payload as { reason?: string }).reason ?? "").includes("not registered"),
      ),
    ).toBe(true);
  });

  test("注入近 N 条历史（上限 10）到 LLM messages", async () => {
    let captured: ChatRequest | null = null;
    const provider = new StubProvider(async (req) => {
      captured = req;
      return {
        content: JSON.stringify({
          complexity: "simple",
          intent: "continue chat",
          contextRelevance: "related",
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const history: MemoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
      timestamp: Date.now() - (15 - i) * 1_000,
      anchored: false,
    }));

    const { env } = buildEnv(provider, history);
    await runIntentPhase(buildSafetyState("new turn"), env);

    expect(captured).not.toBeNull();
    const req = captured as unknown as ChatRequest;
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages.length).toBeLessThanOrEqual(1 + 10 + 1);
    expect(req.messages.length).toBeGreaterThanOrEqual(1 + 1);
    expect(req.messages.at(-1)?.role).toBe("user");
    expect(req.messages.at(-1)?.content).toBe("new turn");
  });

  test("activeAbortSignal 已 abort → Phase 3 仍返回 IntentResult（不阻塞主干）", async () => {
    const provider = new StubProvider(async (_req, signal) => {
      if (signal?.aborted) {
        throw new Error("request aborted");
      }
      return {
        content: "{}",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });
    const controller = new AbortController();
    controller.abort(new Error("client cancelled"));
    const { env, events } = buildEnv(provider, [], controller.signal);

    const out = await runIntentPhase(buildSafetyState("hi"), env);
    expect(out.intent).toBeDefined();
    expect(out.intent.complexity).toBe("simple");
    expect(events.some((e) => e.type === "warning" && e.phase === "intent")).toBe(true);
  });

  test("system prompt 包含 URL/路径/命令强 complex 信号的显式说明与示例", async () => {
    let capturedSystemPrompt = "";
    const provider = new StubProvider(async (req) => {
      const firstContent = req.messages[0]?.content ?? "";
      capturedSystemPrompt =
        typeof firstContent === "string"
          ? firstContent
          : firstContent.map((p) => (p.type === "text" ? p.text : "")).join("");
      return {
        content: JSON.stringify({
          complexity: "complex",
          intent: "noop",
          contextRelevance: "unrelated",
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });
    const { env } = buildEnv(provider);
    await runIntentPhase(buildSafetyState("ping"), env);

    expect(capturedSystemPrompt).toContain("http/https URL");
    expect(capturedSystemPrompt).toContain("本地文件路径");
    expect(capturedSystemPrompt).toContain("shell/git 命令");
    expect(capturedSystemPrompt).toContain("bazel.build");
  });

  test("LLM 判 simple 但输入含 URL → 强制升级为 complex，并记录 warning", async () => {
    const provider = new StubProvider(async () => ({
      content: JSON.stringify({
        complexity: "simple",
        intent: "summarize bazel page",
        contextRelevance: "unrelated",
      }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));
    const { env, events } = buildEnv(provider);
    const out = await runIntentPhase(
      buildSafetyState(
        "总结一下 https://bazel.build/rules/lib/globals/module?hl=zh-cn#use_repo_rule",
      ),
      env,
    );

    expect(out.intent.complexity).toBe("complex");
    expect(
      events.some(
        (e) =>
          e.type === "warning" &&
          e.phase === "intent" &&
          String((e.payload as { reason?: string }).reason ?? "").includes(
            "strong complex markers",
          ),
      ),
    ).toBe(true);
  });

  test("LLM 判 simple 且输入含本地路径 → 强制升级为 complex", async () => {
    const provider = new StubProvider(async () => ({
      content: JSON.stringify({
        complexity: "simple",
        intent: "explain intent.ts",
        contextRelevance: "unrelated",
      }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));
    const { env } = buildEnv(provider);
    const out = await runIntentPhase(
      buildSafetyState("解释一下 packages/core/src/engine/phases/intent.ts 里 STRONG_SIMPLE_MARKERS"),
      env,
    );

    expect(out.intent.complexity).toBe("complex");
  });

  test("LLM 正确判 complex → 不重复 warning（守护只在 simple→complex 时触发）", async () => {
    const provider = new StubProvider(async () => ({
      content: JSON.stringify({
        complexity: "complex",
        intent: "fetch bazel page",
        contextRelevance: "unrelated",
      }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));
    const { env, events } = buildEnv(provider);
    await runIntentPhase(
      buildSafetyState("总结一下 https://bazel.build/rules/lib/globals/module"),
      env,
    );

    expect(
      events.some(
        (e) =>
          e.type === "warning" &&
          e.phase === "intent" &&
          String((e.payload as { reason?: string }).reason ?? "").includes(
            "strong complex markers",
          ),
      ),
    ).toBe(false);
  });
});

// ---- 启发式 fallback 独立单元测试 ------------------------------------------

describe("inferComplexityFallback + hasStrongComplexMarker (URL/路径/命令/时效)", () => {
  const { hasStrongComplexMarker, inferComplexityFallback } = intentInternals;

  test.each([
    ["空字符串", "", "simple"],
    ["问候", "你好", "simple"],
    ["讲笑话", "讲个笑话", "simple"],
    ["写冒泡", "写个冒泡排序", "simple"],
  ] as const)("基准：%s → %s", (_label, input, expected) => {
    expect(inferComplexityFallback(input)).toBe(expected);
  });

  test.each([
    ["裸 URL", "https://example.com/a/b"],
    ["总结 URL（总结白名单被压倒）", "总结一下 https://bazel.build/rules/lib/globals/module?hl=zh-cn"],
    ["解释 URL", "解释 http://foo.bar/baz"],
    ["英文 fetch URL", "summarize https://openai.com"],
  ] as const)("URL 强信号：%s → complex", (_label, input) => {
    expect(hasStrongComplexMarker(input)).toBe(true);
    expect(inferComplexityFallback(input)).toBe("complex");
  });

  test.each([
    ["相对路径带扩展名", "解释 ./src/foo.ts"],
    ["packages/ 子路径", "解释 packages/core/src/engine/phases/intent.ts 的逻辑"],
    ["src/xxx 路径", "改一下 src/index.ts"],
    ["家目录 dotfile", "读一下 ~/.zshrc"],
    ["Windows 路径", "打开 C:\\Users\\dg\\app.log"],
  ] as const)("路径强信号：%s → complex", (_label, input) => {
    expect(hasStrongComplexMarker(input)).toBe(true);
    expect(inferComplexityFallback(input)).toBe("complex");
  });

  test.each([
    ["中文 运行 git", "运行 git log --oneline"],
    ["中文 执行 bun test", "请执行 bun test"],
    ["英文 run npm", "run npm install"],
    ["读取日志", "读取一下日志"],
    ["list directory", "list the directory"],
  ] as const)("命令/动作强信号：%s → complex", (_label, input) => {
    expect(hasStrongComplexMarker(input)).toBe(true);
    expect(inferComplexityFallback(input)).toBe("complex");
  });

  test.each([
    ["今天股价", "今天 A 股收盘点位"],
    ["实时天气", "现在北京的天气"],
    ["latest news", "latest news on openai"],
  ] as const)("时效强信号：%s → complex", (_label, input) => {
    expect(hasStrongComplexMarker(input)).toBe(true);
    expect(inferComplexityFallback(input)).toBe("complex");
  });

  test("纯知识问答即便含“总结/翻译”也保持 simple（无 URL/路径/命令时）", () => {
    expect(inferComplexityFallback("总结一下冒泡排序的思想")).toBe("simple");
    expect(inferComplexityFallback("翻译一下 hello world")).toBe("simple");
  });
});
