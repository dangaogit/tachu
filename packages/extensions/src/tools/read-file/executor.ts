import { stat, readFile } from "node:fs/promises";
import { ValidationError } from "@tachu/core";
import { resolveAllowedPath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface ReadFileInput {
  path: string;
  encoding?: "utf-8" | "base64";
}

interface ReadFileOutput {
  content: string;
  bytes: number;
}

/**
 * 读取文件 Tool 执行器。
 */
export const readFileExecutor: ToolExecutor<ReadFileInput, ReadFileOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const target = resolveAllowedPath(input.path, resolveSandboxPolicy(context));
  const fileStat = await stat(target);
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new ValidationError(
      "VALIDATION_FILE_TOO_LARGE",
      `文件超过限制: ${fileStat.size} bytes > ${MAX_FILE_BYTES} bytes`,
      { context: { path: input.path, size: fileStat.size, max: MAX_FILE_BYTES } },
    );
  }

  const bytes = await readFile(target);
  return {
    content: input.encoding === "base64" ? Buffer.from(bytes).toString("base64") : bytes.toString(),
    bytes: bytes.byteLength,
  };
};
