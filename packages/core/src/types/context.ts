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

