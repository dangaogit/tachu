import type { SafetyViolation } from "../../modules/safety";
import type { ExecutionContext, InputEnvelope } from "../../types";
import type { PhaseEnvironment } from "./index";

export interface SafetyPhaseOutput {
  input: InputEnvelope;
  context: ExecutionContext;
  /** 所有来自 baseline / business 检查的 warning 级违规项。 */
  violations: SafetyViolation[];
}

/**
 * 阶段 2：最小安全准入与业务策略。
 *
 * - `checkBaseline`：5 项基线规则，前 4 项命中即 throw；prompt-injection 走 warning。
 * - `checkBusiness`：遍历业务 policy，命中 error 级 throw，warning 级聚合返回。
 */
export const runSafetyPhase = async (
  input: InputEnvelope,
  context: ExecutionContext,
  env: PhaseEnvironment,
): Promise<SafetyPhaseOutput> => {
  const baseline = await env.safetyModule.checkBaseline(input, context);
  const business = await env.safetyModule.checkBusiness(input, context, "safety");
  await env.runtimeState.update(context.sessionId, { currentPhase: "safety" });
  return {
    input,
    context,
    violations: [...baseline.violations, ...business.violations],
  };
};
