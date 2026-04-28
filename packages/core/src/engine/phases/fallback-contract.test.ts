/**
 * Fallback & User-Facing Contract 硬验收测试。
 *
 * 本文件是 `patch-01-fallback` 引入的**跨模块契约测试**。失败即 CI 红灯。
 *
 * 覆盖范围：
 *   - `EngineError.userMessage`：所有已知 error code 必须提供符合规范的中文 userMessage；
 *     `toUserFacing()` 投影只暴露 `{ code, userMessage, retryable }`。
 *   - `validation.ts`：`diagnosis.reason` 必须脱敏（无 `task-tool-*`），但 `failedTaskIds` 保留原 ID。
 *   - `output.ts` (`runOutputPhase`)：任何 non-success 返回的 `content` 必须 **≥ 30 字**、
 *     **不含内部术语**、**含"下一步"指引**、**不得 stringify 内部 state**。
 *   - `output.sanitizeInternalTerms`：幂等、精确替换。
 */

import { describe, expect, test } from "bun:test";

import { InMemoryRuntimeState } from "../../modules/runtime-state";
import {
  BudgetExhaustedError,
  EngineError,
  HostError,
  PlanningError,
  ProviderError,
  RegistryError,
  SafetyError,
  TimeoutError,
  ValidationError,
} from "../../errors";
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

import { ensureFallbackText, runOutputPhase, sanitizeInternalTerms } from "./output";
import { runValidationPhase } from "./validation";
import type { ValidationPhaseOutput } from "./validation";
import type { ExecutionPhaseOutput } from "./execution";
import type { PhaseEnvironment } from "./index";

// ---- 共享禁用术语正则（要求与 output.ts / stream-renderer.ts 三处严格一致） --------

/**
 * 任意用户可见文本都不得匹配的术语正则。
 *
 * 这里故意**不**复用 output.ts 的 `INTERNAL_TERMS_PATTERNS`：测试断言与源实现
 * 分别维护一份，避免"实现改了，断言也跟着一起改"的形式通过。
 */
const FORBIDDEN_TERMS: ReadonlyArray<RegExp> = [
  /task-tool-\d+/i,
  /task-tool-use\b/i,
  /task-direct-answer\b/i,
  /\bPhase\s*\d+/i,
  /direct-answer\s*子流程/i,
  /tool-use\s*子流程/i,
  /capability\s*路由/i,
  /Tool\s*\/\s*Agent\s*描述符/i,
];

const expectNoInternalTerms = (text: string, label: string): void => {
  for (const pattern of FORBIDDEN_TERMS) {
    if (pattern.test(text)) {
      throw new Error(
        `[${label}] 泄漏了内部术语 ${pattern.source}；原文：\n${text}`,
      );
    }
  }
};

// ---- Phase 9 / Output 共享 fixture ----------------------------------------

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

