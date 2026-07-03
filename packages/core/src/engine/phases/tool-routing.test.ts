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
import type { EngineConfig, EngineEvent, ExecutionContext, InputEnvelope } from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";

import { runToolRoutingPhase, __toolRoutingTesting } from "./tool-routing";
import type { PhaseEnvironment } from "./index";
import type { SafetyPhaseOutput } from "./safety";

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
    archivePath: ".tachu/archive/tool-routing-test.jsonl",
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
      "fast-cheap": { provider: "mock", model: "mock-fast" },
      "high-reasoning": { provider: "mock", model: "mock-large" },
    },
    providerFallbackOrder: ["mock"],
  },
  observability: { enabled: true, maskSensitiveData: false },
  hooks: { writeHookTimeout: 500, failureBehavior: "continue" },
});

const buildState = (content: string, sessionId = "s-tool-routing"): SafetyPhaseOutput => {
  const input: InputEnvelope = {
    content,
    metadata: { modality: "text", size: content.length },
  };
  const context: ExecutionContext = {
    correlation: {
      traceId: "t-tool-routing",
      requestId: "r-tool-routing",
      sessionId,
      turnId: "turn-r-tool-routing",
    },
    principal: {},
    budget: { maxTokens: 2_000, maxDurationMs: 5_000 },
    scopes: ["*"],
  };
  return { input, context, violations: [] };
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

describe("runToolRoutingPhase (ADR-0006 D1/D5 — 取代旧前置分类、计划路由与图校验步骤)", () => {
  test("无匹配工具时仍产出单步 tool-use 任务(subsumes direct-answer:零工具由 loop 自然承接)", async () => {
    const { env } = buildEnv();
    const state = buildState("你好");
    const { route } = await runToolRoutingPhase(state, env);
    const tasks = route.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "task-tool-use", type: "sub-flow", ref: "tool-use" });
    expect((tasks[0]?.input as { toolNames?: unknown }).toolNames).toBeUndefined();
  });

  test("includeTools(pre-seeded turnPolicy)→ tool-use 任务带 toolNames", async () => {
    const { env, events } = buildEnv({ toolNames: ["image.qwen", "currentDate"] });
    const state = buildState("draw a cat");
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
    const { route } = await runToolRoutingPhase(state, env);
    const task = route.tasks[0];
    expect(task).toMatchObject({ id: "task-tool-use", ref: "tool-use" });
    expect(task?.input).toEqual({ prompt: "draw a cat", toolNames: ["image.qwen"] });
    const decisionEvent = events.find(
      (e) =>
        e.phase === "preLLM" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "turn-policy-include",
    );
    expect(decisionEvent).toBeDefined();
  });

  test("includeTools + discoveryExpansion → tool-use 收到同域兄弟工具（pinned 排前）", async () => {
    const { env } = buildEnv({
      toolNames: ["query_database", "search_ontology", "list_databases", "unrelated"],
    });
    env.config.runtime.toolActivation = {
      discoveryExpansion: {
        enabled: true,
        siblings: { query_database: ["search_ontology", "list_databases"] },
      },
    };
    const state = buildState("去年报警数据汇总");
    state.input.metadata = {
      ...state.input.metadata,
      turnPolicy: {
        excludeTools: [],
        includeTools: ["query_database"],
        explicitSkills: [],
        excludeSkills: [],
        pinSkills: [],
        visualization: "",
      },
    };
    const { route } = await runToolRoutingPhase(state, env);
    const task = route.tasks[0];
    expect(task?.ref).toBe("tool-use");
    const toolNames = (task?.input as { toolNames?: string[] }).toolNames ?? [];
    expect(toolNames[0]).toBe("query_database");
    expect(toolNames).toContain("search_ontology");
    expect(toolNames).toContain("list_databases");
    expect(toolNames).not.toContain("unrelated");
  });

  test("discoveryExpansion.excludeTools 命中的兄弟不并入", async () => {
    const { env } = buildEnv({
      toolNames: ["query_database", "search_ontology", "list_databases"],
    });
    env.config.runtime.toolActivation = {
      discoveryExpansion: {
        enabled: true,
        siblings: { query_database: ["search_ontology", "list_databases"] },
      },
    };
    const state = buildState("去年报警数据汇总");
    state.input.metadata = {
      ...state.input.metadata,
      turnPolicy: {
        excludeTools: ["list_databases"],
        includeTools: ["query_database"],
        explicitSkills: [],
        excludeSkills: [],
        pinSkills: [],
        visualization: "",
      },
    };
    const { route } = await runToolRoutingPhase(state, env);
    const toolNames =
      (route.tasks[0]?.input as { toolNames?: string[] }).toolNames ?? [];
    expect(toolNames).toContain("query_database");
    expect(toolNames).toContain("search_ontology");
    expect(toolNames).not.toContain("list_databases");
  });

  test("explicit tool mention overrides includeTools routing", async () => {
    const { env, events } = buildEnv({ toolNames: ["image.qwen", "currentDate"] });
    const state = buildState("使用 image.qwen 工具画一只猫");
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
    const { route } = await runToolRoutingPhase(state, env);
    const task = route.tasks[0];
    expect((task?.input as { toolNames?: string[] }).toolNames).toContain("image.qwen");
    const decisionEvent = events.find(
      (e) =>
        e.phase === "preLLM" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "explicit-tool-mention",
    );
    expect(decisionEvent).toBeDefined();
  });

  test("explicit agent mention routes to scoped agent task(与 complexity 无关的独立能力,不受塌陷影响)", async () => {
    const { env, events } = buildEnv({ agentNames: ["reviewer"] });
    const state = buildState("请让 reviewer 检查 ADR 变更");
    const { route } = await runToolRoutingPhase(state, env);
    const task = route.tasks[0];
    expect(task).toMatchObject({
      id: "task-agent-reviewer",
      type: "agent",
      ref: "reviewer",
      input: { objective: "请让 reviewer 检查 ADR 变更" },
    });
    const decisionEvent = events.find(
      (e) =>
        e.phase === "preLLM" &&
        e.type === "progress" &&
        (e.payload as { reason?: string }).reason === "explicit-agent-mention",
    );
    expect(decisionEvent).toBeDefined();
  });

  test("命中当前时间强信号且候选工具含 run-shell → 收窄为仅 run-shell", () => {
    expect(__toolRoutingTesting.shouldLimitToRunShell("现在几点了")).toBe(true);
    expect(__toolRoutingTesting.shouldLimitToRunShell("讲个笑话")).toBe(false);
  });

  test("turnPolicy 规范化后被写回 input.metadata,供下游(engine.ts activeRunTurnPolicies)消费", async () => {
    const { env } = buildEnv({ toolNames: ["image.qwen"] });
    const state = buildState("draw a cat");
    env.scope = { explicitSkillNames: ["chart-output"] };
    const { input } = await runToolRoutingPhase(state, env);
    expect(input.metadata?.turnPolicy).toBeDefined();
    expect(input.metadata?.turnPolicy?.explicitSkills).toEqual(["chart-output"]);
  });
});
