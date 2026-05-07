import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editFileExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";
import { ValidationError } from "@tachu/core";

const makeContext = async (): Promise<
  { ctx: ToolExecutionContext; dir: string; cleanup: () => Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-edit-file-"));
  const ctx: ToolExecutionContext = {
    abortSignal: new AbortController().signal,
    workspaceRoot: dir,
    allowedRoots: [dir],
    sandboxWaived: false,
    session: {
      id: "s-edit-file",
      status: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    },
  };
  return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

describe("editFileExecutor", () => {
  test("正常替换单次出现", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "test.ts");
      await writeFile(file, "const a = 1;\nconst b = 2;\n", "utf8");
      const result = await editFileExecutor(
        { path: file, oldString: "const b = 2;", newString: "const b = 99;" },
        ctx,
      );
      expect(result.replaced).toBe(1);
      expect(result.matchCount).toBe(1);
      const content = await readFile(file, "utf8");
      expect(content).toContain("const b = 99;");
    } finally {
      await cleanup();
    }
  });

  test("唯一性校验失败：matchCount > 1", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "dup.ts");
      await writeFile(file, "foo\nfoo\nbar\n", "utf8");
      await expect(
        editFileExecutor({ path: file, oldString: "foo", newString: "baz" }, ctx),
      ).rejects.toMatchObject({ code: "EDIT_FILE_NOT_UNIQUE" });
    } finally {
      await cleanup();
    }
  });

  test("唯一性校验失败：matchCount === 0 且 fuzzy=false", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "miss.ts");
      await writeFile(file, "hello world\n", "utf8");
      await expect(
        editFileExecutor(
          { path: file, oldString: "notfound", newString: "x", fuzzy: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "EDIT_FILE_NOT_UNIQUE" });
    } finally {
      await cleanup();
    }
  });

  test("matchCount === 0 且 fuzzy=false 时 message 含 matchCount", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "miss2.ts");
      await writeFile(file, "hello world\n", "utf8");
      let err: unknown;
      try {
        await editFileExecutor(
          { path: file, oldString: "notfound", newString: "x", fuzzy: false },
          ctx,
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain("matchCount=0");
    } finally {
      await cleanup();
    }
  });

  test("fuzzy 模式命中（行首空格不同）", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "fuzzy.ts");
      await writeFile(file, "function foo() {\n  const x = 1;\n  return x;\n}\n", "utf8");
      const result = await editFileExecutor(
        {
          path: file,
          oldString: "const x = 1;\nreturn x;",
          newString: "const x = 42;\nreturn x;",
        },
        ctx,
      );
      expect(result.replaced).toBe(1);
      const content = await readFile(file, "utf8");
      expect(content).toContain("42");
    } finally {
      await cleanup();
    }
  });

  test("replaceAll 替换所有出现", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "multi.ts");
      await writeFile(file, "foo\nfoo\nfoo\n", "utf8");
      const result = await editFileExecutor(
        { path: file, oldString: "foo", newString: "bar", replaceAll: true },
        ctx,
      );
      expect(result.replaced).toBe(3);
      expect(result.matchCount).toBe(3);
      const content = await readFile(file, "utf8");
      expect(content).toBe("bar\nbar\nbar\n");
    } finally {
      await cleanup();
    }
  });

  test("沙箱越界抛错", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await expect(
        editFileExecutor(
          { path: "/etc/passwd", oldString: "root", newString: "x" },
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
      const abortedCtx = { ...ctx, abortSignal: ac.signal };
      const file = join(dir, "abort.ts");
      await writeFile(file, "x", "utf8");
      await expect(
        editFileExecutor({ path: file, oldString: "x", newString: "y" }, abortedCtx),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
