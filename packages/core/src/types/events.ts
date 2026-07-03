import type { ExecutionCorrelation, ExecutionSubject } from "./context";

/**
 * 引擎事件类型。
 *
 * 命名空间遵循 detailed-design §6：全部使用 snake_case，v1 起不再保留 kebab-case
 * 历史别名。外部观测端可据此做稳定的事件过滤；loop/provider/tool/llm/hook 子域
 * 各自带 `_start` / `_end` / `_fired` 等明确后缀，避免语义歧义。
 *
 * `progress` 专门用于表示 loop 内部的进度快照，例如 `tool-use` 子流程每轮循环
 * 开始时发一条带 step / maxSteps 的 progress。与 `loop_step_enter/loop_step_exit`
 * 的差异是：后者描述引擎主干 loop step 边界，progress 描述 step 内部状态。
 */
export type EventType =
  | "loop_step_enter"
  | "loop_step_exit"
  | "phase_enter"
  | "phase_exit"
  | "progress"
  | "llm_call_start"
  | "llm_call_end"
  | "tool_call_start"
  | "tool_call_end"
  | "hook_fired"
  | "retry"
  | "degrade"
  | "handoff"
  | "provider_fallback"
  | "plan_switched"
  | "budget_warning"
  | "budget_exhausted"
  | "context_budget"
  | "skill_activation"
  | "skill_activation_strategy_failed"
  | "skill_sticky_change"
  | "memory_recall"
  | "memory_recall_failed"
  | "tool_activation"
  | "tool_activation_strategy_failed"
  | "warning"
  | "error"
  | "tool_loop_step_start"
  | "tool_loop_step_end"
  | "tool_loop_failure_recovery_injected";

/**
 * 引擎事件结构。
 */
export interface EngineEvent {
  timestamp: number;
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
  type: EventType;
  phase: string;
  payload: Record<string, unknown>;
}
