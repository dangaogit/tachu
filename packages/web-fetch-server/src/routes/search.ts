/**
 * POST /v1/search 路由（Stage 4 占位：registry 解析 provider）。
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §Endpoint 3
 */

import type { WebFetchServerConfig } from "../config/index.js";
import { toHttpResponse, WebFetchServerError } from "../errors/unifier.js";
import type { SearchProviderRegistry, SearchRequest } from "../search/provider.js";

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json; charset=utf-8",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTraceIdField(
  v: unknown,
): { ok: true; value: string | null } | { ok: false; field: string; reason: string } {
  if (v === undefined) {
    return { ok: true, value: null };
  }
  if (v === null) {
    return { ok: true, value: null };
  }
  if (typeof v === "string" && v.length > 0) {
    return { ok: true, value: v };
  }
  return { ok: false, field: "traceId", reason: "must be a non-empty string or null" };
}

/**
 * 未注册搜索 provider 或当前配置 id 无匹配实现时抛出（503）。
 */
export class SearchProviderNotConfiguredError extends WebFetchServerError {
  constructor(requestId: string) {
    super(
      "SEARCH_PROVIDER_NOT_CONFIGURED",
      503,
      "Search provider is not configured for this server",
      requestId,
      {
        requiredEnv: [
          "WEB_SEARCH_PROVIDER",
          "WEB_SEARCH_PROVIDER_API_KEY",
          "WEB_SEARCH_PROVIDER_ENDPOINT",
        ],
        hint: "Register a SearchProvider with matching id or adjust WEB_SEARCH_PROVIDER once a provider is available.",
      },
    );
    this.name = "SearchProviderNotConfiguredError";
  }
}

function buildSearchRequest(
  raw: Record<string, unknown>,
  cfg: WebFetchServerConfig,
  traceId: string,
): SearchRequest {
  const q = raw.query;
  if (typeof q !== "string" || q.trim() === "") {
    throw new WebFetchServerError(
      "INVALID_REQUEST",
      400,
      "Request validation failed",
      traceId,
      { field: "query", reason: "must be a non-empty string" },
    );
  }

  let maxResults = cfg.search.defaultMaxResults;
  if (raw.maxResults !== undefined) {
    if (typeof raw.maxResults !== "number" || !Number.isFinite(raw.maxResults)) {
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: "maxResults", reason: "must be a finite number" },
      );
    }
    maxResults = raw.maxResults;
  }

  const req: SearchRequest = {
    query: q,
    maxResults,
    traceId,
  };

  if (raw.language !== undefined) {
    req.language = raw.language === null ? null : String(raw.language);
  }
  if (raw.region !== undefined) {
    req.region = raw.region === null ? null : String(raw.region);
  }
  if (raw.timeRange !== undefined) {
    const tr = raw.timeRange;
    if (tr !== null && tr !== "day" && tr !== "week" && tr !== "month" && tr !== "year") {
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: "timeRange", reason: 'must be "day", "week", "month", "year", or null' },
      );
    }
    req.timeRange = tr;
  }
  if (raw.safeSearch !== undefined) {
    const ss = raw.safeSearch;
    if (ss !== "off" && ss !== "moderate" && ss !== "strict") {
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: "safeSearch", reason: 'must be "off", "moderate", or "strict"' },
      );
    }
    req.safeSearch = ss;
  }
  if (raw.includeDomains !== undefined) {
    if (!Array.isArray(raw.includeDomains)) {
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: "includeDomains", reason: "must be an array of strings" },
      );
    }
    req.includeDomains = raw.includeDomains.map(String);
  }
  if (raw.excludeDomains !== undefined) {
    if (!Array.isArray(raw.excludeDomains)) {
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: "excludeDomains", reason: "must be an array of strings" },
      );
    }
    req.excludeDomains = raw.excludeDomains.map(String);
  }
  if (raw.fetchTopN !== undefined) {
    if (typeof raw.fetchTopN !== "number" || !Number.isFinite(raw.fetchTopN)) {
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: "fetchTopN", reason: "must be a finite number" },
      );
    }
    req.fetchTopN = raw.fetchTopN;
  }

  return req;
}

/**
 * 处理已鉴权、已限流的 POST /v1/search：解析 JSON、解析 provider、调用 {@link SearchProvider.search}。
 */
export async function handleSearch(
  req: Request,
  cfg: WebFetchServerConfig,
  registry: SearchProviderRegistry,
): Promise<Response> {
  const headerRequestId = req.headers.get("x-request-id") ?? req.headers.get("x-trace-id");
  const extended = req as Request & { traceId?: string };
  const extendedTraceId = typeof extended.traceId === "string" ? extended.traceId : undefined;

  let traceId: string | undefined;
  try {
    let rawJson: unknown;
    try {
      const text = await req.text();
      rawJson = text === "" ? {} : JSON.parse(text);
    } catch {
      const rid = headerRequestId ?? extendedTraceId ?? crypto.randomUUID();
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request body must be valid JSON",
        rid,
        { field: "body", reason: "JSON parse failed" },
      );
    }

    if (!isRecord(rawJson)) {
      const rid = headerRequestId ?? extendedTraceId ?? crypto.randomUUID();
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request body must be a JSON object",
        rid,
        { field: "body", reason: "expected object" },
      );
    }

    const traceField = parseTraceIdField(rawJson.traceId);
    if (!traceField.ok) {
      const rid = headerRequestId ?? extendedTraceId ?? crypto.randomUUID();
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        rid,
        { field: traceField.field, reason: traceField.reason },
      );
    }
    traceId =
      traceField.value !== null
        ? traceField.value
        : (headerRequestId ?? extendedTraceId ?? crypto.randomUUID());

    const searchReq = buildSearchRequest(rawJson, cfg, traceId);

    const provider = registry.resolve(cfg);
    if (provider === null) {
      throw new SearchProviderNotConfiguredError(traceId);
    }

    const signal = AbortSignal.timeout(cfg.timeouts.requestMs);
    const out = await provider.search(searchReq, signal);
    const body = { ...out, traceId };
    return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    const fallback = headerRequestId ?? extendedTraceId ?? crypto.randomUUID();
    return toHttpResponse(err, traceId ?? fallback, { unknownInternal: "extract" });
  }
}
