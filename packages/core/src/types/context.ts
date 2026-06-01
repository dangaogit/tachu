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
 * 本轮执行的关联坐标。
 *
 * 这些字段只表达“事实属于哪次执行”，不表达权限或业务身份。
 */
export interface ExecutionCorrelation {
  traceId: string;
  requestId: string;
  sessionId: string;
  turnId: string;
}

/**
 * 执行主体审计信息。
 *
 * `subject` 是可选的：本地 CLI、匿名调用、系统任务不一定有租户或用户。
 */
export interface ExecutionSubject {
  tenant?: string | undefined;
  userId?: string | undefined;
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
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
 /** Numeric tenant id for catalog / vector isolation (mapped from ExecutionContext.principal). */
  tenant?: number | undefined;
}

/**
 * 无宿主 `ExecutionContext` 时的安全默认（单测、工具内部回退路径）。
 */
export const DEFAULT_ADAPTER_CALL_CONTEXT: AdapterCallContext = {
  correlation: {
    traceId: "unknown-trace",
    requestId: "unknown-request",
    sessionId: "unknown-session",
    turnId: "unknown-turn",
  },
};

const readNumericTenant = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const readUserId = (ctx: ExecutionContext): string | undefined => {
  if (typeof ctx.subject?.userId === "string" && ctx.subject.userId.length > 0) {
    return ctx.subject.userId;
  }
  const fromPrincipal = ctx.principal.userId;
  if (typeof fromPrincipal === "string" && fromPrincipal.length > 0) {
    return fromPrincipal;
  }
  return undefined;
};

/**
 * 由引擎 {@link ExecutionContext} 构造适配器调用上下文。
 *
 * Maps `principal.tenant` from the host application onto {@link AdapterCallContext.tenant}
 * so catalog-driven providers can resolve per-tenant model runtime.
 */
export function adapterCallContextFromExecution(ctx: ExecutionContext): AdapterCallContext {
  const tenant =
    readNumericTenant(ctx.principal.tenant) ?? readNumericTenant(ctx.subject?.tenant);
  const userId = readUserId(ctx);
  const subject: ExecutionSubject | undefined =
    ctx.subject !== undefined
      ? {
          ...ctx.subject,
          ...(tenant !== undefined ? { tenant: String(tenant) } : {}),
          ...(userId !== undefined ? { userId } : {}),
        }
      : tenant !== undefined || userId !== undefined
        ? {
            ...(tenant !== undefined ? { tenant: String(tenant) } : {}),
            ...(userId !== undefined ? { userId } : {}),
          }
        : undefined;

  return {
    correlation: ctx.correlation,
    ...(tenant !== undefined ? { tenant } : {}),
    ...(subject !== undefined ? { subject } : {}),
  };
}

export const isCompleteExecutionCorrelation = (
  value: unknown,
): value is ExecutionCorrelation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.traceId === "string" &&
    record.traceId.trim().length > 0 &&
    typeof record.requestId === "string" &&
    record.requestId.trim().length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.trim().length > 0 &&
    typeof record.turnId === "string" &&
    record.turnId.trim().length > 0
  );
};

export function assertCompleteExecutionCorrelation(
  value: unknown,
): asserts value is ExecutionCorrelation {
  if (!isCompleteExecutionCorrelation(value)) {
    throw new Error(
      "ExecutionContext.correlation requires non-empty traceId, requestId, sessionId, and turnId",
    );
  }
}

/**
 * 引擎全链路执行上下文。
 *
 * `abortSignal` 为可选字段：引擎主干在构造下游 Tool/Backend 的 context 时会从
 * Session 对应的 RunHandle 里取出信号填入（），以便 `ExecutionBackend`
 * 等长耗时组件也能响应宿主的外部取消，而不仅依赖 TaskExecutor 的显式 signal 参数。
 */
export interface ExecutionContext {
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
  principal: Record<string, unknown>;
  budget: BudgetConstraint;
  scopes: string[];
  recursionDepth?: number | undefined;
  startedAt?: number | undefined;
  abortSignal?: AbortSignal | undefined;
}
