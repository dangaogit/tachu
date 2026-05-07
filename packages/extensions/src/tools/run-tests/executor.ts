import { resolve, join } from "node:path";
import { readFile, access } from "node:fs/promises";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";
import { resolveAllowedPath } from "../../common/path";

interface RunTestsInput {
  cwd?: string;
  filter?: string;
  file?: string;
  maxFailures?: number;
  timeout?: number;
}

interface TestFailure {
  name: string;
  file?: string;
  message: string;
  stack?: string;
}

interface RunTestsOutput {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  failures: TestFailure[];
  truncated: boolean;
  rawOutput?: string;
}

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const hasTestScript = async (cwd: string): Promise<boolean> => {
  try {
    const content = await readFile(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.test === "string";
  } catch {
    return false;
  }
};

const hasBunLockfile = async (cwd: string): Promise<boolean> => {
  return (
    (await fileExists(join(cwd, "bun.lockb"))) ||
    (await fileExists(join(cwd, "bun.lock"))) ||
    (await fileExists(join(cwd, "bunfig.toml")))
  );
};

// Parse bun test summary line like "5 pass, 2 fail, 1 skip"
// Also handle individual lines like "5 pass" / "2 fail" / "1 skip"
const parseBunTestSummary = (
  output: string,
): { passedCount: number; failedCount: number; skippedCount: number } => {
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  const skipMatch = output.match(/(\d+)\s+skip/);

  if (passMatch) passedCount = parseInt(passMatch[1]!, 10);
  if (failMatch) failedCount = parseInt(failMatch[1]!, 10);
  if (skipMatch) skippedCount = parseInt(skipMatch[1]!, 10);

  return { passedCount, failedCount, skippedCount };
};

// Parse test failures from bun test output
// bun prints: "✗ test name" followed by error details
const parseFailures = (output: string, maxFailures: number): { failures: TestFailure[]; truncated: boolean } => {
  const failures: TestFailure[] = [];
  const lines = output.split("\n");

  let i = 0;
  while (i < lines.length && failures.length < maxFailures) {
    const line = lines[i]!;
    // bun uses "✗" or "×" for failures, or "FAIL" prefix
    if (line.includes("✗ ") || line.includes("× ") || line.match(/^\s*FAIL\s/)) {
      const nameMatch = line.match(/[✗×]\s+(.+)$/) || line.match(/FAIL\s+(.+)$/);
      const name = nameMatch ? nameMatch[1]!.trim() : line.trim();

      const messageLines: string[] = [];
      i++;
      // Collect following indented lines as message/stack
      while (i < lines.length && (lines[i]!.startsWith("  ") || lines[i]!.startsWith("\t") || lines[i]!.trim().length === 0)) {
        if (lines[i]!.trim().length > 0) {
          messageLines.push(lines[i]!);
        }
        i++;
      }

      const fullMessage = messageLines.join("\n");
      const message = fullMessage.slice(0, 1024);
      const stack = fullMessage.length > 1024 ? fullMessage.slice(0, 2048) : undefined;

      const failure: TestFailure = { name, message };
      if (stack) failure.stack = stack;
      failures.push(failure);
    } else {
      i++;
    }
  }

  // Count remaining failures in output to detect truncation
  let remainingFailures = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.includes("✗ ") || line.includes("× ") || line.match(/^\s*FAIL\s/)) {
      remainingFailures++;
    }
    i++;
  }

  return { failures, truncated: remainingFailures > 0 };
};

export const runTestsExecutor: ToolExecutor<RunTestsInput, RunTestsOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const policy = resolveSandboxPolicy(context);
  const cwd = input.cwd ? resolveAllowedPath(input.cwd, policy) : resolve(context.workspaceRoot);
  const maxFailures = input.maxFailures ?? 20;
  const timeoutMs = input.timeout ?? 60000;

  const useTestScript = await hasTestScript(cwd);
  const useBunLockfile = !useTestScript && (await hasBunLockfile(cwd));

  if (!useTestScript && !useBunLockfile) {
    return {
      passed: false,
      total: 0,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      durationMs: 0,
      failures: [],
      truncated: false,
      rawOutput: "未能自动识别测试命令，请通过 run-shell 手动执行",
    };
  }

  const cmd: string[] = useTestScript ? [process.execPath, "run", "test"] : [process.execPath, "test"];

  if (input.filter) {
    cmd.push("--test-name-pattern", input.filter);
  }
  if (input.file) {
    cmd.push(input.file);
  }

  const startedAt = Date.now();
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });

  const timeout = setTimeout(() => {
    if (proc.pid) {
      void proc.kill();
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timeout);
  }

  assertNotAborted(context.abortSignal);

  const durationMs = Date.now() - startedAt;
  const combined = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n");

  const { passedCount, failedCount, skippedCount } = parseBunTestSummary(combined);
  const { failures, truncated } = parseFailures(combined, maxFailures);

  const total = passedCount + failedCount + skippedCount;
  const passed = exitCode === 0 && failedCount === 0;

  const result: RunTestsOutput = {
    passed,
    total,
    passedCount,
    failedCount,
    skippedCount,
    durationMs,
    failures,
    truncated,
  };

  // Include rawOutput if we couldn't parse anything meaningful
  if (total === 0 && combined.trim().length > 0) {
    result.rawOutput = combined.slice(0, 4096);
  }

  return result;
};
