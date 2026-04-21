import { describe, expect, test } from "bun:test";
import { loadConfig } from "./load-config.js";
import { ConfigValidationError } from "./errors.js";

describe("loadConfig", () => {
  test("fills defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8787);
    expect(c.token).toBeNull();
    expect(c.timeouts.requestMs).toBe(60_000);
    expect(c.timeouts.defaultWaitMs).toBe(15_000);
    expect(c.limits.maxBodyBytes).toBe(10_485_760);
    expect(c.limits.maxRequestBytes).toBe(1_048_576);
    expect(c.limits.defaultMaxBodyChars).toBe(32_768);
    expect(c.concurrency.max).toBe(4);
    expect(c.concurrency.acquireTimeoutMs).toBe(30_000);
    expect(c.concurrency.rateLimitRpm).toBe(60);
    expect(c.concurrency.rateLimitBurst).toBe(10);
    expect(c.browser.enabled).toBe(true);
    expect(c.browser.idleMs).toBe(30_000);
    expect(c.browser.recycleAfter).toBe(500);
    expect(c.browser.recycleIntervalMs).toBe(1_800_000);
    expect(c.browser.stealthDefault).toBe(false);
    expect(c.browser.executablePath).toBeNull();
    expect([...c.browser.userAgents]).toEqual([]);
    expect(c.browser.maxConcurrency).toBe(2);
    expect(c.browser.autoUpgradeMinChars).toBe(200);
    expect(c.security.allowLoopback).toBe(false);
    expect(c.cache.ttlMs).toBe(0);
    expect(c.cache.dir).toBe(".cache/web-fetch");
    expect(c.observability.logLevel).toBe("info");
    expect(c.observability.logFormat).toBe("jsonl");
    expect(c.observability.otlpEndpoint).toBeNull();
    expect(c.observability.serviceName).toBe("tachu-web-fetch-server");
    expect(c.search.provider).toBe("stub");
    expect(c.search.defaultMaxResults).toBe(10);
    expect(Object.isFrozen(c)).toBe(true);
  });

  test("applies custom env overrides", () => {
    const c = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "9000",
      WEB_FETCH_TOKEN: "secret",
      WEB_FETCH_REQUEST_TIMEOUT_MS: "5000",
      WEB_FETCH_LOG_LEVEL: "warn",
    });
    expect(c.port).toBe(9000);
    expect(c.token).toBe("secret");
    expect(c.timeouts.requestMs).toBe(5000);
    expect(c.observability.logLevel).toBe("warn");
  });

  test("rejects invalid port", () => {
    expect(() =>
      loadConfig({ WEB_FETCH_PORT: "70000" }),
    ).toThrow(ConfigValidationError);
    try {
      loadConfig({ WEB_FETCH_PORT: "70000" });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).field).toBe("WEB_FETCH_PORT");
    }
  });

  test("rejects out-of-range positive integer (timeouts)", () => {
    expect(() =>
      loadConfig({ WEB_FETCH_REQUEST_TIMEOUT_MS: "4000" }),
    ).toThrow(ConfigValidationError);
  });

  test("requires 127.0.0.1 when token is absent and host is non-local", () => {
    expect(() =>
      loadConfig({ WEB_FETCH_HOST: "0.0.0.0" }),
    ).toThrow(ConfigValidationError);
    try {
      loadConfig({ WEB_FETCH_HOST: "0.0.0.0" });
    } catch (e) {
      expect((e as ConfigValidationError).reason).toContain("WEB_FETCH_TOKEN");
    }
  });

  test("passes PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH through to browser.executablePath", () => {
    const c = loadConfig({
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(c.browser.executablePath).toBe("/usr/bin/chromium");
  });

  test("downgrades unknown WEB_SEARCH_PROVIDER with a warning", () => {
    const warn = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      const c = loadConfig({ WEB_SEARCH_PROVIDER: "tavily" });
      expect(c.search.provider).toBe("stub");
      expect(messages.some((m) => m.includes("tavily"))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
