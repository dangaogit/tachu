import type {
  ToolUseResult,
  ValidationFinding,
  ValidationOutcome,
  ValidationResult,
  ValidationSignals,
} from "../../../types";
import type { CandidateAnswer, EvidenceEntry } from "../../../types/evidence";
import type { CandidateAnswerPhaseOutput } from "../candidate-answer";
import type { ExecutionPhaseOutput } from "../execution";
import type { PhaseEnvironment } from "../index";
import {
  buildDefaultValidationRuleRegistry,
  ValidationRuleRegistry,
} from "./index";
import {
  BudgetedSemanticJudgeAdapter,
  JudgeBudget,
  type SemanticJudgeAdapter,
} from "./semantic-judge";

export interface ValidationPhaseOutput extends CandidateAnswerPhaseOutput {
  validation: ValidationResult;
}

const describeFailedSteps = (count: number): string =>
  `执行过程中有 ${count} 个步骤未成功完成`;

const isToolUseResult = (value: unknown): value is ToolUseResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === "tool-use-result";
};

/**
 * 基于 **结构化描述符元数据** 判断本轮 plan 是否包含写入类副作用。
 *
 * 替换历史实现里 `/write|edit|patch/i.test(step.name)` 的关键词正则反模式
 * 。
 *
 * 判定规则：
 * - 只看本轮 `state.steps` 中真实跑过的任务（不含 skipped）；
 * - 通过 `state.route.tasks` 找到 task → descriptor 的映射；
 * - 仅 `tool` / `agent` 描述符携带 `sideEffect`，二者 `sideEffect ∈ {write, irreversible}` 视为写入类。
 *
 * 当 registry 未绑定（test fixture 兼容）时返回 `false`，避免抛错。
 */
const detectFileWriteSideEffect = (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
): boolean => {
  if (!env.registry || typeof env.registry.get !== "function") return false;
  const route = state.route;
  const executedTaskIds = new Set(
    state.steps
      .filter((step) => step.status !== "skipped")
      .map((step) => step.name),
  );
  for (const task of route.tasks) {
    if (!executedTaskIds.has(task.id)) continue;
    if (task.type !== "tool" && task.type !== "agent") continue;
    const descriptor = env.registry.get(task.type, task.ref);
    if (!descriptor) continue;
    const sideEffect = (descriptor as { sideEffect?: unknown }).sideEffect;
    if (sideEffect === "write" || sideEffect === "irreversible") {
      return true;
    }
  }
  return false;
};

const buildSignals = (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
  findings: readonly ValidationFinding[],
  policyMode: ValidationSignals["policyMode"],
  evidence: readonly EvidenceEntry[] = [],
  candidateAnswer?: CandidateAnswer,
): ValidationSignals => {
  const toolUseResults = Object.values(state.taskResults).filter(isToolUseResult);
  const observations = toolUseResults.flatMap((result) => result.observations);
  const claimCount = candidateAnswer?.claims.length ?? 0;
  return {
    answerHasClaims: claimCount > 0,
    hasToolObservations: observations.length > 0,
    hasExternalSources: evidence.some(
      (entry) =>
        entry.purpose === "claim-support" ||
        (entry.purpose === "execution-observation" && entry.producedBy !== "tool-use"),
    ),
    hasFileWrites: detectFileWriteSideEffect(state, env),
    hasPartialOrErrorObservations: findings.some(
      (finding) =>
        finding.code === "tool_use_partial" ||
        finding.code === "execution_failed",
    ),
    descriptorSemanticRequired: false,
    policyMode,
  };
};

