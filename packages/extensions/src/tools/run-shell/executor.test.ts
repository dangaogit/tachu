import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runShellExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const withContext = async <T>(
  fn: (ctx: ToolExecutionContext) => Promise<T>,
): Promise<T> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tachu-run-shell-"));
  try {
    return await fn({
      abortSignal: new AbortController().signal,
      workspaceRoot,
      allowedRoots: [workspaceRoot, tmpdir()],
      sandboxWaived: false,
      session: {
        id: "s-run-shell",
        status: "active",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
};

describe("runShellExecutor", () => {
  test("保留 command + args 直跑路径", async () => {
    await withContext(async (ctx) => {
      const output = await runShellExecutor(
        { command: "printf", args: ["hello"] },
        ctx,
      );
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe("hello");
    });
  });

  test("无 args 的 shell 命令字符串支持引号和格式参数", async () => {
    await withContext(async (ctx) => {
      const output = await runShellExecutor(
        { command: "date '+%Y-%m-%d %H:%M:%S %Z'" },
        ctx,
      );
      expect(output.exitCode).toBe(0);
      expect(output.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/);
    });
  });
});
