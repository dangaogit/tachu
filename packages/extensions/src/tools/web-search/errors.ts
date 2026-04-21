import {
  mapServerErrorToClient,
  WebFetchClientError,
  type WebFetchClientErrorCode,
} from "../web-fetch/errors";
import type { ErrorResponseBody } from "../web-fetch/types";

/**
 * `web-search` 工具在客户端抛出的错误类型（语义上与 {@link ../web-fetch/errors.WebFetchClientError} 一致）。
 *
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §2.2 / §4
 */
export class WebSearchClientError extends Error {
  readonly name = "WebSearchClientError";

  constructor(
    public readonly code: WebFetchClientErrorCode,
    public readonly userMessage: string,
    public readonly detail?: unknown,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
  }
}

/**
 * 将 `/v1/search` 的错误响应映射为 {@link WebSearchClientError}。
 * 对 `PROVIDER_NOT_CONFIGURED`（503）提供面向运维的中文指引。
 *
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §2.2
 */
export function mapSearchServerErrorToClient(
  httpStatus: number,
  body: ErrorResponseBody | null,
  ctx: { endpoint: string },
): WebSearchClientError {
  const mapped = mapServerErrorToClient(httpStatus, body, ctx);
  if (mapped.code === "PROVIDER_NOT_CONFIGURED") {
    return new WebSearchClientError(
      "PROVIDER_NOT_CONFIGURED",
      "搜索提供方未配置。请在服务器端设置 WEB_SEARCH_PROVIDER、WEB_SEARCH_PROVIDER_API_KEY 等环境变量后重试。",
      mapped.detail,
      { cause: mapped.cause },
    );
  }
  return new WebSearchClientError(mapped.code, mapped.userMessage, mapped.detail, {
    cause: mapped.cause,
  });
}

/**
 * 客户端整体超时（`TIMEOUT_WEB_SEARCH`）。
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §2.3
 */
export function getSearchTimeoutError(timeoutMs: number): WebSearchClientError {
  return new WebSearchClientError(
    "TIMEOUT_WEB_SEARCH",
    "搜索超时。请缩短查询词或减少 fetchTopN 后重试。",
    { timeoutMs },
  );
}

/** 将 {@link WebFetchClientError} 转为本工具统一抛出的错误类型。 */
export function asWebSearchClientError(err: WebFetchClientError): WebSearchClientError {
  return new WebSearchClientError(err.code, err.userMessage, err.detail, { cause: err.cause });
}
