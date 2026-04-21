import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { noopLogger, type Logger } from "../observability/logger.js";
import type { BrowserAcquisition } from "./types";

/**
 * Thrown when {@link FifoSemaphore.acquire} is aborted or times out.
 * @internal Aligns with s2-h1 `SemaphoreTimeoutError` once `runtime/semaphore` lands.
 */
class SemaphoreTimeoutError extends Error {
  override readonly name = "SemaphoreTimeoutError";
  constructor(message = "Semaphore acquire timed out or aborted") {
    super(message);
  }
}

/**
 * FIFO semaphore with idempotent release callbacks.
 * @internal Prefer importing {@link Semaphore} from `../runtime/semaphore` after task s2-h1 is merged.
 */
class FifoSemaphore {
  private readonly permits: number;
  private inFlight = 0;
  private readonly waiters: Array<{
    resolveRelease: (release: () => void) => void;
    reject: (e: Error) => void;
    cleanup: () => void;
  }> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error("FifoSemaphore: permits must be a positive integer");
    }
    this.permits = permits;
  }

  acquire(signal?: AbortSignal, timeoutMs?: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (this.inFlight < this.permits) {
        this.inFlight++;
        resolve(this.makeRelease());
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        resolveRelease: (release: () => void) => {
          entry.cleanup();
          resolve(release);
        },
        reject: (e: Error) => {
          entry.cleanup();
          reject(e);
        },
        cleanup: () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
        },
      };

      const onAbort = (): void => {
        entry.reject(
          new SemaphoreTimeoutError(
            signal?.reason !== undefined ? String(signal.reason) : "aborted",
          ),
        );
      };

      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          entry.reject(new SemaphoreTimeoutError("timeout"));
        }, timeoutMs);
      }

      this.waiters.push(entry);
    });
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.inFlight < this.permits) {
      const w = this.waiters.shift();
      if (w === undefined) break;
      this.inFlight++;
      w.resolveRelease(this.makeRelease());
    }
  }
}

export interface BrowserPoolDeps {
  /**
   * Injected `chromium.launch` replacement (tests supply a mock; production uses Playwright).
   */
  launch?: (
    options?: Parameters<typeof chromium.launch>[0],
  ) => Promise<Browser>;
}

export interface BrowserPoolOptions {
  maxConcurrency: number;
  contextIdleMs: number;
  executablePath?: string | null;
  deps?: BrowserPoolDeps;
  /** Optional structured logger; defaults to a no-op logger when omitted. */
  logger?: Logger;
}

/**
 * One shared Chromium {@link Browser} with a pool of {@link BrowserContext}s,
 * bounded by {@link BrowserPoolOptions.maxConcurrency} and idle TTL eviction.
 */
export class BrowserPool {
  private readonly contextIdleMs: number;
  private readonly executablePath: string | undefined;
  private readonly deps: BrowserPoolDeps;
  private readonly semaphore: FifoSemaphore;
  private readonly logger: Logger;

  private browser: Browser | null = null;
  private closed = false;

  private readonly idleContexts = new Set<BrowserContext>();
  private readonly idleTimers = new Map<BrowserContext, ReturnType<typeof setTimeout>>();
  private readonly inflightContexts = new Set<BrowserContext>();
  private readonly inflightSemReleases = new Map<BrowserContext, () => void>();
  private readonly contextReleaseFns = new Map<BrowserContext, () => Promise<void>>();

