import { describe, expect, test } from "bun:test";
import { TimeoutError } from "../errors";
import { TaskScheduler } from "./scheduler";

const baseContext = {
  requestId: "r",
  sessionId: "s",
  traceId: "t",
  principal: {},
  budget: {},
  scopes: ["*"],
};

describe("TaskScheduler", () => {
  test("executes tasks in dag order", async () => {
    const scheduler = new TaskScheduler(async (task) => task.id);
    const plan = {
      rank: 1,
      tasks: [
        { id: "a", type: "sub-flow" as const, ref: "a", input: {} },
        { id: "b", type: "sub-flow" as const, ref: "b", input: {} },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const order: string[] = [];
    for await (const result of scheduler.execute(
      plan,
      baseContext,
      { abortSignal: new AbortController().signal },
    )) {
      order.push(result.taskId);
    }
    expect(order).toEqual(["a", "b"]);
  });

  test("continues on task errors when failFast is false", async () => {
    const scheduler = new TaskScheduler(async (task) => {
      if (task.id === "a") {
        throw new Error("boom");
      }
      return task.id;
    });
    const plan = {
      rank: 1,
      tasks: [
        { id: "a", type: "sub-flow" as const, ref: "a", input: {} },
        { id: "b", type: "sub-flow" as const, ref: "b", input: {} },
      ],
      edges: [],
    };

    const results: Array<{ id: string; status: string }> = [];
    for await (const item of scheduler.execute(plan, baseContext, {
      abortSignal: new AbortController().signal,
      failFast: false,
    })) {
      results.push({ id: item.taskId, status: item.status });
    }
    expect(results).toEqual(
      expect.arrayContaining([
        { id: "a", status: "failed" },
        { id: "b", status: "completed" },
      ]),
    );
  });

  test("runs independent tasks in parallel respecting maxConcurrency", async () => {
    let running = 0;
    let peak = 0;
    const scheduler = new TaskScheduler(async (task) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, task.id === "a" ? 20 : 10));
      running -= 1;
      return task.id;
    });
    const plan = {
      rank: 1,
      tasks: [
        { id: "a", type: "sub-flow" as const, ref: "a", input: {} },
        { id: "b", type: "sub-flow" as const, ref: "b", input: {} },
        { id: "c", type: "sub-flow" as const, ref: "c", input: {} },
      ],
      edges: [],
    };
    for await (const _ of scheduler.execute(plan, baseContext, {
      abortSignal: new AbortController().signal,
      maxConcurrency: 2,
    })) {
      // consume
    }
    expect(peak).toBe(2);
  });

  test("throws immediately when failFast is true", async () => {
    const scheduler = new TaskScheduler(async (task) => {
      if (task.id === "a") {
        throw new Error("boom");
      }
      return task.id;
    });
    const plan = {
      rank: 1,
      tasks: [
        { id: "a", type: "sub-flow" as const, ref: "a", input: {} },
        { id: "b", type: "sub-flow" as const, ref: "b", input: {} },
      ],
      edges: [],
    };

    const run = async () => {
      for await (const _ of scheduler.execute(plan, baseContext, {
        abortSignal: new AbortController().signal,
        failFast: true,
      })) {
        // consume
      }
    };
    await expect(run()).rejects.toThrow("boom");
  });

  test("marks timeout path with TimeoutError", async () => {
    const scheduler = new TaskScheduler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "slow";
    });
    const plan = {
      rank: 1,
      tasks: [{ id: "slow", type: "sub-flow" as const, ref: "slow", input: {} }],
      edges: [],
    };

    const results = [];
    for await (const item of scheduler.execute(plan, baseContext, {
      abortSignal: new AbortController().signal,
      taskTimeoutMs: 10,
    })) {
      results.push(item);
    }
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toBeInstanceOf(TimeoutError);
  });

  test("propagates abort signal before scheduling", async () => {
    const scheduler = new TaskScheduler(async () => "ok");
    const plan = {
      rank: 1,
      tasks: [{ id: "x", type: "sub-flow" as const, ref: "x", input: {} }],
      edges: [],
    };
    const controller = new AbortController();
    controller.abort("manual");
    const run = async () => {
      for await (const _ of scheduler.execute(plan, baseContext, {
        abortSignal: controller.signal,
      })) {
        // consume
      }
    };
    await expect(run()).rejects.toThrow("Aborted");
  });
});

