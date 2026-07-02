import type { ExecutionCorrelation, ExecutionSubject } from "./context";

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

/**
 * Hook 返回动作。
 *
 * 与 detailed-design §9.8 对齐：
 * - `modify` 使用 `patch` 作为差量补丁字段名（而非通用的 `data`）。
 * - `approve` 本身仅承载"是否放行"，不再携带额外 `payload`。
 */
export type HookAction =
  | { type: "continue" }
  | { type: "abort"; reason: string }
  | { type: "modify"; patch: unknown }
  | { type: "approve" }
  | { type: "deny"; reason: string }
  | { type: "replace"; data: unknown }
  | { type: "enrich"; data: Record<string, unknown> };

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
