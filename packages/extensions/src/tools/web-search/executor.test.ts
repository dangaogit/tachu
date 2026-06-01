import type { Session } from "@tachu/core";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { executeWebSearch } from "./executor";
import { WebSearchClientError } from "./errors";
import type { ToolExecutionContext } from "../shared";

function createTestToolContext(workspaceRoot: string): ToolExecutionContext {
  const controller = new AbortController();
  const session: Session = {
    id: "test-session",
    status: "active",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  return { abortSignal: controller.signal, workspaceRoot, session };
}

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

const ENV_KEYS = [
  "TACHU_WEB_FETCH_ENDPOINT",
  "TACHU_WEB_FETCH_TOKEN",
  "TACHU_WEB_FETCH_TIMEOUT_MS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) {
      delete process.env[k];
      delete Bun.env[k];
    } else {
      process.env[k] = v;
      Bun.env[k] = v;
    }
  }
}

function sampleSearchJson() {
  return {
    query: "bun runtime",
    provider: "stub",
    results: [
      {
        title: "Bun",
        url: "https://example.com/bun",
        snippet: "fast JS runtime",
      },
    ],
    totalResults: 0,
    searchedAtMs: 12,
    warnings: [] as string[],
    traceId: "req_search_1",
  };
}

describe("executeWebSearch", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    process.env.TACHU_WEB_FETCH_ENDPOINT = "http://127.0.0.1:9999";
    Bun.env.TACHU_WEB_FETCH_ENDPOINT = "http://127.0.0.1:9999";
    delete process.env.TACHU_WEB_FETCH_TOKEN;
    delete Bun.env.TACHU_WEB_FETCH_TOKEN;
    delete process.env.TACHU_WEB_FETCH_TIMEOUT_MS;
    delete Bun.env.TACHU_WEB_FETCH_TIMEOUT_MS;
    globalThis.fetch = mock(async () => {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    restoreEnv(envSnap);
  });

  it("returns WebSearchToolOutput on 200 JSON search response", async () => {
    const body = sampleSearchJson();
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const out = await executeWebSearch({ query: "bun runtime" }, createTestToolContext(process.cwd()));
    expect(out.query).toBe("bun runtime");
    expect(out.provider).toBe("stub");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.url).toBe("https://example.com/bun");
    expect(out.totalResults).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  it("maps 503 PROVIDER_NOT_CONFIGURED to WebSearchClientError with server-config hint", async () => {
    const errJson = {
      error: {
        code: "PROVIDER_NOT_CONFIGURED",
        message: "stub provider",
        requestId: "req-503",
        detail: { provider: "stub", hint: "configure provider" },
      },
    };
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(errJson), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    try {
      await executeWebSearch({ query: "q" }, createTestToolContext(process.cwd()));
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(WebSearchClientError);
      const err = e as WebSearchClientError;
      expect(err.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(err.userMessage).toContain("WEB_SEARCH_PROVIDER");
      expect(err.userMessage).toContain("WEB_SEARCH_PROVIDER_API_KEY");
    }
  });

  it("throws NETWORK_ERROR when fetch throws a non-abort error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    try {
      await executeWebSearch({ query: "q" }, createTestToolContext(process.cwd()));
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(WebSearchClientError);
      expect((e as WebSearchClientError).code).toBe("NETWORK_ERROR");
    }
  });

  it("throws TIMEOUT_WEB_SEARCH on fetch AbortError when context is not aborted", async () => {
    const abortErr = new Error("timed out");
    abortErr.name = "AbortError";
    globalThis.fetch = mock(async () => {
      throw abortErr;
    }) as unknown as typeof fetch;

    try {
      await executeWebSearch({ query: "q" }, createTestToolContext(process.cwd()));
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(WebSearchClientError);
      expect((e as WebSearchClientError).code).toBe("TIMEOUT_WEB_SEARCH");
    }
  });

  it("injects TACHU_WEB_FETCH_TOKEN as Authorization Bearer on requests", async () => {
    process.env.TACHU_WEB_FETCH_TOKEN = "search-secret";
    Bun.env.TACHU_WEB_FETCH_TOKEN = "search-secret";

    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const h = init?.headers;
      const auth =
        h instanceof Headers
          ? h.get("authorization")
          : typeof h === "object" && h !== null && !Array.isArray(h)
            ? (h as Record<string, string>)["Authorization"] ??
              (h as Record<string, string>)["authorization"]
            : undefined;
      expect(auth).toBe("Bearer search-secret");
      return new Response(JSON.stringify(sampleSearchJson()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await executeWebSearch({ query: "q" }, createTestToolContext(process.cwd()));
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("posts to /v1/search with JSON body containing query", async () => {
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:9999/v1/search");
      expect(init?.method).toBe("POST");
      const parsed = JSON.parse(init?.body as string) as { query: string; traceId: null };
      expect(parsed.query).toBe("hello");
      expect(parsed.traceId).toBeNull();
      return new Response(JSON.stringify(sampleSearchJson()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await executeWebSearch({ query: "hello" }, createTestToolContext(process.cwd()));
  });
});
