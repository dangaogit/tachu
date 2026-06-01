import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = async (): Promise<
  { ctx: ToolExecutionContext; dir: string; cleanup: () => Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-read-file-"));
  const ctx: ToolExecutionContext = {
    abortSignal: new AbortController().signal,
    workspaceRoot: dir,
    allowedRoots: [dir],
    sandboxWaived: false,
    session: {
      id: "s-read-file",
      status: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    },
  };
  return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

const SAMPLE = "line1\nline2\nline3\nline4\nline5\n";

describe("readFileExecutor", () => {
 test("基本读取，默认行号", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor({ path: file }, ctx);
      expect(result.content).toContain("     1|line1");
      expect(result.content).toContain("     5|line5");
      expect(result.bytes).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

 test("withLineNumbers=false 不添加行号", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor({ path: file, withLineNumbers: false }, ctx);
      expect(result.content).not.toContain("|");
      expect(result.content).toContain("line1");
    } finally {
      await cleanup();
    }
  });

 test("offset 从指定行开始", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor({ path: file, offset: 3 }, ctx);
      expect(result.content).toContain("     3|line3");
      expect(result.content).not.toContain("     1|line1");
      expect(result.totalLines).toBeDefined();
    } finally {
      await cleanup();
    }
  });

 test("limit 限制行数", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor({ path: file, limit: 2 }, ctx);
      expect(result.content).toContain("     1|line1");
      expect(result.content).toContain("     2|line2");
      expect(result.content).not.toContain("line3");
      expect(result.hasMore).toBe(true);
    } finally {
      await cleanup();
    }
  });

 test("offset + limit 组合", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor({ path: file, offset: 2, limit: 2 }, ctx);
      expect(result.content).toContain("     2|line2");
      expect(result.content).toContain("     3|line3");
      expect(result.content).not.toContain("line1");
      expect(result.hasMore).toBe(true);
      expect(result.totalLines).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

 test("offset 超出总行数时 hasMore=false", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor({ path: file, offset: 4, limit: 10 }, ctx);
      expect(result.hasMore).toBe(false);
    } finally {
      await cleanup();
    }
  });

 test("base64 模式忽略 offset/limit/withLineNumbers", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      const result = await readFileExecutor(
        { path: file, encoding: "base64", offset: 2, limit: 1, withLineNumbers: true },
        ctx,
      );
      const decoded = Buffer.from(result.content, "base64").toString("utf8");
      expect(decoded).toBe(SAMPLE);
      expect(result.totalLines).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

 test("沙箱越界抛错", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await expect(
        readFileExecutor({ path: "/etc/passwd" }, ctx),
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
      const file = join(dir, "sample.txt");
      await writeFile(file, SAMPLE, "utf8");
      await expect(
        readFileExecutor({ path: file }, { ...ctx, abortSignal: ac.signal }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
