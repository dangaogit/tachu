import { afterEach, describe, expect, mock, test } from "bun:test";

import type { BrowserPool } from "../browser/pool.js";
import type { WebFetchServerConfig } from "../config/index.js";
import type { BrowserPipelinePool } from "../pipeline/browser-pipeline.js";
import type { ExtractResponse } from "../pipeline/static-pipeline.js";
import { SsrfBlockedError } from "../security/errors.js";
import { handleExtract } from "./extract.js";

const runStaticPipelineImpl = mock(
  async (
    _req: import("../pipeline/static-pipeline.js").ExtractRequest,
    _cfg: WebFetchServerConfig,
    _signal: AbortSignal,
  ) => ({
    url: "https://ex.example/page",
    finalUrl: "https://ex.example/page",
    status: 200,
    renderedWith: "static" as const,
    renderedAtMs: 12,
    body: "# Hello\n\nmarkdown",
    wordCount: 2,
    truncated: false,
    warnings: [] as string[],
    traceId: "pipeline-trace",
  }),
);

const runBrowserPipelineImpl = mock(
  async (
    _req: import("../pipeline/browser-pipeline.js").BrowserPipelineExtractRequest,
    _cfg: WebFetchServerConfig,
    _pool: BrowserPipelinePool,
    _signal: AbortSignal,
  ): Promise<ExtractResponse> => ({
    url: "https://ex.example/page",
    finalUrl: "https://ex.example/page",
    status: 200,
    renderedWith: "browser",
    renderedAtMs: 99,
    body: "# From browser\n\ncontent",
    wordCount: 3,
    truncated: false,
    warnings: [],
    traceId: "browser-trace",
  }),
);

function fakePool(available: boolean): BrowserPool {
  return { isAvailable: () => available } as unknown as BrowserPool;
}

