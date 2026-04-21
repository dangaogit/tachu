import { PlanningError, TimeoutError } from "../errors";
import type { ExecutionContext, RankedPlan, TaskNode } from "../types";
import { createLinkedAbortController, throwIfAborted } from "../utils";

/**
 * 任务执行结果。
 */
export interface TaskResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: unknown;
}

/**
 * 任务执行器签名。
 */
export type TaskExecutor = (
  task: TaskNode,
  context: ExecutionContext,
  signal: AbortSignal,
) => Promise<unknown>;

/**
 * 调度选项。
 */
export interface SchedulerOptions {
  abortSignal: AbortSignal;
  maxConcurrency?: number;
  taskTimeoutMs?: number;
  failFast?: boolean;
}

/**
 * DAG 任务调度器。
 *
 * 使用 Kahn 拓扑调度有向无环图，支持并发上限、超时保护、
 * 取消传播与 failFast 错误策略。
 */
export class TaskScheduler {
  constructor(private readonly executor: TaskExecutor) {}

  /**
   * 执行规划中的任务图并持续产出任务状态。
   *
   * @param plan 已通过校验的任务计划
   * @param context 执行上下文
   * @param options 调度与运行时控制选项
   * @returns 任务结果异步流
   * @throws PlanningError 当依赖图非法或存在环时抛出
   */
  async *execute(
    plan: RankedPlan,
    context: ExecutionContext,
    options: SchedulerOptions,
  ): AsyncIterable<TaskResult> {
    const maxConcurrency = options.maxConcurrency ?? 4;
    const taskTimeoutMs = options.taskTimeoutMs ?? 30_000;
    const failFast = options.failFast ?? false;
    const taskMap = new Map(plan.tasks.map((task) => [task.id, task]));
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();

    for (const task of plan.tasks) {
      inDegree.set(task.id, 0);
      outgoing.set(task.id, []);
    }

    for (const edge of plan.edges) {
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

    while (finished < plan.tasks.length) {
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
          throw result.error instanceof Error
            ? result.error
            : new Error(`任务失败: ${taskId}`);
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
      const output = await Promise.race([
        this.executor(task, context, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort("task-timeout");
            reject(TimeoutError.taskTimeout(task.id, timeoutMs));
          }, timeoutMs);
        }),
      ]);
      return {
        taskId: task.id,
        status: "completed",
        output,
      };
    } catch (error) {
      if (error instanceof TimeoutError) {
        return {
          taskId: task.id,
          status: "failed",
          error,
        };
      }
      if (controller.signal.aborted) {
        return {
          taskId: task.id,
          status: "cancelled",
          error,
        };
      }
      return {
        taskId: task.id,
        status: "failed",
        error,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

