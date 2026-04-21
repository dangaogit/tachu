/**
 * 服务端安全与鉴权相关错误（路由层可映射为 HTTP 响应）。
 *
 * @see docs/adr/decisions/0003d-web-fetch-errors.md
 */

/**
 * 缺 `Authorization` header 或不符合 `Bearer <token>` 格式（对齐 ADR `UNAUTHORIZED` / 401）。
 */
export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED" as const;
  readonly httpStatus = 401;
  readonly detail: Record<string, unknown> = {};

  constructor(message = "Authorization header missing or malformed", options?: ErrorOptions) {
    super(message, options);
    this.name = "UnauthorizedError";
  }
}

/**
 * Bearer token 与配置值经恒定时间比较后不一致（对齐 ADR `FORBIDDEN` / 403）。
 */
export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN" as const;
  readonly httpStatus = 403;
  readonly detail: Record<string, unknown> = {};

  constructor(message = "Bearer token does not match", options?: ErrorOptions) {
    super(message, options);
    this.name = "ForbiddenError";
  }
}

/** SSRF_BLOCKED 的 detail.reason 取值（0003d §2.1）。 */
export type SsrfBlockedReason =
  | "private-ipv4"
  | "private-ipv6"
  | "localhost"
  | "cloud-metadata"
  | "redirect-chain";

/** DOMAIN_NOT_ALLOWED 的 detail.reason（0003d §2.1）。 */
export type DomainNotAllowedReason = "blocked" | "not-in-allowlist";

export type SsrfBlockedDetail = {
  hostname: string;
  reason: SsrfBlockedReason;
  chain?: string[];
};

export type DomainNotAllowedDetail = {
  hostname: string;
  reason: DomainNotAllowedReason;
};

export type InvalidUrlDetail = {
  url: string;
};

/**
 * URL 指向私网、本机、云元数据等，被 SSRF 策略拦截。
 */
export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED" as const;
  readonly httpStatus = 403 as const;
  readonly detail: SsrfBlockedDetail;
  readonly userMessage: string;

  constructor(
    message: string,
    detail: SsrfBlockedDetail,
    userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SsrfBlockedError";
    this.detail = detail;
    this.userMessage = userMessage;
  }
}

/**
 * 域名不在允许列表或被策略禁止。
 */
export class DomainNotAllowedError extends Error {
  readonly code = "DOMAIN_NOT_ALLOWED" as const;
  readonly httpStatus = 403 as const;
  readonly detail: DomainNotAllowedDetail;
  readonly userMessage: string;

  constructor(
    message: string,
    detail: DomainNotAllowedDetail,
    userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DomainNotAllowedError";
    this.detail = detail;
    this.userMessage = userMessage;
  }
}

/**
 * URL 非法或不支持（非 http/https 等）。
 */
export class InvalidUrlError extends Error {
  readonly code = "INVALID_URL" as const;
  readonly httpStatus = 400 as const;
  readonly detail: InvalidUrlDetail;
  readonly userMessage: string;

  constructor(
    message: string,
    detail: InvalidUrlDetail,
    userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InvalidUrlError";
    this.detail = detail;
    this.userMessage = userMessage;
  }
}

/** RATE_LIMITED 的 detail（0003d §2.1）。 */
export type RateLimitedDetail = {
  retryAfterMs: number;
  limitRpm: number;
};

/**
 * 触发 IP 令牌桶限流（对齐 ADR `RATE_LIMITED` / 429）。
 */
export class RateLimitedError extends Error {
  readonly code = "RATE_LIMITED" as const;
  readonly httpStatus = 429;
  readonly detail: RateLimitedDetail;

  constructor(detail: RateLimitedDetail, options?: ErrorOptions) {
    super("Rate limit exceeded", options);
    this.name = "RateLimitedError";
    this.detail = detail;
  }
}
