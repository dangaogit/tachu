import { describe, expect, test } from "bun:test";
import { InMemoryRuntimeState } from "./runtime-state";

describe("InMemoryRuntimeState", () => {
  test("updates and snapshots state", async () => {
    const state = new InMemoryRuntimeState();
    await state.update("s1", {
      currentPhase: "intent",
      retryCount: { task: 1, system: 0 },
      budgetUsed: { tokens: 10, durationMs: 20, toolCalls: 1 },
    });
    const current = await state.get("s1");
    expect(current?.retryCount.task).toBe(1);
    expect(current?.budgetUsed.tokens).toBe(10);
    const snapshot = await state.snapshot("s1");
    expect(snapshot?.phase).toBe("intent");
  });

  test("restores checkpoint and then cleans up", async () => {
    const state = new InMemoryRuntimeState();
    await state.update("s2", { currentPhase: "planning" });
    const checkpoint = await state.snapshot("s2");
    await state.update("s2", { currentPhase: "execution" });
    expect((await state.get("s2"))?.currentPhase).toBe("execution");
    await state.restore("s2", checkpoint!);
    expect((await state.get("s2"))?.currentPhase).toBe("planning");
    await state.cleanup("s2");
    expect(await state.get("s2")).toBeNull();
  });
});

