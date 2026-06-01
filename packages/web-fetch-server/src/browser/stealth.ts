import { createRequire } from "node:module";
import { chromium as chromiumCore } from "playwright-core";

/**
 * Playwright `chromium` launcher type (same shape as `playwright-core` export).
 */
export type StealthChromiumLauncher = typeof chromiumCore;

const require = createRequire(import.meta.url);

let stealthChromiumSingleton: StealthChromiumLauncher | undefined;

function defaultLoadStealthChromium(): StealthChromiumLauncher {
  const extra = require("playwright-extra") as typeof import("playwright-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth").default as () => object;
  const plugin = StealthPlugin();
  extra.chromium.use(
    plugin as Parameters<typeof extra.chromium.use>[0],
  );
  return extra.chromium as StealthChromiumLauncher;
}

/**
 * Optional wiring for tests: inject a custom loader so unit tests avoid loading
 * `playwright-extra` / applying plugins (no real browser launch).
 */
export type GetStealthChromiumOptions = {
  loadStealthChromium?: () => StealthChromiumLauncher;
};

/**
 * Resolves whether stealth mode is active for a fetch request.
 *
 * Request-level `stealth` overrides the service-level `WEB_FETCH_STEALTH` default.
 * `null` / `undefined` at request level means "inherit service default".
 *
 * @param serviceLevel - Effective service-level default (from `WEB_FETCH_STEALTH`).
 * @param requestLevel - Request field `stealth`, or `null`/`undefined` to inherit.
 * @returns Whether stealth should be used for this request.
 */
export function resolveStealth(
  serviceLevel: boolean,
  requestLevel: boolean | null | undefined,
): boolean {
  if (requestLevel === true) return true;
  if (requestLevel === false) return false;
  return serviceLevel;
}

/**
 * Returns the Chromium launcher with stealth plugin applied (lazy, singleton).
 *
 * When {@link resolveStealth} is `false`, callers should use `playwright-core`'s
 * {@link chromiumCore} directly instead of this function.
 *
 * @param options - Optional {@link GetStealthChromiumOptions.loadStealthChromium} for testing.
 */
export function getStealthChromium(
  options?: GetStealthChromiumOptions,
): StealthChromiumLauncher {
  if (stealthChromiumSingleton !== undefined) {
    return stealthChromiumSingleton;
  }
  const load =
    options?.loadStealthChromium ?? defaultLoadStealthChromium;
  stealthChromiumSingleton = load();
  return stealthChromiumSingleton;
}

/**
 * @internal Resets the stealth chromium singleton (unit tests only).
 */
export function resetStealthChromiumSingletonForTest(): void {
  stealthChromiumSingleton = undefined;
}

/**
 * @internal Exposes singleton state for assertions (unit tests only).
 */
export function getStealthChromiumSingletonForTest():
  | StealthChromiumLauncher
  | undefined {
  return stealthChromiumSingleton;
}
