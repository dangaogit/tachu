import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = async (): Promise<
  { ctx: ToolExecutionContext; dir: string; cleanup: () => Promise<void> }
> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-glob-"));
  const ctx: ToolExecutionContext = {
    abortSignal: new AbortController().signal,
    workspaceRoot: dir,
    allowedRoots: [dir],
    sandboxWaived: false,
    session: {
      id: "s-glob",
      status: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    },
  };
  return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

describe("globExecutor", () => {
 test("匹配 *.ts 文件", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      await writeFile(join(dir, "a.ts"), "", "utf8");
      await writeFile(join(dir, "b.ts"), "", "utf8");
      await writeFile(join(dir, "c.txt"), "", "utf8");
      const result = await globExecutor({ pattern: "*.ts" }, ctx);
      expect(result.files.length).toBe(2);
      expect(result.files.some((f) => f.endsWith("a.ts"))).toBe(true);
      expect(result.files.some((f) => f.endsWith("b.ts"))).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.matchCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

 test("递归匹配 **/*.ts", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "root.ts"), "", "utf8");
      await writeFile(join(dir, "sub", "nested.ts"), "", "utf8");
      const result = await globExecutor({ pattern: "**/*.ts" }, ctx);
      expect(result.matchCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

 test("node_modules 默认被忽略", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "index.ts"), "", "utf8");
      await writeFile(join(dir, "src.ts"), "", "utf8");
      const result = await globExecutor({ pattern: "**/*.ts" }, ctx);
      expect(result.matchCount).toBe(1);
      expect(result.files[0]).not.toContain("node_modules");
    } finally {
      await cleanup();
    }
  });

 test("自定义 ignore 模式", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(join(dir, "dist", "out.ts"), "", "utf8");
      await writeFile(join(dir, "src.ts"), "", "utf8");
      const result = await globExecutor({ pattern: "**/*.ts", ignore: ["**/dist/**"] }, ctx);
      expect(result.matchCount).toBe(1);
      expect(result.files[0]).not.toContain("dist");
    } finally {
      await cleanup();
    }
  });

 test("maxResults 截断", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(dir, `file${i}.ts`), "", "utf8");
      }
      const result = await globExecutor({ pattern: "*.ts", maxResults: 3 }, ctx);
      expect(result.files.length).toBe(3);
      expect(result.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

 test("沙箱越界 cwd 抛错", async () => {
    const { ctx, cleanup } = await makeContext();
    try {
      await expect(
        globExecutor({ pattern: "*.ts", cwd: "/etc" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_PATH_ESCAPE" });
    } finally {
      await cleanup();
    }
  });

 test("无匹配时返回空数组", async () => {
    const { ctx, dir, cleanup } = await makeContext();
    try {
      await writeFile(join(dir, "file.txt"), "", "utf8");
      const result = await globExecutor({ pattern: "*.rs" }, ctx);
      expect(result.files).toHaveLength(0);
      expect(result.truncated).toBe(false);
      expect(result.matchCount).toBe(0);
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
        globExecutor({ pattern: "*.ts" }, { ...ctx, abortSignal: ac.signal }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
