import type { Session } from "@tachu/core";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { executeWebFetch } from "./executor";
import { WebFetchClientError } from "./errors";
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

describe("executeWebFetch", () => {
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

  describe("default endpoint warning", () => {
    beforeEach(() => {
      delete process.env.TACHU_WEB_FETCH_ENDPOINT;
      delete Bun.env.TACHU_WEB_FETCH_ENDPOINT;
    });

    it("falls back to 127.0.0.1:8787 and warns exactly once across two calls", async () => {
      const extractBody = {
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        status: 200,
        renderedWith: "static" as const,
        renderedAtMs: 1,
        body: "x",
        wordCount: 1,
        truncated: false,
        warnings: [] as string[],
        traceId: "t1",
      };
      globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
        const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        expect(u).toBe("http://127.0.0.1:8787/v1/extract");
        return new Response(JSON.stringify(extractBody), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }) as unknown as typeof fetch;

      const ctx = createTestToolContext(process.cwd());
      await executeWebFetch({ url: "https://example.com/" }, ctx);
      await executeWebFetch({ url: "https://example.com/2" }, ctx);

      const warnMock = console.warn as unknown as { mock: { calls: unknown[][] } };
      expect(warnMock.mock.calls.length).toBe(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  it("returns tool output on 200 with valid extract JSON", async () => {
    const extractBody = {
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      status: 200,
      renderedWith: "static" as const,
      renderedAtMs: 42,
      body: "hello",
      wordCount: 1,
      truncated: false,
      warnings: [] as string[],
      traceId: "trace-a",
    };
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(extractBody), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const out = await executeWebFetch({ url: "https://example.com/page" }, createTestToolContext(process.cwd()));
    expect(out.body).toBe("hello");
    expect(out.finalUrl).toBe("https://example.com/");
    expect(out.renderedWith).toBe("static");
    expect(out.wordCount).toBe(1);
    expect(out.warnings).toEqual([]);
  });

  it("maps 4xx JSON error body to WebFetchClientError with same code", async () => {
    const errJson = {
      error: {
        code: "SSRF_BLOCKED",
        message: "blocked",
        requestId: "req-1",
        detail: { hostname: "127.0.0.1", reason: "localhost" },
      },
    };
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(errJson), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    await expect(
      executeWebFetch({ url: "https://example.com/" }, createTestToolContext(process.cwd())),
    ).rejects.toMatchObject({
      name: "WebFetchClientError",
      code: "SSRF_BLOCKED",
    });
  });

  it("throws REQUEST_TIMEOUT on fetch AbortError when context is not aborted", async () => {
    const abortErr = new Error("timed out");
    abortErr.name = "AbortError";
    globalThis.fetch = mock(async () => {
      throw abortErr;
    }) as unknown as typeof fetch;

    try {
      await executeWebFetch({ url: "https://example.com/" }, createTestToolContext(process.cwd()));
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(WebFetchClientError);
      expect((e as WebFetchClientError).code).toBe("REQUEST_TIMEOUT");
    }
  });

  it("throws NETWORK_ERROR when fetch throws a non-abort error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    try {
      await executeWebFetch({ url: "https://example.com/" }, createTestToolContext(process.cwd()));
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(WebFetchClientError);
      expect((e as WebFetchClientError).code).toBe("NETWORK_ERROR");
    }
  });

  it("throws MALFORMED_RESPONSE when 200 body is not valid extract JSON", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    try {
      await executeWebFetch({ url: "https://example.com/" }, createTestToolContext(process.cwd()));
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(WebFetchClientError);
      expect((e as WebFetchClientError).code).toBe("MALFORMED_RESPONSE");
    }
  });

  it("injects TACHU_WEB_FETCH_TOKEN as Authorization Bearer on requests", async () => {
    process.env.TACHU_WEB_FETCH_TOKEN = "secret-token";
    Bun.env.TACHU_WEB_FETCH_TOKEN = "secret-token";

    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const h = init?.headers;
      const auth =
        h instanceof Headers
          ? h.get("authorization")
          : typeof h === "object" && h !== null && !Array.isArray(h)
            ? (h as Record<string, string>)["Authorization"] ??
              (h as Record<string, string>)["authorization"]
            : undefined;
      expect(auth).toBe("Bearer secret-token");
      return new Response(
        JSON.stringify({
          url: "https://example.com/",
          finalUrl: "https://example.com/",
          status: 200,
          renderedWith: "static",
          renderedAtMs: 0,
          body: "",
          wordCount: 0,
          truncated: false,
          warnings: [],
          traceId: "t",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await executeWebFetch({ url: "https://example.com/" }, createTestToolContext(process.cwd()));
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
