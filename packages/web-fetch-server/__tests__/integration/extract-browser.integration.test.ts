/**
 * 浏览器分支端到端：createServer + createMockBrowserPool（无真实 Chromium）。
 * @see .cursor/web-fetch-workflow/contracts/s2-h7-server-integration-browser.md
 */

import { beforeAll, describe, expect, test } from "bun:test";

import type { BrowserAcquisition } from "../../src/browser/types.js";
import { createServer } from "../../src/server.js";
import type { WebFetchServerConfig } from "../../src/types/config.js";
import { Semaphore } from "../../src/runtime/semaphore.js";
import {
  createMockBrowserPool,
  type MockBrowserPoolLike,
} from "../helpers/playwright-mock.js";
import type { MockFetchEntry } from "../helpers/http-mock.js";

async function loadFixture(name: string): Promise<string> {
  const fileUrl = new URL(`../fixtures/${name}`, import.meta.url);
  return Bun.file(fileUrl).text();
}

function startLocalFixtureServer(routes: Record<string, MockFetchEntry>): {
  origin: string;
  url: (pathname: string) => string;
  stop: () => void;
} {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const entry = routes[path];
      if (entry === undefined) {
        return new Response("Not Found", { status: 404 });
      }
      const status = entry.status ?? 200;
      const contentType = entry.contentType ?? "text/html; charset=utf-8";
      return new Response(entry.body, {
        status,
        headers: { "content-type": contentType },
      });
    },
  });
  const origin = `http://127.0.0.1:${String(server.port)}`;
  return {
    origin,
    url: (pathname: string) => {
      const p = pathname.startsWith("/") ? pathname : `/${pathname}`;
      return `${origin}${p}`;
    },
    stop: () => {
      server.stop();
    },
  };
}

