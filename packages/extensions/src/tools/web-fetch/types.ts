/**
 * Web Fetch 工具与 `/v1/extract` 共享的类型（客户端本地复刻，不依赖 `@tachu/web-fetch-server`）。
 *
 * @see docs/adr/decisions/0003b-web-fetch-types.md
 */

/**
 * POST /v1/extract 请求体。
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §Endpoint 2 请求 schema
 */
export interface ExtractRequest {
  url: string;
  renderMode?: RenderMode;
  waitFor?: WaitStrategy;
  waitTimeoutMs?: number;
  scroll?: ScrollStrategy;
  userAgent?: string | null;
  extraHeaders?: Record<string, string>;
  cookies?: CookieInit[];
  blockResources?: ResourceType[];
  stealth?: boolean | null;
  outputFormat?: OutputFormat;
  includeLinks?: boolean;
  includeImages?: boolean;
  includeStructured?: boolean;
  maxBodyChars?: number;
  traceId?: string | null;
}

export type RenderMode = "static" | "browser" | "auto";

export type WaitStrategy =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | { selector: string }
  | { timeMs: number };

export type ScrollStrategy = false | true | { steps: number; delayMs: number };

export interface CookieInit {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export type ResourceType = "image" | "font" | "media" | "stylesheet" | "other";

export type OutputFormat = "markdown" | "text" | "html" | "structured";

/**
 * POST /v1/extract 成功响应体。
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §Endpoint 2 响应 schema
 */
export interface ExtractResponse {
  url: string;
  finalUrl: string;
  status: number;
  renderedWith: "static" | "browser";
  renderedAtMs: number;

  title?: string;
  description?: string;
  siteName?: string;
  lang?: string;
  byline?: string;
  publishedTime?: string | null;
  body: string;
  wordCount: number;
  truncated: boolean;

  links?: LinkRef[];
  images?: ImageRef[];
  structured?: Record<string, unknown>;

  warnings: string[];
  traceId: string;
}

export interface LinkRef {
  text: string;
  href: string;
}

export interface ImageRef {
  alt: string;
  src: string;
  width?: number;
  height?: number;
}

/**
 * `web-fetch` 工具入参（与 server 侧 {@link ExtractRequest} 字段对齐；`timeoutMs` 仅客户端使用）。
 * @see docs/adr/decisions/0003b-web-fetch-types.md §6.1
 */
export interface WebFetchToolInput {
  url: string;
  renderMode?: "static" | "browser" | "auto";
  waitFor?:
    | "load"
    | "domcontentloaded"
    | "networkidle"
    | { selector: string }
    | { timeMs: number };
  waitTimeoutMs?: number;
  scroll?: boolean | { steps: number; delayMs: number };
  outputFormat?: "markdown" | "text" | "html" | "structured";
  includeLinks?: boolean;
  includeImages?: boolean;
  includeStructured?: boolean;
  maxBodyChars?: number;
  stealth?: boolean | null;
  /** client 端整体超时；默认与 `TACHU_WEB_FETCH_TIMEOUT_MS` 或 70000 对齐 */
  timeoutMs?: number;
}

/**
 * `web-fetch` 工具成功出参（不含服务端追踪字段）。
 * @see docs/adr/decisions/0003b-web-fetch-types.md §6.1
 */
export interface WebFetchToolOutput {
  url: string;
  finalUrl: string;
  status: number;
  renderedWith: "static" | "browser";
  title?: string;
  description?: string;
  siteName?: string;
  lang?: string;
  byline?: string;
  publishedTime?: string | null;
  body: string;
  wordCount: number;
  truncated: boolean;
  links?: Array<{ text: string; href: string }>;
  images?: Array<{ alt: string; src: string }>;
  structured?: Record<string, unknown>;
  warnings: string[];
}

/**
 * 统一错误响应体结构。
 * @see docs/adr/decisions/0003d-web-fetch-errors.md
 */
export interface ErrorResponseBody {
  error: {
    code: WebFetchErrorCode;
    message: string;
    detail?: Record<string, unknown>;
    requestId: string;
  };
}

/**
 * 所有错误码的字面量联合类型。
 * @see docs/adr/decisions/0003b-web-fetch-types.md §4
 */
export type WebFetchErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_URL"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "SSRF_BLOCKED"
  | "DOMAIN_NOT_ALLOWED"
  | "REQUEST_TIMEOUT"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE"
  | "RENDER_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "UPSTREAM_ERROR"
  | "BROWSER_POOL_EXHAUSTED"
  | "BROWSER_CRASHED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UPSTREAM_ERROR"
  | "PROVIDER_TIMEOUT"
  | "TIMEOUT_WEB_FETCH"
  | "TIMEOUT_WEB_SEARCH"
  | "WEB_FETCH_SERVER_UNREACHABLE"
  | "WEB_FETCH_ENDPOINT_NOT_CONFIGURED";
