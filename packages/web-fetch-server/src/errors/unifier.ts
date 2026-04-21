/**
 * 将服务端抛出的错误统一映射为 ADR-0003d 形态的 JSON {@link Response}。
 *
 * @see docs/adr/decisions/0003d-web-fetch-errors.md
 */

import { ExtractTimeoutError } from "../pipeline/browser-pipeline.js";
import {
  DomainNotAllowedError,
  ForbiddenError,
  InvalidUrlError,
  RateLimitedError,
  SsrfBlockedError,
  UnauthorizedError,
} from "../security/errors.js";

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json; charset=utf-8",
};

/** 与路由层历史行为一致：错误体使用 `message` + `requestId`（对齐 0003d 示例字段）。 */
export type ToHttpResponseOptions = {
  /**
   * `dispatch`：未知错误沿用 {@link createServer} 历史 `INTERNAL_ERROR.detail`（`trace` = 请求 id）。
   * `extract`：未知错误沿用 extract 路由的 dev stack 片段逻辑。
   */
  unknownInternal?: "dispatch" | "extract";
};

/**
 * 可显式构造的 HTTP 层错误；`requestId` 写入 JSON `error.requestId`。
 */
export class WebFetchServerError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly requestId: string;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: string,
    httpStatus: number,
    message: string,
    requestId: string,
    detail?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebFetchServerError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("authorization") ||
    lower.includes("cookie") ||
    lower.includes("set-cookie") ||
    lower.includes("api_key") ||
    lower.includes("token")
  );
}

function sanitizeDetailValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = isSensitiveKey(k) ? "***" : sanitizeDetailValue(v);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetailValue(item));
  }
  return value;
}

function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const sanitized = sanitizeDetailValue(detail) as Record<string, unknown>;
  return sanitized;
}

function isDevEnv(): boolean {
  return process.env.NODE_ENV === "development";
}

/** extract 路由对未分类错误的 `INTERNAL_ERROR.detail`（生产环境为空对象）。 */
export function internalDetailForExtract(err: unknown): Record<string, unknown> {
  if (!isDevEnv() || !(err instanceof Error)) {
    return {};
  }
  const stack = err.stack ?? err.message;
  const lines = stack.split("\n").slice(0, 10);
  return { trace: lines.join("\n") };
}

function buildErrorPayload(
  code: string,
  message: string,
  requestId: string,
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const err: Record<string, unknown> = { code, message, requestId };
  if (detail !== undefined) {
    err.detail = Object.keys(detail).length > 0 ? sanitizeDetail(detail)! : {};
  }
  return { error: err };
}

function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  detail: Record<string, unknown> | undefined,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  const body = buildErrorPayload(code, message, requestId, detail);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 将任意 `unknown` 错误转译为 JSON 错误 {@link Response}。
 *
 * @param err — 路由或管道抛出的值
 * @param requestId — 用于非 {@link WebFetchServerError} 及无内嵌 requestId 的错误；通常即请求的关联 id
 */
export function toHttpResponse(
  err: unknown,
  requestId: string,
  options?: ToHttpResponseOptions,
): Response {
  const unknownMode = options?.unknownInternal ?? "dispatch";

  if (err instanceof WebFetchServerError) {
    return jsonErrorResponse(
      err.httpStatus,
      err.code,
      err.message,
      err.requestId,
      err.detail,
    );
  }

  const rid = requestId;

  if (err instanceof UnauthorizedError) {
    return jsonErrorResponse(err.httpStatus, err.code, err.message, rid, err.detail);
  }
  if (err instanceof ForbiddenError) {
    return jsonErrorResponse(err.httpStatus, err.code, err.message, rid, err.detail);
  }
  if (err instanceof RateLimitedError) {
    const retrySec = Math.max(1, Math.ceil(err.detail.retryAfterMs / 1000));
    return jsonErrorResponse(
      err.httpStatus,
      err.code,
      err.message,
      rid,
      {
        retryAfterMs: err.detail.retryAfterMs,
        limitRpm: err.detail.limitRpm,
      },
      { "retry-after": String(retrySec) },
    );
  }
  if (err instanceof SsrfBlockedError) {
    return jsonErrorResponse(err.httpStatus, err.code, err.message, rid, {
      ...err.detail,
    });
  }
  if (err instanceof DomainNotAllowedError) {
    return jsonErrorResponse(err.httpStatus, err.code, err.message, rid, {
      ...err.detail,
    });
  }
  if (err instanceof InvalidUrlError) {
    return jsonErrorResponse(err.httpStatus, err.code, err.message, rid, {
      ...err.detail,
    });
  }
  if (err instanceof ExtractTimeoutError) {
    return jsonErrorResponse(err.httpStatus, err.code, err.message, rid, {
      ...err.detail,
    });
  }

  if (unknownMode === "extract") {
    return jsonErrorResponse(
      500,
      "INTERNAL_ERROR",
      "Internal server error",
      rid,
      internalDetailForExtract(err),
    );
  }

  return jsonErrorResponse(500, "INTERNAL_ERROR", "Internal server error", rid, {
    trace: rid,
  });
}
