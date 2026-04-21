import {
  buildWebFetchJsonHeaders,
  getWebFetchEndpointBase,
  readWebFetchClientTimeoutMs,
} from "../_shared/web-client";
import { assertNotAborted } from "../shared";
import type { ToolExecutionContext } from "../shared";
import { getMalformedResponseError, getNetworkError } from "../web-fetch/errors";
import type { ErrorResponseBody } from "../web-fetch/types";
import {
  asWebSearchClientError,
  getSearchTimeoutError,
  mapSearchServerErrorToClient,
} from "./errors";
import type { SearchRequest, SearchResponse, WebSearchToolInput, WebSearchToolOutput } from "./types";

function toSearchRequest(input: WebSearchToolInput): SearchRequest {
  const { timeoutMs: _timeoutMs, ...rest } = input;
  return {
    ...rest,
    traceId: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchResultExtract(
  value: unknown,
): value is NonNullable<WebSearchToolOutput["results"][number]["extract"]> {
  if (!isRecord(value)) return false;
  if (typeof value.status !== "number") return false;
  if (value.renderedWith !== "static" && value.renderedWith !== "browser") return false;
  if (typeof value.body !== "string") return false;
  if (typeof value.wordCount !== "number") return false;
  if (typeof value.truncated !== "boolean") return false;
  if (!Array.isArray(value.warnings)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  return true;
}

function isSearchResultItem(value: unknown): value is WebSearchToolOutput["results"][number] {
  if (!isRecord(value)) return false;
  if (typeof value.title !== "string") return false;
  if (typeof value.url !== "string") return false;
  if (typeof value.snippet !== "string") return false;
  if (value.publishedAt !== undefined && value.publishedAt !== null && typeof value.publishedAt !== "string") {
    return false;
  }
  if (value.score !== undefined && value.score !== null && typeof value.score !== "number") {
    return false;
  }
  if (value.extract !== undefined && !isSearchResultExtract(value.extract)) return false;
  return true;
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (!isRecord(value)) return false;
  if (typeof value.query !== "string") return false;
  if (typeof value.provider !== "string") return false;
  if (!Array.isArray(value.results)) return false;
  for (const item of value.results) {
    if (!isSearchResultItem(item)) return false;
  }
  if (typeof value.totalResults !== "number") return false;
  if (typeof value.searchedAtMs !== "number") return false;
  if (!Array.isArray(value.warnings)) return false;
  if (typeof value.traceId !== "string") return false;
  return true;
}

function toToolOutput(res: SearchResponse): WebSearchToolOutput {
  return {
    query: res.query,
    provider: res.provider,
    results: res.results.map((r) => {
      const row: WebSearchToolOutput["results"][number] = {
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      };
      if (r.publishedAt !== undefined) row.publishedAt = r.publishedAt;
      if (r.score !== undefined) row.score = r.score;
      if (r.extract !== undefined) {
        row.extract = {
          status: r.extract.status,
          renderedWith: r.extract.renderedWith,
          body: r.extract.body,
          wordCount: r.extract.wordCount,
          truncated: r.extract.truncated,
          warnings: r.extract.warnings,
        };
        if (r.extract.title !== undefined) row.extract.title = r.extract.title;
      }
      return row;
    }),
    totalResults: res.totalResults,
    warnings: res.warnings,
  };
}

function tryParseErrorBody(text: string): ErrorResponseBody | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const err = parsed.error;
    if (!isRecord(err)) return null;
    if (typeof err.code !== "string") return null;
    if (typeof err.message !== "string") return null;
    if (typeof err.requestId !== "string") return null;
    const body: ErrorResponseBody = {
      error: {
        code: err.code as ErrorResponseBody["error"]["code"],
        message: err.message,
        requestId: err.requestId,
        ...(isRecord(err.detail) ? { detail: err.detail as Record<string, unknown> } : {}),
      },
    };
    return body;
  } catch {
    return null;
  }
}

/**
 * 调用 Web Fetch Server `POST /v1/search`。
 *
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §Endpoint 3
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §2.2
 */
export async function executeWebSearch(
  input: WebSearchToolInput,
  ctx: ToolExecutionContext,
): Promise<WebSearchToolOutput> {
  assertNotAborted(ctx.abortSignal);

  const endpoint = getWebFetchEndpointBase();
  const url = `${endpoint}/v1/search`;
  const timeoutMs = readWebFetchClientTimeoutMs(input.timeoutMs);
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.abortSignal]);

  const headers = buildWebFetchJsonHeaders();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(toSearchRequest(input)),
      signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      if (ctx.abortSignal.aborted) {
        throw ctx.abortSignal.reason ?? e;
      }
      throw getSearchTimeoutError(timeoutMs);
    }
    throw asWebSearchClientError(getNetworkError(endpoint, e));
  }

  if (!response.ok) {
    const text = await response.text();
    const parsed = tryParseErrorBody(text);
    throw mapSearchServerErrorToClient(response.status, parsed, { endpoint });
  }

  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    throw asWebSearchClientError(getMalformedResponseError());
  }
  if (!isSearchResponse(parsedBody)) {
    throw asWebSearchClientError(getMalformedResponseError());
  }
  return toToolOutput(parsedBody);
}
