/**
 * 进程级优雅停机：监听信号、并行执行关闭钩子、超时后强退。
 */

/** 最小日志接口（可用 `console` 满足）。 */
export type Logger = {
  info(message: string, ...args: unknown[]): void;
};

const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const DEFAULT_TIMEOUT_MS = 10_000;

export type RegisterShutdownOptions = {
  signals?: NodeJS.Signals[];
  timeoutMs?: number;
  logger?: Logger;
  /** 测试注入：替代 `process.exit`（禁止在生产路径依赖）。 */
  _exitForTest?: (code: number) => void;
  /** 测试注入：替代全局 `process`（禁止在生产路径依赖）。 */
  _processForTest?: NodeJS.Process;
};

/**
 * 注册优雅停机：收到信号后并行执行 `handlers`，与超时竞态；完成后退出进程。
 *
 * @param handlers — 并行执行的异步关闭步骤（应幂等、尽快完成）
 * @param opts — 信号列表、超时、日志与测试注入
 * @returns 取消监听同一组信号的函数
 */
export function registerShutdown(
  handlers: Array<() => Promise<void>>,
  opts: RegisterShutdownOptions = {},
): () => void {
  const signals = opts.signals ?? DEFAULT_SIGNALS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = opts.logger ?? console;
  const proc = opts._processForTest ?? process;
  const exit = opts._exitForTest ?? ((code: number) => process.exit(code));

  let shutdownStarted = false;

  const runShutdown = async (): Promise<void> => {
    const allHandlers = Promise.all(handlers.map((h) => h())).then(() => "ok" as const);
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
    });

    try {
      const outcome = await Promise.race([allHandlers, timeout]);
      if (outcome === "timeout") {
        logger.info("[web-fetch-server] shutdown: handlers timed out");
        exit(1);
        return;
      }
      logger.info("[web-fetch-server] shutdown: handlers finished");
      exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.info(`[web-fetch-server] shutdown: handler error: ${msg}`);
      exit(1);
    }
  };

  const onSignal = (): void => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    console.error("shutdown initiated");
    void runShutdown();
  };

  for (const sig of signals) {
    proc.on(sig, onSignal);
  }

  return () => {
    for (const sig of signals) {
      proc.removeListener(sig, onSignal);
    }
  };
}
