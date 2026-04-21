/**
 * IP 维度令牌桶限流（惰性补充，基于单调时钟 {@link performance.now}）。
 *
 * > **容量提示**：本实现使用 `Map` 长期持有各 `clientKey` 的状态。若运行时 client key
 * > 基数极大（例如海量独立 IP），建议在上层引入 LRU 或分片淘汰策略；v0.1 暂不实现。
 */

import { RateLimitedError } from "./errors";

export type { RateLimitedDetail } from "./errors";
export { RateLimitedError };

type BucketState = {
  tokens: number;
  lastRefillMs: number;
};

export type RateLimiter = {
  /**
   * 尝试消耗 1 个令牌；成功则返回，失败则抛出 {@link RateLimitedError}。
   *
   * @param clientKey — 调用方提供的限流键（通常为规范化后的客户端 IP）。
   */
  acquire(clientKey: string): void;
};

/**
 * 创建基于令牌桶的限流器：按墙钟经过时间惰性补充令牌，突发容量为 `capacity`，
 * 可持续补充速率为 `refillPerSec`（令牌/秒）。
 */
export function createRateLimiter(opts: {
  capacity: number;
  refillPerSec: number;
}): RateLimiter {
  const { capacity, refillPerSec } = opts;
  if (capacity <= 0 || !Number.isFinite(capacity)) {
    throw new RangeError("createRateLimiter: capacity must be a positive finite number");
  }
  if (refillPerSec <= 0 || !Number.isFinite(refillPerSec)) {
    throw new RangeError("createRateLimiter: refillPerSec must be a positive finite number");
  }

  const store = new Map<string, BucketState>();
  const limitRpm = Math.round(refillPerSec * 60);

  return {
    acquire(clientKey: string): void {
      const now = performance.now();
      let state = store.get(clientKey);
      if (!state) {
        state = { tokens: capacity, lastRefillMs: now };
        store.set(clientKey, state);
      }

      const elapsedSec = (now - state.lastRefillMs) / 1000;
      const tokens = Math.min(capacity, state.tokens + elapsedSec * refillPerSec);
      state.lastRefillMs = now;

      if (tokens >= 1) {
        state.tokens = tokens - 1;
        return;
      }

      const deficit = 1 - tokens;
      const retryAfterMs = Math.ceil((deficit / refillPerSec) * 1000);
      state.tokens = tokens;
      throw new RateLimitedError({ retryAfterMs, limitRpm });
    },
  };
}
