import { BudgetExhaustedError } from "../errors";
import type { EngineConfig } from "../types";

export interface ResolvedLlmTimeouts {
  llmWaitFirstTokenMs: number;
  llmStreamingMs: number;
}

const DEFAULT_WAIT_FIRST_TOKEN_MS = 90_000;
const DEFAULT_STREAMING_MS = 43_200_000;

export const resolveLlmTimeouts = (
  config: EngineConfig,
  phase: string,
): ResolvedLlmTimeouts => {
  const globalWait = config.budget.llmWaitFirstTokenMs ?? DEFAULT_WAIT_FIRST_TOKEN_MS;
  const globalStreaming = config.budget.llmStreamingMs ?? DEFAULT_STREAMING_MS;
  const phaseConfig = config.runtime.timeouts?.byPhase?.[phase];
  return {
    llmWaitFirstTokenMs: phaseConfig?.llmWaitFirstTokenMs ?? globalWait,
    llmStreamingMs: phaseConfig?.llmStreamingMs ?? globalStreaming,
  };
};

export const buildLlmCallAbortSignal = (
  outer: AbortSignal,
  timeoutMs: number,
  mode: "wait" | "streaming",
): AbortSignal => {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      mode === "wait"
        ? BudgetExhaustedError.llmWaitExceeded(timeoutMs, timeoutMs)
        : BudgetExhaustedError.llmStreamingExceeded(timeoutMs, timeoutMs),
    );
  }, timeoutMs);
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuterAbort);
    },
    { once: true },
  );
  return controller.signal;
};

export const isBudgetTimeoutAbort = (signal: AbortSignal): BudgetExhaustedError | null => {
  if (!signal.aborted) return null;
  const reason = signal.reason;
  if (reason instanceof BudgetExhaustedError) {
    return reason;
  }
  return null;
};

export interface LlmStreamAbortController {
  signal: AbortSignal;
  markFirstOutput(): void;
  dispose(): void;
}

export const createLlmStreamAbortController = (
  outer: AbortSignal,
  timeouts: ResolvedLlmTimeouts,
): LlmStreamAbortController => {
  if (outer.aborted) {
    return {
      signal: outer,
      markFirstOutput: () => {},
      dispose: () => {},
    };
  }
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });

  let firstOutputSeen = false;
  let waitTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    controller.abort(
      BudgetExhaustedError.llmWaitExceeded(
        timeouts.llmWaitFirstTokenMs,
        timeouts.llmWaitFirstTokenMs,
      ),
    );
  }, timeouts.llmWaitFirstTokenMs);
  let streamTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = undefined;
    }
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = undefined;
    }
  };

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimers();
      outer.removeEventListener("abort", onOuterAbort);
    },
    { once: true },
  );

  return {
    signal: controller.signal,
    markFirstOutput: (): void => {
      if (firstOutputSeen) return;
      firstOutputSeen = true;
      if (waitTimer) {
        clearTimeout(waitTimer);
        waitTimer = undefined;
      }
      streamTimer = setTimeout(() => {
        controller.abort(
          BudgetExhaustedError.llmStreamingExceeded(
            timeouts.llmStreamingMs,
            timeouts.llmStreamingMs,
          ),
        );
      }, timeouts.llmStreamingMs);
    },
    dispose: (): void => {
      clearTimers();
      outer.removeEventListener("abort", onOuterAbort);
    },
  };
};
