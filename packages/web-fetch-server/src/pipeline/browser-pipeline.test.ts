import { describe, expect, test } from "bun:test";
import type { BrowserContext, Page, Route } from "playwright-core";

import type { WebFetchServerConfig } from "../config/index.js";
import { SsrfBlockedError } from "../security/errors.js";
import {
  ExtractTimeoutError,
  runBrowserPipeline,
  type BrowserPipelineExtractRequest,
  type BrowserPipelinePool,
} from "./browser-pipeline.js";

type CtxLease = { context: BrowserContext; release(): Promise<void> };

function baseCfg(overrides?: {
  limits?: Partial<WebFetchServerConfig["limits"]>;
  security?: Partial<WebFetchServerConfig["security"]>;
}): WebFetchServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: null,
    timeouts: { requestMs: 60_000, defaultWaitMs: 15_000 },
    limits: {
      maxBodyBytes: 10 * 1024 * 1024,
      maxRequestBytes: 1_048_576,
      defaultMaxBodyChars: 32_768,
      ...overrides?.limits,
    },
    concurrency: {
      max: 4,
      acquireTimeoutMs: 30_000,
      rateLimitRpm: 60,
      rateLimitBurst: 10,
    },
    browser: {
      enabled: true,
      idleMs: 30_000,
      recycleAfter: 500,
      recycleIntervalMs: 1_800_000,
      stealthDefault: false,
      executablePath: null,
      userAgents: ["Pool-UA/1.0"],
      maxConcurrency: 2,
      autoUpgradeMinChars: 200,
    },
    security: {
      allowedDomains: new Set<string>(),
      blockedDomains: new Set<string>(),
      allowLoopback: false,
      ...overrides?.security,
    },
    cache: {
      ttlMs: 0,
      dir: ".cache/web-fetch",
      maxEntries: 1000,
      maxSizeMb: 512,
    },
    observability: {
      logLevel: "info",
      logFormat: "jsonl",
      otlpEndpoint: null,
      otlpHeaders: {},
      serviceName: "tachu-web-fetch-server",
    },
    search: {
      provider: "stub",
      apiKey: null,
      endpoint: null,
      defaultMaxResults: 10,
    },
  };
}

