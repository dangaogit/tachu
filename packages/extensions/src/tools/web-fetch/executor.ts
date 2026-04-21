import {
  getMalformedResponseError,
  getNetworkError,
  getTimeoutError,
  mapServerErrorToClient,
} from "./errors";
import type { ErrorResponseBody, ExtractRequest, ExtractResponse, WebFetchToolInput, WebFetchToolOutput } from "./types";
import type { ToolExecutionContext } from "../shared";
import { assertNotAborted } from "../shared";

let warnedMissingEndpoint = false;

function getEndpointBase(): string {
  const raw = process.env.TACHU_WEB_FETCH_ENDPOINT?.trim();
  if (!raw) {
    if (!warnedMissingEndpoint) {
      warnedMissingEndpoint = true;
      console.warn(
        "[@tachu/extensions/web-fetch] TACHU_WEB_FETCH_ENDPOINT is not set; using default http://127.0.0.1:8787",
      );
    }
    return "http://127.0.0.1:8787";
  }
  return raw.replace(/\/$/, "");
}

function readClientTimeoutMs(input: WebFetchToolInput): number {
  if (input.timeoutMs != null) return input.timeoutMs;
  const raw = process.env.TACHU_WEB_FETCH_TIMEOUT_MS?.trim();
  if (!raw) return 70000;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 70000;
}

function toExtractRequest(input: WebFetchToolInput): ExtractRequest {
  const { timeoutMs: _timeoutMs, ...rest } = input;
  return {
    ...rest,
    traceId: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExtractResponse(value: unknown): value is ExtractResponse {
  if (!isRecord(value)) return false;
  const keys = [
    "url",
    "finalUrl",
    "status",
    "renderedWith",
    "renderedAtMs",
    "body",
    "wordCount",
    "truncated",
    "warnings",
    "traceId",
  ] as const;
  for (const k of keys) {
    if (!(k in value)) return false;
  }
  if (typeof value.url !== "string") return false;
  if (typeof value.finalUrl !== "string") return false;
  if (typeof value.status !== "number") return false;
  if (value.renderedWith !== "static" && value.renderedWith !== "browser") return false;
  if (typeof value.renderedAtMs !== "number") return false;
  if (typeof value.body !== "string") return false;
  if (typeof value.wordCount !== "number") return false;
  if (typeof value.truncated !== "boolean") return false;
  if (!Array.isArray(value.warnings)) return false;
  if (typeof value.traceId !== "string") return false;
  return true;
}

function toToolOutput(res: ExtractResponse): WebFetchToolOutput {
  const out: WebFetchToolOutput = {
    url: res.url,
    finalUrl: res.finalUrl,
    status: res.status,
    renderedWith: res.renderedWith,
    body: res.body,
    wordCount: res.wordCount,
    truncated: res.truncated,
    warnings: res.warnings,
  };
  if (res.title !== undefined) out.title = res.title;
  if (res.description !== undefined) out.description = res.description;
  if (res.siteName !== undefined) out.siteName = res.siteName;
  if (res.lang !== undefined) out.lang = res.lang;
  if (res.byline !== undefined) out.byline = res.byline;
  if (res.publishedTime !== undefined) out.publishedTime = res.publishedTime;
  if (res.links !== undefined) {
    out.links = res.links.map((l) => ({ text: l.text, href: l.href }));
  }
  if (res.images !== undefined) {
    out.images = res.images.map((im) => ({ alt: im.alt, src: im.src }));
  }
  if (res.structured !== undefined) out.structured = res.structured;
  return out;
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
 * 调用 Web Fetch Server `/v1/extract`，返回正文与元数据。
 *
 * @see docs/adr/decisions/0003c-web-fetch-config.md §5.1
 * @see docs/adr/decisions/0003d-web-fetch-errors.md §4
 */
export async function executeWebFetch(
  input: WebFetchToolInput,
  ctx: ToolExecutionContext,
): Promise<WebFetchToolOutput> {
  assertNotAborted(ctx.abortSignal);

  const endpoint = getEndpointBase();
  const url = `${endpoint}/v1/extract`;
  const timeoutMs = readClientTimeoutMs(input);
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.abortSignal]);

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  const token = process.env.TACHU_WEB_FETCH_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(toExtractRequest(input)),
      signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      if (ctx.abortSignal.aborted) {
        throw ctx.abortSignal.reason ?? e;
      }
      throw getTimeoutError(timeoutMs);
    }
    throw getNetworkError(endpoint, e);
  }

  if (!response.ok) {
    const text = await response.text();
    const parsed = tryParseErrorBody(text);
    throw mapServerErrorToClient(response.status, parsed, { endpoint });
  }

  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    throw getMalformedResponseError();
  }
  if (!isExtractResponse(parsedBody)) {
    throw getMalformedResponseError();
  }
  return toToolOutput(parsedBody);
}
