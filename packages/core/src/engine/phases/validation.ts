import type { ValidationResult } from "../../types";
import type { ExecutionPhaseOutput } from "./execution";
import type { PhaseEnvironment } from "./index";

export interface ValidationPhaseOutput extends ExecutionPhaseOutput {
  validation: ValidationResult;
}

/**
 * 把一组失败步骤聚合成**面向用户的简短描述**。
 *
 * 自 patch-01-fallback 起，`reason` 严格禁止泄漏内部步骤 ID（例如 `task-tool-1`）
 * 或 Phase 编号 —— 这些只应作为结构化字段 `failedTaskIds` 单独记录，
 * 供 orchestrator / observability 消费，不进入用户可见渲染路径。
 *
 * 输出形态：`"执行过程中有 N 个步骤未成功完成"`（N ≥ 1）。
 */
const describeFailedSteps = (count: number): string =>
  `执行过程中有 ${count} 个步骤未成功完成`;

/**
 * 阶段 8：结果验证。
 *
 * 职责：
 *   - 聚合 `execution` 阶段产出的 step 状态，判定本轮是否全部成功
 *   - 失败时产出**脱敏后**的 `reason` 与结构化 `failedTaskIds`
 *
 * 契约（patch-01-fallback）：
 *   `validation.diagnosis.reason` 必须对终端用户可读，**不得**包含
 *   任何内部步骤 ID、Phase 编号、子流程名。具体的步骤 ID 放在
 *   `failedTaskIds` 字段里，仅供内部消费。
 */
export const runValidationPhase = async (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
): Promise<ValidationPhaseOutput> => {
  const failed = state.steps.filter((step) => step.status === "failed");
  const validation: ValidationResult =
    failed.length === 0
      ? { passed: true }
      : {
          passed: false,
          diagnosis: {
            type: "execution_issue",
            reason: describeFailedSteps(failed.length),
            failedTaskIds: failed.map((item) => item.name),
          },
        };
  await env.runtimeState.update(state.context.sessionId, { currentPhase: "validation" });
  return { ...state, validation };
};