const buildValidationState = (overrides: {
  intent: IntentResult;
  validation: ValidationResult;
  taskResults?: Record<string, unknown>;
  steps?: StepStatus[];
  inputContent?: string;
}): ValidationPhaseOutput => {
  const input: InputEnvelope = {
    content: overrides.inputContent ?? "noop",
    metadata: { modality: "text", size: 4 },
  };
  const context: ExecutionContext = {
    requestId: "r-fc",
    sessionId: "s-fc",
    traceId: "t-fc",
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

// ---- Contract 1：EngineError.userMessage 全量覆盖 ----------------------------

describe("Contract 1 · EngineError.userMessage 覆盖所有已知 error code", () => {
  /**
   * 覆盖列表：与 `errors/engine-error.ts` 的 USER_MESSAGE_ZH 主表保持同步。
   * 新增 error code 时必须同时在此列表添加断言。
   */
  const ALL_ERRORS: Array<{ label: string; err: EngineError }> = [
    { label: "fromUnknown", err: EngineError.fromUnknown(new Error("boom")) },
    { label: "HostError", err: new HostError("ENGINE_UNKNOWN_ERROR", "internal") },

    { label: "SAFETY_INPUT_TOO_LARGE", err: SafetyError.inputTooLarge(2_000, 1_000) },
    { label: "SAFETY_RECURSION_TOO_DEEP", err: SafetyError.recursionTooDeep(10, 4) },
    { label: "SAFETY_PATH_TRAVERSAL", err: SafetyError.pathTraversal("../etc/passwd") },
    {
      label: "SAFETY_POLICY_DENY",
      err: new SafetyError("SAFETY_POLICY_DENY", "policy deny"),
    },
    {
      label: "SAFETY_TOOL_NOT_ALLOWED",
      err: new SafetyError("SAFETY_TOOL_NOT_ALLOWED", "tool x not allowed", {
        context: { tool: "run-shell" },
      }),
    },
    {
      label: "SAFETY_TOOL_DENIED",
      err: new SafetyError("SAFETY_TOOL_DENIED", "tool denied", {
        context: { tool: "apply-patch" },
      }),
    },
    {
      label: "SAFETY_SCOPE_MISSING",
      err: new SafetyError("SAFETY_SCOPE_MISSING", "scope missing"),
    },
    {
      label: "SAFETY_APPROVAL_REQUIRED",
      err: new SafetyError("SAFETY_APPROVAL_REQUIRED", "approval needed"),
    },
    {
      label: "SAFETY_APPROVAL_REJECTED",
      err: new SafetyError("SAFETY_APPROVAL_REJECTED", "rejected"),
    },
    {
      label: "SAFETY_SHELL_DENYLISTED",
      err: new SafetyError("SAFETY_SHELL_DENYLISTED", "rm -rf"),
    },
    {
      label: "SAFETY_INVALID_URL",
      err: new SafetyError("SAFETY_INVALID_URL", "invalid"),
    },
    {
      label: "SAFETY_PROTOCOL_NOT_ALLOWED",
      err: new SafetyError("SAFETY_PROTOCOL_NOT_ALLOWED", "ftp"),
    },
    {
      label: "SAFETY_PRIVATE_NETWORK_BLOCKED",
      err: new SafetyError("SAFETY_PRIVATE_NETWORK_BLOCKED", "10.0.0.0"),
    },

    { label: "PROVIDER_UNAVAILABLE", err: ProviderError.unavailable("openai") },
    { label: "PROVIDER_CALL_FAILED", err: ProviderError.callFailed("openai") },
    {
      label: "PROVIDER_AUTH_FAILED",
      err: new ProviderError("PROVIDER_AUTH_FAILED", "401"),
    },
    {
      label: "PROVIDER_RATE_LIMITED",
      err: new ProviderError("PROVIDER_RATE_LIMITED", "429"),
    },
    {
      label: "PROVIDER_UPSTREAM_ERROR",
      err: new ProviderError("PROVIDER_UPSTREAM_ERROR", "500"),
    },
    {
      label: "PROVIDER_INVALID_INPUT",
      err: new ProviderError("PROVIDER_INVALID_INPUT", "missing field"),
    },

    {
      label: "BUDGET_TOKEN_EXHAUSTED",
      err: BudgetExhaustedError.tokenExceeded(2_461, 1_000),
    },
    {
      label: "BUDGET_TOOL_CALL_EXHAUSTED",
      err: BudgetExhaustedError.toolCallExceeded(10, 5),
    },
    {
      label: "BUDGET_WALL_TIME_EXHAUSTED",
      err: BudgetExhaustedError.wallTimeExceeded(65_000, 60_000),
    },

    { label: "VALIDATION_INVALID_CONFIG", err: ValidationError.invalidConfig("bad") },
    { label: "VALIDATION_RESULT_FAILED", err: ValidationError.invalidResult("bad") },
    { label: "VALIDATION_PROMPT_TOO_LARGE", err: ValidationError.promptTooLarge(10_000, 8_000) },
    {
      label: "VALIDATION_FILE_OPERATION",
      err: new ValidationError("VALIDATION_FILE_OPERATION", "missing path"),
    },
    {
      label: "VALIDATION_EMPTY_COMMAND",
      err: new ValidationError("VALIDATION_EMPTY_COMMAND", "empty"),
    },
    {
      label: "VALIDATION_INVALID_URL",
      err: new ValidationError("VALIDATION_INVALID_URL", "bad url"),
    },
    {
      label: "VALIDATION_DOCUMENT_PATH",
      err: new ValidationError("VALIDATION_DOCUMENT_PATH", "missing"),
    },
    {
      label: "VALIDATION_PATCH_FORMAT",
      err: new ValidationError("VALIDATION_PATCH_FORMAT", "bad"),
    },
    {
      label: "VALIDATION_PATCH_EMPTY",
      err: new ValidationError("VALIDATION_PATCH_EMPTY", "empty"),
    },
    {
      label: "VALIDATION_PATCH_CONFLICT",
      err: new ValidationError("VALIDATION_PATCH_CONFLICT", "conflict"),
    },
    {
      label: "VALIDATION_PATH_ESCAPE",
      err: new ValidationError("VALIDATION_PATH_ESCAPE", "escape"),
    },

    { label: "TIMEOUT_TASK", err: TimeoutError.taskTimeout("t-1", 30_000) },
    { label: "TIMEOUT_HOOK", err: TimeoutError.hookTimeout("pre-tool", 500) },
    {
      label: "TIMEOUT_PROVIDER_REQUEST",
      err: new TimeoutError("TIMEOUT_PROVIDER_REQUEST", "timeout"),
    },

    { label: "REGISTRY_DUPLICATE", err: RegistryError.duplicate("tool", "read-file") },
    { label: "REGISTRY_MISSING_DEP", err: RegistryError.missingDependency("tool", "foo") },
    { label: "REGISTRY_MODEL_NOT_FOUND", err: RegistryError.modelNotFound("intent") },
    { label: "REGISTRY_RESERVED_NAME", err: RegistryError.reservedName("engine") },

    { label: "PLANNING_GRAPH_CYCLE", err: PlanningError.graphCycle(["a", "b", "a"]) },
    { label: "PLANNING_INVALID_PLAN", err: PlanningError.invalidPlan("bad") },
  ];

  for (const { label, err } of ALL_ERRORS) {
    test(`${label} → userMessage 合规`, () => {
      expect(err.userMessage.length).toBeGreaterThanOrEqual(15);
      expect(err.userMessage.length).toBeLessThanOrEqual(220);
      expectNoInternalTerms(err.userMessage, `userMessage:${label}`);

      const projected = err.toUserFacing();
      expect(projected.code).toBe(err.code);
      expect(projected.userMessage).toBe(err.userMessage);
      expect(typeof projected.retryable).toBe("boolean");
      // toUserFacing 投影不得泄漏 message / stack / cause / context
      expect(Object.keys(projected).sort()).toEqual(["code", "retryable", "userMessage"]);
    });
  }

  test("构造时传入 userMessage 覆盖默认模板", () => {
    const err = new HostError("ENGINE_UNKNOWN_ERROR", "internal", {
      userMessage: "自定义的用户文案。请重试。",
    });
    expect(err.userMessage).toBe("自定义的用户文案。请重试。");
  });

  test("未知 code 走 __DEFAULT__ 兜底而非崩溃", () => {
    const err = new HostError("SOMETHING_COMPLETELY_NEW", "x");
    expect(err.userMessage.length).toBeGreaterThanOrEqual(15);
    expectNoInternalTerms(err.userMessage, "unknown-code");
  });
});

// ---- Contract 2：validation.ts 脱敏 ---------------------------------------

describe("Contract 2 · validation.ts 不得在 reason 中泄漏内部 task ID", () => {
  test("reason 使用脱敏描述；原 ID 保留在 failedTaskIds", async () => {
    const failedSteps: StepStatus[] = [
      { name: "task-tool-1", status: "failed" },
      { name: "task-tool-2", status: "failed" },
      { name: "task-tool-3", status: "failed" },
    ];
    const stateIn: ExecutionPhaseOutput = {
      input: { content: "hi", metadata: { modality: "text", size: 2 } },
      context: {
        requestId: "r",
        sessionId: "s",
        traceId: "t",
        principal: {},
        budget: { maxTokens: 1_000, maxDurationMs: 3_000 },
        scopes: ["*"],
      },
      violations: [],
      intent: { complexity: "complex", intent: "x", contextRelevance: "unrelated" },
      precheck: { budget: { allowed: true } },
      planning: { plans: [{ rank: 1, tasks: [], edges: [] }] },
      graphCheck: { passed: true },
      steps: failedSteps,
      taskResults: {},
    } as unknown as ExecutionPhaseOutput;

    const env = buildEnv();
    const out = await runValidationPhase(stateIn, env);

    expect(out.validation.passed).toBe(false);
    const reason = out.validation.diagnosis?.reason ?? "";
    expect(reason.length).toBeGreaterThan(0);
    expectNoInternalTerms(reason, "validation.reason");

    const failedIds = out.validation.diagnosis?.failedTaskIds ?? [];
    expect(failedIds).toEqual(["task-tool-1", "task-tool-2", "task-tool-3"]);
  });
});

// ---- Contract 3：Output Phase fallback 最小产出 ----------------------------

describe("Contract 3 · Output fallback 契约（最小长度 / 无术语 / 含下一步）", () => {
  test("原始 bug 场景重现：i need a pig img 走 fallback → 模板文案合规", async () => {
    const out = await runOutputPhase(
      buildValidationState({
        intent: {
          complexity: "complex",
          intent: "retrieve a pig image",
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
        inputContent: "i need a pick pig img",
      }),
      buildEnv(),
      metadata,
    );

    const content = out.content as string;
    expect(out.status).toBe("partial");

    // 硬门槛：长度
    expect(content.length).toBeGreaterThanOrEqual(30);

    // 硬门槛：禁止内部术语
    expectNoInternalTerms(content, "fallback.content");

    // 硬门槛：必须含下一步行动指引（自然语言）
    expect(content).toMatch(/下一步|可以尝试|建议/);

    // 硬门槛：不得 stringify 内部 state
    expect(content).not.toContain('"validation"');
    expect(content).not.toContain('"taskResults"');
    expect(content).not.toContain('"graphCheck"');
    expect(content).not.toContain('"precheck"');

    // 保留意图摘要供用户理解
    expect(content).toContain("retrieve a pig image");
  });

  test("ensureFallbackText 在无 provider 时仍返回合规模板（不抛）", async () => {
    const state = buildValidationState({
      intent: { complexity: "complex", intent: "some request", contextRelevance: "unrelated" },
      validation: { passed: false },
    });
    const text = await ensureFallbackText(state, buildEnv());

    expect(text.length).toBeGreaterThanOrEqual(30);
    expectNoInternalTerms(text, "ensureFallbackText(no-provider)");
    expect(text).toMatch(/下一步|可以尝试|建议/);
  });

  test("validation 失败但 intent 为空字符串 → 仍产出合规文案", async () => {
    const out = await runOutputPhase(
      buildValidationState({
        intent: { complexity: "complex", intent: "", contextRelevance: "unrelated" },
        validation: { passed: false },
      }),
      buildEnv(),
      metadata,
    );
    const content = out.content as string;
    expect(content.length).toBeGreaterThanOrEqual(30);
    expectNoInternalTerms(content, "fallback(empty-intent)");
  });
});

// ---- Contract 4：sanitizeInternalTerms 行为 ---------------------------------

describe("Contract 4 · sanitizeInternalTerms 基础行为", () => {
  test("替换所有 task-tool-N", () => {
    const out = sanitizeInternalTerms(
      "存在失败步骤: task-tool-1, task-tool-2, task-tool-3",
    );
    expect(out).not.toMatch(/task-tool-\d+/);
    expect(out).toContain("某个内部步骤");
  });

  test("替换 Phase \\d+", () => {
    const out = sanitizeInternalTerms("本次请求被 Phase 3 归为 simple，Phase 7 未执行");
    expect(out).not.toMatch(/\bPhase\s*\d+/);
    expect(out).toContain("执行阶段");
  });

  test("替换 direct-answer 子流程 / capability 路由 / Tool / Agent 描述符", () => {
    const out = sanitizeInternalTerms(
      "请检查 Tool / Agent 描述符 是否已注册并在 capability 路由中可达；direct-answer 子流程 将接管",
    );
    expect(out).not.toContain("direct-answer 子流程");
    expect(out).not.toContain("capability 路由");
    expect(out).not.toContain("Tool / Agent 描述符");
  });

  test("替换 task-tool-use / tool-use 子流程（ADR-0002 Stage 3 回归）", () => {
    const out = sanitizeInternalTerms(
      "本次进入 task-tool-use 执行；tool-use 子流程 将负责调用工具",
    );
    expect(out).not.toContain("task-tool-use");
    expect(out).not.toContain("tool-use 子流程");
    expect(out).toContain("工具循环");
  });

  test("幂等：多次脱敏结果相同", () => {
    const input = "task-tool-9 task-tool-use Phase 5 direct-answer 子流程 tool-use 子流程";
    const once = sanitizeInternalTerms(input);
    const twice = sanitizeInternalTerms(once);
    expect(twice).toBe(once);
  });

  test("不误杀普通文本", () => {
    const input = "今天天气不错，适合写代码。";
    expect(sanitizeInternalTerms(input)).toBe(input);
  });
});
