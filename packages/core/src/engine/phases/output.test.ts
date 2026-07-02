import { describe, expect, test } from "bun:test";

import { InMemoryRuntimeState } from "../../modules/runtime-state";
import type { ProviderAdapter } from "../../modules/provider";
import type {
  EngineConfig,
  ExecutionContext,
  InputEnvelope,
  OutputMetadata,
  StepStatus,
  ValidationResult,
} from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import { createDefaultEngineConfig } from "../../utils";
import type { CandidateAnswer, EvidenceEntry } from "../../types/evidence";

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

/**
 * ADR-0006 C1 塌陷为深单 loop 后，`candidateAnswer` 唯一由
 * `runCandidateAnswerPhase` 派生(不再有 direct-answer taskResult 特判)；
 * 本文件只测 `runOutputPhase` 的 content 选取逻辑，未显式传入
 * `candidateAnswer` 时默认视为空候选（走结构化 JSON / fallback 分支）。
 */
const deriveCandidateAnswer = (overrides: {
  evidence?: EvidenceEntry[];
  candidateAnswer?: CandidateAnswer;
}): CandidateAnswer =>
  overrides.candidateAnswer ?? {
    content: "",
    producedBy: "execution",
    claims: [],
    evidence: overrides.evidence ?? [],
  };

const buildState = (overrides: {
  intent: { intent: string };
  validation: ValidationResult;
  taskResults?: Record<string, unknown>;
  steps?: StepStatus[];
  candidateAnswer?: CandidateAnswer;
  evidence?: EvidenceEntry[];
}): ValidationPhaseOutput => {
  const input: InputEnvelope = {
    content: "noop",
    metadata: { modality: "text", size: 4 },
  };
  const context: ExecutionContext = {
    correlation: {
      traceId: "t-output",
      requestId: "r-output",
      sessionId: "s-output",
      turnId: "turn-r-output",
    },
    principal: {},
    budget: { maxTokens: 1_000, maxDurationMs: 3_000 },
    scopes: ["*"],
  };
  return {
    input,
    context,
    violations: [],
    intent: overrides.intent,
    route: { tasks: [], edges: [] },
    steps: overrides.steps ?? [],
    taskResults: overrides.taskResults ?? {},
    validation: overrides.validation,
    evidence: overrides.evidence ?? [],
    candidateAnswer: deriveCandidateAnswer(overrides),
  } as unknown as ValidationPhaseOutput;
};

const metadata: OutputMetadata = {
  outcome: "completed",
  toolCalls: [],
  durationMs: 42,
  tokenUsage: { input: 0, output: 0, total: 0 },
};

