import { resolve } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface GitShowInput {
  ref: string;
  cwd?: string;
  maxBytes?: number;
}

interface GitShowOutput {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body?: string;
  diff: string;
  truncated: boolean;
}

// Use a machine-parseable format for commit header
const SHOW_FORMAT = "COMMIT_HEADER\x1fHASH:%H\x1fSHORT:%h\x1fAUTHOR:%an\x1fEMAIL:%ae\x1fDATE:%aI\x1fSUBJECT:%s\x1fBODY:%b\x1fEND_HEADER";

const parseShowOutput = (
  raw: string,
  maxBytes: number,
): GitShowOutput => {
  // Find the structured header section
  const headerStart = raw.indexOf("COMMIT_HEADER\x1f");
  const headerEnd = raw.indexOf("END_HEADER");

  let hash = "";
  let shortHash = "";
  let author = "";
  let email = "";
  let date = "";
  let subject = "";
  let body: string | undefined;

  if (headerStart >= 0 && headerEnd > headerStart) {
    const headerBlock = raw.slice(headerStart + "COMMIT_HEADER\x1f".length, headerEnd);
    const fields = headerBlock.split("\x1f");
    for (const field of fields) {
      if (field.startsWith("HASH:")) hash = field.slice(5);
      else if (field.startsWith("SHORT:")) shortHash = field.slice(6);
      else if (field.startsWith("AUTHOR:")) author = field.slice(7);
      else if (field.startsWith("EMAIL:")) email = field.slice(6);
      else if (field.startsWith("DATE:")) date = field.slice(5);
      else if (field.startsWith("SUBJECT:")) subject = field.slice(8);
      else if (field.startsWith("BODY:")) {
        const b = field.slice(5).trim();
        if (b.length > 0) body = b;
      }
    }
  }

  // Everything after END_HEADER is the diff/stat
  let diffText = "";
  if (headerEnd >= 0) {
    diffText = raw.slice(headerEnd + "END_HEADER".length).trimStart();
  }

  let truncated = false;
  if (diffText.length > maxBytes) {
    diffText = diffText.slice(0, maxBytes);
    truncated = true;
  }

  const result: GitShowOutput = { hash, shortHash, author, email, date, subject, diff: diffText, truncated };
  if (body !== undefined) result.body = body;
  return result;
};

export const gitShowExecutor: ToolExecutor<GitShowInput, GitShowOutput | { error: string }> =
  async (input, context) => {
    assertNotAborted(context.abortSignal);
    const policy = resolveSandboxPolicy(context);
    const cwd = input.cwd ? resolveAllowedPath(input.cwd, policy) : resolve(context.workspaceRoot);
    const maxBytes = input.maxBytes ?? 32768;

    const cmd = ["git", "show", `--format=${SHOW_FORMAT}`, "--stat", "--patch", input.ref];

    const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

    const [rawBytes, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    assertNotAborted(context.abortSignal);

    if (exitCode !== 0) {
      return { error: stderr || `git show exited with code ${exitCode}` };
    }

    const raw = new TextDecoder().decode(rawBytes);
    return parseShowOutput(raw, maxBytes);
  };
