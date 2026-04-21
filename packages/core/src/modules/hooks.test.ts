import { describe, expect, test } from "bun:test";
import { DefaultHookRegistry } from "./hooks";
import { DefaultObservabilityEmitter } from "./observability";

describe("DefaultHookRegistry", () => {
  test("runs register handlers by priority", async () => {
    const registry = new DefaultHookRegistry(new DefaultObservabilityEmitter(), 200);
    const order: number[] = [];
    registry.register(
      "beforePlanning",
      async () => {
        order.push(2);
        return { type: "continue" };
      },
      { priority: 20 },
    );
    registry.register(
      "beforePlanning",
      async () => {
        order.push(1);
        return { type: "continue" };
      },
      { priority: 10 },
    );
    await registry.fire("beforePlanning", {
      point: "beforePlanning",
      timestamp: Date.now(),
      traceId: "t1",
      sessionId: "s1",
      data: {},
    });
    expect(order).toEqual([1, 2]);
  });

  test("supports subscribe/unsubscribe and ignores subscriber errors", async () => {
    const emitter = new DefaultObservabilityEmitter();
    const events: string[] = [];
    emitter.on("error", (event) => {
      events.push(String(event.payload.source));
    });

    const registry = new DefaultHookRegistry(emitter, 200);
    let called = 0;
    const unsubscribe = registry.subscribe("beforePlanning", () => {
      called += 1;
      throw new Error("subscriber failed");
    });
    await registry.fire("beforePlanning", {
      point: "beforePlanning",
      timestamp: Date.now(),
      traceId: "t-sub",
      sessionId: "s-sub",
      data: {},
    });
    expect(called).toBe(1);
    expect(events).toContain("hook-subscribe");

    unsubscribe();
    await registry.fire("beforePlanning", {
      point: "beforePlanning",
      timestamp: Date.now(),
      traceId: "t-sub-2",
      sessionId: "s-sub-2",
      data: {},
    });
    expect(called).toBe(1);
  });

  test("times out slow register handlers and keeps main flow", async () => {
    const emitter = new DefaultObservabilityEmitter();
    const registry = new DefaultHookRegistry(emitter, 20);
    const errorEvents: string[] = [];
    emitter.on("error", (event) => {
      errorEvents.push(String(event.payload.source));
    });
    registry.register(
      "beforePlanning",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { type: "continue" as const };
      },
      { id: "slow", timeout: 10 },
    );
    registry.register("beforePlanning", async () => ({ type: "continue" }), {
      id: "fast",
      timeout: 30,
    });
    const result = await registry.fire("beforePlanning", {
      point: "beforePlanning",
      timestamp: Date.now(),
      traceId: "t-timeout",
      sessionId: "s-timeout",
      data: {},
    });
    expect(result).toBeUndefined();
    expect(errorEvents).toContain("hook-register");
  });

  test("returns first non-continue action and isolates register errors", async () => {
    const emitter = new DefaultObservabilityEmitter();
    const registry = new DefaultHookRegistry(emitter, 200);
    const called: string[] = [];
    registry.register(
      "beforePlanning",
      async () => {
        called.push("first");
        throw new Error("broken");
      },
      { priority: 1 },
    );
    registry.register(
      "beforePlanning",
      async () => {
        called.push("second");
        return { type: "deny", reason: "manual block" };
      },
      { priority: 2 },
    );
    registry.register(
      "beforePlanning",
      async () => {
        called.push("third");
        return { type: "continue" };
      },
      { priority: 3 },
    );
    const action = await registry.fire("beforePlanning", {
      point: "beforePlanning",
      timestamp: Date.now(),
      traceId: "t-action",
      sessionId: "s-action",
      data: {},
    });
    expect(action?.type).toBe("deny");
    expect(called).toEqual(["first", "second"]);
  });
});

