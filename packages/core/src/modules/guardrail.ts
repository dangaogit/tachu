import type { Guardrail, GuardrailContext, GuardrailDecision } from "../types/guardrail";
import type { SafetyViolation } from "./safety";
import type { ValidationOutcome } from "../types/result";

/**
 * 组合运行一组 guardrail(ADR-0006 D4)。
 *
 * 语义:
 * - 任一 guard 返回 `block` → 立即短路返回(fail-closed,不再跑后续 guard)。
 * - 无 `block` 时,若存在 `degrade` → 返回第一个 `degrade`(优先级高于 annotate,
 *   因为 degrade 承载"内容层面降级"的强制性说明)。
 * - 都没有 `degrade` 时,若存在一个或多个 `annotate` → 合并前缀(空格分隔)返回。
 * - 全部 `pass` → 返回 `pass`。
 */
export const runGuardrails = async (
  guardrails: readonly Guardrail[],
  ctx: GuardrailContext,
): Promise<GuardrailDecision> => {
  let degrade: Extract<GuardrailDecision, { kind: "degrade" }> | undefined;
  const annotations: string[] = [];

  for (const guardrail of guardrails) {
    const decision = await guardrail.run(ctx);
    if (decision.kind === "block") {
      return decision;
    }
    if (decision.kind === "degrade" && !degrade) {
      degrade = decision;
    }
    if (decision.kind === "annotate" && decision.prefix.trim().length > 0) {
      annotations.push(decision.prefix.trim());
    }
  }

  if (degrade) return degrade;
  if (annotations.length > 0) {
    return { kind: "annotate", prefix: annotations.join(" ") };
  }
  return { kind: "pass" };
};

/**
 * 内置默认 `turnStart` guard(ADR-0006 D4):把 `SafetyModule` 已产出的
 * warning 级违规(baseline prompt-injection + business policy)映射为
 * `annotate` 决策,而不是像此前那样静默丢弃(`safetyState.violations`
 * 此前计算后从未被消费)。
 *
 * 刻意接收**已计算好**的 `violations` 而非自己重新调用
 * `SafetyModule.checkBaseline/checkBusiness` —— 避免与
 * `runSafetyPhase` 重复调用同一策略(会导致 `emitWarning` 双发)。
 * error 级违规已经在 `runSafetyPhase` 内部通过 throw 处理,不会走到这里。
 */
export const createSafetyViolationsGuardrail = (
  violations: readonly SafetyViolation[],
): Guardrail => ({
  id: "builtin.safety-violations",
  run(): GuardrailDecision {
    if (violations.length === 0) {
      return { kind: "pass" };
    }
    const prefix = violations
      .map((violation) => `[safety] ${violation.message}`)
      .join(" ");
    return { kind: "annotate", prefix };
  },
});

/**
 * 内置默认 `turnStop` guard(ADR-0006 D4):把 Result Validation 已产出的
 * `ValidationOutcome` 映射为 guardrail 决策。
 *
 * 映射表:
 * - `pass` → `pass`
 * - `degrade` → `degrade`(原样透传 reason/userVisibleReason)
 * - `handoff` → `block`(人工接手 = 不能把当前候选答案当作合格结果直接交付)
 * - `retry` → `pass`(retry 是 turn-level 重试循环的职责,不在 guardrail 的
 *   pass/block/degrade/annotate 词汇表内;guardrail 只在"已经是最后一次
 *   attempt、即将交付"时才有意义)
 */
export const createResultValidationGuardrail = (
  outcome: ValidationOutcome | undefined,
): Guardrail => ({
  id: "builtin.result-validation",
  run(): GuardrailDecision {
    if (!outcome || outcome.kind === "pass" || outcome.kind === "retry") {
      return { kind: "pass" };
    }
    if (outcome.kind === "degrade") {
      return {
        kind: "degrade",
        reason: outcome.reason,
        userVisibleReason: outcome.userVisibleReason,
      };
    }
    return {
      kind: "block",
      reason: outcome.reason,
      userVisibleReason: outcome.userVisibleReason,
    };
  },
});