  constructor(options: BrowserPoolOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error("BrowserPool: maxConcurrency must be a positive integer");
    }
    if (!Number.isFinite(options.contextIdleMs) || options.contextIdleMs < 0) {
      throw new Error("BrowserPool: contextIdleMs must be a non-negative finite number");
    }
    this.contextIdleMs = options.contextIdleMs;
    this.executablePath =
      options.executablePath === null || options.executablePath === ""
        ? undefined
        : options.executablePath;
    this.deps = options.deps ?? {};
    this.logger = options.logger ?? noopLogger;
    this.semaphore = new FifoSemaphore(options.maxConcurrency);
  }

  /**
   * Starts a single Chromium browser instance. Idempotent if already launched.
   */
  async launch(): Promise<void> {
    if (this.closed) {
      throw new Error("BrowserPool.launch: pool is closed");
    }
    if (this.browser !== null) {
      return;
    }
    const launch = this.deps.launch ?? ((opts) => chromium.launch(opts));
    const startedAt = performance.now();
    this.logger.info("browser.pool.launch.start", {
      executablePath: this.executablePath ?? "<default>",
    });
    try {
      this.browser = await launch({
        headless: true,
        ...(this.executablePath !== undefined ? { executablePath: this.executablePath } : {}),
      });
      this.logger.info("browser.pool.launch.done", {
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      this.logger.error("browser.pool.launch.failed", {
        durationMs: Math.round(performance.now() - startedAt),
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Whether a browser has been launched and is still connected.
   */
  isAvailable(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * Borrows a context from the idle pool or creates a new one.
   */
  async acquire(signal?: AbortSignal): Promise<BrowserAcquisition> {
    if (this.closed) {
      throw new Error("BrowserPool.acquire: pool is closed");
    }
    if (this.browser === null) {
      throw new Error("BrowserPool.acquire: call launch() first");
    }

    const t0 = performance.now();
    const semRelease = await this.semaphore.acquire(signal);

    let ctx = this.takeIdleContext();
    let reused = true;
    if (ctx === undefined) {
      reused = false;
      ctx = await this.browser.newContext();
    }
    this.logger.debug("browser.pool.acquire", {
      reused,
      waitMs: Math.round(performance.now() - t0),
      inflight: this.inflightContexts.size + 1,
      idle: this.idleContexts.size,
    });
    this.inflightContexts.add(ctx);
    this.inflightSemReleases.set(ctx, semRelease);

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      this.contextReleaseFns.delete(ctx);
      await this.returnToIdle(semRelease, ctx);
    };
    this.contextReleaseFns.set(ctx, release);

    return {
      context: ctx,
      release,
    };
  }

  /**
   * Same as calling {@link BrowserAcquisition.release} for the given context. Idempotent.
   */
  async release(context: BrowserContext): Promise<void> {
    const fn = this.contextReleaseFns.get(context);
    if (fn === undefined) {
      return;
    }
    await fn();
  }

  /**
   * Closes all contexts and the browser. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.logger.info("browser.pool.close.start", {
      inflight: this.inflightContexts.size,
      idle: this.idleContexts.size,
    });

    for (const t of this.idleTimers.values()) {
      clearTimeout(t);
    }
    this.idleTimers.clear();

    this.contextReleaseFns.clear();

    for (const ctx of this.idleContexts) {
      await this.safeCloseContext(ctx);
    }
    this.idleContexts.clear();

    for (const ctx of [...this.inflightContexts]) {
      const sr = this.inflightSemReleases.get(ctx);
      if (sr !== undefined) {
        sr();
        this.inflightSemReleases.delete(ctx);
      }
      await this.safeCloseContext(ctx);
    }
    this.inflightContexts.clear();

    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch {
        /* best-effort shutdown */
      }
      this.browser = null;
    }
  }

  private takeIdleContext(): BrowserContext | undefined {
    const first = this.idleContexts.values().next();
    if (first.done) {
      return undefined;
    }
    const ctx = first.value;
    this.idleContexts.delete(ctx);
    const timer = this.idleTimers.get(ctx);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(ctx);
    }
    return ctx;
  }

  private async returnToIdle(semRelease: () => void, ctx: BrowserContext): Promise<void> {
    this.inflightContexts.delete(ctx);
    this.inflightSemReleases.delete(ctx);
    semRelease();

    if (this.closed) {
      await this.safeCloseContext(ctx);
      return;
    }

    this.idleContexts.add(ctx);
    const timer = setTimeout(() => {
      void this.evictIdleContext(ctx);
    }, this.contextIdleMs);
    this.idleTimers.set(ctx, timer);
  }

  private async evictIdleContext(ctx: BrowserContext): Promise<void> {
    if (!this.idleContexts.has(ctx)) {
      return;
    }
    this.idleContexts.delete(ctx);
    const t = this.idleTimers.get(ctx);
    if (t !== undefined) {
      clearTimeout(t);
      this.idleTimers.delete(ctx);
    }
    await this.safeCloseContext(ctx);
  }

  private async safeCloseContext(ctx: BrowserContext): Promise<void> {
    try {
      await ctx.close();
    } catch {
      /* context may already be closed */
    }
  }
}
