import { describe, expect, test } from "bun:test";

import type { WebFetchServerConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import { SearchProviderRegistry } from "../search/provider.js";
import { handleSearch } from "./search.js";

function baseCfg(): WebFetchServerConfig {
  return loadConfig({
    WEB_FETCH_HOST: "127.0.0.1",
    WEB_FETCH_PORT: "8787",
    WEB_FETCH_TOKEN: "",
  });
}

function postSearch(body: string, headers?: Record<string, string>): Request {
  const h = new Headers({ "content-type": "application/json" });
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      h.set(k, v);
    }
  }
  return new Request("http://127.0.0.1/v1/search", { method: "POST", headers: h, body });
}

describe("handleSearch", () => {
  test("empty registry → 503 SEARCH_PROVIDER_NOT_CONFIGURED with requiredEnv", async () => {
    const cfg = baseCfg();
    const reg = new SearchProviderRegistry();
    const res = await handleSearch(
      postSearch(JSON.stringify({ query: "hello" })),
      cfg,
      reg,
    );
    expect(res.status).toBe(503);
    const j = (await res.json()) as {
      error: { code: string; detail?: { requiredEnv?: string[] } };
    };
    expect(j.error.code).toBe("SEARCH_PROVIDER_NOT_CONFIGURED");
    expect(j.error.detail?.requiredEnv).toEqual([
      "WEB_SEARCH_PROVIDER",
      "WEB_SEARCH_PROVIDER_API_KEY",
      "WEB_SEARCH_PROVIDER_ENDPOINT",
    ]);
  });

  test("invalid JSON → 400 INVALID_REQUEST", async () => {
    const cfg = baseCfg();
    const reg = new SearchProviderRegistry();
    const res = await handleSearch(postSearch("{"), cfg, reg);
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("INVALID_REQUEST");
  });

  test("registered provider returns 200", async () => {
    const cfg = baseCfg();
    const reg = new SearchProviderRegistry();
    reg.register({
      id: "stub",
      search: async (req) => ({
        query: req.query,
        provider: "stub",
        results: [
          {
            title: "t",
            url: "https://example.com",
            snippet: "s",
          },
        ],
        totalResults: 1,
        searchedAtMs: 2,
        warnings: [],
        traceId: req.traceId ?? "x",
      }),
    });
    const res = await handleSearch(
      postSearch(JSON.stringify({ query: "bun" })),
      cfg,
      reg,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      query: string;
      provider: string;
      results: { url: string }[];
      traceId: string;
    };
    expect(j.query).toBe("bun");
    expect(j.provider).toBe("stub");
    expect(j.results[0]?.url).toBe("https://example.com");
    expect(j.traceId.length).toBeGreaterThan(0);
  });

  test("provider throws → INTERNAL_ERROR via unifier", async () => {
    const cfg = baseCfg();
    const reg = new SearchProviderRegistry();
    reg.register({
      id: "stub",
      search: async () => {
        throw new Error("simulated provider failure");
      },
    });
    const res = await handleSearch(
      postSearch(JSON.stringify({ query: "x" })),
      cfg,
      reg,
    );
    expect(res.status).toBe(500);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("INTERNAL_ERROR");
  });
});
