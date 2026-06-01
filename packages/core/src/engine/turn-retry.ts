import type { ValidationOutcome } from "../types";

/**
 * Engine turn-level retry 决策输入。
 *
 * Engine 主循环在每次 ValidationPhase 收尾后调用 {@link decideTurnRetry}
 * 来判定本轮 turn 是直接进入 OutputPhase（exit）还是回到 PlanningPhase 重试（continue）。
 *
 * 设计要点：
 * - 终态 outcome（`pass` / `degrade` / `handoff`）一律 exit；不重试。
 * - `retry/tool-loop-finalize` 属于 tool-use sub-flow 的内部信号，turn 级别 exit。
 * - `retry/same-plan` 与 `retry/next-plan` 触发 turn 级重试，受 maxRetries 约束。
 * - 反死循环：上一轮 outcome.kind 与本轮相同 → 强制 exit，避免相同失败模式无限循环。
 */
export interface TurnRetryDecisionInput {
 /** ValidationPhase 产出的结构化结论。 */
  outcome: ValidationOutcome;
 /** 已经完成的重试次数（0 表示本轮是首次执行）。 */
  retryCount: number;
 /** ExecutionPolicy.maxRetries 上限。 */
  maxRetries: number;
 /** 此前各轮的 outcome.kind 序列，按时间顺序；最后一项为上一轮 kind。 */
  previousOutcomeKinds: readonly string[];
}

export type TurnRetryDecision =
  | { kind: "continue"; nextRetryCount: number; reason: string }
  | { kind: "exit"; reason: string };

/**
 * 计算 ValidationPhase outcome 之后下一步动作。
 *
 * 返回 `continue` 时 Engine 应当：
 * 1. 把 `previousAttempt` 注入 PlanningPhase evidence；
 * 2. `retryCount` 升到 `nextRetryCount`；
 * 3. 回到 planning 阶段重新跑一轮（precheck 不重复）。
 *
 * 返回 `exit` 时 Engine 进入 OutputPhase。
 */
export const decideTurnRetry = (input: TurnRetryDecisionInput): TurnRetryDecision => {
  const { outcome, retryCount, maxRetries, previousOutcomeKinds } = input;

  if (outcome.kind === "pass") {
    return { kind: "exit", reason: "validation-pass" };
  }
  if (outcome.kind === "degrade") {
    return { kind: "exit", reason: "validation-degrade" };
  }
  if (outcome.kind === "handoff") {
    return { kind: "exit", reason: "validation-handoff" };
  }

  if (outcome.kind === "retry") {
    if (outcome.target === "tool-loop-finalize") {
      return { kind: "exit", reason: "tool-loop-finalize-handled-in-subflow" };
    }
    if (retryCount >= maxRetries) {
      return { kind: "exit", reason: `max-retries-exceeded (${retryCount}/${maxRetries})` };
    }
    const lastKind = previousOutcomeKinds[previousOutcomeKinds.length - 1];
    if (lastKind === outcome.kind) {
      return {
        kind: "exit",
        reason: `anti-loop: outcome.kind "${outcome.kind}" repeated twice in a row`,
      };
    }
    return {
      kind: "continue",
      nextRetryCount: retryCount + 1,
      reason: `retry/${outcome.target}: ${outcome.reason}`,
    };
  }

 // Exhaustive guard
  const _exhaustive: never = outcome;
  void _exhaustive;
  return { kind: "exit", reason: "unknown-outcome" };
};
