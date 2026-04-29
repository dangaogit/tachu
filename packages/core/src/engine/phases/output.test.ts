import { describe, expect, test } from "bun:test";

import { InMemoryRuntimeState } from "../../modules/runtime-state";
import type {
  EngineConfig,
  ExecutionContext,
  InputEnvelope,
  IntentResult,
  OutputMetadata,
  StepStatus,
  ValidationResult,
} from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";

import { runOutputPhase } from "./output";
import type { ValidationPhaseOutput } from "./validation";
import type { PhaseEnvironment } from "./index";

/**
 * Phase 9 单测只关心 content 挑选与文本装配，不走 provider / memory，
 * 因此 env 里只填 runtimeState 即可，其余字段以 never 占位。
 */
const buildEnv = (): PhaseEnvironment =>
  ({
    config: {} as EngineConfig,
    registry: {} as never,
    sessionManager: {} as never,
    memorySystem: {} as never,
    runtimeState: new InMemoryRuntimeState(),
    modelRouter: {} as never,
    providers: new Map(),
    safetyModule: {} as never,
    observability: {} as never,
    hooks: {} as never,
    scheduler: {} as never,
    activeAbortSignal: new AbortController().signal,
    adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
  }) satisfies PhaseEnvironment;

const buildState = (overrides: {
  intent: IntentResult;
  validation: ValidationResult;
  taskResults?: Record<string, unknown>;
  steps?: StepStatus[];
}): ValidationPhaseOutput => {
  const input: InputEnvelope = {
    content: "noop",
    metadata: { modality: "text", size: 4 },
  };
  const context: ExecutionContext = {
    requestId: "r-output",
    sessionId: "s-output",
    traceId: "t-output",
    principal: {},
    budget: { maxTokens: 1_000, maxDurationMs: 3_000 },
    scopes: ["*"],
  };
  return {
    input,
    context,
    violations: [],
    intent: overrides.intent,
    precheck: { budget: { allowed: true } },
    planning: { plans: [{ rank: 1, tasks: [], edges: [] }] },
    graphCheck: { passed: true },
    steps: overrides.steps ?? [],
    taskResults: overrides.taskResults ?? {},
    validation: overrides.validation,
  } as unknown as ValidationPhaseOutput;
};

const metadata: OutputMetadata = {
  toolCalls: [],
  durationMs: 42,
  tokenUsage: { input: 0, output: 0, total: 0 },
};

describe("runOutputPhase (Phase 9 — Output Assembly, direct-answer contract)", () => {
  test("simple：taskResults 中的 direct-answer 内容直接作为 content", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "simple",
          intent: "greeting",
          contextRelevance: "unrelated",
        },
        validation: { passed: true },
        taskResults: { "task-direct-answer": "你好！有什么我可以帮到你的？" },
        steps: [{ name: "task-direct-answer", status: "completed" }],
      }),
      buildEnv(),
      metadata,
    );

    expect(out.content).toBe("你好！有什么我可以帮到你的？");
    expect(out.status).toBe("success");
  });

  test("complex + 有匹配工具：无 direct-answer 时，保留结构化 JSON（intent + taskResults）", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "complex",
          intent: "fetch-and-summarize",
          contextRelevance: "unrelated",
        },
        validation: { passed: true },
        taskResults: { "task-1": { ok: true } },
        steps: [{ name: "task-1", status: "completed" }],
      }),
      buildEnv(),
      metadata,
    );

    const parsed = JSON.parse(out.content as string);
    expect(parsed).toEqual({
      intent: "fetch-and-summarize",
      taskResults: { "task-1": { ok: true } },
    });
    expect(out.status).toBe("success");
  });

  test("complex + direct-answer 兜底成功：优先使用 direct-answer 文本（不再输出结构化 JSON）", async () => {
    // 对应 Phase 5 的"complex 无匹配工具 → direct-answer 兜底"分支。
    // direct-answer 跑通时，Phase 9 应以它为 content，而不是 stringify taskResults。
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "complex",
          intent: "convert ts to go and open a PR",
          contextRelevance: "unrelated",
        },
        validation: { passed: true },
        taskResults: {
          "task-direct-answer":
            "目前没有匹配到可用工具，以下是基于通用知识的迁移思路：...",
        },
        steps: [{ name: "task-direct-answer", status: "completed" }],
      }),
      buildEnv(),
      metadata,
    );

    expect(out.content).toBe("目前没有匹配到可用工具，以下是基于通用知识的迁移思路：...");
    expect((out.content as string).startsWith("{")).toBe(false);
  });

  test("complex + 验证失败（无 direct-answer 结果）：走 ensureFallbackText 模板，严禁泄漏内部术语", async () => {
    // 极端兜底：direct-answer 执行也失败了才会走到这里。
    // patch-01-fallback：测试态无可用 provider，tryLLMFallbackSummary 直接返回 null，
    // 全路径走本地模板 + sanitizeInternalTerms。
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "complex",
          intent: "create a TDD lesson plan for a Mars rover using TypeScript",
          contextRelevance: "unrelated",
        },
        validation: {
          passed: false,
          diagnosis: {
            type: "execution_issue",
            reason: "执行过程中有 3 个步骤未成功完成",
            failedTaskIds: ["task-tool-1", "task-tool-2", "task-tool-3"],
          },
        },
        steps: [
          { name: "task-tool-1", status: "failed" },
          { name: "task-tool-2", status: "failed" },
          { name: "task-tool-3", status: "failed" },
        ],
      }),
      buildEnv(),
      metadata,
    );

    const content = out.content as string;
    expect(out.status).toBe("partial");

    // 保留用户感知必需元素：意图 + 下一步指引 + 长度 >= 30
    expect(content).toContain("create a TDD lesson plan for a Mars rover using TypeScript");
    expect(content).toContain("下一步");
    expect(content.length).toBeGreaterThanOrEqual(30);

    // 硬约束（patch-01-fallback）：严禁出现内部术语
    expect(content).not.toMatch(/task-tool-\d+/);
    expect(content).not.toMatch(/task-direct-answer/);
    expect(content).not.toMatch(/\bPhase\s*\d+/);
    expect(content).not.toContain("direct-answer 子流程");
    expect(content).not.toContain("capability 路由");
    expect(content).not.toContain("Tool / Agent 描述符");

    // 硬约束：不得把内部 state JSON 化吐出
    expect(content.includes('"validation"')).toBe(false);
    expect(content.includes('"taskResults"')).toBe(false);
  });

  test("complex + 验证失败且无 diagnosis 也不会异常 / 不泄漏", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "complex",
          intent: "some complex request",
          contextRelevance: "unrelated",
        },
        validation: { passed: false },
      }),
      buildEnv(),
      metadata,
    );

    const content = out.content as string;
    expect(content).toContain("some complex request");
    expect(content.length).toBeGreaterThanOrEqual(30);
    expect(content).not.toMatch(/task-tool-\d+/);
    expect(content).not.toMatch(/\bPhase\s*\d+/);
    expect(content).not.toContain("direct-answer 子流程");
  });

  test("direct-answer 产出空字符串时自动回落到下一优先级（结构化 JSON 或 honest fallback）", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "simple",
          intent: "hi",
          contextRelevance: "unrelated",
        },
        validation: { passed: true },
        taskResults: { "task-direct-answer": "" }, // 空字符串
      }),
      buildEnv(),
      metadata,
    );
    // simple + 空 direct-answer + validation 通过 → 走结构化 JSON 分支
    const parsed = JSON.parse(out.content as string);
    expect(parsed.intent).toBe("hi");
    expect(parsed.taskResults).toEqual({ "task-direct-answer": "" });
  });
});
