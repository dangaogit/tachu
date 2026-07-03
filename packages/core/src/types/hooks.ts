import type { ExecutionCorrelation, ExecutionSubject } from "./context";
import type { ValidationFinding } from "./result";

/**
 * 生命周期钩子点(ADR-0006 D2)。
 *
 * 多阶段流水线塌陷为深单 loop 后,14 个 phase 命名的 HookPoint 里只有
 * `afterPlanning` 真正被 fire(其余 13 个是从未触发的死点)。本次改为
 * loop-lifecycle 的 9 个事件,每个点都必须有真实 fire 位 + 精确 action
 * 语义 + 测试,禁止重蹈死点覆辙:
 *
 * - `turnStart`:一轮开始,承载 pre-guard(SafetyModule baseline + business policy)。
 * - `preLLM` / `postLLM`:loop 每个 step 调用 LLM 前后,free-mutation(受 Engine
 *   Seatbelt 约束,mutation 后引擎会做结构化 normalize/re-validate)。
 * - `preToolUse` / `postToolUse`:loop 每次工具调用前后;`preToolUse` 归位既有
 *   `onBeforeToolCall` 审批语义(可 approve/deny)。
 * - `turnStop`:一轮结束前,承载 post-guard + Result Validation,恒 fail-closed
 *   最后跑。
 * - `preSubagent` / `postSubagent`:派发/收敛 subagent(Task-style 工具)前后。
 * - `preCompact`:loop per-step 上下文超阈值、即将自动压缩前。
 */
export type HookPoint =
  | "turnStart"
  | "preLLM"
  | "postLLM"
  | "preToolUse"
  | "postToolUse"
  | "turnStop"
  | "preSubagent"
  | "postSubagent"
  | "preCompact";

/**
 * Hook 事件数据。
 */
export interface HookEvent<TData = unknown> {
  point: HookPoint;
  timestamp: number;
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
  data: TData;
}

export type HookGuardDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "block"; readonly reason: string; readonly userVisibleReason?: string }
  | { readonly kind: "degrade"; readonly reason: string; readonly userVisibleReason: string }
  | { readonly kind: "annotate"; readonly prefix: string };

/**
 * Hook 返回动作。
 *
 * 这是唯一的 guard/hook firing seam：
 * - `mutate` 只用于 `preLLM` / `postLLM`，由 Engine Seatbelt 重新校验。
 * - `guard` 只承载 pass/block/degrade/annotate，不允许 free-mutation payload。
 * - `finding` 承载 ValidationRule 产出的 deterministic/semantic findings。
 * - `approve` / `deny` 对齐既有 `onBeforeToolCall` 工具审批语义。
 */
export type HookAction =
  | { type: "continue" }
  | { type: "mutate"; data: unknown }
  | { type: "finding"; findings: readonly ValidationFinding[] }
  | { type: "guard"; decision: HookGuardDecision }
  | { type: "approve" }
  | { type: "deny"; reason: string };

/**
 * 只读订阅处理器。
 */
export type SubscribeHandler<TData = unknown> = (
  event: HookEvent<TData>,
) => void | Promise<void>;

/**
 * 可写注册处理器。
 */
export type RegisterHandler<TData = unknown> = (
  event: HookEvent<TData>,
) => Promise<HookAction | void>;
