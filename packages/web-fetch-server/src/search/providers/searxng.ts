/**
 * SearXNG / 兼容实例：`GET {base}/search?format=json&q=...`
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

function extractSearxResults(data: unknown, limit: number): SearchResultItem[] {
  if (!isRecord(data)) {
    return [];
  }
  const raw = data.results;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SearchResultItem[] = [];
  for (const item of raw) {
    if (out.length >= limit) {
      break;
    }
    if (!isRecord(item)) {
      continue;
    }
    const url = typeof item.url === "string" ? item.url : "";
    if (url === "") {
      continue;
    }
    const title = typeof item.title === "string" ? item.title : url;
    const snippet =
      typeof item.content === "string"
        ? item.content
        : typeof item.snippet === "string"
          ? item.snippet
          : "";
    out.push({
      title,
      url,
      snippet,
      publishedAt: typeof item.publishedDate === "string" ? item.publishedDate : null,
      score: typeof item.score === "number" ? item.score : null,
    });
  }
  return out;
}

export function normalizeSearxngBase(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

export function createSearxngSearchProvider(cfg: WebFetchServerConfig): SearchProvider {
  const base = cfg.search.endpoint;
  if (base === null || base === "") {
    throw new Error("SearXNG search provider requires cfg.search.endpoint");
  }
  const origin = normalizeSearxngBase(base);

  return {
    id: "searxng",

    async search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
      const traceId = req.traceId ?? "unknown";
      const timeoutMs = cfg.timeouts.requestMs;
      const limit = clampSearchMaxResults(req.maxResults, cfg.search.defaultMaxResults);
      try {
        const url = new URL(`${origin}/search`);
        url.searchParams.set("q", req.query);
        url.searchParams.set("format", "json");
        if (req.language !== undefined && req.language !== null && req.language !== "") {
          url.searchParams.set("language", req.language);
        }
        if (req.safeSearch === "strict") {
          url.searchParams.set("safesearch", "2");
        } else if (req.safeSearch === "moderate") {
          url.searchParams.set("safesearch", "1");
        } else if (req.safeSearch === "off") {
          url.searchParams.set("safesearch", "0");
        }
        url.searchParams.set("pageno", "1");

        const res = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal,
        });
        assertOkJsonResponse(res, "searxng", traceId);
        const data = await readJsonBody(res, "searxng", traceId);
        const items = extractSearxResults(data, limit);
        let totalResults = items.length;
        if (isRecord(data) && typeof data.number_of_results === "number") {
          totalResults = Math.max(totalResults, data.number_of_results);
        }

        return {
          query: req.query,
          provider: "searxng",
          results: items,
          totalResults,
          searchedAtMs: Date.now(),
          warnings: [],
          traceId,
        };
      } catch (err) {
        rethrowSearchProviderError(err, "searxng", traceId, timeoutMs);
      }
    },
  };
}
