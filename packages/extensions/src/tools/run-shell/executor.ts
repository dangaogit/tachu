import { ValidationError } from "@tachu/core";
import { resolveAllowedPath } from "../../common/path";
import { readStreamWithLimit, terminateProcess } from "../../common/process";
import type { ToolExecutor } from "../shared";
import { assertNotAborted, resolveSandboxPolicy } from "../shared";

interface RunShellInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface RunShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STREAM_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG"] as const;

const buildSandboxedEnv = (extra?: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value;
  }
  return env;
};

/**
 * 执行 shell Tool 执行器。
 */
export const runShellExecutor: ToolExecutor<RunShellInput, RunShellOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  if (!input.command || input.command.trim().length === 0) {
    throw new ValidationError("VALIDATION_EMPTY_COMMAND", "command 不能为空");
  }

  const cwd = input.cwd
    ? resolveAllowedPath(input.cwd, resolveSandboxPolicy(context))
    : context.workspaceRoot;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const processRef = Bun.spawn({
    cmd: [input.command, ...(input.args ?? [])],
    cwd,
    env: buildSandboxedEnv(input.env),
    stdout: "pipe",
    stderr: "pipe",
  });

  const onAbort = (): void => {
    if (processRef.pid) {
      void terminateProcess(processRef.pid);
    }
  };
  context.abortSignal.addEventListener("abort", onAbort, { once: true });

  const timeout = setTimeout(() => {
    if (processRef.pid) {
      void terminateProcess(processRef.pid);
    }
  }, timeoutMs);

  try {
    const [stdoutResult, stderrResult, exitCode] = await Promise.all([
      readStreamWithLimit(processRef.stdout, STREAM_LIMIT_BYTES),
      readStreamWithLimit(processRef.stderr, STREAM_LIMIT_BYTES),
      processRef.exited,
    ]);

    const stdout = stdoutResult.truncated
      ? `${stdoutResult.text}\n[truncated:${STREAM_LIMIT_BYTES}]`
      : stdoutResult.text;
    const stderr = stderrResult.truncated
      ? `${stderrResult.text}\n[truncated:${STREAM_LIMIT_BYTES}]`
      : stderrResult.text;
    return {
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    context.abortSignal.removeEventListener("abort", onAbort);
  }
};
