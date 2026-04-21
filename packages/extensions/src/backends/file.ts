import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BackendInput,
  BackendOutput,
  ExecutionBackend,
  ExecutionContext,
  ExecutionTraits,
} from "@tachu/core";
import { ValidationError } from "@tachu/core";

/**
 * 如果 `context.abortSignal` 已触发，就立即抛出；否则 no-op。
 *
 * D1-LOW-11：Node fs 的 Promises API 并非每个方法都支持 `signal`，改用显式检查
 * 在 backend 入口以及每个分支前完成"响应外部取消"的语义。
 */
const assertNotAborted = (context: ExecutionContext): void => {
  if (context.abortSignal?.aborted) {
    throw context.abortSignal.reason ?? new Error("file backend aborted");
  }
};

/**
 * 文件系统执行后端。
 */
export class FileBackend implements ExecutionBackend {
  readonly name = "file";
  readonly kind = "file" as const;
  readonly traits: ExecutionTraits = {
    sideEffect: "write",
    idempotent: false,
    requiresApproval: true,
    timeout: 30_000,
  };

  /**
   * 执行文件操作。
   *
   * @param input 后端输入
   * @param context 执行上下文
   * @returns 后端输出
   */
  async execute(input: BackendInput, context: ExecutionContext): Promise<BackendOutput> {
    const payload = input.payload as {
      operation?: "read" | "write" | "delete" | "move" | "copy";
      path?: string;
      to?: string;
      content?: string;
      createDirs?: boolean;
      encoding?: BufferEncoding;
    };
    if (!payload.operation || !payload.path) {
      throw new ValidationError("VALIDATION_FILE_OPERATION", "file backend 缺少 operation/path");
    }

    assertNotAborted(context);
    switch (payload.operation) {
      case "read": {
        const data = await readFile(payload.path, payload.encoding ?? "utf8");
        assertNotAborted(context);
        return { success: true, result: { content: data, traceId: context.traceId } };
      }
      case "write": {
        if (typeof payload.content !== "string") {
          throw new ValidationError("VALIDATION_FILE_OPERATION", "write 操作缺少 content");
        }
        if (payload.createDirs) {
          await mkdir(dirname(payload.path), { recursive: true });
        }
        assertNotAborted(context);
        await writeFile(payload.path, payload.content, payload.encoding ?? "utf8");
        const fileStat = await stat(payload.path);
        return { success: true, result: { bytesWritten: fileStat.size, traceId: context.traceId } };
      }
      case "delete": {
        await rm(payload.path, { force: true, recursive: true });
        return { success: true, result: { deleted: true, traceId: context.traceId } };
      }
      case "move": {
        if (!payload.to) {
          throw new ValidationError("VALIDATION_FILE_OPERATION", "move 操作缺少 to");
        }
        await mkdir(dirname(payload.to), { recursive: true });
        assertNotAborted(context);
        await rename(payload.path, payload.to);
        return { success: true, result: { moved: true, traceId: context.traceId } };
      }
      case "copy": {
        if (!payload.to) {
          throw new ValidationError("VALIDATION_FILE_OPERATION", "copy 操作缺少 to");
        }
        await mkdir(dirname(payload.to), { recursive: true });
        assertNotAborted(context);
        await copyFile(payload.path, payload.to);
        return { success: true, result: { copied: true, traceId: context.traceId } };
      }
      default:
        throw new ValidationError("VALIDATION_FILE_OPERATION", `未知文件操作: ${payload.operation}`);
    }
  }
}
