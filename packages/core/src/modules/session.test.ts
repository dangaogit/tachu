import { describe, expect, test } from "bun:test";
import { InMemorySessionManager } from "./session";

describe("InMemorySessionManager", () => {
  test("supports last-message-wins via beginRun", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("s1");
    const first = manager.beginRun("s1", "req-1");
    const second = manager.beginRun("s1", "req-2");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(first.signal.reason).toBe("last-message-wins");
    expect(first.requestId).toBe("req-1");
    expect(second.requestId).toBe("req-2");
  });

  test("cleans up inactive sessions", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("s1");
    const removed = await manager.cleanupInactive(-1);
    expect(removed).toBe(1);
  });

  test("cancel aborts current run with reason", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("cancel-session");
    const handle = manager.beginRun("cancel-session", "req");
    await manager.cancel("cancel-session", "user-abort");
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe("user-abort");
  });

  test("cancel uses default reason when none provided", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("cancel-default");
    const handle = manager.beginRun("cancel-default", "req");
    await manager.cancel("cancel-default");
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe("cancelled");
  });

  test("suspend and close change lifecycle state", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("s2");
    await manager.suspend("s2");
    expect(manager.getSession("s2")?.status).toBe("suspended");
    await manager.close("s2");
    expect(manager.getSession("s2")).toBeUndefined();
  });

  test("throws when beginRun targets non-existing session", () => {
    const manager = new InMemorySessionManager();
    expect(() => manager.beginRun("missing", "req")).toThrow("session not found");
  });

  test("listSessions supports status filter", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("a");
    await manager.resolve("b");
    await manager.suspend("b");
    const active = manager.listSessions({ status: "active" });
    const suspended = manager.listSessions({ status: "suspended" });
    expect(active.map((session) => session.id)).toEqual(["a"]);
    expect(suspended.map((session) => session.id)).toEqual(["b"]);
  });

  test("clear(sessionId) aborts current run and keeps session alive", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("clear-me");
    const handle = manager.beginRun("clear-me", "req");
    await manager.clear("clear-me");
    expect(handle.signal.aborted).toBe(true);
    expect(manager.getSession("clear-me")?.status).toBe("active");
  });

  test("release() releases run handle without re-aborting", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("release-me");
    const handle = manager.beginRun("release-me", "req");
    handle.release();
    handle.release();
    expect(handle.signal.aborted).toBe(false);
  });

  test("removeSession aborts current run and deletes session", async () => {
    const manager = new InMemorySessionManager();
    await manager.resolve("to-remove");
    const handle = manager.beginRun("to-remove", "req");
    await manager.removeSession("to-remove");
    expect(handle.signal.aborted).toBe(true);
    expect(manager.getSession("to-remove")).toBeUndefined();
  });
});

