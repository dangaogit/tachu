import { describe, expect, test } from "bun:test";
import { BudgetExhaustedError } from "../errors";
import type { EngineConfig } from "../types";
import { DefaultObservabilityEmitter } from "../modules/observability";
import { ExecutionOrchestrator } from "./orchestrator";

const createConfig = (override?: Partial<EngineConfig["budget"]>): EngineConfig => ({
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: { planMode: false, maxConcurrency: 4, defaultTaskTimeoutMs: 1_000, failFast: false },
  memory: {
    contextTokenLimit: 2_000,
    compressionThreshold: 0.8,
    headKeep: 2,
    tailKeep: 2,
    archivePath: ".tachu/archive/orchestrator-test.jsonl",
    vectorIndexLimit: 100,
  },
  budget: {
    maxTokens: override?.maxTokens ?? 100,
    maxToolCalls: override?.maxToolCalls ?? 2,
    maxWallTimeMs: override?.maxWallTimeMs ?? 10_000,
    ...(override?.maxToolLoopActiveMs !== undefined
      ? { maxToolLoopActiveMs: override.maxToolLoopActiveMs }
      : {}),
    ...(override?.llmWaitFirstTokenMs !== undefined
      ? { llmWaitFirstTokenMs: override.llmWaitFirstTokenMs }
      : {}),
    ...(override?.llmStreamingMs !== undefined
      ? { llmStreamingMs: override.llmStreamingMs }
      : {}),
  },
  safety: {
    maxInputSizeBytes: 1_024,
    maxRecursionDepth: 3,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "noop", model: "dev-small" },
    },
    providerFallbackOrder: ["noop"],
  },
  observability: { enabled: true, maskSensitiveData: true },
  hooks: { writeHookTimeout: 1_000, failureBehavior: "continue" },
});
const runIds = (traceId: string, sessionId: string) => ({
  correlation: {
    traceId,
    requestId: `req-${traceId}`,
    sessionId,
    turnId: `turn-${traceId}`,
  },
});

describe("ExecutionOrchestrator", () => {
 test("sorts plans and switches with event emission", () => {
    const emitter = new DefaultObservabilityEmitter();
    const events: string[] = [];
    emitter.on("plan_switched", () => events.push("plan_switched"));

    const orchestrator = new ExecutionOrchestrator(
      createConfig(),
      runIds("t", "s"),
      emitter,
    );
    orchestrator.setPlanningResult({
      plans: [
        { rank: 2, tasks: [], edges: [] },
        { rank: 1, tasks: [], edges: [] },
      ],
    });
    expect(orchestrator.getActivePlan().rank).toBe(1);
    const next = orchestrator.switchToNextPlan("validation-failed");
    expect(next?.rank).toBe(2);
    expect(events).toEqual(["plan_switched"]);
    expect(orchestrator.switchToNextPlan("no-more")).toBeNull();
  });

 test("throws budget errors for token/tool/wall-time overuse", async () => {
    const emitter = new DefaultObservabilityEmitter();
    const tokenBudget = new ExecutionOrchestrator(
      createConfig({ maxTokens: 1, maxToolCalls: 99 }),
      runIds("t1", "s1"),
      emitter,
    );
    expect(() => tokenBudget.recordModelUsage(1, 1)).toThrow(BudgetExhaustedError);

    const toolBudget = new ExecutionOrchestrator(
      createConfig({ maxTokens: 99, maxToolCalls: 0 }),
      runIds("t2", "s2"),
      emitter,
    );
    expect(() => toolBudget.recordToolCall()).toThrow(BudgetExhaustedError);

    const wallBudget = new ExecutionOrchestrator(
      createConfig({ maxTokens: 99, maxToolCalls: 99, maxWallTimeMs: 1 }),
      runIds("t3", "s3"),
      emitter,
    );
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(() => wallBudget.recordToolCall()).toThrow(BudgetExhaustedError);
  });

 test("throws when active plan is missing", () => {
    const orchestrator = new ExecutionOrchestrator(
      createConfig(),
      runIds("tm", "sm"),
      new DefaultObservabilityEmitter(),
    );
    expect(() => orchestrator.getActivePlan()).toThrow("No active plan");
  });

 test("tool-loop active budget excludes user blocking time", async () => {
   // 用较小的活跃等待与宽松上限,使活跃侧留有足够余量,避免 CI 上
   // setTimeout 抖动让活跃时间逼近上限;阻塞等待远大于上限,确保
   // 「排除用户阻塞时间」的断言依然有效。
   const orchestrator = new ExecutionOrchestrator(
     createConfig({ maxToolCalls: 99, maxTokens: 99, maxToolLoopActiveMs: 500 }),
     runIds("tb", "sb"),
     new DefaultObservabilityEmitter(),
   );

   orchestrator.beginToolLoopActiveTimer();
   await new Promise((resolve) => setTimeout(resolve, 5));
   orchestrator.beginUserBlocking();
   await new Promise((resolve) => setTimeout(resolve, 1_000));
   orchestrator.endUserBlocking();
   await new Promise((resolve) => setTimeout(resolve, 5));
   expect(() => orchestrator.recordToolCall()).not.toThrow();
   orchestrator.endToolLoopActiveTimer();
 });

 test("overlapping user blocking (parallel tool approvals) still excludes full wait", async () => {
   const orchestrator = new ExecutionOrchestrator(
     createConfig({ maxToolCalls: 99, maxTokens: 99, maxToolLoopActiveMs: 500 }),
     runIds("tb2", "sb2"),
     new DefaultObservabilityEmitter(),
   );

   orchestrator.beginToolLoopActiveTimer();
   orchestrator.beginUserBlocking();
   orchestrator.beginUserBlocking();
   await new Promise((resolve) => setTimeout(resolve, 700));
   orchestrator.endUserBlocking();
   await new Promise((resolve) => setTimeout(resolve, 500));
   orchestrator.endUserBlocking();
   await new Promise((resolve) => setTimeout(resolve, 5));
   expect(() => orchestrator.recordToolCall()).not.toThrow();
   orchestrator.endToolLoopActiveTimer();
 });

 test("tool-loop active budget throws when active time exceeds limit", async () => {
    const orchestrator = new ExecutionOrchestrator(
      createConfig({ maxToolCalls: 99, maxTokens: 99, maxToolLoopActiveMs: 10 }),
      runIds("ta", "sa"),
      new DefaultObservabilityEmitter(),
    );

    orchestrator.beginToolLoopActiveTimer();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(() => orchestrator.endToolLoopActiveTimer()).toThrow(BudgetExhaustedError);
  });
});
