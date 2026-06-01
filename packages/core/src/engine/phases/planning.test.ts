import { describe, expect, test } from "bun:test";

import { DefaultObservabilityEmitter } from "../../modules/observability";
import { InMemoryRuntimeState } from "../../modules/runtime-state";
import { DefaultModelRouter } from "../../modules/model-router";
import { InMemoryVectorStore } from "../../vector";
import { DescriptorRegistry } from "../../registry";
import {
  DefaultToolActivator,
  createDefaultToolCandidateStrategies,
} from "../tool-activation";
import type { ProviderAdapter } from "../../modules/provider";
import type {
  EngineConfig,
  EngineEvent,
  ExecutionContext,
  InputEnvelope,
  IntentResult,
} from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";

import { runPlanningPhase } from "./planning";
import type { PhaseEnvironment } from "./index";
import type { PrecheckPhaseOutput } from "./precheck";

const buildConfig = (): EngineConfig => ({
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: {
    planMode: false,
    maxConcurrency: 2,
    defaultTaskTimeoutMs: 3_000,
    failFast: false,
  },
  memory: {
    contextTokenLimit: 2_000,
    compressionThreshold: 0.8,
    headKeep: 2,
    tailKeep: 2,
    archivePath: ".tachu/archive/planning-test.jsonl",
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

const buildPrecheckState = (
  content: string,
  intent: IntentResult,
  sessionId = "s-planning",
): PrecheckPhaseOutput => {
  const input: InputEnvelope = {
    content,
    metadata: { modality: "text", size: content.length },
  };
  const context: ExecutionContext = {
    correlation: {
      traceId: "t-planning",
      requestId: "r-planning",
      sessionId,
      turnId: "turn-r-planning",
    },
    principal: {},
    budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
    scopes: ["*"],
  };
  return {
    input,
    context,
    violations: [],
    intent,
  };
};

const buildEnv = (
  opts?: { toolNames?: string[]; agentNames?: string[] },
): { env: PhaseEnvironment; events: EngineEvent[] } => {
  const config = buildConfig();
  const observability = new DefaultObservabilityEmitter();
  const events: EngineEvent[] = [];
  observability.on("*", (e) => events.push(e));
  const vectorStore = new InMemoryVectorStore({
    indexLimit: config.memory.vectorIndexLimit,
  });
  const registry = new DescriptorRegistry({ vectorStore });
  for (const name of opts?.toolNames ?? []) {
    void registry.register({
      kind: "tool",
      name,
      description: `${name} 测试工具`,
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 5_000,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      execute: "<stub>",
    });
  }
  for (const name of opts?.agentNames ?? []) {
    void registry.register({
      kind: "agent",
      name,
      description: `${name} 测试 agent`,
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 5_000,
      maxDepth: 1,
      availableTools: ["read-file"],
      instructions: "只处理被分派的目标。",
    });
  }
  const env: PhaseEnvironment = {
    config,
    registry,
    sessionManager: {} as never,
    memorySystem: {} as never,
    runtimeState: new InMemoryRuntimeState(),
    modelRouter: new DefaultModelRouter(config),
    providers: new Map<string, ProviderAdapter>(),
    safetyModule: {} as never,
    observability,
    hooks: {} as never,
    scheduler: {} as never,
    activeAbortSignal: new AbortController().signal,
    adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    toolActivator: new DefaultToolActivator({
      strategies: createDefaultToolCandidateStrategies(),
    }),
  };
  return { env, events };
};

describe("runPlanningPhase (Phase 5 — Task Planning, 路由)", () => {
 test("simple 意图 → 单步 direct-answer 任务", async () => {
    const { env } = buildEnv({ toolNames: ["list-dir"] });
    const state = buildPrecheckState("你好", {
      intent: "greeting",
      complexity: "simple",
      contextRelevance: "related",
    });
    const { planning } = await runPlanningPhase(state, env);
    expect(planning.plans).toHaveLength(1);
    const tasks = planning.plans[0]?.tasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-direct-answer",
      type: "sub-flow",
      ref: "direct-answer",
    });
 // simple 路径不带 warn=true
    expect((tasks[0]?.input as { warn?: unknown }).warn).toBeUndefined();
  });

 test("includeTools + simple intent → tool-use (intent-turn-policy-include)", async () => {
    const { env, events } = buildEnv({ toolNames: ["image.qwen", "currentDate"] });
    const state = buildPrecheckState("draw a cat", {
      intent: "generate an image of a cat",
      complexity: "simple",
      contextRelevance: "related",
    });
    state.input.metadata = {
      ...state.input.metadata,
      turnPolicy: {
        excludeTools: [],
        includeTools: ["image.qwen"],
        explicitSkills: [],
        excludeSkills: [],
        pinSkills: [],
        visualization: "",
      },
    };
    const { planning } = await runPlanningPhase(state, env);
    const task = planning.plans[0]?.tasks?.[0];
    expect(task).toMatchObject({
      id: "task-tool-use",
      ref: "tool-use",
    });
    expect(task?.input).toEqual({
      prompt: "generate an image of a cat",
      toolNames: ["image.qwen"],
    });
    const decisionEvent = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "intent-turn-policy-include",
    );
    expect(decisionEvent).toBeDefined();
  });

 test("explicit tool mention overrides includeTools routing", async () => {
    const { env, events } = buildEnv({ toolNames: ["image.qwen", "currentDate"] });
    const state = buildPrecheckState("使用 image.qwen 工具画一只猫", {
      intent: "draw a cat",
      complexity: "simple",
      contextRelevance: "related",
    });
    state.input.metadata = {
      ...state.input.metadata,
      turnPolicy: {
        excludeTools: [],
        includeTools: ["currentDate"],
        explicitSkills: [],
        excludeSkills: [],
        pinSkills: [],
        visualization: "",
      },
    };
    env.scope = { explicitToolNames: ["image.qwen"] };
    const { planning } = await runPlanningPhase(state, env);
    const task = planning.plans[0]?.tasks?.[0];
    expect((task?.input as { toolNames?: string[] }).toolNames).toContain("image.qwen");
    const decisionEvent = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "explicit-tool-mention",
    );
    expect(decisionEvent).toBeDefined();
  });

 test("explicit agent mention routes to scoped agent task", async () => {
    const { env, events } = buildEnv({ agentNames: ["reviewer"] });
    const state = buildPrecheckState("请让 reviewer 检查 ADR 变更", {
      intent: "review ADR changes",
      complexity: "complex",
      contextRelevance: "related",
    });
    const { planning } = await runPlanningPhase(state, env);
    const task = planning.plans[0]?.tasks?.[0];
    expect(task).toMatchObject({
      id: "task-agent-reviewer",
      type: "agent",
      ref: "reviewer",
      input: { objective: "review ADR changes" },
    });
    const decisionEvent = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "explicit-agent-mention",
    );
    expect(decisionEvent).toBeDefined();
  });

 test("complex 意图 + 有工具 → 单步 tool-use 任务（Agentic Loop）", async () => {
    const { env, events } = buildEnv({
      toolNames: ["list-dir", "read-file", "run-shell"],
    });
    const state = buildPrecheckState("列目录并修改文件", {
      intent: "refactor project",
      complexity: "complex",
      contextRelevance: "related",
    });
    const { planning } = await runPlanningPhase(state, env);
    const tasks = planning.plans[0]?.tasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-tool-use",
      type: "sub-flow",
      ref: "tool-use",
    });
    expect(tasks[0]?.input).toEqual({ prompt: "refactor project" });
 // 路由决策需要一条 decision=tool-use 的 observability 记录
    const decisionEvent = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { decision?: string }).decision === "tool-use",
    );
    expect(decisionEvent).toBeDefined();
  });

 test("当前时间类请求只暴露 run-shell 给 tool-use", async () => {
    const { env, events } = buildEnv({
      toolNames: ["list-dir", "read-file", "run-shell"],
    });
    const state = buildPrecheckState("当前时间", {
      intent: "look up the current time",
      complexity: "complex",
      contextRelevance: "related",
    });
    const { planning } = await runPlanningPhase(state, env);
    const task = planning.plans[0]?.tasks?.[0];
    expect(task).toMatchObject({
      id: "task-tool-use",
      ref: "tool-use",
    });
    expect(task?.input).toEqual({
      prompt: "look up the current time",
      toolNames: ["run-shell"],
    });
    const decisionEvent = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { decision?: string }).decision === "tool-use",
    );
    expect((decisionEvent?.payload as { selectedToolNames?: string[] }).selectedToolNames).toEqual([
      "run-shell",
    ]);
  });

 test("complex 意图 + 无工具 → direct-answer warn=true 兜底", async () => {
    const { env, events } = buildEnv({ toolNames: [] });
    const state = buildPrecheckState("请帮我写代码", {
      intent: "write code",
      complexity: "complex",
      contextRelevance: "related",
    });
    const { planning } = await runPlanningPhase(state, env);
    const tasks = planning.plans[0]?.tasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "task-direct-answer",
      ref: "direct-answer",
    });
    expect((tasks[0]?.input as { warn?: unknown }).warn).toBe(true);
    const warnEvent = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "warning" &&
        typeof (e.payload as { reason?: unknown }).reason === "string",
    );
    expect(warnEvent).toBeDefined();
  });

 test("previousAttempt 注入时 emit previous-attempt-injected 事件（ P1 δ）", async () => {
    const { env, events } = buildEnv({ toolNames: ["list-dir"] });
    env.previousAttempt = {
      retryCount: 1,
      lastOutcomeKind: "retry",
      target: "next-plan",
      reason: "deterministic-rule-x failed",
      diagnosis: "tool output truncated",
    };
    const state = buildPrecheckState("继续重试", {
      intent: "retry",
      complexity: "complex",
      contextRelevance: "related",
    });
    await runPlanningPhase(state, env);
    const injected = events.find(
      (e) =>
        e.phase === "planning" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "previous-attempt-injected",
    );
    expect(injected).toBeDefined();
    expect((injected?.payload as { previousAttempt?: unknown }).previousAttempt).toEqual({
      retryCount: 1,
      lastOutcomeKind: "retry",
      target: "next-plan",
      reason: "deterministic-rule-x failed",
      diagnosis: "tool output truncated",
    });
  });

 test(" P4 γ: env.semanticRetrieval 透传到 toolActivator.activate()", async () => {
    const { env } = buildEnv({ toolNames: ["list-dir"] });
    let capturedSemanticRetrieval: unknown = "not-captured";
    env.toolActivator = {
      async activate(ctx: { semanticRetrieval?: unknown }) {
        capturedSemanticRetrieval = ctx.semanticRetrieval;
        return {
          visibleTools: [],
          matchedToolNames: [],
          fallbackUsed: false,
          perStrategyMs: {},
          trace: [],
        };
      },
    } as unknown as NonNullable<PhaseEnvironment["toolActivator"]>;
    const fakeFacade = { retrieve: async () => ({ hits: [] }) };
    env.semanticRetrieval = fakeFacade as unknown as NonNullable<
      PhaseEnvironment["semanticRetrieval"]
    >;
    const state = buildPrecheckState("路由测试", {
      intent: "list",
      complexity: "complex",
      contextRelevance: "related",
    });
    await runPlanningPhase(state, env);
    expect(capturedSemanticRetrieval).toBe(fakeFacade);
  });

 test("未注入 previousAttempt 时不 emit 该事件", async () => {
    const { env, events } = buildEnv({ toolNames: ["list-dir"] });
    const state = buildPrecheckState("首次", {
      intent: "greeting",
      complexity: "simple",
      contextRelevance: "related",
    });
    await runPlanningPhase(state, env);
    const injected = events.find(
      (e) =>
        e.phase === "planning" &&
        (e.payload as { reason?: string }).reason === "previous-attempt-injected",
    );
    expect(injected).toBeUndefined();
  });

 test("intent.intent 为空字符串时使用原 prompt 作为 tool-use 输入", async () => {
    const { env } = buildEnv({ toolNames: ["list-dir"] });
    const state = buildPrecheckState("raw input when intent empty", {
      intent: "",
      complexity: "complex",
      contextRelevance: "related",
    });
    const { planning } = await runPlanningPhase(state, env);
    const task = planning.plans[0]?.tasks?.[0];
    expect(task?.input).toEqual({ prompt: "raw input when intent empty" });
  });
});
