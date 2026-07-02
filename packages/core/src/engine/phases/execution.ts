import type { StepStatus } from "../../types";
import type { TaskExecutionError } from "../scheduler";
import type { ToolRoutingPhaseOutput } from "./tool-routing";
import type { PhaseEnvironment } from "./index";

export interface ExecutionPhaseOutput extends ToolRoutingPhaseOutput {
  steps: StepStatus[];
  taskResults: Record<string, unknown>;
  taskErrors: Record<string, TaskExecutionError>;
}

/**
 * 阶段 7：任务调度执行。
 */
export const runExecutionPhase = async (
  state: ToolRoutingPhaseOutput,
  env: PhaseEnvironment,
  onTaskResult?: (result: {
    taskId: string;
    taskType: string;
    taskRef: string;
    status: string;
    output?: unknown;
    error?: { code: string; message: string; retryable: boolean; source: string } | undefined;
  }) => void,
): Promise<ExecutionPhaseOutput> => {
  const route = state.route;
  const steps: StepStatus[] = [];
  const taskResults: Record<string, unknown> = {};
  const taskErrors: Record<string, TaskExecutionError> = {};

  for await (const result of env.scheduler.execute(route, state.context, {
    abortSignal: env.activeAbortSignal,
    maxConcurrency: env.config.runtime.maxConcurrency,
    taskTimeoutMs: env.config.runtime.defaultTaskTimeoutMs,
    failFast: env.config.runtime.failFast,
  })) {
    const step: StepStatus = {
      name: result.taskId,
      status:
        result.status === "completed"
          ? "completed"
          : result.status === "cancelled"
            ? "skipped"
            : "failed",
    };
    if (result.status === "failed") {
      step.reason = result.error?.message ?? "Task failed";
      if (result.error !== undefined) {
        taskErrors[result.taskId] = result.error;
      }
    }
    steps.push(step);
    if (result.output !== undefined) {
      taskResults[result.taskId] = result.output;
    }
    onTaskResult?.({
      taskId: result.taskId,
      taskType: route.tasks.find((task) => task.id === result.taskId)?.type ?? "unknown",
      taskRef: route.tasks.find((task) => task.id === result.taskId)?.ref ?? result.taskId,
      status: result.status,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

  await env.runtimeState.update(state.context.correlation.sessionId, {
    currentPhase: "execution",
    taskProgress: new Map(steps.map((step) => [step.name, step.status])),
  });
  return { ...state, steps, taskResults, taskErrors };
};
