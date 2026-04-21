import type { ErrorResponseBody, WebFetchErrorCode } from "./types";

/**
 * 客户端在解析失败或网络层错误时使用的扩展码（契约 §3 行为要求；不在纯 HTTP 错误体中出现）。
 */
export type WebFetchClientOnlyErrorCode = "MALFORMED_RESPONSE" | "NETWORK_ERROR";

export type WebFetchClientErrorCode = WebFetchErrorCode | WebFetchClientOnlyErrorCode;

/**
 * `web-fetch` / `web-search` 工具在客户端抛出的统一错误类型。
 *
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §4
 */
export class WebFetchClientError extends Error {
  readonly name = "WebFetchClientError";

  constructor(
    public readonly code: WebFetchClientErrorCode,
    public readonly userMessage: string,
    public readonly detail?: unknown,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
  }
}

/** @see docs/adr/decisions/0003d-web-fetch-errors.md §5 */
const HTTP_STATUS_TO_CODE: Record<number, WebFetchErrorCode> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "INVALID_REQUEST",
  408: "REQUEST_TIMEOUT",
  413: "REQUEST_TOO_LARGE",
  422: "RENDER_FAILED",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "UPSTREAM_ERROR",
  503: "BROWSER_POOL_EXHAUSTED",
  504: "PROVIDER_TIMEOUT",
};

function inferCodeFromStatus(httpStatus: number): WebFetchErrorCode {
  return HTTP_STATUS_TO_CODE[httpStatus] ?? "INTERNAL_ERROR";
}

const USER_MESSAGE_ZH: Record<WebFetchClientErrorCode, string> = {
  INVALID_REQUEST: "请求格式无效。请检查参数后重试。",
  INVALID_URL: "URL 无效。请使用合法的 http/https 地址。",
  UNAUTHORIZED: "鉴权失败。请检查 Web Fetch 服务的访问令牌配置。",
  FORBIDDEN: "访问被拒绝。请确认令牌与权限配置是否正确。",
  SSRF_BLOCKED: "出于安全策略，无法访问该地址。请仅使用允许的公网 URL。",
  DOMAIN_NOT_ALLOWED: "域名不在允许列表中。请调整白名单或更换 URL。",
  REQUEST_TIMEOUT: "请求处理超时。请稍后重试，或尝试缩短等待时间。",
  REQUEST_TOO_LARGE: "请求体过大。请减小提交内容后重试。",
  RESPONSE_TOO_LARGE: "目标页面响应过大。请尝试降低正文长度上限或更换页面。",
  RENDER_FAILED: "页面渲染失败。可尝试更换渲染模式或稍后重试。",
  RATE_LIMITED: "触发限流。请稍后再试或降低请求频率。",
  INTERNAL_ERROR: "服务端出现内部错误。请稍后重试或联系管理员。",
  UPSTREAM_ERROR: "上游站点返回异常。请稍后重试。",
  BROWSER_POOL_EXHAUSTED: "浏览器资源繁忙。请降低并发或稍后重试。",
  BROWSER_CRASHED: "浏览器进程异常。请立即重试，通常可以恢复。",
  PROVIDER_NOT_CONFIGURED: "搜索提供方未配置。请检查搜索相关环境变量。",
  PROVIDER_UPSTREAM_ERROR: "搜索提供方返回异常。请稍后重试。",
  PROVIDER_TIMEOUT: "搜索提供方调用超时。请稍后重试。",
  TIMEOUT_WEB_FETCH: "网页抓取超时。请缩短正文长度上限或更换 URL 后重试。",
  TIMEOUT_WEB_SEARCH: "搜索超时。请缩短查询或减少抓取条数后重试。",
  WEB_FETCH_SERVER_UNREACHABLE: "渲染服务不可达。请检查网络或服务端状态。",
  WEB_FETCH_ENDPOINT_NOT_CONFIGURED:
    "未能连接到 Web Fetch 服务。请先启动渲染服务，或通过 TACHU_WEB_FETCH_ENDPOINT 配置远端地址。",
  MALFORMED_RESPONSE: "服务返回了无法解析的响应。请检查服务端版本或稍后重试。",
  NETWORK_ERROR: "网络请求失败。请检查网络连接与服务是否可用。",
};

/**
 * 将服务端错误响应映射为 {@link WebFetchClientError}。
 *
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §4.2
 */
export function mapServerErrorToClient(
  httpStatus: number,
  body: ErrorResponseBody | null,
  ctx: { endpoint: string },
): WebFetchClientError {
  const code = body?.error.code ?? inferCodeFromStatus(httpStatus);
  const userMessage = USER_MESSAGE_ZH[code] ?? body?.error.message ?? USER_MESSAGE_ZH.INTERNAL_ERROR;
  const detail = {
    ...(body?.error.detail ?? {}),
    httpStatus,
    endpoint: ctx.endpoint,
    requestId: body?.error.requestId,
  };
  return new WebFetchClientError(code, userMessage, detail);
}

export function getMalformedResponseError(): WebFetchClientError {
  return new WebFetchClientError(
    "MALFORMED_RESPONSE",
    USER_MESSAGE_ZH.MALFORMED_RESPONSE,
    undefined,
  );
}

export function getNetworkError(endpoint: string, originalError: unknown): WebFetchClientError {
  const original =
    originalError instanceof Error ? originalError.message : String(originalError);
  return new WebFetchClientError("NETWORK_ERROR", USER_MESSAGE_ZH.NETWORK_ERROR, {
    endpoint,
    originalError: original,
  }, { cause: originalError instanceof Error ? originalError : undefined });
}

export function getTimeoutError(timeoutMs: number): WebFetchClientError {
  return new WebFetchClientError(
    "REQUEST_TIMEOUT",
    USER_MESSAGE_ZH.REQUEST_TIMEOUT,
    { timeoutMs, phase: "fetch" as const },
  );
}
