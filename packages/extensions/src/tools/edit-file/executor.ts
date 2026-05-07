import { readFile, writeFile } from "node:fs/promises";
import { ValidationError } from "@tachu/core";
import { resolveAllowedPath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

export interface EditFileInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  fuzzy?: boolean;
}

export interface EditFileOutput {
  replaced: number;
  matchCount: number;
}

export const countMatches = (content: string, search: string): number => {
  if (search.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
};

/**
 * Fuzzy: match oldString lines (trimmed) against file lines (trimmed).
 * Returns the actual content from the file (with original indentation) if found.
 */
export const fuzzyFindActual = (content: string, oldString: string): string | null => {
  const oldLines = oldString.split("\n");
  const contentLines = content.split("\n");
  if (oldLines.length === 0) return null;
  const oldTrimmed = oldLines.map((l) => l.trim());

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if ((contentLines[i + j] ?? "").trim() !== (oldTrimmed[j] ?? "")) {
        match = false;
        break;
      }
    }
    if (match) {
      return contentLines.slice(i, i + oldLines.length).join("\n");
    }
  }
  return null;
};

/**
 * Core replacement logic (pure, no I/O).
 * Returns the new content and replacement stats, or throws ValidationError.
 */
export const applyEdit = (
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  fuzzy: boolean,
): { newContent: string; replaced: number; matchCount: number } => {
  let effectiveOld = oldString;
  let matchCount = countMatches(content, effectiveOld);

  if (matchCount === 0 && fuzzy) {
    const actual = fuzzyFindActual(content, effectiveOld);
    if (actual !== null) {
      effectiveOld = actual;
      matchCount = countMatches(content, effectiveOld);
    }
  }

  if (!replaceAll && matchCount !== 1) {
    throw new ValidationError(
      "EDIT_FILE_NOT_UNIQUE",
      `oldString 在文件中出现 ${matchCount} 次，期望恰好 1 次（matchCount=${matchCount}）`,
      { context: { matchCount } },
    );
  }

  let newContent: string;
  let replaced: number;

  if (replaceAll) {
    newContent = content.split(effectiveOld).join(newString);
    replaced = matchCount;
  } else {
    const idx = content.indexOf(effectiveOld);
    newContent =
      content.slice(0, idx) + newString + content.slice(idx + effectiveOld.length);
    replaced = 1;
  }

  return { newContent, replaced, matchCount };
};

/**
 * 编辑文件 Tool 执行器：精确字符串替换。
 */
export const editFileExecutor: ToolExecutor<EditFileInput, EditFileOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const target = resolveAllowedPath(input.path, resolveSandboxPolicy(context));
  const content = await readFile(target, "utf8");

  const fuzzy = input.fuzzy !== false;
  const replaceAll = input.replaceAll === true;

  const { newContent, replaced, matchCount } = applyEdit(
    content,
    input.oldString,
    input.newString,
    replaceAll,
    fuzzy,
  );

  await writeFile(target, newContent, "utf8");
  return { replaced, matchCount };
};
