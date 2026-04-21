import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "@tachu/core";
import { writeFileExecutor } from "../../src/tools/write-file/executor";
import type { ToolExecutionContext } from "../../src/tools/shared";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

const buildCtx = (overrides: Partial<ToolExecutionContext>): ToolExecutionContext => {
  const controller = new AbortController();
  const session: Session = {
    id: "test-session",
    status: "active",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  return {
    abortSignal: controller.signal,
    workspaceRoot: overrides.workspaceRoot ?? "/tmp/placeholder-workspace",
    session,
    ...overrides,
  };
};

describe("write-file executor", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("writes file with createDirs", async () => {
    const result = await writeFileExecutor(
      { path: "nested/a.txt", content: "hello", createDirs: true },
      createToolContext(root),
    );
    expect(result.bytesWritten).toBe(5);
    expect(await readFile(`${root}/nested/a.txt`, "utf8")).toBe("hello");
  });

  it("rejects path escape", async () => {
    await expect(
      writeFileExecutor({ path: "../a.txt", content: "x" }, createToolContext(root)),
    ).rejects.toMatchObject({ code: "VALIDATION_PATH_ESCAPE" });
  });

  it("allowedRoots 里声明的额外根允许写入（静态白名单扩展）", async () => {
    const extra = await createTempDir();
    try {
      const target = join(extra, "scratch.txt");
      const result = await writeFileExecutor(
        { path: target, content: "ok" },
        buildCtx({ workspaceRoot: root, allowedRoots: [root, extra] }),
      );
      expect(result.bytesWritten).toBe(2);
      expect(await readFile(target, "utf8")).toBe("ok");
    } finally {
      await cleanupTempDir(extra);
    }
  });

  it("sandboxWaived=true 时允许写入所有根之外的路径（审批豁免）", async () => {
    const outsider = await createTempDir();
    try {
      const target = join(outsider, "approved.txt");
      const result = await writeFileExecutor(
        { path: target, content: "approved" },
        buildCtx({
          workspaceRoot: root,
          allowedRoots: [root],
          sandboxWaived: true,
        }),
      );
      expect(result.bytesWritten).toBe(8);
      expect(await readFile(target, "utf8")).toBe("approved");
    } finally {
      await cleanupTempDir(outsider);
    }
  });

  it("sandboxWaived=false 且路径越界时仍被拦截（没有隐式放行）", async () => {
    const outsider = await createTempDir();
    try {
      await expect(
        writeFileExecutor(
          { path: join(outsider, "x.txt"), content: "x" },
          buildCtx({
            workspaceRoot: root,
            allowedRoots: [root],
            sandboxWaived: false,
          }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_PATH_ESCAPE" });
    } finally {
      await cleanupTempDir(outsider);
    }
  });
});
