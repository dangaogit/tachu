import { TimeoutError } from "../errors";

/**
 * 创建可链式传播的 AbortController。
 */
export const createLinkedAbortController = (
  parent?: AbortSignal,
): AbortController => {
  const controller = new AbortController();
  if (!parent) {
    return controller;
  }

  if (parent.aborted) {
    controller.abort(parent.reason);
    return controller;
  }

  const onAbort = (): void => {
    controller.abort(parent.reason);
  };
  parent.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => parent.removeEventListener("abort", onAbort),
    { once: true },
  );
  return controller;
};

/**
 * 为 Promise 增加超时保护。
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(TimeoutError.taskTimeout(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/**
 * 在 signal 触发时抛出错误。
 */
export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
};

