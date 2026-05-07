import { readFile, writeFile } from "node:fs/promises";
import { resolveAllowedPath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { applyEdit } from "../edit-file/executor";

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface MultiEditInput {
  path: string;
  edits: EditSpec[];
  fuzzy?: boolean;
}

interface EditResult {
  index: number;
  replaced: number;
  matchCount: number;
  error?: string;
}

interface MultiEditOutput {
  applied: number;
  total: number;
  results: EditResult[];
}

/**
 * 多处原子编辑 Tool 执行器。
 * 在内存中顺序应用每个 edit，任一失败则全部回滚（不写文件）。
 */
export const multiEditExecutor: ToolExecutor<MultiEditInput, MultiEditOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const target = resolveAllowedPath(input.path, resolveSandboxPolicy(context));
  const original = await readFile(target, "utf8");

  const fuzzy = input.fuzzy !== false;
  const results: EditResult[] = [];
  let current = original;
  let failed = false;

  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i]!;
    try {
      const { newContent, replaced, matchCount } = applyEdit(
        current,
        edit.oldString,
        edit.newString,
        edit.replaceAll === true,
        fuzzy,
      );
      current = newContent;
      results.push({ index: i, replaced, matchCount });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ index: i, replaced: 0, matchCount: 0, error });
      failed = true;
      break;
    }
  }

  if (failed) {
    return { applied: results.filter((r) => r.error === undefined).length, total: input.edits.length, results };
  }

  await writeFile(target, current, "utf8");
  return { applied: results.length, total: input.edits.length, results };
};