const reduceOutcome = (findings: readonly ValidationFinding[]): ValidationOutcome => {
  if (findings.length === 0) {
    return { kind: "pass" };
  }
  const fatal = findings.find((finding) => finding.severity === "fatal");
  if (fatal) {
    return {
      kind: "handoff",
      reason: fatal.code,
      userVisibleReason:
        fatal.userVisibleMessage ??
        "当前结果无法可靠交付，需要人工接手或补充上下文。",
    };
  }
  const retryableError = findings.find(
    (finding) =>
      finding.severity === "error" &&
      finding.retryable === true,
  );
  if (retryableError) {
    return {
      kind: "retry",
      reason: retryableError.code,
      target:
        retryableError.code === "tool_use_partial"
          ? "tool-loop-finalize"
          : "retry-turn",
    };
  }
  const error = findings.find((finding) => finding.severity === "error");
  if (error) {
    return {
      kind: "degrade",
      reason: error.code,
      userVisibleReason:
        error.userVisibleMessage ??
        "当前结果只有部分可确认内容，不能按完成状态交付。",
    };
  }
  return { kind: "pass" };
};

/**
 * 判断当前 turn 是否需要触发 semantic judge。
 *
 * 规则：
 * - `policyMode === "off"` → 永远不触发；
 * - `policyMode === "always"` → 永远触发；
 * - `policyMode === "deterministic-only"` → 永远不触发；
 * - `policyMode === "auto"` → 仅当满足任一条件：
 * a. signals.descriptorSemanticRequired === true；
 * b. signals.answerHasClaims === true 且 hasExternalSources === true。
 */
const shouldInvokeSemanticJudge = (signals: ValidationSignals): boolean => {
  switch (signals.policyMode) {
    case "off":
    case "deterministic-only":
      return false;
    case "always":
      return true;
    case "auto":
      return (
        signals.descriptorSemanticRequired === true ||
        (signals.answerHasClaims === true && signals.hasExternalSources === true)
      );
    default:
      return false;
  }
};

interface ValidationConfigShape {
  validation?: {
    policyMode?: ValidationSignals["policyMode"];
    semanticJudge?: {
      maxCallsPerTurn?: number;
      timeoutMs?: number;
      cacheCapacity?: number;
    };
    outputBudget?: {
 /** deterministic.output.length-budget 阈值（字符数）。 */
      maxChars?: number;
    };
  };
}

/**
 * 阶段 8：结果验证。
 *
 * 职责：
 * - 通过 `ValidationRuleRegistry` 评估当前轮次，聚合 finding 与 outcome；
 * - 失败时产出**脱敏后**的 `reason` 与结构化 `failedTaskIds`。
 *
 * 契约（patch-01-fallback）：
 * `validation.diagnosis.reason` 必须对终端用户可读，**不得**包含
 * 任何内部步骤 ID、Phase 编号、子流程名。具体的步骤 ID 放在
 * `failedTaskIds` 字段里，仅供内部消费。
 *
 * 反模式根除（alpha.7）：
 * - 不得在 signal/finding 推导路径使用 `/write|edit|patch/i` 等关键词正则；
 * 副作用判断必须 grounded 在 descriptor.sideEffect。
 * - `policyMode` 不再硬编码为 `"deterministic-only"`，而是来自
 * `env.config.validation?.policyMode`（缺省 `"deterministic-only"`）。
 *
 * Semantic judge 集成：
 * 当 `shouldInvokeSemanticJudge(signals) === true` 且调用方传入 `semanticJudge`
 * 时，phase 会构造一次性 `JudgeBudget`、包成 `BudgetedSemanticJudgeAdapter`，
 * 把产出的 finding 追加到 deterministic finding 之后再 reduce outcome。
 * 未传 adapter 时，phase 行为与 deterministic-only 完全等价。
 */
