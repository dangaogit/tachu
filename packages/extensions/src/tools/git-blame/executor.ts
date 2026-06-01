import { resolve } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface GitBlameInput {
  path: string;
  cwd?: string;
  startLine?: number;
  endLine?: number;
}

interface BlameLine {
  lineNumber: number;
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  content: string;
}

interface GitBlameOutput {
  lines: BlameLine[];
  path: string;
}

const parsePorcelain = (stdout: string): BlameLine[] => {
  const lines = stdout.split("\n");
  const result: BlameLine[] = [];

  let i = 0;
  let currentHash = "";
  let currentAuthor = "";
  let currentDate = "";
  let currentLineNumber = 0;

  while (i < lines.length) {
    const line = lines[i]!;

 // A line starting with 40-char hex hash followed by line info
    const hashMatch = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (hashMatch) {
      currentHash = hashMatch[1]!;
      currentLineNumber = parseInt(hashMatch[2]!, 10);
      i++;
      continue;
    }

    if (line.startsWith("author ") && !line.startsWith("author-")) {
      currentAuthor = line.slice("author ".length);
      i++;
      continue;
    }

    if (line.startsWith("author-time ")) {
      const ts = parseInt(line.slice("author-time ".length), 10);
      currentDate = new Date(ts * 1000).toISOString();
      i++;
      continue;
    }

    if (line.startsWith("\t")) {
      const content = line.slice(1);
      result.push({
        lineNumber: currentLineNumber,
        hash: currentHash,
        shortHash: currentHash.slice(0, 7),
        author: currentAuthor,
        date: currentDate,
        content,
      });
      i++;
      continue;
    }

    i++;
  }

  return result;
};

export const gitBlameExecutor: ToolExecutor<GitBlameInput, GitBlameOutput | { error: string }> =
  async (input, context) => {
    assertNotAborted(context.abortSignal);
    const policy = resolveSandboxPolicy(context);
    const cwd = input.cwd ? resolveAllowedPath(input.cwd, policy) : resolve(context.workspaceRoot);
    const filePath = resolveAllowedPath(input.path, policy);

    const startLine = input.startLine ?? 1;
    const cmd: string[] = ["git", "blame", "--porcelain"];

    if (input.endLine !== undefined) {
      cmd.push("-L", `${startLine},${input.endLine}`);
    } else if (startLine > 1) {
      cmd.push("-L", `${startLine},`);
    }

    cmd.push("--", filePath);

    const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    assertNotAborted(context.abortSignal);

    if (exitCode !== 0) {
      return { error: stderr || `git blame exited with code ${exitCode}` };
    }

    return { lines: parsePorcelain(stdout), path: input.path };
  };
