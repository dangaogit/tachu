import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { multiEditExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = async (): Promise<
  { ctx: ToolExecutionContext; dir: string; cleanup: () => Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-multi-edit-"));
  const ctx: ToolExecutionContext = {
    abortSignal: new AbortController().signal,
    workspaceRoot: dir,
    allowedRoots: [dir],
    sandboxWaived: false,
    session: {
      id: "s-multi-edit",
      status: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    },
  };
  return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

describe("multiEditExecutor", () => {
 test("全部成功时写文件", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "test.ts");
      await writeFile(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
      const result = await multiEditExecutor(
        {
          path: file,
          edits: [
            { oldString: "const a = 1;", newString: "const a = 10;" },
            { oldString: "const b = 2;", newString: "const b = 20;" },
          ],
        },
        ctx,
      );
      expect(result.applied).toBe(2);
      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]?.error).toBeUndefined();
      expect(result.results[1]?.error).toBeUndefined();
      const content = await readFile(file, "utf8");
      expect(content).toContain("const a = 10;");
      expect(content).toContain("const b = 20;");
    } finally {
      await cleanup();
    }
  });

 test("某 edit 失败时全部回滚，不写文件", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const original = "const a = 1;\nconst b = 2;\n";
      const file = join(dir, "rollback.ts");
      await writeFile(file, original, "utf8");
      const result = await multiEditExecutor(
        {
          path: file,
          edits: [
            { oldString: "const a = 1;", newString: "const a = 10;" },
            { oldString: "DOES_NOT_EXIST", newString: "x", replaceAll: false },
          ],
        },
        ctx,
      );
      expect(result.applied).toBe(1);
      expect(result.total).toBe(2);
      const failedResult = result.results.find((r) => r.error !== undefined);
      expect(failedResult).toBeDefined();
      const content = await readFile(file, "utf8");
      expect(content).toBe(original);
    } finally {
      await cleanup();
    }
  });

 test("replaceAll 多处替换", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "multi.ts");
      await writeFile(file, "foo foo foo\nbar\n", "utf8");
      const result = await multiEditExecutor(
        {
          path: file,
          edits: [
            { oldString: "foo", newString: "baz", replaceAll: true },
            { oldString: "bar", newString: "qux" },
          ],
        },
        ctx,
      );
      expect(result.applied).toBe(2);
      const content = await readFile(file, "utf8");
      expect(content).toContain("baz baz baz");
      expect(content).toContain("qux");
    } finally {
      await cleanup();
    }
  });

 test("fuzzy 模式：行首缩进不同仍能匹配", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "fuzzy.ts");
      await writeFile(file, "function f() {\n  const x = 1;\n  return x;\n}\n", "utf8");
      const result = await multiEditExecutor(
        {
          path: file,
          edits: [{ oldString: "const x = 1;", newString: "const x = 42;" }],
          fuzzy: true,
        },
        ctx,
      );
      expect(result.applied).toBe(1);
      const content = await readFile(file, "utf8");
      expect(content).toContain("42");
    } finally {
      await cleanup();
    }
  });

 test("沙箱越界抛错", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await expect(
        multiEditExecutor(
          { path: "/etc/passwd", edits: [{ oldString: "root", newString: "x" }] },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_PATH_ESCAPE" });
    } finally {
      await cleanup();
    }
  });

 test("AbortSignal 取消", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const ac = new AbortController();
      ac.abort();
      const file = join(dir, "abort.ts");
      await writeFile(file, "x", "utf8");
      await expect(
        multiEditExecutor(
          { path: file, edits: [{ oldString: "x", newString: "y" }] },
          { ...ctx, abortSignal: ac.signal },
        ),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
