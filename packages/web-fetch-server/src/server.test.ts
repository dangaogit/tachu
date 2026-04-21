import { beforeEach, describe, expect, test } from "bun:test";

import type { ExtractResponse } from "./pipeline/static-pipeline.js";
import type { WebFetchServerConfig } from "./config/index.js";
import { loadConfig } from "./config/index.js";
import { createServer } from "./server.js";

const okResponse: ExtractResponse = {
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  status: 200,
  renderedWith: "static",
  renderedAtMs: 0,
  body: "ok",
  wordCount: 1,
  truncated: false,
  warnings: [],
  traceId: "fixed-trace",
};

let runStaticPipelineImpl: (
  req: import("./pipeline/static-pipeline.js").ExtractRequest,
  cfg: WebFetchServerConfig,
  signal: AbortSignal,
) => Promise<ExtractResponse> = async () => okResponse;

beforeEach(() => {
  runStaticPipelineImpl = async () => okResponse;
});

describe("createServer", () => {
  test("GET /healthz returns 200", async () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
    });
    const s = createServer(cfg, { runStaticPipeline: runStaticPipelineImpl });
    const res = await s.fetch(new Request("http://127.0.0.1/healthz"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { status: string };
    expect(j.status).toBe("ok");
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  test("GET /unknown returns 404 NOT_FOUND", async () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
    });
    const s = createServer(cfg, { runStaticPipeline: runStaticPipelineImpl });
    const res = await s.fetch(new Request("http://127.0.0.1/nope"));
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("NOT_FOUND");
  });

  test("POST /v1/extract rejects when token configured but header missing", async () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "secret-token",
    });
    const s = createServer(cfg, { runStaticPipeline: runStaticPipelineImpl });
    const res = await s.fetch(
      new Request("http://127.0.0.1/v1/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("UNAUTHORIZED");
  });

  test("POST /v1/search returns 503 SEARCH_PROVIDER_NOT_CONFIGURED", async () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
    });
    const s = createServer(cfg, { runStaticPipeline: runStaticPipelineImpl });
    const res = await s.fetch(
      new Request("http://127.0.0.1/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "hello" }),
      }),
    );
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("SEARCH_PROVIDER_NOT_CONFIGURED");
  });

  test("pipeline error surfaces as 500 INTERNAL_ERROR", async () => {
    runStaticPipelineImpl = async () => {
      throw new Error("simulated failure");
    };
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "",
    });
    const s = createServer(cfg, { runStaticPipeline: runStaticPipelineImpl });
    const res = await s.fetch(
      new Request("http://127.0.0.1/v1/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );
    expect(res.status).toBe(500);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("INTERNAL_ERROR");
  });

  test("rate limiter returns 429 after burst exhausted", async () => {
    const cfg = loadConfig({
      WEB_FETCH_HOST: "127.0.0.1",
      WEB_FETCH_PORT: "8787",
      WEB_FETCH_TOKEN: "",
      WEB_FETCH_RATE_LIMIT_RPM: "60",
      WEB_FETCH_RATE_LIMIT_BURST: "1",
    });
    const s = createServer(cfg, { runStaticPipeline: runStaticPipelineImpl });
    const mk = () =>
      s.fetch(
        new Request("http://127.0.0.1/v1/extract", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com" }),
        }),
      );
    expect((await mk()).status).toBe(200);
    const second = await mk();
    expect(second.status).toBe(429);
    const j = (await second.json()) as { error: { code: string } };
    expect(j.error.code).toBe("RATE_LIMITED");
  });
});
