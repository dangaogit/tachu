/**
 * 搜索 Provider 注册表（Stage 4 占位）：按配置 id 解析已注册实现。
 * @see docs/adr/decisions/0003b-web-fetch-types.md §2
 */

import type { WebFetchServerConfig } from "../config/index.js";
import type { ExtractResponse } from "../pipeline/static-pipeline.js";

/**
 * POST /v1/search 请求体（与 ADR 0003b 对齐的 server 侧子集）。
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
  traceId?: string | null;
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
 * POST /v1/search 成功响应体。
 */
export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResultItem[];
  totalResults: number;
  searchedAtMs: number;
  warnings: string[];
  traceId: string;
}

/**
 * 单个搜索 provider：由注册表按 {@link WebFetchServerConfig.search} 解析。
 */
export interface SearchProvider {
  /** 与 `WEB_SEARCH_PROVIDER` 及 {@link WebFetchServerConfig.search} 中 `provider` 字段对齐的 id。 */
  readonly id: string;
  search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
}

/**
 * 内存注册表：v0.1 仅支持显式 `register`，不做动态加载。
 */
export class SearchProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();

  /**
   * 注册 provider；同一 `id` 重复注册会抛错。
   */
  register(p: SearchProvider): void {
    if (this.providers.has(p.id)) {
      throw new Error(`Search provider already registered: ${p.id}`);
    }
    this.providers.set(p.id, p);
  }

  /**
   * 按当前冻结配置选择 provider；未注册或配置 id 无匹配时返回 `null`。
   */
  resolve(cfg: WebFetchServerConfig): SearchProvider | null {
    const id = cfg.search.provider;
    const found = this.providers.get(id);
    return found ?? null;
  }
}
