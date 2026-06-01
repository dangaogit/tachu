import type { TaskEdge, TaskNode } from "../types";

/**
 * 上下文分发接口。
 */
export interface ContextDistributor {
  distribute(
    globalContext: Record<string, unknown>,
    tasks: TaskNode[],
    edges: TaskEdge[],
  ): Map<string, unknown>;
}

const buildDependencyMap = (tasks: TaskNode[], edges: TaskEdge[]): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  for (const task of tasks) {
    map.set(task.id, new Set());
  }
  for (const edge of edges) {
    map.get(edge.to)?.add(edge.from);
  }
  return map;
};

/**
 * 默认“需要知道”上下文分发器。
 */
export class NeedToKnowContextDistributor implements ContextDistributor {
  distribute(
    globalContext: Record<string, unknown>,
    tasks: TaskNode[],
    edges: TaskEdge[],
  ): Map<string, unknown> {
    const result = new Map<string, unknown>();
    const dependencies = buildDependencyMap(tasks, edges);

    for (const task of tasks) {
      const depIds = dependencies.get(task.id) ?? new Set<string>();
      const parentResults = [...depIds]
        .map((id) => (globalContext.taskResults as Record<string, unknown> | undefined)?.[id])
        .filter((value) => value !== undefined);

      const contextSlice = {
        rules: globalContext.rules,
        constraints: globalContext.constraints,
        input: task.input,
        parentResults,
      };
      result.set(task.id, contextSlice);
    }
    return result;
  }
}

