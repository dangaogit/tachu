import { PlanningError } from "../errors";
import type { TaskEdge, TaskNode } from "../types";

/**
 * 执行拓扑排序并返回有序节点列表。
 */
export const topologicalSort = (
  tasks: TaskNode[],
  edges: TaskEdge[],
): TaskNode[] => {
  const nodeMap = new Map(tasks.map((task) => [task.id, task]));
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    outgoing.set(task.id, []);
  }

  for (const edge of edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
      throw PlanningError.invalidPlan(`依赖边引用未知任务: ${edge.from} -> ${edge.to}`);
    }
    outgoing.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [taskId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  const sorted: TaskNode[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(nodeMap.get(current)!);
    for (const next of outgoing.get(current) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (sorted.length !== tasks.length) {
    const cycle = [...inDegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([taskId]) => taskId);
    throw PlanningError.graphCycle(cycle);
  }

  return sorted;
};

