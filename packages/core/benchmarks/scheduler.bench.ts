import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { TaskScheduler, type RankedPlan, type TaskNode } from "../src";

const buildPlan = (): RankedPlan => {
  const tasks: TaskNode[] = [];
  const edges: RankedPlan["edges"] = [];
  const layers = 25;
  const width = 4;
  for (let l = 0; l < layers; l += 1) {
    for (let i = 0; i < width; i += 1) {
      const id = `L${l}-T${i}`;
      tasks.push({
        id,
        type: "sub-flow",
        ref: "bench",
        input: { layer: l, index: i },
      });
      if (l > 0) {
        for (let prev = 0; prev < width; prev += 1) {
          edges.push({ from: `L${l - 1}-T${prev}`, to: id });
        }
      }
    }
  }
  return { rank: 1, tasks, edges };
};

test("scheduler benchmark 100 tasks dag", async () => {
  const scheduler = new TaskScheduler(async (task) => {
    await Bun.sleep(1);
    return task.id;
  });
  const plan = buildPlan();
  const started = performance.now();
  let count = 0;
  for await (const result of scheduler.execute(
    plan,
    {
      requestId: "bench",
      sessionId: "bench",
      traceId: "bench",
      principal: {},
      budget: {},
      scopes: ["*"],
    },
    { abortSignal: new AbortController().signal, maxConcurrency: 8, taskTimeoutMs: 5_000 },
  )) {
    if (result.status === "completed") {
      count += 1;
    }
  }
  const elapsed = performance.now() - started;
  console.log(`scheduler.bench: ${elapsed.toFixed(2)}ms, completed=${count}`);
  expect(count).toBe(100);
});

