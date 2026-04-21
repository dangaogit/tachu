# ADR 0003b — Web Fetch Server TypeScript 类型契约

- Status: Proposed
- Date: 2026-04-20
- Parent: [ADR-0003](./0003-web-fetch-server.md)
- Applies to: `@tachu/web-fetch-server` 内部模块, `@tachu/extensions` 中 `web-fetch` / `web-search` 工具

本文件**冻结**所有跨模块共享的 TS 类型定义。subagent 实现时必须**严格使用这些类型名称 / 字段 / 可选性**。**任何类型变更都必须先更新本文档并通知主 agent 解冻**。

## 类型归属

```
packages/web-fetch-server/src/types/
├── extract.ts       # /v1/extract 的请求/响应 + 内部中间类型
├── search.ts        # /v1/search 的请求/响应
├── health.ts        # /healthz 响应
├── config.ts        # server 运行期配置（见 0003c）
├── error.ts         # 统一错误响应体
└── index.ts         # 汇总导出
```

- Server 侧类型**内部使用**，**不发布 npm**
- Client 侧（`@tachu/extensions` 的 `web-fetch` / `web-search`）**不导入 server 包的类型**（会形成循环依赖且污染 SDK bundle）
- 改为：client 侧在 `packages/extensions/src/tools/web-fetch/types.ts` 与 `web-search/types.ts` **各自重复定义**请求/响应类型，并加注释 `/** @see docs/adr/decisions/0003b-web-fetch-types.md */`。两侧类型通过本 ADR 保持同步。

---

## 1. Extract 类型（`extract.ts`）

### 1.1 请求

```ts
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

export type ScrollStrategy =
  | false
  | true
  | { steps: number; delayMs: number };

export interface CookieInit {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;          // Unix epoch seconds
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export type ResourceType = "image" | "font" | "media" | "stylesheet" | "other";

export type OutputFormat = "markdown" | "text" | "html" | "structured";
```

### 1.2 响应

```ts
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
```

### 1.3 内部中间类型（server 专用）

```ts
/**
 * Readability 解析后的中间结果，喂给 Turndown 或直接输出。
 */
export interface ReadabilityArticle {
  title: string;
  byline: string | null;
  dir: string | null;
  lang: string | null;
  content: string;               // 清洗后的 HTML 片段
  textContent: string;           // 纯文本
  length: number;                // textContent.length
  excerpt: string;
  siteName: string | null;
  publishedTime: string | null;
}

/**
 * static 抓取的原始 HTTP 结果，供 pipeline 下游消费。
 */
export interface RawFetchResult {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  html: string;
  contentType: string | null;
  elapsedMs: number;
}

/**
 * browser 渲染的结果。
 */
export interface BrowserRenderResult {
  finalUrl: string;
  status: number;
  html: string;
  elapsedMs: number;
  navigationChain: string[];     // 所有跳转过的 URL（供 SSRF 审计）
}

/**
 * Pipeline 编排器的输入。
 */
export interface PipelineInput {
  request: ExtractRequest;
  requestId: string;
  logger: Logger;                  // 见下方 Logger 定义
  abortSignal: AbortSignal;
}

/**
 * Pipeline 编排器的输出（pre-serialization）。
 */
export interface PipelineResult {
  response: ExtractResponse;
  internal: {
    shouldUpgradeToBrowser: boolean;   // auto 模式下的升级标志
    warnings: string[];
  };
}
```

---

## 2. Search 类型（`search.ts`）

### 2.1 请求

```ts
/**
 * POST /v1/search 请求体。
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §Endpoint 3
 */
export interface SearchRequest {
  query: string;
  maxResults?: number;
  language?: string | null;
  region?: string | null;
  timeRange?: "day" | "week" | "month" | "year" | null;
  safeSearch?: "off" | "moderate" | "strict";
  includeDomains?: string[];
  excludeDomains?: string[];
  fetchTopN?: number;
  fetchOptions?: Omit<ExtractRequest, "url" | "traceId">;
  traceId?: string | null;
}
```

### 2.2 响应

```ts
export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResultItem[];
  totalResults: number;
  searchedAtMs: number;
  warnings: string[];
  traceId: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
  score?: number | null;
  extract?: Pick<
    ExtractResponse,
    | "status"
    | "renderedWith"
    | "title"
    | "body"
    | "wordCount"
    | "truncated"
    | "warnings"
  >;
}
```

### 2.3 Provider 抽象

**这是搜索占位实现的核心**。未来接入 Tavily / Brave / Serper 时只需新增 provider 文件并在工厂中注册。

