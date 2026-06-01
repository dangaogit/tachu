import { resolve } from "node:path";
import { resolveAllowedPath, toWorkspaceRelativePath } from "../../common/path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];
const DEFAULT_MAX_RESULTS = 1000;

interface GlobInput {
  pattern: string;
  cwd?: string;
  ignore?: string[];
  maxResults?: number;
}

interface GlobOutput {
  files: string[];
  truncated: boolean;
  matchCount: number;
}

const matchesIgnore = (relPath: string, ignorePatterns: string[]): boolean => {
  for (const pattern of ignorePatterns) {
    if (new Bun.Glob(pattern).match(relPath)) {
      return true;
    }
  }
  return false;
};

/**
 * Glob 文件搜索 Tool 执行器。
 */
export const globExecutor: ToolExecutor<GlobInput, GlobOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const policy = resolveSandboxPolicy(context);
  const resolvedCwd = input.cwd !== undefined
    ? resolveAllowedPath(input.cwd, policy)
    : context.workspaceRoot;

  const ignore = input.ignore !== undefined ? input.ignore : DEFAULT_IGNORE;
  const maxResults = input.maxResults !== undefined ? input.maxResults : DEFAULT_MAX_RESULTS;

  const files: string[] = [];
  let truncated = false;

  for await (const relPath of new Bun.Glob(input.pattern).scan({ cwd: resolvedCwd, onlyFiles: true })) {
    if (matchesIgnore(relPath, ignore)) {
      continue;
    }

    const absPath = resolve(resolvedCwd, relPath);

 // Sandbox check: silently skip out-of-bounds paths
    try {
      resolveAllowedPath(absPath, policy);
    } catch {
      continue;
    }

    if (files.length >= maxResults) {
      truncated = true;
      break;
    }

    files.push(toWorkspaceRelativePath(context.workspaceRoot, absPath));
  }

  return { files, truncated, matchCount: files.length };
};
