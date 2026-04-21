/**
 * 生命周期钩子点。
 */
export type HookPoint =
  | "beforeSafetyCheck"
  | "afterSafetyCheck"
  | "beforeIntentAnalysis"
  | "afterIntentAnalysis"
  | "beforePreCheck"
  | "afterPreCheck"
  | "beforePlanning"
  | "afterPlanning"
  | "beforeExecution"
  | "afterExecution"
  | "beforeValidation"
  | "afterValidation"
  | "beforeOutput"
  | "afterOutput";

/**
 * Hook 事件数据。
 */
export interface HookEvent<TData = unknown> {
  point: HookPoint;
  timestamp: number;
  traceId: string;
  sessionId: string;
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

