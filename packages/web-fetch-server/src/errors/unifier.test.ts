import { describe, expect, test } from "bun:test";

import { ExtractTimeoutError } from "../pipeline/browser-pipeline.js";
import {
  DomainNotAllowedError,
  ForbiddenError,
  InvalidUrlError,
  RateLimitedError,
  SsrfBlockedError,
  UnauthorizedError,
} from "../security/errors.js";
import { internalDetailForExtract, toHttpResponse, WebFetchServerError } from "./unifier.js";

describe("toHttpResponse", () => {
  const rid = "req-test-001";

  test("UnauthorizedError → 401", async () => {
    const res = toHttpResponse(new UnauthorizedError(), rid, { unknownInternal: "dispatch" });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string; requestId: string } };
    expect(j.error.code).toBe("UNAUTHORIZED");
    expect(j.error.requestId).toBe(rid);
  });

  test("ForbiddenError → 403", async () => {
    const res = toHttpResponse(new ForbiddenError(), rid, { unknownInternal: "dispatch" });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("FORBIDDEN");
  });

  test("RateLimitedError → 429 with Retry-After", async () => {
    const res = toHttpResponse(
      new RateLimitedError({ retryAfterMs: 2500, limitRpm: 60 }),
      rid,
      { unknownInternal: "dispatch" },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
    const j = (await res.json()) as { error: { detail: { retryAfterMs: number } } };
    expect(j.error.detail.retryAfterMs).toBe(2500);
  });

  test("SsrfBlockedError → 403 with detail", async () => {
    const res = toHttpResponse(
      new SsrfBlockedError("blocked", { hostname: "10.0.0.1", reason: "private-ipv4" }, "um"),
      rid,
      { unknownInternal: "dispatch" },
    );
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string; detail: { hostname: string } } };
    expect(j.error.code).toBe("SSRF_BLOCKED");
    expect(j.error.detail.hostname).toBe("10.0.0.1");
  });

  test("DomainNotAllowedError → 403", async () => {
    const res = toHttpResponse(
      new DomainNotAllowedError(
        "denied",
        { hostname: "evil.invalid", reason: "blocked" },
        "um",
      ),
      rid,
      { unknownInternal: "dispatch" },
    );
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("DOMAIN_NOT_ALLOWED");
  });

  test("InvalidUrlError → 400", async () => {
    const res = toHttpResponse(
      new InvalidUrlError("bad", { url: "ftp://x" }, "um"),
      rid,
      { unknownInternal: "dispatch" },
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; detail: { url: string } } };
    expect(j.error.code).toBe("INVALID_URL");
    expect(j.error.detail.url).toBe("ftp://x");
  });

  test("ExtractTimeoutError → 408 EXTRACT_TIMEOUT", async () => {
    const res = toHttpResponse(new ExtractTimeoutError(5000, "timeout"), rid, {
      unknownInternal: "dispatch",
    });
    expect(res.status).toBe(408);
    const j = (await res.json()) as { error: { code: string; detail: { phase: string } } };
    expect(j.error.code).toBe("EXTRACT_TIMEOUT");
    expect(j.error.detail.phase).toBe("render");
  });

  test("WebFetchServerError uses embedded requestId", async () => {
    const res = toHttpResponse(
      new WebFetchServerError("INVALID_REQUEST", 400, "bad", "client-trace-xyz", {
        field: "body",
        reason: "x",
      }),
      "ignored",
      { unknownInternal: "dispatch" },
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { requestId: string } };
    expect(j.error.requestId).toBe("client-trace-xyz");
  });

  test("unknown error dispatch → 500 INTERNAL_ERROR with trace", async () => {
    const res = toHttpResponse(new Error("boom"), rid, { unknownInternal: "dispatch" });
    expect(res.status).toBe(500);
    const j = (await res.json()) as { error: { code: string; detail: { trace: string } } };
    expect(j.error.code).toBe("INTERNAL_ERROR");
    expect(j.error.detail.trace).toBe(rid);
  });
});

describe("internalDetailForExtract", () => {
  test("non-Error yields empty object", () => {
    expect(internalDetailForExtract("x")).toEqual({});
  });
});
