import { resolve } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface GitDiffInput {
  cwd?: string;
  path?: string;
  staged?: boolean;
  ref?: string;
  context?: number;
  maxBytes?: number;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

interface FileDiff {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary: boolean;
}

interface GitDiffOutput {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const parseDiff = (rawDiff: string): FileDiff[] => {
  const files: FileDiff[] = [];
  const fileBlocks = rawDiff.split(/^diff --git /m).filter((b) => b.trim().length > 0);

  for (const block of fileBlocks) {
    const lines = block.split("\n");
    let path = "";
    let oldPath: string | undefined;
    let status: FileDiff["status"] = "modified";
    let binary = false;
    let additions = 0;
    let deletions = 0;
    const hunks: DiffHunk[] = [];

    // Parse header lines
    let i = 0;
    // First line is "a/... b/..."
    const firstLine = lines[0] ?? "";
    const abMatch = firstLine.match(/^a\/(.+) b\/(.+)$/);
    if (abMatch) {
      oldPath = abMatch[1];
      path = abMatch[2]!;
    }

    i = 1;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.startsWith("new file mode")) {
        status = "added";
      } else if (line.startsWith("deleted file mode")) {
        status = "deleted";
      } else if (line.startsWith("rename from ")) {
        oldPath = line.slice("rename from ".length);
        status = "renamed";
      } else if (line.startsWith("rename to ")) {
        path = line.slice("rename to ".length);
        status = "renamed";
      } else if (line.startsWith("copy from ")) {
        oldPath = line.slice("copy from ".length);
        status = "copied";
      } else if (line.startsWith("copy to ")) {
        path = line.slice("copy to ".length);
        status = "copied";
      } else if (line.startsWith("Binary files")) {
        binary = true;
        break;
      } else if (line.startsWith("GIT binary patch")) {
        binary = true;
        break;
      } else if (line.startsWith("--- ")) {
        // entering hunk section
        i++;
        break;
      }
      i++;
    }

    if (!binary) {
      // Skip "+++ " line if present
      if (i < lines.length && lines[i]?.startsWith("+++ ")) {
        i++;
      }
      // Parse hunks
      while (i < lines.length) {
        const line = lines[i]!;
        const hunkMatch = line.match(HUNK_HEADER_RE);
        if (hunkMatch) {
          const oldStart = parseInt(hunkMatch[1]!, 10);
          const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
          const newStart = parseInt(hunkMatch[3]!, 10);
          const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
          const hunkLines: string[] = [line];
          i++;
          while (i < lines.length && !lines[i]!.match(HUNK_HEADER_RE) && !lines[i]!.startsWith("diff --git ")) {
            const dl = lines[i]!;
            hunkLines.push(dl);
            if (dl.startsWith("+")) additions++;
            else if (dl.startsWith("-")) deletions++;
            i++;
          }
          hunks.push({
            oldStart,
            oldLines,
            newStart,
            newLines,
            header: line,
            lines: hunkLines,
          });
        } else {
          i++;
        }
      }
    }

    const fileDiff: FileDiff = { path, status, additions, deletions, hunks, binary };
    if (oldPath !== undefined && (status === "renamed" || status === "copied")) {
      fileDiff.oldPath = oldPath;
    }
    files.push(fileDiff);
  }

  return files;
};

export const gitDiffExecutor: ToolExecutor<GitDiffInput, GitDiffOutput | { error: string }> =
  async (input, context) => {
    assertNotAborted(context.abortSignal);
    const policy = resolveSandboxPolicy(context);
    const cwd = input.cwd
      ? resolveAllowedPath(input.cwd, policy)
      : resolve(context.workspaceRoot);

    const contextLines = input.context ?? 3;
    const maxBytes = input.maxBytes ?? 32768;

    const cmd: string[] = ["git", "diff", `--unified=${contextLines}`];
    if (input.staged) cmd.push("--staged");
    if (input.ref) cmd.push(input.ref);
    if (input.path) cmd.push("--", input.path);

    const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

    const [rawBytes, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    assertNotAborted(context.abortSignal);

    if (exitCode !== 0 && exitCode !== 1) {
      return { error: stderr || `git diff exited with code ${exitCode}` };
    }

    let truncated = false;
    let rawDiff: string;
    if (rawBytes.byteLength > maxBytes) {
      truncated = true;
      rawDiff = new TextDecoder().decode(rawBytes.slice(0, maxBytes));
    } else {
      rawDiff = new TextDecoder().decode(rawBytes);
    }

    const files = parseDiff(rawDiff);
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const f of files) {
      totalAdditions += f.additions;
      totalDeletions += f.deletions;
    }

    return { files, totalAdditions, totalDeletions, truncated };
  };
