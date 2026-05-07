import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { todoWriteExecutor } from "../todo-write/executor";
import { todoReadExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = async (sessionId = "sess-read-001"): Promise<
  { ctx: ToolExecutionContext; dir: string; cleanup: () => Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-todo-read-"));
  const ctx: ToolExecutionContext = {
    abortSignal: new AbortController().signal,
    workspaceRoot: dir,
    allowedRoots: [dir],
    sandboxWaived: false,
    session: {
      id: sessionId,
      status: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    },
  };
  return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

describe("todoReadExecutor", () => {
  test("读取全部 todos", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await todoWriteExecutor(
        {
          todos: [
            { id: "t1", content: "Task 1", status: "pending" },
            { id: "t2", content: "Task 2", status: "completed" },
          ],
        },
        ctx,
      );
      const result = await todoReadExecutor({}, ctx);
      expect(result.total).toBe(2);
      expect(result.todos).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test("按状态过滤", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await todoWriteExecutor(
        {
          todos: [
            { id: "t1", content: "Task 1", status: "pending" },
            { id: "t2", content: "Task 2", status: "completed" },
            { id: "t3", content: "Task 3", status: "pending" },
          ],
        },
        ctx,
      );
      const result = await todoReadExecutor({ status: "pending" }, ctx);
      expect(result.total).toBe(2);
      expect(result.todos.every((t) => t.status === "pending")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("status=all 返回全部", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await todoWriteExecutor(
        {
          todos: [
            { id: "t1", content: "x", status: "pending" },
            { id: "t2", content: "y", status: "cancelled" },
          ],
        },
        ctx,
      );
      const result = await todoReadExecutor({ status: "all" }, ctx);
      expect(result.total).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("文件不存在时返回空数组", async () => {
    const { ctx, cleanup } = await makeContext("no-todos-session");
    try {
      const result = await todoReadExecutor({}, ctx);
      expect(result.todos).toHaveLength(0);
      expect(result.total).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("不同 session 数据隔离", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tachu-todo-isolation-"));
    try {
      const makeCtx = (sessionId: string): ToolExecutionContext => ({
        abortSignal: new AbortController().signal,
        workspaceRoot: dir,
        allowedRoots: [dir],
        sandboxWaived: false,
        session: { id: sessionId, status: "active", createdAt: Date.now(), lastActiveAt: Date.now() },
      });

      const ctx1 = makeCtx("session-A");
      const ctx2 = makeCtx("session-B");

      await todoWriteExecutor(
        { todos: [{ id: "t1", content: "for A", status: "pending" }] },
        ctx1,
      );
      await todoWriteExecutor(
        { todos: [{ id: "t2", content: "for B", status: "in_progress" }] },
        ctx2,
      );

      const r1 = await todoReadExecutor({}, ctx1);
      const r2 = await todoReadExecutor({}, ctx2);

      expect(r1.todos[0]?.content).toBe("for A");
      expect(r2.todos[0]?.content).toBe("for B");
      expect(r1.total).toBe(1);
      expect(r2.total).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("AbortSignal 取消", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      const ac = new AbortController();
      ac.abort();
      await expect(
        todoReadExecutor({}, { ...ctx, abortSignal: ac.signal }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
