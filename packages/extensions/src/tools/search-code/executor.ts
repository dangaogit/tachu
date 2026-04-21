import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath, toWorkspaceRelativePath } from "../../common/path";

interface SearchCodeInput {
  pattern: string;
  path?: string;
  fileGlob?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}

interface SearchCodeMatch {
  file: string;
  line: number;
  text: string;
}

interface SearchCodeOutput {
  matches: SearchCodeMatch[];
  truncated: boolean;
}

const parseRgOutput = (
  output: string,
  maxResults: number,
): { matches: SearchCodeMatch[]; truncated: boolean } => {
  const matches: SearchCodeMatch[] = [];
  const lines = output.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    const first = line.indexOf(":");
    const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
    if (first <= 0 || second <= first + 1) {
      continue;
    }
    matches.push({
      file: line.slice(0, first),
      line: Number(line.slice(first + 1, second)),
      text: line.slice(second + 1),
    });
    if (matches.length >= maxResults) {
      return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
};

/**
 * 搜索代码 Tool 执行器。
 */
export const searchCodeExecutor: ToolExecutor<SearchCodeInput, SearchCodeOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const root = resolveAllowedPath(input.path ?? ".", resolveSandboxPolicy(context));
  const maxResults = input.maxResults ?? 100;

  try {
    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      input.caseSensitive ? "--case-sensitive" : "--ignore-case",
      "--max-count",
      String(maxResults),
    ];
    if (input.fileGlob) {
      args.push("--glob", input.fileGlob);
    }
    args.push(input.pattern, root);
    const process = Bun.spawn({
      cmd: ["rg", ...args],
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const code = await process.exited;
    if (code !== 0 && code !== 1) {
      throw new Error(stderr || `rg exited with code ${code}`);
    }
    const parsed = parseRgOutput(stdout, maxResults);
    return {
      matches: parsed.matches.map((item) => ({
        ...item,
        file: toWorkspaceRelativePath(context.workspaceRoot, join(root, item.file)),
      })),
      truncated: parsed.truncated,
    };
  } catch {
    const matcher = new RegExp(input.pattern, input.caseSensitive ? "g" : "gi");
    const matches: SearchCodeMatch[] = [];
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      // D1-LOW-10：进入新目录前先检查取消，避免在大型仓库里无休止递归。
      assertNotAborted(context.abortSignal);
      const children = await readdir(dir, { withFileTypes: true });
      for (const child of children) {
        // 每个子条目都做一次取消检查，粒度足够细而开销极低。
        assertNotAborted(context.abortSignal);
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
        const target = join(dir, child.name);
        if (child.isDirectory()) {
          await walk(target);
          continue;
        }
        if (!child.isFile()) {
          continue;
        }
        if (input.fileGlob && !target.endsWith(input.fileGlob.replace("*", ""))) {
          continue;
        }
        const content = await readFile(target, "utf8").catch(() => "");
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          // 大文件按行遍历时同样做细粒度取消检查。
          if (index % 256 === 0) {
            assertNotAborted(context.abortSignal);
          }
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          const line = lines[index] ?? "";
          if (matcher.test(line)) {
            matches.push({
              file: toWorkspaceRelativePath(context.workspaceRoot, target),
              line: index + 1,
              text: line,
            });
          }
          matcher.lastIndex = 0;
        }
      }
    };

    await walk(root);
    return { matches, truncated };
  }
};
