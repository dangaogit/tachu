import { describe, expect, test } from "bun:test";
import { RateLimitedError, createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  test("allows bursts up to capacity then rejects", () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 100 });
    limiter.acquire("a");
    limiter.acquire("a");
    limiter.acquire("a");
    expect(() => limiter.acquire("a")).toThrow(RateLimitedError);
  });

  test("throws RateLimitedError with RATE_LIMITED / 429 / detail.retryAfterMs", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 10 });
    limiter.acquire("ip");
    try {
      limiter.acquire("ip");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitedError);
      const err = e as RateLimitedError;
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.httpStatus).toBe(429);
      expect(err.detail.retryAfterMs).toBeGreaterThan(0);
      expect(Number.isFinite(err.detail.limitRpm)).toBe(true);
    }
  });

  test("recovers after enough wall time passes for refill", async () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 20 });
    limiter.acquire("c");
    expect(() => limiter.acquire("c")).toThrow(RateLimitedError);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    limiter.acquire("c");
  });

  test("independent buckets per clientKey", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1 });
    limiter.acquire("x");
    limiter.acquire("y");
  });
});