function baseCfg(
  overrides?: Partial<WebFetchServerConfig> & {
    timeouts?: Partial<WebFetchServerConfig["timeouts"]>;
    concurrency?: Partial<WebFetchServerConfig["concurrency"]>;
    browser?: Partial<WebFetchServerConfig["browser"]>;
  },
): WebFetchServerConfig {
  const timeouts = {
    requestMs: overrides?.timeouts?.requestMs ?? 60_000,
    defaultWaitMs: overrides?.timeouts?.defaultWaitMs ?? 15_000,
  };
  const concurrency = {
    max: overrides?.concurrency?.max ?? 4,
    acquireTimeoutMs: overrides?.concurrency?.acquireTimeoutMs ?? 30_000,
    rateLimitRpm: overrides?.concurrency?.rateLimitRpm ?? 60,
    rateLimitBurst: overrides?.concurrency?.rateLimitBurst ?? 10,
  };
  return {
    host: overrides?.host ?? "127.0.0.1",
    port: overrides?.port ?? 8787,
    token: overrides?.token ?? null,
    timeouts,
    limits: overrides?.limits ?? {
      maxBodyBytes: 50 * 1024 * 1024,
      maxRequestBytes: 1_048_576,
      defaultMaxBodyChars: 32_768,
    },
    concurrency,
    browser: overrides?.browser ?? {
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
    security: overrides?.security ?? {
      allowedDomains: new Set<string>(),
      blockedDomains: new Set<string>(),
      allowLoopback: true,
    },
    cache: overrides?.cache ?? {
      ttlMs: 0,
      dir: ".cache/web-fetch",
      maxEntries: 1000,
      maxSizeMb: 512,
    },
    observability: overrides?.observability ?? {
      logLevel: "info",
      logFormat: "jsonl",
      otlpEndpoint: null,
      otlpHeaders: {},
      serviceName: "tachu-web-fetch-server",
    },
    search: overrides?.search ?? {
      provider: "stub",
      apiKey: null,
      endpoint: null,
      defaultMaxResults: 10,
    },
  };
}

/**
 * 限制 mock pool 并发，使 `stats().inflight` 与真实 BrowserPool 的 semaphore 语义一致。
 */
function wrapPoolWithSemaphore(
  inner: MockBrowserPoolLike,
  permits: number,
): { pool: MockBrowserPoolLike; maxConcurrent: () => number } {
  const sem = new Semaphore({ permits });
  let active = 0;
  let maxSeen = 0;
  const origAcquire = inner.acquire.bind(inner);
  const wrapped: MockBrowserPoolLike = {
    ...inner,
    async acquire(signal?: AbortSignal): Promise<BrowserAcquisition> {
      const releaseSem = await sem.acquire(signal);
      active++;
      maxSeen = Math.max(maxSeen, active);
      try {
        const lease = await origAcquire(signal);
        const origRelease = lease.release;
        return {
          context: lease.context,
          release: async (): Promise<void> => {
            await origRelease();
            active--;
            releaseSem();
          },
        };
      } catch (e) {
        active--;
        releaseSem();
        throw e;
      }
    },
  };
  return {
    pool: wrapped,
    maxConcurrent: () => maxSeen,
  };
}

describe("POST /v1/extract browser branch (integration)", () => {
  let fixturesArticle: string;
  let fixturesSpaShell: string;

  beforeAll(async () => {
    fixturesArticle = await loadFixture("article.html");
    fixturesSpaShell = await loadFixture("spa-shell.html");
  });

  test("renderMode browser: 200 且 markdown 非空", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/p": { body: "<html><body><article><h1>T</h1><p>Paragraph one.</p></article></body></html>" },
    });
    const target = url("/p");
    const pool = createMockBrowserPool({
      htmlByUrl: {
        [target]:
          "<html><body><article><h1>Browser Title</h1><p>Longer browser rendered paragraph for markdown.</p></article></body></html>",
      },
    });
    try {
      const srv = createServer(baseCfg(), pool);
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: target,
            renderMode: "browser",
            outputFormat: "markdown",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { body: string; renderedWith: string; wordCount: number };
      expect(json.renderedWith).toBe("browser");
      expect(json.body.trim().length).toBeGreaterThan(0);
      expect(json.wordCount).toBeGreaterThan(0);
      await pool.close();
    } finally {
      stop();
    }
  });

  test("renderMode auto + shell 页：升级到 browser", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/shell": { body: fixturesSpaShell },
    });
    const target = url("/shell");
    const pool = createMockBrowserPool({
      htmlByUrl: {
        [target]: `<html><body><main><h1>Upgraded</h1>${"<p>x</p>".repeat(80)}</main></body></html>`,
      },
    });
    try {
      const srv = createServer(baseCfg(), pool);
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: target,
            renderMode: "auto",
            outputFormat: "markdown",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { renderedWith: string; body: string };
      expect(json.renderedWith).toBe("browser");
      expect(json.body.length).toBeGreaterThan(10);
      await pool.close();
    } finally {
      stop();
    }
  });

  test("renderMode auto + 正常文章：保留 static", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/article": { body: fixturesArticle },
    });
    const target = url("/article");
    const pool = createMockBrowserPool({
      htmlByUrl: {
        [target]: "<html><body><p>should not be used</p></body></html>",
      },
    });
    try {
      const srv = createServer(baseCfg(), pool);
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: target,
            renderMode: "auto",
            outputFormat: "markdown",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { renderedWith: string };
      expect(json.renderedWith).toBe("static");
      await pool.close();
    } finally {
      stop();
    }
  });

  test("pool 不可用 + renderMode browser → 503", async () => {
    const pool = createMockBrowserPool({
      htmlByUrl: { "https://ex.example/x": "<p>x</p>" },
    });
    await pool.close();
    const srv = createServer(baseCfg(), pool);
    const res = await srv.fetch(
      new Request("http://127.0.0.1/v1/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://ex.example/x",
          renderMode: "browser",
        }),
      }),
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("BROWSER_NOT_AVAILABLE");
  });

  test("waitTimeoutMs: 10 + throwOnGoto → 408 EXTRACT_TIMEOUT", async () => {
    const pool = createMockBrowserPool({
      htmlByUrl: { "https://timeout.test/t": "<p>x</p>" },
      throwOnGoto: true,
    });
    try {
      const srv = createServer(baseCfg(), pool);
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://timeout.test/t",
            renderMode: "browser",
            waitTimeoutMs: 10,
          }),
        }),
      );
      expect(res.status).toBe(408);
      const json = (await res.json()) as { error: { code: string; detail?: { phase?: string } } };
      expect(json.error.code).toBe("EXTRACT_TIMEOUT");
      expect(json.error.detail?.phase).toBe("render");
    } finally {
      await pool.close();
    }
  });

  test("blockResources + cookies + extraHeaders 透传到 mock", async () => {
    const routeCalls: Array<{ url: string | RegExp }> = [];
    const cookieCalls: unknown[] = [];
    const headerSnapshots: string[] = [];

    const basePool = createMockBrowserPool({
      htmlByUrl: { "https://hdr.test/page": "<html><body><p>ok</p></body></html>" },
    });
    const origAcquireBase = basePool.acquire.bind(basePool);
    const instrumentedPool: MockBrowserPoolLike = {
      ...basePool,
      acquire: async (signal?: AbortSignal): Promise<BrowserAcquisition> => {
        const lease = await origAcquireBase(signal);
        const ctx = lease.context;
        const origNewPage = ctx.newPage.bind(ctx);
        ctx.newPage = async () => {
          const page = await origNewPage();
          const origRoute = page.route.bind(page);
          page.route = async (u, handler): Promise<void> => {
            routeCalls.push({ url: u });
            return origRoute(u, handler);
          };
          const origSet = page.setExtraHTTPHeaders.bind(page);
          page.setExtraHTTPHeaders = async (h): Promise<void> => {
            headerSnapshots.push(JSON.stringify(h));
            return origSet(h);
          };
          return page;
        };
        const origCookies = ctx.addCookies.bind(ctx);
        ctx.addCookies = async (cookies): Promise<void> => {
          cookieCalls.push(cookies);
          return origCookies(cookies);
        };
        return lease;
      },
    };

    try {
      const srv = createServer(baseCfg(), instrumentedPool);
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://hdr.test/page",
            renderMode: "browser",
            blockResources: ["image"],
            cookies: [{ name: "sid", value: "abc", domain: "hdr.test" }],
            extraHeaders: { "X-Integration": "probe" },
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(routeCalls.length).toBeGreaterThan(0);
      expect(String(routeCalls[0]?.url)).toContain("*");
      expect(cookieCalls.length).toBe(1);
      const ck = cookieCalls[0] as { name?: string }[];
      expect(ck[0]?.name).toBe("sid");
      const joined = headerSnapshots.join("\n");
      expect(joined).toContain("X-Integration");
      expect(joined.toLowerCase()).toContain("user-agent");
    } finally {
      await basePool.close();
    }
  });

  test("并发 5 路 browser：inflight 峰值不超过 browser.maxConcurrency", async () => {
    const delayMs = 40;
    const pool = createMockBrowserPool({
      htmlByUrl: Object.fromEntries(
        [0, 1, 2, 3, 4].map((i) => [
          `https://conc.test/r${String(i)}`,
          "<html><body><p>ok</p></body></html>",
        ]),
      ),
      delayMs,
    });
    const maxConc = 2;
    const { pool: limited, maxConcurrent } = wrapPoolWithSemaphore(pool, maxConc);
    try {
      const srv = createServer(
        baseCfg({
          browser: {
            enabled: true,
            idleMs: 30_000,
            recycleAfter: 500,
            recycleIntervalMs: 1_800_000,
            stealthDefault: false,
            executablePath: null,
            userAgents: ["Pool-UA/1.0"],
            maxConcurrency: maxConc,
            autoUpgradeMinChars: 200,
          },
        }),
        limited,
      );
      const urls = [0, 1, 2, 3, 4].map((i) => `https://conc.test/r${String(i)}`);
      await Promise.all(
        urls.map((u) =>
          srv.fetch(
            new Request("http://127.0.0.1/v1/extract", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: u,
                renderMode: "browser",
                outputFormat: "markdown",
              }),
            }),
          ),
        ),
      );
      expect(maxConcurrent()).toBeLessThanOrEqual(maxConc);
      const st = limited.stats();
      expect(st.inflight).toBe(0);
    } finally {
      await pool.close();
    }
  });
});
