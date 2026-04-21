import { describe, expect, test } from "bun:test";

import type { WebFetchServerConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import type { SearchRequest, SearchResponse } from "./provider.js";
import { SearchProviderRegistry } from "./provider.js";

function baseCfg(): WebFetchServerConfig {
  return loadConfig({
    WEB_FETCH_HOST: "127.0.0.1",
    WEB_FETCH_PORT: "8787",
  });
}

/** 绕过 loadConfig 对 Stage 4 前 provider 的降级，直接构造解析用配置快照。 */
function cfgWithProvider(provider: string): WebFetchServerConfig {
  const b = baseCfg();
  return {
    ...b,
    search: {
      ...b.search,
      provider,
    },
  };
}

const noopSearch = async (
  req: SearchRequest,
  _signal: AbortSignal,
): Promise<SearchResponse> => ({
  query: req.query,
  provider: "stub",
  results: [],
  totalResults: 0,
  searchedAtMs: 0,
  warnings: [],
  traceId: "t",
});

describe("SearchProviderRegistry", () => {
  test("empty registry → resolve returns null", () => {
    const r = new SearchProviderRegistry();
    expect(r.resolve(cfgWithProvider("stub"))).toBeNull();
  });

  test("after register, resolve returns the provider", () => {
    const r = new SearchProviderRegistry();
    const p = { id: "stub", search: noopSearch };
    r.register(p);
    expect(r.resolve(cfgWithProvider("stub"))).toBe(p);
  });

  test("unknown configured id → null", () => {
    const r = new SearchProviderRegistry();
    r.register({ id: "stub", search: noopSearch });
    expect(r.resolve(cfgWithProvider("tavily"))).toBeNull();
  });

  test("register duplicate id throws", () => {
    const r = new SearchProviderRegistry();
    const p = { id: "stub", search: noopSearch };
    r.register(p);
    expect(() => r.register({ id: "stub", search: noopSearch })).toThrow(
      /already registered/,
    );
  });
});
