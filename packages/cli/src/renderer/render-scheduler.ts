/**
 * 将高频 UI 更新合并到至多 maxFps 次/秒，减轻终端重绘压力。
 */

export interface RenderScheduler {
  /** 登记一次刷新；在节流窗口内合并为单次执行（保留最后一次回调）。 */
  schedule: (cb: () => void) => void;
  cancel: () => void;
}

/**
 * 创建基于最小间隔的调度器（默认约 60 FPS）。
 *
 * - 同一窗口内多次 `schedule` 只触发一次 `cb`，执行**最后一次**传入的回调。
 */
export function createRenderScheduler(options?: { maxFps?: number }): RenderScheduler {
  const maxFps = options?.maxFps ?? 60;
  const minIntervalMs = Math.max(1, Math.floor(1000 / maxFps));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | undefined;
  let lastRun = 0;

  return {
    schedule(cb: () => void) {
      pending = cb;
      if (timer !== undefined) {
        return;
      }
      const now = Date.now();
      const elapsed = now - lastRun;
      const delay = elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
      timer = setTimeout(() => {
        timer = undefined;
        lastRun = Date.now();
        const fn = pending;
        pending = undefined;
        fn?.();
      }, delay);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = undefined;
    },
  };
}

/**
 * 经典 throttle：在 `ms` 毫秒内最多调用一次 `fn`（尾部对齐）。
 */
export function throttle<A extends unknown[]>(
  ms: number,
  fn: (...args: A) => void,
): (...args: A) => void {
  let lastInvoke = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;

  return (...args: A) => {
    const now = Date.now();
    const remaining = ms - (now - lastInvoke);
    lastArgs = args;
    if (remaining <= 0) {
      if (trailingTimer !== undefined) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      lastInvoke = now;
      fn(...args);
      lastArgs = undefined;
      return;
    }
    if (trailingTimer !== undefined) {
      clearTimeout(trailingTimer);
    }
    trailingTimer = setTimeout(() => {
      trailingTimer = undefined;
      lastInvoke = Date.now();
      if (lastArgs !== undefined) {
        fn(...lastArgs);
        lastArgs = undefined;
      }
    }, remaining);
  };
}
