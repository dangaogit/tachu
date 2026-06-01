import { describe, expect, test } from "bun:test";

import { InMemoryRuntimeState } from "../../modules/runtime-state";
import type { ProviderAdapter } from "../../modules/provider";
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

const deriveCandidateAnswer = (overrides: {
  taskResults?: Record<string, unknown>;
  evidence?: EvidenceEntry[];
  candidateAnswer?: CandidateAnswer;
}): CandidateAnswer => {
  if (overrides.candidateAnswer !== undefined) {
    return overrides.candidateAnswer;
  }
  const raw = overrides.taskResults?.["task-direct-answer"];
  if (raw !== undefined) {
    const text =
      (typeof raw === "string" ? raw : JSON.stringify(raw))
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
        .trim();
    return {
      content: text,
      producedBy: "direct-answer",
      claims: [],
      evidence: overrides.evidence ?? [],
    };
  }
  return {
    content: "",
    producedBy: "execution",
    claims: [],
    evidence: overrides.evidence ?? [],
  };
};

const buildState = (overrides: {
  intent: IntentResult;
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
    precheck: { budget: { allowed: true } },
    planning: { plans: [{ rank: 1, tasks: [], edges: [] }] },
    graphCheck: { passed: true },
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

describe("runOutputPhase (Phase 9 — Output Assembly, direct-answer contract)", () => {
 test("simple：validation 通过时使用 candidateAnswer 内容", async () => {
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
        candidateAnswer: {
          content: "你好！有什么我可以帮到你的？",
          producedBy: "direct-answer",
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
    expect(out.metadata.outcome).toBe("completed");
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
 // ：验证失败后 Output Phase 不再向 LLM 发起任何调用，全路径走本地模板
 // + sanitizeInternalTerms（即使 env 里挂着可用 provider 也不应被调用，见
 // "validation 失败后不得发起 LLM 调用" 用例）。
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
    expect(out.metadata.outcome).toBe("completed");

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
        intent: {
          complexity: "complex",
          intent: "anything that fails validation",
          contextRelevance: "unrelated",
        },
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

 test("tool-use validation 通过时渲染已验证 candidateAnswer", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "complex",
          intent: "summarise searched result",
          contextRelevance: "unrelated",
        },
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

 test("validation 失败但带 tool-use partial observations 时使用本地保底模板", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: {
          complexity: "complex",
          intent: "获取最新股票走势数据",
          contextRelevance: "unrelated",
        },
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

    expect(out.content).toContain("部分结果");
    expect(out.content).not.toBe("基于部分搜索结果：A 股主要指数小幅调整。");
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
        intent: { complexity: "simple", intent: "ping", contextRelevance: "unrelated" },
        validation: {
          passed: false,
          outcome: { kind: "pass" },
        },
      }),
      buildEnv(),
      metadata,
    );
 // pass 分支 + 无 direct-answer / tool-use → 结构化 JSON 输出
    const parsed = JSON.parse(out.content as string);
    expect(parsed.intent).toBe("ping");
  });

 test("outcome.kind === 'degrade' 时走 fallback，即使 passed 字段为 true", async () => {
    const out = await runOutputPhase(
      buildState({
        intent: { complexity: "complex", intent: "some request", contextRelevance: "unrelated" },
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
        intent: { complexity: "simple", intent: "legacy", contextRelevance: "unrelated" },
        validation: { passed: true },
      }),
      buildEnv(),
      metadata,
    );
    const parsed = JSON.parse(out.content as string);
    expect(parsed.intent).toBe("legacy");
  });
});
