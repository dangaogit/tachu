import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { runStaticPipeline, truncateAtBlockBoundary } from "./static-pipeline.js";

type WebFetchServerConfig = Parameters<typeof runStaticPipeline>[1];

/** 满足 Readability charThreshold，并含 OG / JSON-LD / 正文链接供真实抽取与结构化测试使用 */
function longBody(): string {
  return `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed vitae urna non velit faucibus fermentum. `.repeat(
    4,
  );
}

function articleHtmlFixture(): string {
  const long = longBody();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Article Title</title>
<meta property="og:title" content="OG Title">
<meta name="twitter:card" content="summary">
<meta name="description" content="meta desc">
<script type="application/ld+json">{"@type":"Article","headline":"Article Title"}</script>
</head>
<body><article><h1>Article Title</h1><p>${long}</p><p>Hello world</p><p><a href="https://ex.example/next">more</a></p></article></body></html>`;
}

/** 极长正文，用于 maxBodyChars 截断断言 */
function longTextArticleHtml(): string {
  const long = `${"word ".repeat(4000)}end`;
  return `<!DOCTYPE html><html><head><title>Long</title></head>
<body><article><p>${long}</p></article></body></html>`;
}

function responseWithUrl(body: string, requestUrl: string, contentType = "text/html; charset=utf-8"): Response {
  const res = new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
  try {
    Object.defineProperty(res, "url", { value: requestUrl, configurable: true });
  } catch {
    /* 部分环境 Response.url 不可写，仅影响相对链接解析；本 fixture 使用绝对链接 */
  }
  return res;
}

function normalizeFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

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

const FIXTURE_HTML = articleHtmlFixture();

describe("truncateAtBlockBoundary", () => {
  test("leaves short content unchanged", () => {
    const r = truncateAtBlockBoundary("abc", 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("abc");
  });

  test("truncates with suffix and block preference", () => {
    const long = "a".repeat(5000);
    const r = truncateAtBlockBoundary(long, 200);
    expect(r.truncated).toBe(true);
    expect(r.text.includes("content truncated")).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(200);
  });
});

describe("runStaticPipeline", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  /** Bun 的 `typeof fetch` 含静态成员，`spyOn` 的 `mockImplementation` 需断言为可调用形态 */
  function stubFetch(
    fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ): typeof globalThis.fetch {
    return fn as unknown as typeof globalThis.fetch;
  }

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(
      stubFetch(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = normalizeFetchInput(input);
        return responseWithUrl(FIXTURE_HTML, url);
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("fetch success: markdown output", async () => {
    const res = await runStaticPipeline(
      { url: "https://example.com/page", outputFormat: "markdown" },
      baseCfg(),
      new AbortController().signal,
    );
    expect(res.renderedWith).toBe("static");
    expect(res.body).toContain("Article Title");
    expect(res.status).toBe(200);
    expect(res.traceId.length).toBeGreaterThan(0);
  });

  test("text output uses readable.textContent", async () => {
    const res = await runStaticPipeline(
      { url: "https://example.com/t", outputFormat: "text" },
      baseCfg(),
      new AbortController().signal,
    );
    expect(res.body).toContain("Hello world");
    expect(res.body).toContain("more");
  });

  test("html output uses contentHtml", async () => {
    const res = await runStaticPipeline(
      { url: "https://example.com/h", outputFormat: "html" },
      baseCfg(),
      new AbortController().signal,
    );
    expect(res.body.toLowerCase()).toContain("<p>");
    expect(res.body.toLowerCase()).not.toContain("<script");
  });

  test("json output is pretty-printed structured JSON", async () => {
    const res = await runStaticPipeline(
      { url: "https://example.com/j", outputFormat: "json" },
      baseCfg(),
      new AbortController().signal,
    );
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(Array.isArray(parsed.jsonLd)).toBe(true);
    expect((parsed.jsonLd as unknown[]).length).toBeGreaterThan(0);
    expect(res.body.includes("\n")).toBe(true);
  });

  test("SSRF guard blocks before fetch", async () => {
    await expect(
      runStaticPipeline(
        { url: "http://127.0.0.1/secret" },
        baseCfg(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("fetch respects abort signal", async () => {
    fetchSpy.mockImplementation(
      stubFetch((_input: RequestInfo | URL, init?: RequestInit) => {
        const sig = init?.signal;
        return new Promise<Response>((resolve, reject) => {
          if (sig?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          sig?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }),
    );
    const ac = new AbortController();
    const p = runStaticPipeline(
      { url: "https://example.com/slow" },
      baseCfg(),
      ac.signal,
    );
    queueMicrotask(() => ac.abort());
    await expect(p).rejects.toThrow();
  });

  test("maxBodyChars truncates body", async () => {
    fetchSpy.mockImplementation(
      stubFetch(async (input: RequestInfo | URL) => {
        const url = normalizeFetchInput(input);
        return responseWithUrl(longTextArticleHtml(), url);
      }),
    );
    const res = await runStaticPipeline(
      { url: "https://example.com/long", outputFormat: "text", maxBodyChars: 120 },
      baseCfg(),
      new AbortController().signal,
    );
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(120);
    expect(res.body.includes("content truncated")).toBe(true);
  });
});