export const runValidationPhase = async (
  state: CandidateAnswerPhaseOutput,
  env: PhaseEnvironment,
  registry: ValidationRuleRegistry = buildDefaultValidationRuleRegistry(),
  semanticJudge?: SemanticJudgeAdapter,
): Promise<ValidationPhaseOutput> => {
  const failed = state.steps.filter((step) => step.status === "failed");
  const route = state.route;
  const validationConfig = (env.config as ValidationConfigShape).validation;
  const evidence = state.evidence ?? [];
  const candidateAnswer = state.candidateAnswer;
 // 将 validation 配置注入 state 透传字段，供 deterministic.output.length-budget
 // 等规则消费——避免规则直接耦合 env / config。
  const stateWithConfig = {
    ...state,
    validationConfig: validationConfig ?? {},
  } as typeof state & { validationConfig: NonNullable<ValidationConfigShape["validation"]> };
  const ruleContext = {
    state: stateWithConfig,
    route,
    registry: env.registry,
    evidence,
    candidateAnswer,
  };
  const deterministicFindings = registry.evaluateAll(ruleContext);
  const policyMode: ValidationSignals["policyMode"] =
    validationConfig?.policyMode ?? "deterministic-only";
  const baseSignals = buildSignals(
    state,
    env,
    deterministicFindings,
    policyMode,
    evidence,
    candidateAnswer,
  );

  let findings: readonly ValidationFinding[] = deterministicFindings;
  if (semanticJudge !== undefined && shouldInvokeSemanticJudge(baseSignals)) {
    const semanticConfig = validationConfig?.semanticJudge;
    const budget = new JudgeBudget(semanticConfig?.maxCallsPerTurn ?? 2);
    const wrapped =
      semanticJudge instanceof BudgetedSemanticJudgeAdapter
        ? semanticJudge
        : new BudgetedSemanticJudgeAdapter({
            inner: semanticJudge,
            budget,
            ...(semanticConfig?.timeoutMs !== undefined
              ? { timeoutMs: semanticConfig.timeoutMs }
              : {}),
            ...(semanticConfig?.cacheCapacity !== undefined
              ? { cacheCapacity: semanticConfig.cacheCapacity }
              : {}),
          });
    const semanticFindings = await wrapped.judge({
      prompt: buildSemanticJudgePrompt(state),
      signals: baseSignals,
    });
    findings = [...deterministicFindings, ...semanticFindings];
  }
  if (env.hooks && typeof env.hooks.fire === "function") {
    const findingAction = await env.hooks.fire("turnStop", {
      point: "turnStop",
      timestamp: Date.now(),
      correlation: state.context.correlation,
      ...(state.context.subject !== undefined ? { subject: state.context.subject } : {}),
      data: {
        candidateAnswer,
        evidence,
        route,
        state: stateWithConfig,
        findings,
      },
    });
    if (findingAction?.type === "finding") {
      findings = [...findings, ...findingAction.findings];
    }
  }

  const outcome = reduceOutcome(findings);
  const signals = buildSignals(
    state,
    env,
    findings,
    policyMode,
    evidence,
    candidateAnswer,
  );
  const validation: ValidationResult =
    findings.length === 0
      ? { passed: true, outcome, findings: [...findings], signals }
      : {
          passed: outcome.kind === "pass",
          outcome,
          findings: [...findings],
          signals,
          diagnosis:
            outcome.kind === "pass"
              ? undefined
              : {
                  type: "execution_issue",
                  reason:
                    failed.length > 0
                      ? describeFailedSteps(failed.length)
                      : outcome.kind === "degrade"
                        ? outcome.userVisibleReason
                        : "结果验证未通过，当前输出不能按完成状态交付",
                  failedTaskIds: failed.map((item) => item.name),
                },
        };
  await env.runtimeState.update(state.context.correlation.sessionId, {
    currentPhase: "validation",
  });
  return { ...state, validation };
};

/**
 * 简易 semantic judge prompt 构造器。
 *
 * 当前版本只负责把 turn 关键信号塞进单条字符串里，供 cache key 派生与（未来）
 * provider semantic judge 真实消费。Provider adapter 实现落地前，prompt 仅作
 * **可测试可观测**的输入键存在。
 */
const buildSemanticJudgePrompt = (state: ExecutionPhaseOutput): string => {
  const steps = state.steps
    .map((step) => `${step.name}:${step.status}`)
    .join(",");
  return `intent=${state.intent.intent};steps=[${steps}]`;
};
