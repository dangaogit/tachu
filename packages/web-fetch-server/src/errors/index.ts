/**
 * Web Fetch Server 错误类型与 HTTP 映射统一出口。
 */

export { ConfigValidationError } from "../config/errors.js";
export { ExtractTimeoutError } from "../pipeline/browser-pipeline.js";
export {
  DomainNotAllowedError,
  ForbiddenError,
  InvalidUrlError,
  type DomainNotAllowedDetail,
  type DomainNotAllowedReason,
  type InvalidUrlDetail,
  type RateLimitedDetail,
  RateLimitedError,
  SsrfBlockedError,
  type SsrfBlockedDetail,
  type SsrfBlockedReason,
  UnauthorizedError,
} from "../security/errors.js";
export {
  internalDetailForExtract,
  type ToHttpResponseOptions,
  toHttpResponse,
  WebFetchServerError,
} from "./unifier.js";
