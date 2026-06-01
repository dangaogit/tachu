import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface RunTypecheckInput {
  cwd?: string;
  tsconfig?: string;
  maxErrors?: number;
}

interface TypecheckError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  severity: "error" | "warning";
}

interface RunTypecheckOutput {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  errors: TypecheckError[];
  truncated: boolean;
  rawOutput?: string;
}

// Matches: file.ts(10,5): error TS2345: some message
const TSC_LINE_RE = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

const parseTscOutput = (output: string, maxErrors: number): {
  errors: TypecheckError[];
  errorCount: number;
  warningCount: number;
  truncated: boolean;
  rawOutput?: string;
} => {
  const lines = output.split("\n");
  const allErrors: TypecheckError[] = [];
  let parseSuccess = false;

  for (const line of lines) {
    const m = line.match(TSC_LINE_RE);
    if (m) {
      parseSuccess = true;
      const severity = m[4] as "error" | "warning";
      allErrors.push({
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        col: parseInt(m[3]!, 10),
        code: m[5]!,
        message: m[6]!,
        severity,
      });
    }
  }

 // Sort: errors before warnings
  allErrors.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === "error" ? -1 : 1;
  });

  const errorCount = allErrors.filter((e) => e.severity === "error").length;
  const warningCount = allErrors.filter((e) => e.severity === "warning").length;
  const truncated = allErrors.length > maxErrors;
  const errors = truncated ? allErrors.slice(0, maxErrors) : allErrors;

  const result: {
    errors: TypecheckError[];
    errorCount: number;
    warningCount: number;
    truncated: boolean;
    rawOutput?: string;
  } = { errors, errorCount, warningCount, truncated };

  if (!parseSuccess && output.trim().length > 0) {
    result.rawOutput = output.slice(0, 4096);
  }

  return result;
};

const hasTypecheckScript = async (cwd: string): Promise<boolean> => {
  try {
    const pkgPath = join(cwd, "package.json");
    const content = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.typecheck === "string";
  } catch {
    return false;
  }
};

export const runTypecheckExecutor: ToolExecutor<RunTypecheckInput, RunTypecheckOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const policy = resolveSandboxPolicy(context);
  const cwd = input.cwd ? resolveAllowedPath(input.cwd, policy) : resolve(context.workspaceRoot);
  const maxErrors = input.maxErrors ?? 50;

  const usePackageScript = await hasTypecheckScript(cwd);

  let cmd: string[];
  if (usePackageScript) {
    cmd = [process.execPath, "run", "typecheck"];
  } else {
    cmd = [process.execPath, "x", "tsc", "--noEmit"];
    if (input.tsconfig) {
      cmd.push("--project", input.tsconfig);
    }
  }

  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  assertNotAborted(context.abortSignal);

  const combined = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n");
  const parsed = parseTscOutput(combined, maxErrors);

  return {
    passed: exitCode === 0,
    ...parsed,
  };
};