function baseCfg(overrides?: Partial<WebFetchServerConfig["timeouts"]>): WebFetchServerConfig {
  const timeouts = {
    requestMs: overrides?.requestMs ?? 60_000,
    defaultWaitMs: overrides?.defaultWaitMs ?? 15_000,
  };
  return {
    host: "127.0.0.1",
    port: 8787,
    token: null,
    timeouts,
    limits: {
      maxBodyBytes: 10 * 1024 * 1024,
      maxRequestBytes: 1_048_576,
      defaultMaxBodyChars: 32_768,
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

afterEach(() => {
  runStaticPipelineImpl.mockReset();
  runBrowserPipelineImpl.mockReset();
  runStaticPipelineImpl.mockImplementation(async (_req, _cfg, _signal) => ({
    url: "https://ex.example/page",
    finalUrl: "https://ex.example/page",
    status: 200,
    renderedWith: "static" as const,
    renderedAtMs: 12,
    body: "# Hello\n\nmarkdown",
    wordCount: 2,
    truncated: false,
    warnings: [],
    traceId: "pipeline-trace",
  }));
  runBrowserPipelineImpl.mockImplementation(
    async (_req, _cfg, _pool, _signal): Promise<ExtractResponse> => ({
      url: "https://ex.example/page",
      finalUrl: "https://ex.example/page",
      status: 200,
      renderedWith: "browser",
      renderedAtMs: 99,
      body: "# From browser\n\ncontent",
      wordCount: 3,
      truncated: false,
      warnings: [],
      traceId: "browser-trace",
    }),
  );
});

describe("handleExtract", () => {
  test("returns 200 with markdown body for static renderMode", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://ex.example/page",
        renderMode: "static",
        outputFormat: "markdown",
      }),
    });
    const res = await handleExtract(req, baseCfg(), { runStaticPipeline: runStaticPipelineImpl });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: string; traceId: string };
    expect(json.body).toContain("markdown");
    expect(json.traceId).toBeDefined();
  });

  test("returns 400 INVALID_REQUEST on invalid JSON", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      body: "{not-json",
    });
    const res = await handleExtract(req, baseCfg());
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; detail?: { field: string } } };
    expect(json.error.code).toBe("INVALID_REQUEST");
    expect(json.error.detail?.field).toBe("body");
  });

  test("returns 400 INVALID_URL for non-http URL", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "ftp://files.example/a" }),
    });
    const res = await handleExtract(req, baseCfg());
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; detail?: { url: string } } };
    expect(json.error.code).toBe("INVALID_URL");
    expect(json.error.detail?.url).toBe("ftp://files.example/a");
  });

  test("returns 503 BROWSER_NOT_AVAILABLE for renderMode browser when pool is null", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "browser" }),
    });
    const res = await handleExtract(req, baseCfg(), { runStaticPipeline: runStaticPipelineImpl });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("BROWSER_NOT_AVAILABLE");
    expect(runStaticPipelineImpl).not.toHaveBeenCalled();
  });

  test("returns 503 BROWSER_NOT_AVAILABLE when browser pool is not available", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "browser" }),
    });
    const res = await handleExtract(req, baseCfg(), fakePool(false), {
      runStaticPipeline: runStaticPipelineImpl,
      runBrowserPipeline: runBrowserPipelineImpl,
    });
    expect(res.status).toBe(503);
    expect(runBrowserPipelineImpl).not.toHaveBeenCalled();
  });

  test("returns 200 for renderMode browser when pool is available", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "browser" }),
    });
    const res = await handleExtract(req, baseCfg(), fakePool(true), {
      runStaticPipeline: runStaticPipelineImpl,
      runBrowserPipeline: runBrowserPipelineImpl,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: string; renderedWith: string };
    expect(json.renderedWith).toBe("browser");
    expect(json.body).toContain("browser");
    expect(runBrowserPipelineImpl).toHaveBeenCalled();
    expect(runStaticPipelineImpl).not.toHaveBeenCalled();
  });

  test("auto mode keeps static result when content is long enough", async () => {
    runStaticPipelineImpl.mockImplementation(async () => ({
      url: "https://ex.example/page",
      finalUrl: "https://ex.example/page",
      status: 200,
      renderedWith: "static",
      renderedAtMs: 1,
      body: "x".repeat(500),
      wordCount: 1,
      truncated: false,
      warnings: [],
      traceId: "s",
    }));
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "auto" }),
    });
    const res = await handleExtract(req, baseCfg(), fakePool(true), {
      runStaticPipeline: runStaticPipelineImpl,
      runBrowserPipeline: runBrowserPipelineImpl,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { renderedWith: string; body: string };
    expect(json.renderedWith).toBe("static");
    expect(json.body.length).toBe(500);
    expect(runBrowserPipelineImpl).not.toHaveBeenCalled();
  });

  test("auto mode upgrades to browser when static body is short", async () => {
    runStaticPipelineImpl.mockImplementation(async () => ({
      url: "https://ex.example/page",
      finalUrl: "https://ex.example/page",
      status: 200,
      renderedWith: "static",
      renderedAtMs: 1,
      body: "short",
      wordCount: 1,
      truncated: false,
      warnings: [],
      traceId: "s",
    }));
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "auto" }),
    });
    const res = await handleExtract(req, baseCfg(), fakePool(true), {
      runStaticPipeline: runStaticPipelineImpl,
      runBrowserPipeline: runBrowserPipelineImpl,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { renderedWith: string; body: string };
    expect(json.renderedWith).toBe("browser");
    expect(runStaticPipelineImpl).toHaveBeenCalled();
    expect(runBrowserPipelineImpl).toHaveBeenCalled();
  });

  test("auto mode upgrades when static warns readability-failed", async () => {
    runStaticPipelineImpl.mockImplementation(async () => ({
      url: "https://ex.example/page",
      finalUrl: "https://ex.example/page",
      status: 200,
      renderedWith: "static",
      renderedAtMs: 1,
      body: "x".repeat(400),
      wordCount: 1,
      truncated: false,
      warnings: ["readability-failed"],
      traceId: "s",
    }));
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "auto" }),
    });
    const res = await handleExtract(req, baseCfg(), fakePool(true), {
      runStaticPipeline: runStaticPipelineImpl,
      runBrowserPipeline: runBrowserPipelineImpl,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { renderedWith: string };
    expect(json.renderedWith).toBe("browser");
    expect(runBrowserPipelineImpl).toHaveBeenCalled();
  });

  test("auto mode returns static when pool unavailable even if body is short", async () => {
    runStaticPipelineImpl.mockImplementation(async () => ({
      url: "https://ex.example/page",
      finalUrl: "https://ex.example/page",
      status: 200,
      renderedWith: "static",
      renderedAtMs: 1,
      body: "tiny",
      wordCount: 1,
      truncated: false,
      warnings: [],
      traceId: "s",
    }));
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "auto" }),
    });
    const res = await handleExtract(req, baseCfg(), null, {
      runStaticPipeline: runStaticPipelineImpl,
      runBrowserPipeline: runBrowserPipelineImpl,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { renderedWith: string; body: string };
    expect(json.renderedWith).toBe("static");
    expect(json.body).toBe("tiny");
    expect(runBrowserPipelineImpl).not.toHaveBeenCalled();
  });

  test("maps SsrfBlockedError to 403", async () => {
    runStaticPipelineImpl.mockImplementation(async () => {
      throw new SsrfBlockedError(
        "blocked",
        { hostname: "127.0.0.1", reason: "localhost" },
        "blocked",
      );
    });
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "static" }),
    });
    const res = await handleExtract(req, baseCfg(), { runStaticPipeline: runStaticPipelineImpl });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; detail?: { hostname: string } } };
    expect(json.error.code).toBe("SSRF_BLOCKED");
    expect(json.error.detail?.hostname).toBe("127.0.0.1");
  });

  test("returns 408 REQUEST_TIMEOUT when pipeline aborts", async () => {
    // @ts-expect-error Abort-only branch; never returns a success body
    runStaticPipelineImpl.mockImplementation(async (_req, _cfg, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://ex.example/page", renderMode: "static" }),
    });
    const res = await handleExtract(req, baseCfg({ requestMs: 5 }), {
      runStaticPipeline: runStaticPipelineImpl,
    });
    expect(res.status).toBe(408);
    const json = (await res.json()) as { error: { code: string; detail?: { phase: string } } };
    expect(json.error.code).toBe("REQUEST_TIMEOUT");
    expect(json.error.detail?.phase).toBe("extract");
  });

  test("passes maxBodyChars into runStaticPipeline", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://ex.example/page",
        renderMode: "static",
        maxBodyChars: 9000,
      }),
    });
    await handleExtract(req, baseCfg(), { runStaticPipeline: runStaticPipelineImpl });
    expect(runStaticPipelineImpl).toHaveBeenCalled();
    const firstArg = runStaticPipelineImpl.mock.calls[0]![0] as { maxBodyChars?: number };
    expect(firstArg.maxBodyChars).toBe(9000);
  });

  test("echoes client traceId in success JSON", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://ex.example/page",
        renderMode: "static",
        traceId: "client-trace-001",
      }),
    });
    const res = await handleExtract(req, baseCfg(), { runStaticPipeline: runStaticPipelineImpl });
    const json = (await res.json()) as { traceId: string };
    expect(json.traceId).toBe("client-trace-001");
  });

  test("echoes traceId in error JSON for INVALID_URL", async () => {
    const req = new Request("http://localhost/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "ftp://bad",
        traceId: "err-trace-xyz",
      }),
    });
    const res = await handleExtract(req, baseCfg());
    const json = (await res.json()) as { error: { requestId: string } };
    expect(json.error.requestId).toBe("err-trace-xyz");
  });
});
