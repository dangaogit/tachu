import { describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { BrowserPool, type BrowserPoolDeps } from "./pool";

type LaunchOptions = Parameters<typeof chromium.launch>[0];

export interface __MockBrowserPoolFixture {
  deps: BrowserPoolDeps;
  launchOptions: (LaunchOptions | undefined)[];
  closedContextIds: string[];
  browserCloseCount: number;
}

/**
 * Test helper: injectable Playwright launch mock (no real Chromium, no `mock.module`).
 */
export function __createMockBrowserPool(): __MockBrowserPoolFixture {
  const launchOptions: (LaunchOptions | undefined)[] = [];
  const closedContextIds: string[] = [];
  let browserCloseCount = 0;
  let ctxSeq = 0;

  const deps: BrowserPoolDeps = {
    launch: async (opts) => {
      launchOptions.push(opts);
      const browser: Browser = {
        isConnected: () => true,
        newContext: async () => {
          const id = `ctx-${++ctxSeq}`;
          const ctx = {
            close: async () => {
              closedContextIds.push(id);
            },
            _mockId: id,
          } as BrowserContext & { _mockId: string };
          return ctx;
        },
        close: async () => {
          browserCloseCount++;
        },
      } as unknown as Browser;
      return browser;
    },
  };

  return {
    deps,
    get launchOptions() {
      return launchOptions;
    },
    get closedContextIds() {
      return closedContextIds;
    },
    get browserCloseCount() {
      return browserCloseCount;
    },
  };
}

describe("BrowserPool", () => {
  test("acquire returns a lease; release returns context to idle", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 2,
      contextIdleMs: 60_000,
      deps: fx.deps,
    });
    expect(pool.isAvailable()).toBe(false);
    await pool.launch();
    expect(pool.isAvailable()).toBe(true);

    const lease = await pool.acquire();
    expect(lease.context).toBeDefined();
    await lease.release();
    expect(fx.closedContextIds.length).toBe(0);

    await pool.close();
    expect(fx.closedContextIds.length).toBe(1);
    expect(fx.browserCloseCount).toBe(1);
  });

  test("release is idempotent on the same lease", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 1,
      contextIdleMs: 60_000,
      deps: fx.deps,
    });
    await pool.launch();
    const lease = await pool.acquire();
    await lease.release();
    await lease.release();
    expect(fx.closedContextIds.length).toBe(0);
    await pool.close();
    expect(fx.closedContextIds.length).toBe(1);
  });

  test("third acquire waits until a permit is released", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 2,
      contextIdleMs: 60_000,
      deps: fx.deps,
    });
    await pool.launch();
    const u1 = await pool.acquire();
    const u2 = await pool.acquire();
    let thirdResolved = false;
    const p3 = pool.acquire().then((u) => {
      thirdResolved = true;
      return u;
    });
    await new Promise<void>((r) => {
      setTimeout(r, 15);
    });
    expect(thirdResolved).toBe(false);
    await u1.release();
    const u3 = await p3;
    expect(thirdResolved).toBe(true);
    await u2.release();
    await u3.release();
    await pool.close();
  });

  test("idle TTL closes an idle context", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 1,
      contextIdleMs: 40,
      deps: fx.deps,
    });
    await pool.launch();
    const lease = await pool.acquire();
    await lease.release();
    await new Promise<void>((r) => {
      setTimeout(r, 120);
    });
    expect(fx.closedContextIds.length).toBe(1);
    await pool.close();
  });

  test("close shuts down browser and releases inflight contexts", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 2,
      contextIdleMs: 60_000,
      deps: fx.deps,
    });
    await pool.launch();
    await pool.acquire();
    await pool.acquire();
    await pool.close();
    expect(fx.closedContextIds.length).toBe(2);
    expect(fx.browserCloseCount).toBe(1);
    expect(pool.isAvailable()).toBe(false);
  });

  test("executablePath is forwarded to launch options", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 1,
      contextIdleMs: 1,
      executablePath: "/mock/chromium",
      deps: fx.deps,
    });
    await pool.launch();
    expect(fx.launchOptions[0]?.executablePath).toBe("/mock/chromium");
    await pool.close();
  });

  test("pool.release(context) delegates to the active lease", async () => {
    const fx = __createMockBrowserPool();
    const pool = new BrowserPool({
      maxConcurrency: 1,
      contextIdleMs: 60_000,
      deps: fx.deps,
    });
    await pool.launch();
    const lease = await pool.acquire();
    await pool.release(lease.context);
    await pool.release(lease.context);
    await pool.close();
  });
});
