import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  buildWebFetchJsonHeaders,
  getWebFetchEndpointBase,
  readWebFetchClientTimeoutMs,
} from "./web-client";

const originalWarn = console.warn;

describe("web-client shared", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = {
      TACHU_WEB_FETCH_ENDPOINT: process.env.TACHU_WEB_FETCH_ENDPOINT,
      TACHU_WEB_FETCH_TOKEN: process.env.TACHU_WEB_FETCH_TOKEN,
      TACHU_WEB_FETCH_TIMEOUT_MS: process.env.TACHU_WEB_FETCH_TIMEOUT_MS,
    };
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) {
        delete process.env[k];
        delete Bun.env[k];
      } else {
        process.env[k] = v;
        Bun.env[k] = v;
      }
    }
    console.warn = originalWarn;
  });

  it("getWebFetchEndpointBase falls back to 127.0.0.1:8787 and warns when env unset", () => {
    delete process.env.TACHU_WEB_FETCH_ENDPOINT;
    delete Bun.env.TACHU_WEB_FETCH_ENDPOINT;
    expect(getWebFetchEndpointBase()).toBe("http://127.0.0.1:8787");
    expect(getWebFetchEndpointBase()).toBe("http://127.0.0.1:8787");
    expect(console.warn).toHaveBeenCalled();
  });

  it("getWebFetchEndpointBase trims trailing slash", () => {
    process.env.TACHU_WEB_FETCH_ENDPOINT = "http://example.com/api/";
    Bun.env.TACHU_WEB_FETCH_ENDPOINT = "http://example.com/api/";
    expect(getWebFetchEndpointBase()).toBe("http://example.com/api");
  });

  it("readWebFetchClientTimeoutMs uses input then env then default", () => {
    delete process.env.TACHU_WEB_FETCH_TIMEOUT_MS;
    delete Bun.env.TACHU_WEB_FETCH_TIMEOUT_MS;
    expect(readWebFetchClientTimeoutMs(1234)).toBe(1234);

    process.env.TACHU_WEB_FETCH_TIMEOUT_MS = "5000";
    Bun.env.TACHU_WEB_FETCH_TIMEOUT_MS = "5000";
    expect(readWebFetchClientTimeoutMs(undefined)).toBe(5000);

    process.env.TACHU_WEB_FETCH_TIMEOUT_MS = "not-a-number";
    Bun.env.TACHU_WEB_FETCH_TIMEOUT_MS = "not-a-number";
    expect(readWebFetchClientTimeoutMs(undefined)).toBe(70000);
  });

  it("buildWebFetchJsonHeaders injects Bearer when TACHU_WEB_FETCH_TOKEN set", () => {
    delete process.env.TACHU_WEB_FETCH_TOKEN;
    delete Bun.env.TACHU_WEB_FETCH_TOKEN;
    const h1 = buildWebFetchJsonHeaders();
    expect(h1.Authorization).toBeUndefined();
    expect(h1["Content-Type"]).toContain("application/json");

    process.env.TACHU_WEB_FETCH_TOKEN = "  tok  ";
    Bun.env.TACHU_WEB_FETCH_TOKEN = "  tok  ";
    const h2 = buildWebFetchJsonHeaders();
    expect(h2.Authorization).toBe("Bearer tok");
  });
});
