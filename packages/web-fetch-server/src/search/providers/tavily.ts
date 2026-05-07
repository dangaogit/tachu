/**
 * Tavily Search API：`POST https://api.tavily.com/search`
 * @see https://docs.tavily.com/
 */

import type { WebFetchServerConfig } from "../../config/index.js";
import type { SearchProvider, SearchRequest, SearchResponse, SearchResultItem } from "../provider.js";
import {
  assertOkJsonResponse,
  clampSearchMaxResults,
  readJsonBody,
  rethrowSearchProviderError,
} from "./common.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractTavilyResults(data: unknown): SearchResultItem[] {
  if (!isRecord(data)) {
    return [];
  }
  const raw = data.results;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SearchResultItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const url = typeof item.url === "string" ? item.url : "";
    if (url === "") {
      continue;
    }
    const title = typeof item.title === "string" ? item.title : url;
    const snippet = typeof item.content === "string" ? item.content : "";
    out.push({
      title,
      url,
      snippet,
      publishedAt: typeof item.published_time === "string" ? item.published_time : null,
      score: typeof item.score === "number" ? item.score : null,
    });
  }
  return out;
}

export function createTavilySearchProvider(cfg: WebFetchServerConfig): SearchProvider {
  const apiKey = cfg.search.apiKey;
  if (apiKey === null || apiKey === "") {
    throw new Error("Tavily search provider requires cfg.search.apiKey");
  }

  const endpoint =
    cfg.search.endpoint !== null && cfg.search.endpoint !== ""
      ? (() => {
          const u = new URL(cfg.search.endpoint);
          if (u.pathname === "/" || u.pathname === "") {
            u.pathname = "/search";
          }
          return u.toString().replace(/\/+$/, "");
        })()
      : "https://api.tavily.com/search";

  return {
    id: "tavily",

    async search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
      const traceId = req.traceId ?? "unknown";
      const timeoutMs = cfg.timeouts.requestMs;
      const maxResults = clampSearchMaxResults(req.maxResults, cfg.search.defaultMaxResults);
      try {
        const body: Record<string, unknown> = {
          api_key: apiKey,
          query: req.query,
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
        };
        if (req.includeDomains !== undefined && req.includeDomains.length > 0) {
          body.include_domains = req.includeDomains;
        }
        if (req.excludeDomains !== undefined && req.excludeDomains.length > 0) {
          body.exclude_domains = req.excludeDomains;
        }

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        assertOkJsonResponse(res, "tavily", traceId);
        const data = await readJsonBody(res, "tavily", traceId);
        const items = extractTavilyResults(data);
        const totalResults = items.length;

        return {
          query: req.query,
          provider: "tavily",
          results: items.slice(0, maxResults),
          totalResults,
          searchedAtMs: Date.now(),
          warnings: [],
          traceId,
        };
      } catch (err) {
        rethrowSearchProviderError(err, "tavily", traceId, timeoutMs);
      }
    },
  };
}
