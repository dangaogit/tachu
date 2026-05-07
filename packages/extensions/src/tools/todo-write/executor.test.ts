import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { todoWriteExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = async (sessionId = "sess-001"): Promise<
  { ctx: ToolExecutionContext; dir: string; cleanup: () => Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-todo-write-"));
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

describe("todoWriteExecutor", () => {
  test("写入新 todos（全量）", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      const result = await todoWriteExecutor(
        {
          todos: [
            { id: "t1", content: "Task 1", status: "pending" },
            { id: "t2", content: "Task 2", status: "in_progress" },
          ],
          merge: false,
        },
        ctx,
      );
      expect(result.total).toBe(2);
      expect(result.written).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("merge=true 时按 id 合并", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await todoWriteExecutor(
        { todos: [{ id: "t1", content: "Task 1", status: "pending" }] },
        ctx,
      );
      const result = await todoWriteExecutor(
        {
          todos: [
            { id: "t1", content: "Task 1 updated", status: "completed" },
            { id: "t2", content: "Task 2", status: "pending" },
          ],
          merge: true,
        },
        ctx,
      );
      expect(result.total).toBe(2);
      expect(result.written).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("merge=false 时全量覆盖", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await todoWriteExecutor(
        { todos: [{ id: "t1", content: "old", status: "pending" }] },
        ctx,
      );
      const result = await todoWriteExecutor(
        { todos: [{ id: "t99", content: "new", status: "pending" }], merge: false },
        ctx,
      );
      expect(result.total).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("目录不存在时自动创建", async () => {
    const { ctx, dir, cleanup } = await makeContext("session-auto-mkdir");
    try {
      const result = await todoWriteExecutor(
        { todos: [{ id: "t1", content: "x", status: "pending" }] },
        ctx,
      );
      expect(result.written).toBe(1);
      const fs = await import("node:fs/promises");
      const stat = await fs.stat(join(dir, ".tachu", "sessions", "session-auto-mkdir", "todos.json"));
      expect(stat.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("AbortSignal 取消", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      const ac = new AbortController();
      ac.abort();
      await expect(
        todoWriteExecutor(
          { todos: [{ id: "t1", content: "x", status: "pending" }] },
          { ...ctx, abortSignal: ac.signal },
        ),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
