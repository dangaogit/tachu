import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAllowedPath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

interface WriteFileInput {
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
  createDirs?: boolean;
}

interface WriteFileOutput {
  bytesWritten: number;
}

/**
 * 写入文件 Tool 执行器。
 */
export const writeFileExecutor: ToolExecutor<WriteFileInput, WriteFileOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const target = resolveAllowedPath(input.path, resolveSandboxPolicy(context));
  if (input.createDirs) {
    await mkdir(dirname(target), { recursive: true });
  }
  const payload =
    input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content);
  await writeFile(target, payload);
  return { bytesWritten: payload.byteLength };
};
