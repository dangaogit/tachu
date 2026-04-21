import type { BrowserContext, Page, Route } from "playwright-core";
import type { BrowserPool } from "../../src/browser/pool";
import type { BrowserAcquisition } from "../../src/browser/types";

/**
 * Options for {@link createMockBrowserPool}.
 */
export interface CreateMockBrowserPoolOptions {
  /** URL → HTML body served by mock {@link Page.goto} / {@link Page.content}. */
  htmlByUrl: Record<string, string>;
  /** Artificial delay applied before `goto` resolves (default: 0). */
  delayMs?: number;
  /** When true, every `goto` rejects (for failure-path tests). */
  throwOnGoto?: boolean;
}

/**
 * Lightweight counters exposed by the mock pool (not present on the real {@link BrowserPool} yet).
 */
export interface MockBrowserPoolStats {
  /** Contexts currently acquired and not yet released. */
  inflight: number;
  /** Monotonic counter of successful `acquire` calls. */
  acquireCount: number;
  /** Whether {@link MockBrowserPoolLike.close} has completed. */
  closed: boolean;
}

/**
 * Subset of {@link BrowserPool} used in tests, plus {@link MockBrowserPoolLike.stats}.
 */
export type MockBrowserPoolLike = Pick<
  BrowserPool,
  "acquire" | "release" | "isAvailable" | "close"
> & {
  stats(): MockBrowserPoolStats;
};

interface MockContextState {
  readonly context: BrowserContext;
  release: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asBrowserContext(ctx: object): BrowserContext {
  return ctx as BrowserContext;
}

function asPage(page: object): Page {
  return page as Page;
}

/**
 * Builds a Playwright-free stand-in for {@link BrowserPool} that feeds HTML from a URL map.
 * Intended for unit/integration tests (no real browser launch).
 */
export function createMockBrowserPool(opts: CreateMockBrowserPoolOptions): MockBrowserPoolLike {
  const delayMs = opts.delayMs ?? 0;
  let closed = false;
  let acquireCount = 0;
  const inflight = new Map<BrowserContext, MockContextState>();

  const assertNotClosed = (): void => {
    if (closed) {
      throw new Error("BrowserPool.acquire: pool is closed");
    }
  };

  const createPage = (_ctx: BrowserContext): Page => {
    let html = "<html><head></head><body></body></html>";

    const page = {
      async goto(url: string): Promise<null> {
        if (opts.throwOnGoto === true) {
          throw new Error("MockBrowserPool: throwOnGoto");
        }
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        const body = opts.htmlByUrl[url];
        if (body === undefined) {
          throw new Error(`MockBrowserPool: no fixture HTML for URL: ${url}`);
        }
        html = body;
        return null;
      },
      async content(): Promise<string> {
        return html;
      },
      async route(_url: string | RegExp, _handler: (route: Route) => void | Promise<void>): Promise<void> {
        /* noop */
      },
      async setExtraHTTPHeaders(_headers: Record<string, string>): Promise<void> {
        /* noop */
      },
      async close(): Promise<void> {
        /* noop */
      },
    };

    return asPage(page);
  };

  const createContext = (): BrowserContext => {
    const ctxObj = {
      async newPage(): Promise<Page> {
        return createPage(asBrowserContext(ctxObj));
      },
      async addCookies(_cookies: Parameters<BrowserContext["addCookies"]>[0]): Promise<void> {
        /* noop */
      },
      async setExtraHTTPHeaders(_headers: Record<string, string>): Promise<void> {
        /* noop */
      },
      async close(): Promise<void> {
        /* noop */
      },
    };
    return asBrowserContext(ctxObj);
  };

  return {
    isAvailable(): boolean {
      return !closed;
    },

    async acquire(signal?: AbortSignal): Promise<BrowserAcquisition> {
      assertNotClosed();
      if (signal?.aborted === true) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }

      acquireCount++;
      const context = createContext();
      let released = false;
      const releaseFn = async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;
        inflight.delete(context);
      };
      inflight.set(context, { context, release: releaseFn });

      return {
        context,
        release: releaseFn,
      };
    },

    async release(context: BrowserContext): Promise<void> {
      const entry = inflight.get(context);
      if (entry === undefined) {
        return;
      }
      await entry.release();
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const { release } of inflight.values()) {
        await release();
      }
      inflight.clear();
    },

    stats(): MockBrowserPoolStats {
      return {
        inflight: inflight.size,
        acquireCount,
        closed,
      };
    },
  };
}
