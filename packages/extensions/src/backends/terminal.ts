import type {
  BackendInput,
  BackendOutput,
  ExecutionBackend,
  ExecutionTraits,
  ExecutionContext,
} from "@tachu/core";
import { ValidationError } from "@tachu/core";
import { readStreamWithLimit, terminateProcess } from "../common/process";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * 终端执行后端。
 */
export class TerminalBackend implements ExecutionBackend {
  readonly name = "terminal";
  readonly kind = "terminal" as const;
  readonly traits: ExecutionTraits = {
    sideEffect: "irreversible",
    idempotent: false,
    requiresApproval: true,
    timeout: 60_000,
  };

  /**
   * 执行终端命令。
   *
   * @param input 后端输入
   * @param context 执行上下文
   * @returns 后端输出
   */
  async execute(input: BackendInput, context: ExecutionContext): Promise<BackendOutput> {
    const payload = input.payload as {
      command?: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
    };
    if (!payload.command) {
      throw new ValidationError("VALIDATION_EMPTY_COMMAND", "terminal backend command 不能为空");
    }

    // D1-LOW-11：尊重宿主注入的 `context.abortSignal`。即便主干传入一个已取消的
    // 信号，也直接返回失败，不再产生真实子进程，避免 "先 spawn 再 kill" 的开销。
    if (context.abortSignal?.aborted) {
      const reason =
        context.abortSignal.reason instanceof Error
          ? context.abortSignal.reason.message
          : String(context.abortSignal.reason ?? "aborted");
      return {
        success: false,
        result: {
          stdout: "",
          stderr: `terminal backend aborted before spawn: ${reason}`,
          exitCode: -1,
          traceId: context.traceId,
          aborted: true,
        },
      };
    }

    const processRef = Bun.spawn({
      cmd: [payload.command, ...(payload.args ?? [])],
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const onExternalAbort = (): void => {
      if (processRef.pid) {
        void terminateProcess(processRef.pid);
      }
    };
    context.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const timeoutId = setTimeout(() => {
      if (processRef.pid) {
        void terminateProcess(processRef.pid);
      }
    }, payload.timeoutMs ?? this.traits.timeout);

    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamWithLimit(processRef.stdout, OUTPUT_LIMIT_BYTES),
      readStreamWithLimit(processRef.stderr, OUTPUT_LIMIT_BYTES),
      processRef.exited,
    ]);
    clearTimeout(timeoutId);
    context.abortSignal?.removeEventListener("abort", onExternalAbort);

    return {
      success: exitCode === 0,
      result: {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        traceId: context.traceId,
      },
    };
  }
}
