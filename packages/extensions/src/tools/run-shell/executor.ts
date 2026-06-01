import { resolve, resolve as pathResolve } from "node:path";
import { stat } from "node:fs/promises";
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
const SHELL_SYNTAX_PATTERN = /[\s'"`|&;<>*$(){}[\]\\]/;

/**
 * B1: 环境变量白名单可配置。
 * 默认包含常用开发工具所需变量；可通过 TACHU_SHELL_ENV_ALLOWLIST 环境变量完全覆盖。
 */
const resolveEnvAllowlist = (): readonly string[] => {
  const envOverride = process.env.TACHU_SHELL_ENV_ALLOWLIST;
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "PATH",
    "HOME",
    "LANG",
    "TERM",
    "USER",
    "SHELL",
    "NODE_ENV",
    "BUN_INSTALL",
    "PNPM_HOME",
    "NPM_CONFIG_PREFIX",
  ];
};

/**
 * B2: Session 级持久 cwd。
 * 键为 sessionId，值为上次使用的工作目录。
 */
const sessionCwdMap = new Map<string, string>();

/**
 * B3: 危险命令黑名单。
 */
const BUILTIN_DENY_PATTERNS: RegExp[] = [
  /^rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/(\s|$)/,
  /\|\s*sh\b/,
  /\|\s*bash\b/,
  />\s*\/dev\/sd[a-z]/,
  /mkfs\b/,
];

const checkDenyPatterns = (command: string): void => {
  const extraPatterns = (process.env.TACHU_SHELL_DENY_PATTERNS ?? "")
    .split("||")
    .filter(Boolean)
    .map((s) => new RegExp(s));
  const all = [...BUILTIN_DENY_PATTERNS, ...extraPatterns];
  for (const re of all) {
 if (re.test(command)) {
      throw new ValidationError(
        "SHELL_COMMAND_DENIED",
        `命令被安全策略拒绝（匹配黑名单）：${command}`,
      );
    }
  }
};

const buildSandboxedEnv = (extra?: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of resolveEnvAllowlist()) {
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

const buildSpawnCommand = (input: RunShellInput): string[] => {
  const args = input.args ?? [];
  if (args.length > 0) {
    return [input.command, ...args];
  }
  const command = input.command.trim();
 if (SHELL_SYNTAX_PATTERN.test(command)) {
    return ["/bin/sh", "-c", command];
  }
  return [command];
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

 // B3: 危险命令检查
  checkDenyPatterns(input.command);

  const sessionId = context.session.id;

 // B2: 确定本次 cwd
  let effectiveCwd: string;
  if (input.cwd) {
    effectiveCwd = resolveAllowedPath(input.cwd, resolveSandboxPolicy(context));
    sessionCwdMap.set(sessionId, effectiveCwd);
  } else if (sessionCwdMap.has(sessionId)) {
    effectiveCwd = sessionCwdMap.get(sessionId)!;
  } else {
    effectiveCwd = context.workspaceRoot;
  }

 // B2: cd 命令特殊处理
  const cdMatch = /^cd\s+(.+)$/.exec(input.command.trim());
  if (cdMatch) {
    const target = cdMatch[1]!.trim().replace(/^['"]|['"]$/g, "");
    const nextCwd = pathResolve(effectiveCwd, target);
    try {
      const s = await stat(nextCwd);
      if (s.isDirectory()) {
        sessionCwdMap.set(sessionId, nextCwd);
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      }
    } catch {
 // 目录不存在，让 spawn 自然报错
    }
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const cmd = buildSpawnCommand(input);
  const processRef = Bun.spawn({
    cmd,
    cwd: effectiveCwd,
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

// Export for testing
export { sessionCwdMap, resolveEnvAllowlist, checkDenyPatterns };
