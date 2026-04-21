import { describe, expect, test } from "bun:test";
import { createLinkedAbortController, throwIfAborted, withTimeout } from "./abort";

describe("abort helpers", () => {
  test("linked controller follows parent abort", () => {
    const parent = new AbortController();
    const linked = createLinkedAbortController(parent.signal);
    parent.abort("x");
    expect(linked.signal.aborted).toBe(true);
  });

  test("linked controller is immediately aborted if parent already aborted", () => {
    const parent = new AbortController();
    parent.abort("already");
    const linked = createLinkedAbortController(parent.signal);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe("already");
  });

  test("withTimeout rejects long running promise", async () => {
    await expect(
      withTimeout(
        new Promise((resolve) => setTimeout(resolve, 100)),
        10,
        "test",
      ),
    ).rejects.toBeDefined();
  });

  test("withTimeout resolves fast promise", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 50, "fast");
    expect(result).toBe("ok");
  });

  test("throwIfAborted throws AbortError", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow("Aborted");
  });
});