```ts
/**
 * 统一搜索 provider 接口。
 * 所有 provider 实现都必须满足此接口，包括 stub。
 */
export interface SearchProvider {
  /** 唯一标识；如 "stub" / "tavily" / "brave" / "serper" / "searxng" */
  readonly name: string;

  /** 是否已完成必要的配置（通常是 API key）。stub 永远返回 false */
  isConfigured(): boolean;

  /**
   * 执行搜索。
   * - 未配置时必须抛 ProviderNotConfiguredError
   * - 调用失败必须抛 ProviderUpstreamError / ProviderTimeoutError
   * - 不负责批量 extract（由路由层编排）
   */
  search(
    params: SearchProviderParams,
    signal: AbortSignal,
  ): Promise<SearchProviderResult>;
}

export interface SearchProviderParams {
  query: string;
  maxResults: number;
  language?: string | null;
  region?: string | null;
  timeRange?: SearchRequest["timeRange"];
  safeSearch: NonNullable<SearchRequest["safeSearch"]>;
  includeDomains: string[];
  excludeDomains: string[];
}

export interface SearchProviderResult {
  results: Array<Omit<SearchResultItem, "extract">>;
  totalResults: number;
}

/**
 * Provider 工厂：按 name 取 provider 实例。
 * 启动期根据 WEB_SEARCH_PROVIDER 环境变量实例化默认 provider。
 */
export interface SearchProviderRegistry {
  get(name: string): SearchProvider | undefined;
  list(): string[];
  default(): SearchProvider;                // 启动期锁定
}
```

---

## 3. Health 类型（`health.ts`）

```ts
export interface HealthResponse {
  status: "ok" | "degraded" | "unhealthy";
  version: string;
  uptimeMs: number;
  browser: BrowserPoolStatus | null;
  search: {
    provider: string;
    configured: boolean;
  };
  reason?: string;                            // unhealthy 时必填
}

export interface BrowserPoolStatus {
  enabled: boolean;
  inUse: number | null;
  idle: number | null;
  maxConcurrency: number | null;
  totalRendered: number | null;
  lastRecycleAt: string | null;
}
```

---

## 4. Error 类型（`error.ts`）

```ts
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
 * 新增错误码时必须同步更新 0003d 和本枚举。
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
  // /v1/search 专用
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UPSTREAM_ERROR"
  | "PROVIDER_TIMEOUT"
  // client 端抛出（非 server 响应）
  | "TIMEOUT_WEB_FETCH"
  | "TIMEOUT_WEB_SEARCH"
  | "WEB_FETCH_SERVER_UNREACHABLE"
  | "WEB_FETCH_ENDPOINT_NOT_CONFIGURED";

/**
 * Server 内部抛出的基类；路由层 catch 后翻译为 ErrorResponseBody。
 */
export class WebFetchError extends Error {
  constructor(
    public readonly code: WebFetchErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly detail?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebFetchError";
  }
}
```

---

## 5. Logger 接口（`observability/logger.ts`）

```ts
/**
 * 最小 Logger 接口，便于测试替换。
 * 实现见 packages/web-fetch-server/src/observability/logger.ts。
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
```

---

## 6. 客户端侧（`@tachu/extensions`）类型

### 6.1 `web-fetch` 工具

```ts
// packages/extensions/src/tools/web-fetch/types.ts
// @see docs/adr/decisions/0003b-web-fetch-types.md §6.1
// 字段与 server 侧 ExtractRequest / ExtractResponse 保持同步

export interface WebFetchInput {
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
  /** client 端整体超时；默认 70000（server + 10s 余量） */
  timeoutMs?: number;
}

export interface WebFetchOutput {
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
```

### 6.2 `web-search` 工具

```ts
// packages/extensions/src/tools/web-search/types.ts

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  language?: string;
  region?: string;
  timeRange?: "day" | "week" | "month" | "year";
  safeSearch?: "off" | "moderate" | "strict";
  includeDomains?: string[];
  excludeDomains?: string[];
  /** 渲染前 N 条结果为 Markdown；上限 5 */
  fetchTopN?: number;
  timeoutMs?: number;
}

export interface WebSearchOutput {
  query: string;
  provider: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    publishedAt?: string | null;
    score?: number | null;
    extract?: {
      status: number;
      renderedWith: "static" | "browser";
      title?: string;
      body: string;
      wordCount: number;
      truncated: boolean;
    };
  }>;
  totalResults: number;
  warnings: string[];
}
```

---

## 7. 命名与约定

| 约定 | 规则 |
|---|---|
| 文件名 | kebab-case，如 `browser-pool.ts` |
| 类型名 | PascalCase，如 `ExtractRequest` |
| 字段名 | camelCase，如 `maxBodyChars`（对齐现有 codebase） |
| 枚举类型 | 字面量联合，不用 TypeScript `enum`（对齐 codebase 风格） |
| 可选字段 | 一律用 `?:`，不用 `| undefined`（除非有明确语义区分） |
| 导出风格 | 命名导出，不用 default export |
| 注释 | 所有公开接口必须有 JSDoc，复杂字段要举例 |

## 关联文档

- 父 ADR：[0003](./0003-web-fetch-server.md)
- HTTP API 契约：[0003a](./0003a-web-fetch-api-contract.md)
- 配置：[0003c](./0003c-web-fetch-config.md)
- 错误码：[0003d](./0003d-web-fetch-errors.md)
