/**
 * 静态分支端到端：createServer + 本机 Bun.serve 提供 fixture（Bun.fetch 不经过 globalThis.fetch，故不用 http-mock）。
 * @see .cursor/web-fetch-workflow/contracts/s1-d2-server-integration-static.md
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { createServer } from "../../src/server.js";
import type { WebFetchServerConfig } from "../../src/types/config.js";
import type { MockFetchEntry } from "../helpers/http-mock.js";

async function loadFixture(name: string): Promise<string> {
  const fileUrl = new URL(`../fixtures/${name}`, import.meta.url);
  return Bun.file(fileUrl).text();
}

/**
 * 在 127.0.0.1 起临时 HTTP 服务，路径 → 响应体（无公网访问，满足「无真实互联网」）。
 */
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
  const origin = `http://127.0.0.1:${server.port}`;
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

describe("POST /v1/extract static branch (integration)", () => {
  let fixturesArticle: string;
  let fixturesJsonld: string;

  beforeAll(async () => {
    fixturesArticle = await loadFixture("article.html");
    fixturesJsonld = await loadFixture("jsonld.html");
  });

  test("markdown: 200 且 body 非空", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/article": { body: fixturesArticle },
    });
    try {
      const srv = createServer(baseCfg());
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url("/article"),
            renderMode: "static",
            outputFormat: "markdown",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { body: string; wordCount: number };
      expect(json.body.trim().length).toBeGreaterThan(0);
      expect(json.wordCount).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("text: 200 且正文为纯文本", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/article": { body: fixturesArticle },
    });
    try {
      const srv = createServer(baseCfg());
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url("/article"),
            renderMode: "static",
            outputFormat: "text",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { body: string };
      expect(json.body).toContain("Understanding Web Content");
    } finally {
      stop();
    }
  });

  test("html: 200 且 body 含 HTML 片段", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/article": { body: fixturesArticle },
    });
    try {
      const srv = createServer(baseCfg());
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url("/article"),
            renderMode: "static",
            outputFormat: "html",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { body: string };
      expect(json.body.toLowerCase()).toContain("<");
    } finally {
      stop();
    }
  });

  test("json: 200 且 body 为可解析 JSON 字符串", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/jsonld": { body: fixturesJsonld },
    });
    try {
      const srv = createServer(baseCfg());
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url("/jsonld"),
            renderMode: "static",
            outputFormat: "json",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { body: string };
      const parsed = JSON.parse(json.body) as { jsonLd: unknown[] };
      expect(Array.isArray(parsed.jsonLd)).toBe(true);
    } finally {
      stop();
    }
  });

  test("SSRF: 169.254.169.254 → 403 SSRF_BLOCKED", async () => {
    const srv = createServer(
      baseCfg({
        security: {
          allowedDomains: new Set<string>(),
          blockedDomains: new Set<string>(),
          allowLoopback: false,
        },
      }),
    );
    const res = await srv.fetch(
      new Request("http://127.0.0.1/v1/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "http://169.254.169.254/latest/meta-data/",
          renderMode: "static",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; detail?: { reason?: string } } };
    expect(json.error.code).toBe("SSRF_BLOCKED");
    expect(json.error.detail?.reason).toBe("cloud-metadata");
  });

  test("INVALID_URL: 非 http(s) → 400 INVALID_URL", async () => {
    const srv = createServer(baseCfg());
    const res = await srv.fetch(
      new Request("http://127.0.0.1/v1/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "ftp://example.com/a",
          renderMode: "static",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("INVALID_URL");
  });

  test("鉴权: 错误 Bearer → 403 FORBIDDEN（与配置 token 不一致）", async () => {
    const srv = createServer(
      baseCfg({
        token: "expected-integration-token",
      }),
    );
    const res = await srv.fetch(
      new Request("http://127.0.0.1/v1/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({
          url: "https://example.com/article",
          renderMode: "static",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("FORBIDDEN");
  });

  /**
   * `handleExtract` 使用 `AbortSignal.timeout()`；Bun 在超时时抛出 `TimeoutError`，
   * 而 `isAbortError` 仅识别 `AbortError`，故当前为 500 而非 408（见 report §5）。
   */
  test("超时: 极小 requestMs + 延迟上游 → 当前实现为 500 INTERNAL_ERROR", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/slow") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
          return new Response(fixturesArticle, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    const slowUrl = `http://127.0.0.1:${server.port}/slow`;
    try {
      const srv = createServer(
        baseCfg({
          timeouts: { requestMs: 15, defaultWaitMs: 15_000 },
        }),
      );
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: slowUrl,
            renderMode: "static",
            outputFormat: "markdown",
          }),
        }),
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("INTERNAL_ERROR");
    } finally {
      server.stop();
    }
  });

  test("限流: 第二次请求 → 429 RATE_LIMITED", async () => {
    const tiny =
      "<!DOCTYPE html><html><head><title>t</title></head><body><p>hi</p></body></html>";
    const { url, stop } = startLocalFixtureServer({
      "/tiny": { body: tiny },
    });
    try {
      const srv = createServer(
        baseCfg({
          concurrency: {
            max: 4,
            acquireTimeoutMs: 30_000,
            rateLimitRpm: 1,
            rateLimitBurst: 1,
          },
        }),
      );
      const req = () =>
        srv.fetch(
          new Request("http://127.0.0.1/v1/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: url("/tiny"),
              renderMode: "static",
              outputFormat: "markdown",
            }),
          }),
        );
      const first = await req();
      expect(first.status).toBe(200);
      const second = await req();
      expect(second.status).toBe(429);
      const json = (await second.json()) as { error: { code: string } };
      expect(json.error.code).toBe("RATE_LIMITED");
    } finally {
      stop();
    }
  });

  test("includeStructured: true 时返回 structured 含 JSON-LD", async () => {
    const { url, stop } = startLocalFixtureServer({
      "/jsonld": { body: fixturesJsonld },
    });
    try {
      const srv = createServer(baseCfg());
      const res = await srv.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url("/jsonld"),
            renderMode: "static",
            outputFormat: "markdown",
            includeStructured: true,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        structured?: { jsonLd?: unknown[] };
      };
      expect(json.structured).toBeDefined();
      expect(Array.isArray(json.structured?.jsonLd)).toBe(true);
      expect(json.structured?.jsonLd?.length).toBeGreaterThan(0);
      expect(JSON.stringify(json.structured?.jsonLd)).toContain("Article");
    } finally {
      stop();
    }
  });
});
