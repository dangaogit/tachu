import { resolve } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface GitStatusInput {
  cwd?: string;
}

interface GitFileEntry {
  path: string;
  originalPath?: string;
  status: string;
}

interface GitStatusOutput {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: string[];
  isClean: boolean;
  detachedHead: boolean;
}

const parsePortcelainV2 = (stdout: string): GitStatusOutput => {
  const lines = stdout.split("\n");
  let branch = "";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let detachedHead = false;
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      if (head === "(detached)") {
        detachedHead = true;
        branch = "HEAD";
      } else {
        branch = head;
      }
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const ab = line.slice("# branch.ab ".length);
      const match = ab.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = parseInt(match[1]!, 10);
        behind = parseInt(match[2]!, 10);
      }
    } else if (line.startsWith("1 ")) {
 // ordinary changed entries: "1 XY sub mH mI mW hH hI path"
      const parts = line.split(" ");
      const xy = parts[1]!;
      const filePath = parts.slice(8).join(" ");
      const stagedStatus = xy[0]!;
      const unstagedStatus = xy[1]!;
      if (stagedStatus !== "." && stagedStatus !== " ") {
        staged.push({ path: filePath, status: stagedStatus });
      }
      if (unstagedStatus !== "." && unstagedStatus !== " ") {
        unstaged.push({ path: filePath, status: unstagedStatus });
      }
    } else if (line.startsWith("2 ")) {
 // renamed/copied entries: "2 XY sub mH mI mW hH hI X score origPath\tpath"
      const parts = line.split(" ");
      const xy = parts[1]!;
      const stagedStatus = xy[0]!;
      const unstagedStatus = xy[1]!;
 // paths are at the end after a tab
      const pathPart = parts.slice(9).join(" ");
      const tabIdx = pathPart.indexOf("\t");
      let filePath: string;
      let originalPath: string | undefined;
      if (tabIdx >= 0) {
        originalPath = pathPart.slice(0, tabIdx);
        filePath = pathPart.slice(tabIdx + 1);
      } else {
        filePath = pathPart;
      }
      if (stagedStatus !== "." && stagedStatus !== " ") {
        const entry: GitFileEntry = { path: filePath, status: stagedStatus };
        if (originalPath) entry.originalPath = originalPath;
        staged.push(entry);
      }
      if (unstagedStatus !== "." && unstagedStatus !== " ") {
        unstaged.push({ path: filePath, status: unstagedStatus });
      }
    } else if (line.startsWith("? ")) {
      untracked.push(line.slice(2));
    }
  }

  const isClean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;

  const result: GitStatusOutput = {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    isClean,
    detachedHead,
  };
  if (upstream !== undefined) result.upstream = upstream;
  return result;
};

export const gitStatusExecutor: ToolExecutor<GitStatusInput, GitStatusOutput | { error: string }> =
  async (input, context) => {
    assertNotAborted(context.abortSignal);
    const policy = resolveSandboxPolicy(context);
    const cwd = input.cwd
      ? resolveAllowedPath(input.cwd, policy)
      : resolve(context.workspaceRoot);

    const proc = Bun.spawn({
      cmd: ["git", "status", "--porcelain=v2", "--branch"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    assertNotAborted(context.abortSignal);

    if (exitCode !== 0) {
      return { error: stderr || `git status exited with code ${exitCode}` };
    }

    return parsePortcelainV2(stdout);
  };