describe("runOutputPhase (输出装配：output.ts content 选取优先级)", () => {
 test("simple：validation 通过时使用 candidateAnswer 内容", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "greeting",        },
        validation: { passed: true },
        taskResults: { "task-tool-use": "你好！有什么我可以帮到你的？" },
        steps: [{ name: "task-tool-use", status: "completed" }],
        candidateAnswer: {
          content: "你好！有什么我可以帮到你的？",
          producedBy: "tool-use",
          claims: [],
          evidence: [],
        },
      }),
      buildEnv(),
      metadata,
    );

    expect(out.content).toBe("你好！有什么我可以帮到你的？");
    expect(out.metadata.outcome).toBe("completed");
  });

 test("complex + candidateAnswer 为空时，保留结构化 JSON（intent + taskResults）", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "fetch-and-summarize",        },
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
    expect(out.metadata.outcome).toBe("completed");
  });

 test("complex + 验证失败（无候选答案）：走 ensureFallbackText 模板，严禁泄漏内部术语", async () => {
 // 验证失败后 Output Phase 不再向 LLM 发起任何调用，全路径走本地模板
 // + sanitizeInternalTerms（即使 env 里挂着可用 provider 也不应被调用，见
 // "validation 失败后不得发起 LLM 调用" 用例）。
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "create a TDD lesson plan for a Mars rover using TypeScript",        },
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
    expect(out.metadata.outcome).toBe("completed");

 // 保留用户感知必需元素：意图 + 下一步指引 + 长度 >= 30
    expect(content).toContain("create a TDD lesson plan for a Mars rover using TypeScript");
    expect(content).toContain("下一步");
    expect(content.length).toBeGreaterThanOrEqual(30);

 // 硬约束（patch-01-fallback）：严禁出现内部术语
    expect(content).not.toMatch(/task-tool-\d+/);
    expect(content).not.toMatch(/\bPhase\s*\d+/);
    expect(content).not.toContain("capability 路由");
    expect(content).not.toContain("Tool / Agent 描述符");

 // 硬约束：不得把内部 state JSON 化吐出
    expect(content.includes('"validation"')).toBe(false);
    expect(content.includes('"taskResults"')).toBe(false);
  });

 test("validation 失败后不得发起 LLM 调用：注入一个会抛错的 provider 也必须只走模板", async () => {
 // Acceptance（）: A configured provider would throw if `chat()` is
 // called after validation failure, proving no post-validation LLM call occurs.
    let chatInvocations = 0;
    let routeResolveInvocations = 0;
    const explodingProvider: ProviderAdapter = {
      id: "exploding",
      name: "exploding",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        chatInvocations += 1;
        throw new Error("post-validation LLM call must not happen");
      },
      async *chatStream() {
        chatInvocations += 1;
        throw new Error("post-validation streaming call must not happen");
      },
    } as unknown as ProviderAdapter;

    const env = buildEnv();
    const envWithProvider: PhaseEnvironment = {
      ...env,
      providers: new Map([["exploding", explodingProvider]]),
      modelRouter: {
        resolve: () => {
          routeResolveInvocations += 1;
          return { provider: "exploding", model: "exploding-model" };
        },
      } as unknown as PhaseEnvironment["modelRouter"],
    };

    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "anything that fails validation",        },
        validation: {
          passed: false,
          diagnosis: {
            type: "execution_issue",
            reason: "执行过程中有 1 个步骤未成功完成",
            failedTaskIds: ["task-tool-1"],
          },
        },
        steps: [{ name: "task-tool-1", status: "failed" }],
      }),
      envWithProvider,
      metadata,
    );

    expect(chatInvocations).toBe(0);
 // We also assert no model route resolution happens — the Output Phase is
 // fully deterministic on the failure path now.
    expect(routeResolveInvocations).toBe(0);
    const content = out.content as string;
    expect(content).toContain("anything that fails validation");
    expect(content.length).toBeGreaterThanOrEqual(30);
  });

 test("complex + 验证失败且无 diagnosis 也不会异常 / 不泄漏", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "some complex request",        },
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
  });

 test("candidateAnswer 为空字符串时自动回落到下一优先级（结构化 JSON）", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "hi",        },
        validation: { passed: true },
        taskResults: { "task-tool-use": "" },
        candidateAnswer: {
          content: "",
          producedBy: "tool-use",
          claims: [],
          evidence: [],
        },
      }),
      buildEnv(),
      metadata,
    );
 // simple + 空 candidateAnswer + validation 通过 → 走结构化 JSON 分支
    const parsed = JSON.parse(out.content as string);
    expect(parsed.intent).toBe("hi");
    expect(parsed.taskResults).toEqual({ "task-tool-use": "" });
  });

 test("tool-use validation 通过时渲染已验证 candidateAnswer", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "summarise searched result",        },
        validation: { passed: true },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [{ step: 1, modelNotes: "我查一下", toolCalls: [] }],
            observations: [
              {
                source: "tool",
                tool: "mcp.web-search.web_search",
                callId: "call-1",
                text: "raw search output",
              },
            ],
            terminalDraft: "过程草稿，不应直接当最终答案",
          },
        },
        candidateAnswer: {
          content: "最终答案",
          producedBy: "tool-use",
          claims: [],
          evidence: [],
        },
      }),
      buildEnv(),
      metadata,
    );

    expect(out.content).toBe("最终答案");
  });

 test("validation 失败 + tool-use partial → 确定性 fallback 模板（软兜底 buildToolUseLocalFallbackText 已随 ADR-0006 删除）", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {          intent: "获取最新股票走势数据",        },
        validation: {
          passed: false,
          diagnosis: {
            type: "execution_issue",
            reason: "执行过程中有 1 个步骤未成功完成",
            failedTaskIds: ["task-tool-use"],
          },
        },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "partial",
            steps: [{ step: 1, modelNotes: "已搜索行情", toolCalls: [] }],
            observations: [
              {
                source: "tool",
                tool: "mcp.web-search.web_search",
                callId: "call-1",
                text: "上证指数下跌0.09%，深证成指下跌0.20%",
              },
            ],
            error: {
              code: "TIMEOUT_TASK",
              message: "task timed out",
              retryable: true,
            },
          },
        },
        steps: [{ name: "task-tool-use", status: "failed" }],
        candidateAnswer: {
          content: "基于部分搜索结果：A 股主要指数小幅调整。",
          producedBy: "tool-use",
          claims: [],
          evidence: [],
        },
      }),
      buildEnv(),
      metadata,
    );

    // ADR-0006：软兜底已删，validation 失败统一走确定性 ensureFallbackText 模板，
    // 不再基于 observations 捏造"部分结果"叙述，也不回退到 candidateAnswer.content。
    expect(out.content).not.toBe("基于部分搜索结果：A 股主要指数小幅调整。");
    expect(out.content).toMatch(/下一步|可以尝试|建议/);
  });
});

/**
 * P1 δ — OutputPhase 优先消费 `outcome.kind` 替代 `validation.passed`。
 *
 * 三组用例对齐 Implementation Verification：
 * - 仅 outcome.kind=pass，passed 故意为 false（旧 host 未同步）→ 走 pass 分支
 * - 仅 outcome.kind=degrade，passed 故意为 true（旧 host 未同步）→ 走 fallback 分支
 * - 旧 host 完全不写 outcome，只写 passed → 仍然按 passed 兼容回退
 */
describe("runOutputPhase (P1 δ — consume outcome.kind, deprecate validation.passed)", () => {
 test("outcome.kind === 'pass' 时进入 pass 分支，即使 passed 字段为 false", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: { intent: "ping" },
        validation: {
          passed: false,
          outcome: { kind: "pass" },
        },
      }),
      buildEnv(),
      metadata,
    );
 // pass 分支 + candidateAnswer 为空 → 结构化 JSON 输出
    const parsed = JSON.parse(out.content as string);
    expect(parsed.intent).toBe("ping");
  });

 test("outcome.kind === 'degrade' 时走 fallback，即使 passed 字段为 true", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: { intent: "some request" },
        validation: {
          passed: true,
          outcome: { kind: "degrade", reason: "test", userVisibleReason: "降级" },
        },
      }),
      buildEnv(),
      metadata,
    );
    const content = out.content as string;
 // fallback 分支返回的是 honest fallback 文本，不会产出 structured JSON
    expect(() => JSON.parse(content)).toThrow();
    expect(content.length).toBeGreaterThanOrEqual(30);
  });

 test("outcome 未注入时按 passed 兼容回退（P1 δ 后向兼容）", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: { intent: "legacy" },
        validation: { passed: true },
      }),
      buildEnv(),
      metadata,
    );
    const parsed = JSON.parse(out.content as string);
    expect(parsed.intent).toBe("legacy");
  });
});
