import { resolve } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface GitBranchInput {
  cwd?: string;
  all?: boolean;
}

interface BranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

interface GitBranchOutput {
  branches: BranchEntry[];
  current: string;
}

// Parses lines from `git branch -vv` or `git branch -vva`
// Format: [* ] <name> <hash> [<upstream>[: ahead N[, behind N]]] <subject>
const parseBranchLine = (line: string): BranchEntry | null => {
  const current = line.startsWith("* ");
 // Strip the leading "* " or " "
  const rest = line.slice(2);
 // Split by whitespace: name, hash, rest...
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx < 0) return null;
  const name = rest.slice(0, spaceIdx).trim();
  const after = rest.slice(spaceIdx).trim();

 // after: "<hash> [upstream info] subject"
  const hashEnd = after.search(/\s/);
  if (hashEnd < 0) return null;
  const remaining = after.slice(hashEnd).trim();

  const remote = name.startsWith("remotes/");

  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

 // Check for upstream tracking info like [origin/main] or [origin/main: ahead 2, behind 1]
  const trackingMatch = remaining.match(/^\[([^\]]+)\]/);
  if (trackingMatch) {
    const trackingInfo = trackingMatch[1]!;
    const colonIdx = trackingInfo.indexOf(":");
    if (colonIdx >= 0) {
      upstream = trackingInfo.slice(0, colonIdx).trim();
      const stats = trackingInfo.slice(colonIdx + 1);
      const aheadMatch = stats.match(/ahead\s+(\d+)/);
      const behindMatch = stats.match(/behind\s+(\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1]!, 10);
      if (behindMatch) behind = parseInt(behindMatch[1]!, 10);
    } else {
      upstream = trackingInfo.trim();
    }
  }

  const entry: BranchEntry = { name, current, remote };
  if (upstream !== undefined) entry.upstream = upstream;
  if (ahead !== undefined) entry.ahead = ahead;
  if (behind !== undefined) entry.behind = behind;
  return entry;
};

export const gitBranchExecutor: ToolExecutor<GitBranchInput, GitBranchOutput | { error: string }> =
  async (input, context) => {
    assertNotAborted(context.abortSignal);
    const policy = resolveSandboxPolicy(context);
    const cwd = input.cwd ? resolveAllowedPath(input.cwd, policy) : resolve(context.workspaceRoot);

    const cmd = input.all ? ["git", "branch", "-vva"] : ["git", "branch", "-vv"];

    const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    assertNotAborted(context.abortSignal);

    if (exitCode !== 0) {
      return { error: stderr || `git branch exited with code ${exitCode}` };
    }

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const branches: BranchEntry[] = [];
    let current = "";

    for (const line of lines) {
      const entry = parseBranchLine(line);
      if (entry) {
        branches.push(entry);
        if (entry.current) current = entry.name;
      }
    }

    return { branches, current };
  };
