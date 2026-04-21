import type { StepStatus } from "../../types";
import type { GraphCheckPhaseOutput } from "./graph-check";
import type { PhaseEnvironment } from "./index";

export interface ExecutionPhaseOutput extends GraphCheckPhaseOutput {
  steps: StepStatus[];
  taskResults: Record<string, unknown>;
}

/**
 * 阶段 7：任务调度执行。
 */
export const runExecutionPhase = async (
  state: GraphCheckPhaseOutput,
  env: PhaseEnvironment,
  onTaskResult?: (result: { taskId: string; status: string; output?: unknown }) => void,
): Promise<ExecutionPhaseOutput> => {
  const plan = state.planning.plans[0]!;
  const steps: StepStatus[] = [];
  const taskResults: Record<string, unknown> = {};

  for await (const result of env.scheduler.execute(plan, state.context, {
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
      step.reason = result.error instanceof Error ? result.error.message : String(result.error);
    }
    steps.push(step);
    if (result.output !== undefined) {
      taskResults[result.taskId] = result.output;
    }
    onTaskResult?.({
      taskId: result.taskId,
      status: result.status,
      output: result.output,
    });
  }

  await env.runtimeState.update(state.context.sessionId, {
    currentPhase: "execution",
    taskProgress: new Map(steps.map((step) => [step.name, step.status])),
  });
  return { ...state, steps, taskResults };
};

