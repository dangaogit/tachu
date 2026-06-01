import type { ToolDescriptor } from "./descriptor";
import type { IntentTurnPolicyLlmOutput } from "./turn-policy";

/**
 * 意图分析结果。
 *
 * `IntentResult` 以复杂度 + 意图摘要 + 会话相关性为主干；
 * 本轮能力进退清单由可选字段 `turnPolicy` 表达（见 
 * 不包含 `directAnswer`：面向用户的自然语言答复统一由 Phase 7 的内置
 * Sub-flow `direct-answer` 产出（参见 ADR 0001）。
 */
export interface IntentResult {
  complexity: "simple" | "complex";
  intent: string;
  contextRelevance: "related" | "unrelated";
 /** Intent LLM subset; normalized to {@link InputMetadata.turnPolicy} after intent phase. */
  turnPolicy?: IntentTurnPolicyLlmOutput | undefined;
  relevantContext?: unknown | undefined;
}

/**
 * 任务节点。
 */
export interface TaskNode {
  id: string;
  type: "tool" | "agent" | "sub-flow";
  ref: string;
  input: Record<string, unknown>;
  contextSlice?: unknown | undefined;
 /**
 * 引擎内部在调度链条上附加的元数据，不对 planner / LLM 暴露。
 *
 * 目前承载：
 * - `approvalGranted`：当 `tool-use` sub-flow 的 `onBeforeToolCall` 审批
 * 通过（`{ type: "approve" }`）后写入。宿主的 TaskExecutor 可据此决定
 * 是否对该次调用豁免工作区沙箱等静态策略 —— 语义上用户已经通过
 * argumentsPreview 看到并确认了参数（含路径等敏感字段）。
 * 注意：没有审批回调或审批未触发时此字段**不会被设置**；宿主应把
 * `metadata?.approvalGranted !== true` 视作"未经用户明确授权"并走默认沙箱。
 */
  metadata?: {
    approvalGranted?: boolean;
  } | undefined;
}

/**
 * 任务依赖边。
 */
export interface TaskEdge {
  from: string;
  to: string;
}

/**
 * 排名方案。
 */
export interface RankedPlan {
  rank: number;
  tasks: TaskNode[];
  edges: TaskEdge[];
}

/**
 * 规划结果。
 */
export interface PlanningResult {
  plans: RankedPlan[];
 /** Visible tools resolved by ToolActivator for the tool-use sub-flow. */
  visibleTools?: ToolDescriptor[];
}

/**
 * Result Validation 的结构化 finding。
 *
 * Phase 8 先产生 finding，再由 ValidationPolicy 汇总为 outcome；`passed`
 * 字段保留给旧调用方和 `applyTurnOutcome` 兼容。
 */
export interface ValidationFinding {
  ruleId: string;
  kind: "deterministic" | "semantic";
  severity: "info" | "warning" | "error" | "fatal";
  code: string;
  message: string;
  userVisibleMessage?: string | undefined;
  retryable?: boolean | undefined;
}

/**
 * Phase 8 对 Engine / Orchestrator 的处置建议。
 */
export type ValidationOutcome =
  | { kind: "pass" }
  | {
      kind: "retry";
      reason: string;
      target: "same-plan" | "next-plan" | "tool-loop-finalize";
    }
  | { kind: "degrade"; reason: string; userVisibleReason: string }
  | { kind: "handoff"; reason: string; userVisibleReason: string };

export interface ValidationSignals {
  intentValidationNeed?: "none" | "deterministic" | "semantic" | undefined;
  finalAnswerHasClaims: boolean;
  hasToolObservations: boolean;
  hasExternalSources: boolean;
  hasFileWrites: boolean;
  hasPartialOrErrorObservations: boolean;
  descriptorSemanticRequired: boolean;
  policyMode: "off" | "deterministic-only" | "auto" | "always";
}

/**
 * 结果验证结构。
 */
export interface ValidationResult {
 /**
 * @deprecated 优先消费 `outcome.kind === "pass"`。
 * 该布尔字段保留给：
 * 1. `applyTurnOutcome` / `deriveTurnOutcome` 仍走的 `validationPassed` 入参；
 * 2. 旧 host adapter / 测试夹具未注入 `outcome` 时的兜底；
 * 3. CHANGELOG.md alpha.7 之前的下游序列化协议。
 * 新增消费方请使用 `isValidationPassing(validation)` helper。
 */
  passed: boolean;
  outcome?: ValidationOutcome | undefined;
  findings?: ValidationFinding[] | undefined;
  signals?: ValidationSignals | undefined;
  diagnosis?: {
    type: "execution_issue" | "planning_issue";
    reason: string;
 /**
 * 失败任务 ID 列表（可选）。
 *
 * 用于：
 * - Orchestrator 在切换备选方案时定位"失败子图"
 * - Output 阶段在 honest fallback 中输出"哪些任务失败"
 */
    failedTaskIds?: string[];
  } | undefined;
}
