import { resolve } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface GitLogInput {
  cwd?: string;
  limit?: number;
  since?: string;
  until?: string;
  author?: string;
  path?: string;
  ref?: string;
  oneline?: boolean;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body?: string;
  refs?: string[];
}

interface GitLogOutput {
  commits: GitCommit[];
  total: number;
  hasMore: boolean;
}

// Fields: hash \x1f shortHash \x1f author \x1f email \x1f date \x1f refs \x1f subject \x1f body \x1e
const FORMAT = "%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%D\x1f%s\x1f%b\x1e";

const parseLog = (stdout: string, oneline: boolean): GitCommit[] => {
  const records = stdout.split("\x1e").filter((r) => r.trim().length > 0);
  return records.map((record) => {
    const parts = record.trim().split("\x1f");
    const hash = parts[0] ?? "";
    const shortHash = parts[1] ?? "";
    const author = parts[2] ?? "";
    const email = parts[3] ?? "";
    const date = parts[4] ?? "";
    const refsRaw = parts[5] ?? "";
    const subject = parts[6] ?? "";
    const body = parts[7] ?? "";

    const refs = refsRaw
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    const commit: GitCommit = { hash, shortHash, author, email, date, subject };
    if (!oneline && body.trim().length > 0) {
      commit.body = body.trim();
    }
    if (refs.length > 0) {
      commit.refs = refs;
    }
    return commit;
  });
};

export const gitLogExecutor: ToolExecutor<GitLogInput, GitLogOutput | { error: string }> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const policy = resolveSandboxPolicy(context);
  const cwd = input.cwd ? resolveAllowedPath(input.cwd, policy) : resolve(context.workspaceRoot);

  const limit = Math.min(input.limit ?? 20, 100);
  const ref = input.ref ?? "HEAD";
  const oneline = input.oneline ?? false;

  const cmd: string[] = ["git", "log", `--format=${FORMAT}`, `-n`, String(limit), ref];
  if (input.since) cmd.push(`--since=${input.since}`);
  if (input.until) cmd.push(`--until=${input.until}`);
  if (input.author) cmd.push(`--author=${input.author}`);
  if (input.path) cmd.push("--", input.path);

  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  assertNotAborted(context.abortSignal);

  if (exitCode !== 0) {
    return { error: stderr || `git log exited with code ${exitCode}` };
  }

  const commits = parseLog(stdout, oneline);
  return {
    commits,
    total: commits.length,
    hasMore: commits.length >= limit,
  };
};
