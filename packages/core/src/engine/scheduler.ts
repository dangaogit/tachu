import { EngineError, PlanningError, TimeoutError } from "../errors";
import type { ExecutionContext, ExecutionRoute, TaskNode, TurnErrorSource } from "../types";
import { createLinkedAbortController, throwIfAborted } from "../utils";

export interface TaskExecutionError {
  code: string;
  message: string;
  retryable: boolean;
  source: TurnErrorSource;
}

export type TaskExecutionResult =
  | { ok: true; output: unknown }
  | { ok: false; error: TaskExecutionError };

/**
 * 任务执行结果。
 */
export interface TaskResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: TaskExecutionError;
}

/**
 * 任务执行器签名。
 */
export type TaskExecutor = (
  task: TaskNode,
  context: ExecutionContext,
  signal: AbortSignal,
) => Promise<TaskExecutionResult>;

/**
 * 调度选项。
 */
export interface SchedulerOptions {
  abortSignal: AbortSignal;
  maxConcurrency?: number;
  taskTimeoutMs?: number;
  failFast?: boolean;
}

const DEFAULT_TASK_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_PARTIAL_OUTPUT_GRACE_MS = 2_000;

const timeoutPartialOutputGraceMs = (timeoutMs: number): number =>
  Math.min(MAX_TIMEOUT_PARTIAL_OUTPUT_GRACE_MS, Math.max(50, Math.floor(timeoutMs * 0.02)));

export const errorToTaskExecutionError = (
  error: unknown,
  fallbackCode = "TASK_EXECUTION_FAILED",
  source: TurnErrorSource = "scheduler",
): TaskExecutionError => {
  if (error instanceof EngineError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      source,
    };
  }
  if (error instanceof TimeoutError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      source: "scheduler",
    };
  }
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  return {
    code: typeof record?.code === "string" ? record.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: typeof record?.retryable === "boolean" ? record.retryable : false,
    source,
  };
};

/**
 * DAG 任务调度器。
 *
 * 使用 Kahn 拓扑调度有向无环图，支持并发上限、超时保护、
 * 取消传播与 failFast 错误策略。
 */
export class TaskScheduler {
  constructor(private readonly executor: TaskExecutor) {}

 /**
 * 执行路由中的任务图并持续产出任务状态。
 *
 * @param route 已通过校验的执行路由（任务图）
 * @param context 执行上下文
 * @param options 调度与运行时控制选项
 * @returns 任务结果异步流
 * @throws PlanningError 当依赖图非法或存在环时抛出
 */
  async *execute(
    route: ExecutionRoute,
    context: ExecutionContext,
    options: SchedulerOptions,
  ): AsyncIterable<TaskResult> {
    const maxConcurrency = options.maxConcurrency ?? 4;
    const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const failFast = options.failFast ?? false;
    const taskMap = new Map(route.tasks.map((task) => [task.id, task]));
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();

    for (const task of route.tasks) {
      inDegree.set(task.id, 0);
      outgoing.set(task.id, []);
    }

    for (const edge of route.edges) {
      if (!taskMap.has(edge.from) || !taskMap.has(edge.to)) {
        throw PlanningError.invalidPlan(`依赖边引用未知任务: ${edge.from} -> ${edge.to}`);
      }
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
      outgoing.get(edge.from)!.push(edge.to);
    }

    const readyQueue: string[] = [...inDegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([taskId]) => taskId);

    const running = new Map<
      string,
      Promise<{ taskId: string; result: TaskResult }>
    >();
    const errors: TaskResult[] = [];
    let finished = 0;

    const startTask = (taskId: string): void => {
      const task = taskMap.get(taskId);
      if (!task) {
        throw PlanningError.invalidPlan(`任务不存在: ${taskId}`);
      }
      const promise = this.runTask(task, context, options.abortSignal, taskTimeoutMs).then(
        (result) => ({ taskId, result }),
      );
      running.set(taskId, promise);
    };

    while (finished < route.tasks.length) {
      throwIfAborted(options.abortSignal);

      while (readyQueue.length > 0 && running.size < maxConcurrency) {
        startTask(readyQueue.shift()!);
      }

      if (running.size === 0) {
        const cycle = [...inDegree.entries()]
          .filter(([, degree]) => degree > 0)
          .map(([taskId]) => taskId);
        throw PlanningError.graphCycle(cycle);
      }

      const { taskId, result } = await Promise.race(running.values());
      running.delete(taskId);
      finished += 1;

      yield result;

      if (result.status === "failed") {
        errors.push(result);
        if (failFast) {
          throw new Error(result.error?.message ?? `任务失败: ${taskId}`);
        }
      }

      for (const downstream of outgoing.get(taskId) ?? []) {
        const degree = (inDegree.get(downstream) ?? 0) - 1;
        inDegree.set(downstream, degree);
        if (degree === 0) {
          readyQueue.push(downstream);
        }
      }
    }

    if (errors.length > 0 && failFast) {
      throw new Error(`任务失败数: ${errors.length}`);
    }
  }

  private async runTask(
    task: TaskNode,
    context: ExecutionContext,
    abortSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<TaskResult> {
    const controller = createLinkedAbortController(abortSignal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const taskSettled = this.executor(task, context, controller.signal).then(
        (result) => ({ kind: "completed" as const, result }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      const first = await Promise.race([
        taskSettled,
        new Promise<{ kind: "timed-out"; error: TimeoutError }>((resolve) => {
          timer = setTimeout(() => {
            const error = TimeoutError.taskTimeout(task.id, timeoutMs);
            controller.abort(error);
            resolve({ kind: "timed-out", error });
          }, timeoutMs);
        }),
      ]);
      if (first.kind === "timed-out") {
        const graceMs = timeoutPartialOutputGraceMs(timeoutMs);
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const late = await Promise.race([
          taskSettled,
          new Promise<{ kind: "grace-expired" }>((resolve) => {
            graceTimer = setTimeout(() => resolve({ kind: "grace-expired" }), graceMs);
          }),
        ]);
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer);
        }
        return {
          taskId: task.id,
          status: "failed",
          error: errorToTaskExecutionError(first.error, first.error.code, "scheduler"),
          ...(late.kind === "completed" && late.result.ok && late.result.output !== undefined
            ? { output: late.result.output }
            : {}),
        };
      }
      if (first.kind === "rejected") {
        const taskError = errorToTaskExecutionError(first.error);
        if (controller.signal.aborted) {
          return {
            taskId: task.id,
            status: "cancelled",
            error: taskError,
          };
        }
        return {
          taskId: task.id,
          status: "failed",
          error: taskError,
        };
      }
      if (!first.result.ok) {
        return {
          taskId: task.id,
          status: "failed",
          error: first.result.error,
        };
      }
      return {
        taskId: task.id,
        status: "completed",
        output: first.result.output,
      };
    } catch (error) {
      const taskError = errorToTaskExecutionError(error);
      if (error instanceof TimeoutError) {
        return {
          taskId: task.id,
          status: "failed",
          error: taskError,
        };
      }
      if (controller.signal.aborted) {
        return {
          taskId: task.id,
          status: "cancelled",
          error: taskError,
        };
      }
      return {
        taskId: task.id,
        status: "failed",
        error: taskError,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
