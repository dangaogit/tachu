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

describe("ExecutionOrchestrator", () => {
  test("sorts plans and switches with event emission", () => {
    const emitter = new DefaultObservabilityEmitter();
    const events: string[] = [];
    emitter.on("plan_switched", () => events.push("plan_switched"));

    const orchestrator = new ExecutionOrchestrator(
      createConfig(),
      { traceId: "t", sessionId: "s" },
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
      { traceId: "t1", sessionId: "s1" },
      emitter,
    );
    expect(() => tokenBudget.recordModelUsage(1, 1)).toThrow(BudgetExhaustedError);

    const toolBudget = new ExecutionOrchestrator(
      createConfig({ maxTokens: 99, maxToolCalls: 0 }),
      { traceId: "t2", sessionId: "s2" },
      emitter,
    );
    expect(() => toolBudget.recordToolCall()).toThrow(BudgetExhaustedError);

    const wallBudget = new ExecutionOrchestrator(
      createConfig({ maxTokens: 99, maxToolCalls: 99, maxWallTimeMs: 1 }),
      { traceId: "t3", sessionId: "s3" },
      emitter,
    );
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(() => wallBudget.recordToolCall()).toThrow(BudgetExhaustedError);
  });

  test("throws when active plan is missing", () => {
    const orchestrator = new ExecutionOrchestrator(
      createConfig(),
      { traceId: "tm", sessionId: "sm" },
      new DefaultObservabilityEmitter(),
    );
    expect(() => orchestrator.getActivePlan()).toThrow("No active plan");
  });
});
