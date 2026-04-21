import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveAllowedPath, toWorkspaceRelativePath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

interface ListDirInput {
  path: string;
  recursive?: boolean;
  maxEntries?: number;
  pattern?: string;
}

interface ListDirEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

interface ListDirOutput {
  entries: ListDirEntry[];
  truncated: boolean;
}

/**
 * 列目录 Tool 执行器。
 */
export const listDirExecutor: ToolExecutor<ListDirInput, ListDirOutput> = async (
  input,
  context,
) => {
  const recursive = input.recursive ?? false;
  const maxEntries = input.maxEntries ?? 1000;
  const matcher = input.pattern ? new RegExp(input.pattern) : undefined;
  const root = resolveAllowedPath(input.path, resolveSandboxPolicy(context));
  const entries: ListDirEntry[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    assertNotAborted(context.abortSignal);
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      // D1-LOW-10：长循环中周期性检查 AbortSignal，保证取消能及时生效。
      assertNotAborted(context.abortSignal);
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const absolute = join(dir, child.name);
      const relative = toWorkspaceRelativePath(context.workspaceRoot, absolute);
      if (matcher && !matcher.test(relative)) {
        if (recursive && child.isDirectory()) {
          await walk(absolute);
        }
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ name: relative, type: "directory" });
        if (recursive) {
          await walk(absolute);
        }
      } else if (child.isFile()) {
        const fileStat = await stat(absolute);
        entries.push({ name: relative, type: "file", size: fileStat.size });
      }
    }
  };

  await walk(root);
  return { entries, truncated };
};
