import type { BrowserContext } from "playwright-core";

/**
 * Lease for a pooled {@link BrowserContext}. Call {@link BrowserAcquisition.release}
 * to return the context to the idle pool (subject to {@link BrowserPoolOptions.contextIdleMs} eviction).
 */
export interface BrowserAcquisition {
  readonly context: BrowserContext;
  /**
   * Returns the context to the pool. Idempotent: repeated calls are no-ops.
   */
  release(): Promise<void>;
  readonly traceId?: string;
}