function articleFixtureHtml(): string {
  const long = `Lorem ipsum dolor sit amet. `.repeat(20);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Article Title</title>
</head><body><article><h1>Article Title</h1><p>${long}</p><p>Hello world</p><p><a href="https://ex.example/next">more</a></p></article></body></html>`;
}

function createMockPool(page: Page): { pool: BrowserPipelinePool; releaseCalls: () => number } {
  let releases = 0;
  const context = {
    newPage: async () => page,
    addCookies: async () => {},
  } as unknown as BrowserContext;

  const lease: CtxLease = {
    context,
    release: async () => {
      releases++;
    },
  };

  return {
    pool: {
      acquire: async () => lease,
    },
    releaseCalls: () => releases,
  };
}

describe("runBrowserPipeline", () => {
  test("markdown output from rendered HTML", async () => {
    const fixture = articleFixtureHtml();
    const page = {
      setExtraHTTPHeaders: async () => {},
      route: async () => {},
      goto: async () =>
        ({
          status: () => 200,
        }) as unknown as Awaited<ReturnType<Page["goto"]>>,
      content: async () => fixture,
      url: () => "https://example.com/article",
      waitForSelector: async () => {},
      evaluate: async () => {},
      close: async () => {},
    } as unknown as Page;

    const { pool, releaseCalls } = createMockPool(page);
    const res = await runBrowserPipeline(
      { url: "https://example.com/article", outputFormat: "markdown" },
      baseCfg(),
      pool,
      new AbortController().signal,
    );
    expect(res.renderedWith).toBe("browser");
    expect(res.title).toBe("Article Title");
    expect(res.body).toContain("Hello world");
    expect(res.traceId.length).toBeGreaterThan(0);
    expect(releaseCalls()).toBe(1);
  });

  test("waitFor networkidle maps to page.goto waitUntil", async () => {
    const fixture = articleFixtureHtml();
    const gotoCalls: Array<{ waitUntil?: string; timeout?: number } | undefined> = [];
    const page = {
      setExtraHTTPHeaders: async () => {},
      route: async () => {},
      goto: async (_url: string, opts?: { waitUntil?: string; timeout?: number }) => {
        gotoCalls.push(opts);
        return { status: () => 200 } as unknown as Awaited<ReturnType<Page["goto"]>>;
      },
      content: async () => fixture,
      url: () => "https://example.com/n",
      waitForSelector: async () => {},
      evaluate: async () => {},
      close: async () => {},
    } as unknown as Page;

    const { pool } = createMockPool(page);
    await runBrowserPipeline(
      { url: "https://example.com/n", waitFor: "networkidle" } satisfies BrowserPipelineExtractRequest,
      baseCfg(),
      pool,
      new AbortController().signal,
    );
    expect(gotoCalls[0]?.waitUntil).toBe("networkidle");
  });

  test("scroll triggers evaluate for incremental scroll and final scrollTo", async () => {
    const fixture = articleFixtureHtml();
    let evaluateCount = 0;
    const page = {
      setExtraHTTPHeaders: async () => {},
      route: async () => {},
      goto: async () => ({ status: () => 200 }) as unknown as Awaited<ReturnType<Page["goto"]>>,
      content: async () => fixture,
      url: () => "https://example.com/s",
      waitForSelector: async () => {},
      evaluate: async () => {
        evaluateCount++;
      },
      close: async () => {},
    } as unknown as Page;

    const { pool } = createMockPool(page);
    await runBrowserPipeline(
      {
        url: "https://example.com/s",
        scroll: { steps: 2, delayMs: 1 },
      },
      baseCfg(),
      pool,
      new AbortController().signal,
    );
    expect(evaluateCount).toBe(3);
  });

  test("blockResources image aborts image routes", async () => {
    const fixture = articleFixtureHtml();
    let routeHandler: ((route: Route) => void) | undefined;
    let abortCalls = 0;
    let continueCalls = 0;

    const page = {
      setExtraHTTPHeaders: async () => {},
      route: async (_pattern: string, handler: (route: Route) => void) => {
        routeHandler = handler;
      },
      goto: async () => ({ status: () => 200 }) as unknown as Awaited<ReturnType<Page["goto"]>>,
      content: async () => fixture,
      url: () => "https://example.com/b",
      waitForSelector: async () => {},
      evaluate: async () => {},
      close: async () => {},
    } as unknown as Page;

    const { pool } = createMockPool(page);
    await runBrowserPipeline(
      { url: "https://example.com/b", blockResources: ["image"] },
      baseCfg(),
      pool,
      new AbortController().signal,
    );

    expect(routeHandler).toBeDefined();
    const fakeDoc = {
      request: () => ({ resourceType: () => "document" }),
      abort: async () => {
        abortCalls++;
      },
      continue: async () => {
        continueCalls++;
      },
    } as unknown as Route;
    routeHandler!(fakeDoc);
    expect(abortCalls).toBe(0);
    expect(continueCalls).toBe(1);

    const fakeImage = {
      request: () => ({ resourceType: () => "image" }),
      abort: async () => {
        abortCalls++;
      },
      continue: async () => {
        continueCalls++;
      },
    } as unknown as Route;
    routeHandler!(fakeImage);
    expect(abortCalls).toBe(1);
    expect(continueCalls).toBe(1);
  });

  test("goto timeout throws ExtractTimeoutError", async () => {
    const page = {
      setExtraHTTPHeaders: async () => {},
      route: async () => {},
      goto: async () => {
        const err = new Error("Timeout 15000ms exceeded");
        err.name = "TimeoutError";
        throw err;
      },
      content: async () => "",
      url: () => "",
      waitForSelector: async () => {},
      evaluate: async () => {},
      close: async () => {},
    } as unknown as Page;

    const { pool, releaseCalls } = createMockPool(page);
    await expect(
      runBrowserPipeline(
        { url: "https://example.com/timeout", waitTimeoutMs: 15000 },
        baseCfg(),
        pool,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ExtractTimeoutError);

    expect(releaseCalls()).toBe(1);
  });

  test("SSRF blocked before pool.acquire", async () => {
    let acquired = false;
    const pool: BrowserPipelinePool = {
      acquire: async () => {
        acquired = true;
        const ctx = {
          newPage: async () => ({}),
          addCookies: async () => {},
        } as unknown as BrowserContext;
        return {
          context: ctx,
          release: async () => {},
        };
      },
    };

    await expect(
      runBrowserPipeline(
        { url: "http://127.0.0.1:9999/x" },
        baseCfg(),
        pool,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);

    expect(acquired).toBe(false);
  });
});
