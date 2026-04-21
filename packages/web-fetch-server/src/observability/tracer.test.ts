import { describe, expect, test } from "bun:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import type { WebFetchServerConfig } from "../types/config.js";
import { createTracer, type FetchLike, withSpan } from "./tracer.js";

function baseCfg(
  overrides?: Partial<WebFetchServerConfig["observability"]>,
): WebFetchServerConfig {
  const observability: WebFetchServerConfig["observability"] = {
    logLevel: "info",
    logFormat: "jsonl",
    otlpEndpoint: null,
    otlpHeaders: {},
    serviceName: "tachu-web-fetch-server",
    ...overrides,
  };
  return {
    host: "127.0.0.1",
    port: 8787,
    token: null,
    timeouts: { requestMs: 60_000, defaultWaitMs: 15_000 },
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
      userAgents: ["Test-UA/1.0"],
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
    observability,
    search: {
      provider: "stub",
      apiKey: null,
      endpoint: null,
      defaultMaxResults: 10,
    },
  };
}

describe("createTracer / withSpan", () => {
  test("withSpan 成功路径结束 span 且状态为 OK", async () => {
    const exporter = new InMemorySpanExporter();
    const cfg = baseCfg();
    const { tracer, shutdown } = createTracer(cfg, { spanExporter: exporter });

    const out = await withSpan(tracer, "op.ok", async () => "done");
    expect(out).toBe("done");

    await new Promise<void>((r) => setTimeout(r, 0));
    const spans = exporter.getFinishedSpans();
    await shutdown();
    expect(spans.length).toBe(1);
    expect(spans[0]?.name).toBe("op.ok");
    expect(spans[0]?.status.code).toBe(1);
  });

  test("withSpan 异常路径仍 end，且状态为 ERROR", async () => {
    const exporter = new InMemorySpanExporter();
    const cfg = baseCfg();
    const { tracer, shutdown } = createTracer(cfg, { spanExporter: exporter });

    await expect(
      withSpan(tracer, "op.fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await new Promise<void>((r) => setTimeout(r, 0));
    const spans = exporter.getFinishedSpans();
    await shutdown();
    expect(spans.length).toBe(1);
    expect(spans[0]?.name).toBe("op.fail");
    expect(spans[0]?.status.code).toBe(2);
  });

  test("attributes 传入会出现在 span 上", async () => {
    const exporter = new InMemorySpanExporter();
    const cfg = baseCfg();
    const { tracer, shutdown } = createTracer(cfg, { spanExporter: exporter });

    await withSpan(
      tracer,
      "op.attrs",
      async () => undefined,
      { "test.key": "v1" },
    );

    await new Promise<void>((r) => setTimeout(r, 0));
    const spans = exporter.getFinishedSpans();
    await shutdown();
    expect(spans[0]?.attributes["test.key"]).toBe("v1");
  });

  test("InMemory exporter 可读出已结束 span", async () => {
    const exporter = new InMemorySpanExporter();
    const cfg = baseCfg();
    const { tracer, shutdown } = createTracer(cfg, { spanExporter: exporter });

    await withSpan(tracer, "a", async () => 1);
    await withSpan(tracer, "b", async () => 2);

    await new Promise<void>((r) => setTimeout(r, 0));
    const names = exporter.getFinishedSpans().map((s) => s.name);
    await shutdown();
    expect(names.sort()).toEqual(["a", "b"]);
  });

  test("shutdown 后 provider 释放（可再次调用 exporter.shutdown）", async () => {
    const exporter = new InMemorySpanExporter();
    const cfg = baseCfg();
    const { tracer, shutdown } = createTracer(cfg, { spanExporter: exporter });

    await withSpan(tracer, "x", async () => 0);
    await new Promise<void>((r) => setTimeout(r, 0));
    await shutdown();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  test("配置 OTLP 端点时使用注入 fetch，不访问真实网络", async () => {
    let postedUrl = "";
    let contentType = "";
    const fetchImpl: FetchLike = async (url, init) => {
      postedUrl = String(url);
      const h = init?.headers;
      contentType =
        h instanceof Headers ? h.get("Content-Type") ?? "" : "";
      return new Response(null, { status: 200 });
    };

    const cfg = baseCfg({
      otlpEndpoint: "http://otel-collector:4318",
      otlpHeaders: { "x-custom": "a" },
    });
    const { tracer, shutdown } = createTracer(cfg, { fetchImpl });

    await withSpan(tracer, "remote", async () => "ok");
    await new Promise<void>((r) => setTimeout(r, 0));
    await shutdown();

    expect(postedUrl).toBe("http://otel-collector:4318/v1/traces");
    expect(contentType).toBe("application/json");
  });
});
