/**
 * Web Search 工具类型（客户端本地复刻，不依赖 `@tachu/web-fetch-server`）。
 *
 * @see docs/adr/decisions/0003b-web-fetch-types.md §2 / §6.2
 */

import type { ExtractRequest, ExtractResponse } from "../web-fetch/types";

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
    "status" | "renderedWith" | "title" | "body" | "wordCount" | "truncated" | "warnings"
  >;
}

/**
 * `web-search` 工具入参（`timeoutMs` 仅客户端使用）。
 * @see docs/adr/decisions/0003b-web-fetch-types.md §6.2
 */
export interface WebSearchToolInput {
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
  /** `fetchTopN > 0` 时透传至服务端 extract 管线 */
  fetchOptions?: Omit<ExtractRequest, "url" | "traceId">;
  timeoutMs?: number;
}

/**
 * `web-search` 工具成功出参（不含 `searchedAtMs` / `traceId` 等追踪字段）。
 * @see docs/adr/decisions/0003b-web-fetch-types.md §6.2
 */
export interface WebSearchToolOutput {
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
      warnings?: string[];
    };
  }>;
  totalResults: number;
  warnings: string[];
}
