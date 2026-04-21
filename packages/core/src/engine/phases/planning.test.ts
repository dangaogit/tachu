import { describe, expect, test } from "bun:test";

import { DefaultObservabilityEmitter } from "../../modules/observability";
import { InMemoryRuntimeState } from "../../modules/runtime-state";
import { DefaultModelRouter } from "../../modules/model-router";
import { InMemoryVectorStore } from "../../vector";
import { DescriptorRegistry } from "../../registry";
import type { ProviderAdapter } from "../../modules/provider";
import type {
  EngineConfig,
  EngineEvent,
  ExecutionContext,
  InputEnvelope,
  IntentResult,
} from "../../types";

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
    requestId: "r-planning",
    sessionId,
    traceId: "t-planning",
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
  opts?: { toolNames?: string[] },
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
  };
  return { env, events };
};

describe("runPlanningPhase (Phase 5 — Task Planning, ADR-0002 路由)", () => {
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
