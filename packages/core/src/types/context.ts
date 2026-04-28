/**
 * 预算约束。
 */
export interface BudgetConstraint {
  maxTokens?: number;
  maxDurationMs?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
}

/**
 * Port 层调用 Provider / VectorStore / Memory 时附带的隔离与可观测性上下文
 *（TACHU-GAP-01 / `ProviderCallContext` 家族的最小公共子集）。
 *
 * **隔离标识**：单机工具、单租户服务可无 `tenant` / `scopeId`；多租户宿主按需选用
 * 数字型 {@link AdapterCallContext.tenant}、字符串型 {@link AdapterCallContext.scopeId}
 *（UUID、org slug、`orgId` 等均通过 `principal` 映射，见 `adapterCallContextFromExecution`）。
 */
export interface AdapterCallContext {
  traceId: string;
  sessionId?: string;
  turnId?: string;
  userId?: string;
  /**
   * 可选数字租户/空间 ID（经典 INT 多租户）。无此模型时不要求设置。
   */
  tenant?: number;
  /**
   * 可选通用隔离作用域（UUID、组织标识、环境名等）。与 `tenant` 独立，可由宿主并存使用。
   */
  scopeId?: string;
}

/**
 * 无宿主 `ExecutionContext` 时的安全默认（单测、工具内部回退路径）。
 */
export const DEFAULT_ADAPTER_CALL_CONTEXT: AdapterCallContext = {
  traceId: "unknown",
};

/**
 * 从 `principal.tenant` 解析数字租户或字符串作用域（非纯整数字符串视为 `scopeId`）。
 */
const parseTenantPrincipal = (value: unknown): { tenant?: number; scopeId?: string } => {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { tenant: Math.trunc(value) };
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length === 0) {
      return {};
    }
    if (/^-?\d+$/.test(t)) {
      return { tenant: Math.trunc(Number(t)) };
    }
    return { scopeId: t };
  }
  return {};
};

const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const s = value.trim();
  return s.length > 0 ? s : undefined;
};

/**
 * 由引擎 {@link ExecutionContext} 构造适配器调用上下文。
 *
 * `principal` 约定（均为可选）：
 * - `tenant`：数字或整数字符串 → {@link AdapterCallContext.tenant}；其它字符串 → 归入 `scopeId`
 * - `scopeId` / `orgId`：显式字符串作用域（`scopeId` 优先于 `orgId`）
 */
export function adapterCallContextFromExecution(ctx: ExecutionContext): AdapterCallContext {
  const turnRaw = ctx.principal["turnId"];
  const userRaw = ctx.principal["userId"];
  const explicitScope =
    readOptionalString(ctx.principal["scopeId"]) ?? readOptionalString(ctx.principal["orgId"]);
  const fromTenantField = parseTenantPrincipal(ctx.principal["tenant"]);
  const scopeId = explicitScope ?? fromTenantField.scopeId;

  const out: AdapterCallContext = {
    traceId: ctx.traceId,
    sessionId: ctx.sessionId,
  };
  if (typeof turnRaw === "string") {
    out.turnId = turnRaw;
  }
  if (typeof userRaw === "string") {
    out.userId = userRaw;
  }
  if (fromTenantField.tenant !== undefined) {
    out.tenant = fromTenantField.tenant;
  }
  if (scopeId !== undefined) {
    out.scopeId = scopeId;
  }
  return out;
}

/**
 * 引擎全链路执行上下文。
 *
 * `abortSignal` 为可选字段：引擎主干在构造下游 Tool/Backend 的 context 时会从
 * Session 对应的 RunHandle 里取出信号填入（D1-LOW-11），以便 `ExecutionBackend`
 * 等长耗时组件也能响应宿主的外部取消，而不仅依赖 TaskExecutor 的显式 signal 参数。
 */
export interface ExecutionContext {
  requestId: string;
  sessionId: string;
  traceId: string;
  principal: Record<string, unknown>;
  budget: BudgetConstraint;
  scopes: string[];
  recursionDepth?: number | undefined;
  startedAt?: number | undefined;
  abortSignal?: AbortSignal | undefined;
}

