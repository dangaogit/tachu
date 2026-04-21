import { PlanningError } from "../../errors";
import type { PlanningResult } from "../../types";
import { topologicalSort } from "../../utils";
import type { PhaseEnvironment } from "./index";
import type { PrecheckPhaseOutput } from "./precheck";

export interface GraphCheckPhaseOutput extends PrecheckPhaseOutput {
  planning: PlanningResult;
}

/**
 * 阶段 6：依赖图校验。
 */
export const runGraphCheckPhase = async (
  state: GraphCheckPhaseOutput,
  env: PhaseEnvironment,
): Promise<GraphCheckPhaseOutput> => {
  const plan = state.planning.plans[0];
  if (!plan) {
    throw PlanningError.invalidPlan("未生成可执行方案");
  }

  for (const task of plan.tasks) {
    if (task.type === "tool" && !env.registry.get("tool", task.ref)) {
      throw PlanningError.invalidPlan(`任务引用了不存在的 Tool: ${task.ref}`);
    }
    if (task.type === "agent" && !env.registry.get("agent", task.ref)) {
      throw PlanningError.invalidPlan(`任务引用了不存在的 Agent: ${task.ref}`);
    }
  }

  topologicalSort(plan.tasks, plan.edges);
  await env.runtimeState.update(state.context.sessionId, { currentPhase: "graph-check" });
  return state;
};

