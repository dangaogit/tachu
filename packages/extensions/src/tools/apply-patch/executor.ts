import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ValidationError } from "@tachu/core";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath, toWorkspaceRelativePath } from "../../common/path";

interface ApplyPatchInput {
  patch: string;
  basePath?: string;
}

interface ApplyPatchOutput {
  applied: Array<{ file: string; status: "ok" | "failed"; reason?: string }>;
  success: boolean;
}

interface HunkLine {
  type: " " | "+" | "-";
  content: string;
}

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

interface FileSnapshot {
  exists: boolean;
  content: string;
  trailingNewline: boolean;
}

const normalizePatchPath = (value: string): string =>
  value.replace(/^[ab]\//, "").trim();

const splitContent = (content: string): { lines: string[]; trailingNewline: boolean } => {
  if (content.length === 0) {
    return { lines: [], trailingNewline: false };
  }
  const normalized = content.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
};

const parsePatch = (rawPatch: string): FilePatch[] => {
  const lines = rawPatch.replaceAll("\r\n", "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("--- ")) {
      index += 1;
      continue;
    }
    const oldPath = normalizePatchPath(line.slice(4));
    const newLine = lines[index + 1] ?? "";
    if (!newLine.startsWith("+++ ")) {
      throw new ValidationError("VALIDATION_PATCH_FORMAT", "patch 缺少 +++ 文件头");
    }
    const newPath = normalizePatchPath(newLine.slice(4));
    index += 2;

    const hunks: Hunk[] = [];
    while (index < lines.length) {
      const hunkHeader = lines[index] ?? "";
      if (hunkHeader.startsWith("--- ")) {
        break;
      }
      if (!hunkHeader.startsWith("@@ ")) {
        index += 1;
        continue;
      }
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunkHeader);
      if (!match) {
        throw new ValidationError("VALIDATION_PATCH_FORMAT", `无效 hunk 头: ${hunkHeader}`);
      }
      const oldStart = Number(match[1]);
      const newStart = Number(match[2]);
      index += 1;

      const hunkLines: HunkLine[] = [];
      while (index < lines.length) {
        const hunkLine = lines[index] ?? "";
        if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("--- ")) {
          break;
        }
        if (hunkLine === "\\ No newline at end of file") {
          index += 1;
          continue;
        }
        const marker = hunkLine[0];
        if (marker !== " " && marker !== "+" && marker !== "-") {
          throw new ValidationError("VALIDATION_PATCH_FORMAT", `非法 hunk 行: ${hunkLine}`);
        }
        hunkLines.push({ type: marker, content: hunkLine.slice(1) });
        index += 1;
      }
      hunks.push({ oldStart, newStart, lines: hunkLines });
    }

    files.push({ oldPath, newPath, hunks });
  }

  if (files.length === 0) {
    throw new ValidationError("VALIDATION_PATCH_EMPTY", "patch 不包含任何文件");
  }
  return files;
};

const applyFilePatch = (
  original: string,
  patch: FilePatch,
): { content: string; trailingNewline: boolean } => {
  const { lines: sourceLines, trailingNewline } = splitContent(original);
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of patch.hunks) {
    const hunkStart = Math.max(0, hunk.oldStart - 1);
    if (hunkStart < cursor) {
      throw new ValidationError("VALIDATION_PATCH_CONFLICT", "patch hunk 重叠，无法应用");
    }
    result.push(...sourceLines.slice(cursor, hunkStart));
    let sourceIndex = hunkStart;

    for (const line of hunk.lines) {
      if (line.type === " ") {
        const actual = sourceLines[sourceIndex];
        if (actual !== line.content) {
          throw new ValidationError(
            "VALIDATION_PATCH_CONFLICT",
            `上下文不匹配: expected "${line.content}" got "${actual ?? "<eof>"}"`,
          );
        }
        result.push(actual);
        sourceIndex += 1;
        continue;
      }
      if (line.type === "-") {
        const actual = sourceLines[sourceIndex];
        if (actual !== line.content) {
          throw new ValidationError(
            "VALIDATION_PATCH_CONFLICT",
            `删除行不匹配: expected "${line.content}" got "${actual ?? "<eof>"}"`,
          );
        }
        sourceIndex += 1;
        continue;
      }
      result.push(line.content);
    }
    cursor = sourceIndex;
  }
  result.push(...sourceLines.slice(cursor));
  return { content: result.join("\n"), trailingNewline };
};

/**
 * 应用 unified diff Tool 执行器。
 */
export const applyPatchExecutor: ToolExecutor<ApplyPatchInput, ApplyPatchOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const baseRoot = resolveAllowedPath(input.basePath ?? ".", resolveSandboxPolicy(context));
  const filePatches = parsePatch(input.patch);
  const backups = new Map<string, FileSnapshot>();
  const applied: Array<{ file: string; status: "ok" | "failed"; reason?: string }> = [];

  const rollback = async (): Promise<void> => {
    for (const [path, snapshot] of backups.entries()) {
      if (!snapshot.exists) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      await mkdir(dirname(path), { recursive: true });
      const suffix = snapshot.trailingNewline ? "\n" : "";
      await writeFile(path, `${snapshot.content}${suffix}`);
    }
  };

  try {
    for (const patch of filePatches) {
      assertNotAborted(context.abortSignal);
      const logicalTarget = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
      // 这里的校验语义与外层沙箱正交：patch 里声明的每个文件路径都必须
      // 相对 `baseRoot` 不越界，即使外层整体已经 sandboxWaived 也不能让
      // 单个 patch 跳出用户授权的 basePath（否则一次审批会变成无限通道）。
      const absoluteTarget = resolveAllowedPath(logicalTarget, { allowedRoots: [baseRoot] });
      if (!backups.has(absoluteTarget)) {
        const existing = await readFile(absoluteTarget, "utf8").catch(() => null);
        if (existing === null) {
          backups.set(absoluteTarget, { exists: false, content: "", trailingNewline: false });
        } else {
          const split = splitContent(existing);
          backups.set(absoluteTarget, {
            exists: true,
            content: split.lines.join("\n"),
            trailingNewline: split.trailingNewline,
          });
        }
      }

      const original = backups.get(absoluteTarget)?.exists
        ? ((await readFile(absoluteTarget, "utf8").catch(() => "") as string) ?? "")
        : "";

      const next = applyFilePatch(original, patch);
      if (patch.newPath === "/dev/null") {
        await rm(absoluteTarget, { force: true });
      } else {
        await mkdir(dirname(absoluteTarget), { recursive: true });
        const suffix = next.trailingNewline ? "\n" : "";
        await writeFile(absoluteTarget, `${next.content}${suffix}`);
      }
      applied.push({
        file: toWorkspaceRelativePath(context.workspaceRoot, absoluteTarget),
        status: "ok",
      });
    }
    return { applied, success: true };
  } catch (error) {
    await rollback();
    const reason = error instanceof Error ? error.message : String(error);
    if (applied.length === 0) {
      applied.push({ file: "<none>", status: "failed", reason });
    } else {
      const previous = applied[applied.length - 1];
      applied[applied.length - 1] = {
        file: previous?.file ?? "<unknown>",
        status: "failed",
        reason,
      };
    }
    return { applied, success: false };
  }
};
