import { stat, readFile } from "node:fs/promises";
import { ValidationError } from "@tachu/core";
import { resolveAllowedPath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface ReadFileInput {
  path: string;
  encoding?: "utf-8" | "base64";
  offset?: number;
  limit?: number;
  withLineNumbers?: boolean;
}

interface ReadFileOutput {
  content: string;
  bytes: number;
  totalLines?: number;
  hasMore?: boolean;
}

/**
 * 格式化行号前缀：右对齐 6 位 + `|`，例如 `" 1|"`
 */
const formatLineNumber = (n: number): string => String(n).padStart(6, " ") + "|";

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

  if (input.encoding === "base64") {
    return {
      content: Buffer.from(bytes).toString("base64"),
      bytes: bytes.byteLength,
    };
  }

  const rawText = bytes.toString("utf8");

  const useLineNumbers = input.withLineNumbers !== false;
  const hasOffsetOrLimit = input.offset !== undefined || input.limit !== undefined;

  if (!hasOffsetOrLimit && !useLineNumbers) {
    return { content: rawText, bytes: bytes.byteLength };
  }

  const allLines = rawText.split("\n");
 // If file ends with \n, last element is empty string — keep for totalLines accounting
  const totalLines = allLines.length;

  const startLine = input.offset !== undefined ? Math.max(1, input.offset) : 1;
  const startIdx = startLine - 1;

  let endIdx: number;
  if (input.limit !== undefined) {
    endIdx = startIdx + input.limit;
  } else {
    endIdx = totalLines;
  }
  endIdx = Math.min(endIdx, totalLines);

  const selectedLines = allLines.slice(startIdx, endIdx);

  let content: string;
  if (useLineNumbers) {
    content = selectedLines
      .map((line, i) => formatLineNumber(startLine + i) + line)
      .join("\n");
  } else {
    content = selectedLines.join("\n");
  }

  const output: ReadFileOutput = {
    content,
    bytes: bytes.byteLength,
  };

  if (hasOffsetOrLimit) {
    output.totalLines = totalLines;
    output.hasMore = endIdx < totalLines;
  }

  return output;
};
