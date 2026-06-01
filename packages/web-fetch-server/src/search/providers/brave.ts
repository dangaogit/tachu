/**
 * Brave Web Search API（`https://api.search.brave.com/res/v1/web/search`）。
 * @see https://brave.com/search/api/
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

function extractBraveResults(data: unknown): SearchResultItem[] {
  if (!isRecord(data)) {
    return [];
  }
  const web = data.web;
  if (!isRecord(web)) {
    return [];
  }
  const raw = web.results;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SearchResultItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const title = typeof item.title === "string" ? item.title : "";
    const url = typeof item.url === "string" ? item.url : "";
    const snippet = typeof item.description === "string" ? item.description : "";
    if (url === "") {
      continue;
    }
    const publishedAt =
      typeof item.age === "string" && item.age.length > 0 ? item.age : typeof item.page_age === "string"
        ? item.page_age
        : null;
    out.push({
      title: title || url,
      url,
      snippet,
      publishedAt,
      score: typeof item.score === "number" ? item.score : null,
    });
  }
  return out;
}

function braveFreshness(timeRange: SearchRequest["timeRange"]): string | undefined {
  if (timeRange === "day") {
    return "pd";
  }
  if (timeRange === "week") {
    return "pw";
  }
  if (timeRange === "month") {
    return "pm";
  }
  if (timeRange === "year") {
    return "py";
  }
  return undefined;
}

function braveSafesearch(level: SearchRequest["safeSearch"]): string | undefined {
  if (level === "off") {
    return "off";
  }
  if (level === "moderate") {
    return "moderate";
  }
  if (level === "strict") {
    return "strict";
  }
  return undefined;
}

export function createBraveSearchProvider(cfg: WebFetchServerConfig): SearchProvider {
  const apiKey = cfg.search.apiKey;
  if (apiKey === null || apiKey === "") {
    throw new Error("Brave search provider requires cfg.search.apiKey");
  }

  return {
    id: "brave",

    async search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
      const traceId = req.traceId ?? "unknown";
      const timeoutMs = cfg.timeouts.requestMs;
      const count = clampSearchMaxResults(req.maxResults, cfg.search.defaultMaxResults);
      try {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", req.query);
        url.searchParams.set("count", String(count));
        const freshness = braveFreshness(req.timeRange);
        if (freshness !== undefined) {
          url.searchParams.set("freshness", freshness);
        }
        const ss = braveSafesearch(req.safeSearch);
        if (ss !== undefined) {
          url.searchParams.set("safesearch", ss);
        }
        if (req.language !== undefined && req.language !== null && req.language !== "") {
          url.searchParams.set("search_lang", req.language);
        }
        if (req.region !== undefined && req.region !== null && req.region !== "") {
          url.searchParams.set("country", req.region);
        }

        const res = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal,
        });
        assertOkJsonResponse(res, "brave", traceId);
        const data = await readJsonBody(res, "brave", traceId);
        const items = extractBraveResults(data);
        let totalResults = items.length;
        if (isRecord(data) && isRecord(data.web) && typeof data.web.results_count_hint === "number") {
          totalResults = Math.max(totalResults, data.web.results_count_hint);
        }

        return {
          query: req.query,
          provider: "brave",
          results: items,
          totalResults,
          searchedAtMs: Date.now(),
          warnings: [],
          traceId,
        };
      } catch (err) {
        rethrowSearchProviderError(err, "brave", traceId, timeoutMs);
      }
    },
  };
}
