import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@tachu/core";
import type { ToolExecutionContext } from "../src/tools/shared";

/**
 * 创建测试临时目录。
 *
 * @returns 临时目录绝对路径
 */
export const createTempDir = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "tachu-ext-test-"));

/**
 * 删除测试临时目录。
 *
 * @param path 临时目录路径
 */
export const cleanupTempDir = async (path: string): Promise<void> => {
  await rm(path, { recursive: true, force: true });
};

/**
 * 创建 Tool 执行上下文。
 *
 * @param workspaceRoot 工作区路径
 * @returns 工具执行上下文
 */
export const createToolContext = (workspaceRoot: string): ToolExecutionContext => {
  const controller = new AbortController();
  const session: Session = {
    id: "test-session",
    status: "active",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  return {
    abortSignal: controller.signal,
    workspaceRoot,
    session,
  };
};
