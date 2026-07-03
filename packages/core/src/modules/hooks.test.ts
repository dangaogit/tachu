import { describe, expect, test } from "bun:test";
import { DefaultHookRegistry } from "./hooks";
import { DefaultObservabilityEmitter } from "./observability";
import type { HookAction } from "../types";

const guardActionWithMutationPayload: HookAction = {
  type: "guard",
  decision: { kind: "pass" },
  // @ts-expect-error guard 决策不能携带 free-mutation payload。
  data: { content: "not allowed" },
};
void guardActionWithMutationPayload;

const hookEvent = (traceId: string, sessionId: string) => ({
  point: "turnStart" as const,
  timestamp: Date.now(),
  correlation: {
    traceId,
    requestId: `req-${traceId}`,
    sessionId,
    turnId: `turn-${traceId}`,
  },
  data: {},
});

describe("DefaultHookRegistry", () => {
 test("runs register handlers by priority", async () => {
    const registry = new DefaultHookRegistry(new DefaultObservabilityEmitter(), 200);
    const order: number[] = [];
    registry.register(
      "turnStart",
      async () => {
        order.push(2);
        return { type: "continue" };
      },
      { priority: 20 },
    );
    registry.register(
      "turnStart",
      async () => {
        order.push(1);
        return { type: "continue" };
      },
      { priority: 10 },
    );
    await registry.fire("turnStart", hookEvent("t1", "s1"));
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
    const unsubscribe = registry.subscribe("turnStart", () => {
      called += 1;
      throw new Error("subscriber failed");
    });
    await registry.fire("turnStart", hookEvent("t-sub", "s-sub"));
    expect(called).toBe(1);
    expect(events).toContain("hook-subscribe");

    unsubscribe();
    await registry.fire("turnStart", hookEvent("t-sub-2", "s-sub-2"));
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
      "turnStart",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { type: "continue" as const };
      },
      { id: "slow", timeout: 10 },
    );
    registry.register("turnStart", async () => ({ type: "continue" }), {
      id: "fast",
      timeout: 30,
    });
    const result = await registry.fire("turnStart", hookEvent("t-timeout", "s-timeout"));
    expect(result).toBeUndefined();
    expect(errorEvents).toContain("hook-register");
  });

 test("returns first non-continue action and isolates register errors", async () => {
    const emitter = new DefaultObservabilityEmitter();
    const registry = new DefaultHookRegistry(emitter, 200);
    const called: string[] = [];
    registry.register(
      "turnStart",
      async () => {
        called.push("first");
        throw new Error("broken");
      },
      { priority: 1 },
    );
    registry.register(
      "turnStart",
      async () => {
        called.push("second");
        return { type: "deny", reason: "manual block" };
      },
      { priority: 2 },
    );
    registry.register(
      "turnStart",
      async () => {
        called.push("third");
        return { type: "continue" };
      },
      { priority: 3 },
    );
    const action = await registry.fire("turnStart", hookEvent("t-action", "s-action"));
    expect(action?.type).toBe("deny");
    expect(called).toEqual(["first", "second"]);
  });

 test("aggregates guard decisions at the same point with most-restrictive-wins", async () => {
    const registry = new DefaultHookRegistry(new DefaultObservabilityEmitter(), 200);
    const called: string[] = [];
    registry.register(
      "turnStop",
      async () => {
        called.push("annotate");
        return { type: "guard", decision: { kind: "annotate", prefix: "note" } };
      },
      { priority: 1 },
    );
    registry.register(
      "turnStop",
      async () => {
        called.push("block");
        return { type: "guard", decision: { kind: "block", reason: "deny" } };
      },
      { priority: 2 },
    );
    const action = await registry.fire("turnStop", { ...hookEvent("t-guard", "s-guard"), point: "turnStop" });
    expect(called).toEqual(["annotate", "block"]);
    expect(action).toEqual({ type: "guard", decision: { kind: "block", reason: "deny" } });
  });

 test("fire 无条件发 hook_fired observability 事件(ADR-0006 D2:防死面复发)，即便无人订阅/注册", async () => {
    const emitter = new DefaultObservabilityEmitter();
    const hookFiredEvents: Array<{ payload: Record<string, unknown> }> = [];
    emitter.on("hook_fired", (event) => {
      hookFiredEvents.push({ payload: event.payload });
    });
    const registry = new DefaultHookRegistry(emitter, 200);
// 无任何 subscribe/register：hook_fired 仍应发出，证明这是真实 fire 位而非死面。
    await registry.fire("turnStart", hookEvent("t-empty", "s-empty"));
    expect(hookFiredEvents.length).toBe(1);
    expect(hookFiredEvents[0]?.payload).toMatchObject({
      point: "turnStart",
      subscriberCount: 0,
      registrarCount: 0,
    });

    registry.register("turnStart", async () => ({ type: "deny", reason: "x" }));
    await registry.fire("turnStart", hookEvent("t-with-handler", "s-with-handler"));
    expect(hookFiredEvents.length).toBe(2);
    expect(hookFiredEvents[1]?.payload).toMatchObject({
      point: "turnStart",
      registrarCount: 1,
      action: "deny",
    });
  });
});
