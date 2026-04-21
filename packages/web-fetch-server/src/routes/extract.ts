/**
 * POST /v1/extract 路由：`renderMode` 分派静态、浏览器与 auto（含自动升级）。
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §Endpoint 2
 * @see docs/adr/decisions/0003d-web-fetch-errors.md
 */

import type { WebFetchServerConfig } from "../config/index.js";
import type { BrowserPool } from "../browser/pool.js";
import { noopLogger, type Logger } from "../observability/logger.js";
import {
  ExtractTimeoutError,
  runBrowserPipeline,
  type BrowserPipelineExtractRequest,
  type CookieInit,
  type ResourceType,
  type ScrollStrategy,
  type WaitStrategy,
} from "../pipeline/browser-pipeline.js";
import {
  runStaticPipeline,
  type ExtractRequest as PipelineExtractRequest,
} from "../pipeline/static-pipeline.js";
import { internalDetailForExtract, toHttpResponse, WebFetchServerError } from "../errors/unifier.js";
import {
  DomainNotAllowedError,
  InvalidUrlError,
  SsrfBlockedError,
} from "../security/errors.js";

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json; charset=utf-8",
};

/** 请求体允许的顶层字段（其余字段静默丢弃）。 */
const ALLOWED_TOP_KEYS = new Set<string>([
  "url",
  "renderMode",
  "waitFor",
  "waitTimeoutMs",
  "scroll",
  "userAgent",
  "extraHeaders",
  "cookies",
  "blockResources",
  "stealth",
  "outputFormat",
  "includeLinks",
  "includeImages",
  "includeStructured",
  "maxBodyChars",
  "traceId",
]);

type ParseFailure = { kind: "invalid_request"; field: string; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripUnknownKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (ALLOWED_TOP_KEYS.has(key)) {
      out[key] = body[key];
    }
  }
  return out;
}

/** 供字段校验使用，避免 `traceId` 参与 URL 等校验顺序问题。 */
function stripTraceField(body: Record<string, unknown>): Record<string, unknown> {
  const { traceId: _t, ...rest } = body;
  return rest;
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

function parseTraceId(
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

function parseRenderMode(
  v: unknown,
): { ok: true; value: PipelineExtractRequest["renderMode"] } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (v === "static" || v === "browser" || v === "auto") {
    return { ok: true, value: v };
  }
  return { kind: "invalid_request", field: "renderMode", reason: 'must be "static", "browser", or "auto"' };
}

function parseUserAgent(
  v: unknown,
): { ok: true; value: string | null | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (v === null) {
    return { ok: true, value: null };
  }
  if (typeof v === "string") {
    return { ok: true, value: v };
  }
  return { kind: "invalid_request", field: "userAgent", reason: "must be string or null" };
}

function parseExtraHeaders(
  v: unknown,
): { ok: true; value: Record<string, string> | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(v)) {
    return { kind: "invalid_request", field: "extraHeaders", reason: "must be an object" };
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") {
      return {
        kind: "invalid_request",
        field: `extraHeaders.${k}`,
        reason: "values must be strings",
      };
    }
    out[k] = val;
  }
  return { ok: true, value: out };
}

function parseOutputFormat(
  v: unknown,
): { ok: true; value: PipelineExtractRequest["outputFormat"] } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (v === "markdown" || v === "text" || v === "html" || v === "structured" || v === "json") {
    return { ok: true, value: v };
  }
  return {
    kind: "invalid_request",
    field: "outputFormat",
    reason: 'must be "markdown", "text", "html", "structured", or "json"',
  };
}

function parseMaxBodyChars(v: unknown): { ok: true; value: number | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { kind: "invalid_request", field: "maxBodyChars", reason: "must be an integer" };
  }
  const min = 1024;
  const max = 524_288;
  if (v < min || v > max) {
    return {
      kind: "invalid_request",
      field: "maxBodyChars",
      reason: `must be between ${min} and ${max}`,
    };
  }
  return { ok: true, value: v };
}

function parseBooleanOpt(
  v: unknown,
  field: string,
): { ok: true; value: boolean | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof v === "boolean") {
    return { ok: true, value: v };
  }
  return { kind: "invalid_request", field, reason: "must be boolean" };
}

function parseWaitTimeoutMs(v: unknown): { ok: true; value: number | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { kind: "invalid_request", field: "waitTimeoutMs", reason: "must be a finite number" };
  }
  const n = Math.floor(Math.abs(v));
  if (n < 1 || n > 60_000) {
    return {
      kind: "invalid_request",
      field: "waitTimeoutMs",
      reason: "must be between 1 and 60000",
    };
  }
  return { ok: true, value: n };
}

function parseWaitFor(v: unknown): { ok: true; value: WaitStrategy | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (v === "load" || v === "domcontentloaded" || v === "networkidle") {
    return { ok: true, value: v };
  }
  if (isRecord(v) && typeof v.selector === "string") {
    return { ok: true, value: { selector: v.selector } };
  }
  if (isRecord(v) && typeof v.timeMs === "number" && Number.isFinite(v.timeMs)) {
    return { ok: true, value: { timeMs: Math.floor(v.timeMs) } };
  }
  return { kind: "invalid_request", field: "waitFor", reason: "invalid wait strategy" };
}

function parseScroll(v: unknown): { ok: true; value: ScrollStrategy | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (v === false || v === true) {
    return { ok: true, value: v };
  }
  if (
    isRecord(v) &&
    typeof v.steps === "number" &&
    Number.isFinite(v.steps) &&
    typeof v.delayMs === "number" &&
    Number.isFinite(v.delayMs)
  ) {
    return {
      ok: true,
      value: { steps: Math.floor(v.steps), delayMs: Math.floor(v.delayMs) },
    };
  }
  return { kind: "invalid_request", field: "scroll", reason: "invalid scroll strategy" };
}

const RESOURCE_TYPES = new Set<ResourceType>(["image", "font", "media", "stylesheet", "other"]);

function parseBlockResources(v: unknown): { ok: true; value: ResourceType[] | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(v)) {
    return { kind: "invalid_request", field: "blockResources", reason: "must be an array" };
  }
  const out: ResourceType[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== "string" || !RESOURCE_TYPES.has(item as ResourceType)) {
      return {
        kind: "invalid_request",
        field: `blockResources[${String(i)}]`,
        reason: "must be a known resource type",
      };
    }
    out.push(item as ResourceType);
  }
  return { ok: true, value: out };
}

function parseCookies(v: unknown): { ok: true; value: CookieInit[] | undefined } | ParseFailure {
  if (v === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(v)) {
    return { kind: "invalid_request", field: "cookies", reason: "must be an array" };
  }
  const out: CookieInit[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (!isRecord(item)) {
      return { kind: "invalid_request", field: `cookies[${String(i)}]`, reason: "must be an object" };
    }
    if (
      typeof item.name !== "string" ||
      typeof item.value !== "string" ||
      typeof item.domain !== "string"
    ) {
      return {
        kind: "invalid_request",
        field: `cookies[${String(i)}]`,
        reason: "name, value, domain must be strings",
      };
    }
    const c: CookieInit = {
      name: item.name,
      value: item.value,
      domain: item.domain,
    };
    if (typeof item.path === "string") {
      c.path = item.path;
    }
    if (typeof item.expires === "number" && Number.isFinite(item.expires)) {
      c.expires = item.expires;
    }
    if (typeof item.httpOnly === "boolean") {
      c.httpOnly = item.httpOnly;
    }
    if (typeof item.secure === "boolean") {
      c.secure = item.secure;
    }
    if (item.sameSite === "Strict" || item.sameSite === "Lax" || item.sameSite === "None") {
      c.sameSite = item.sameSite;
    }
    out.push(c);
  }
  return { ok: true, value: out };
}

function buildPipelineRequest(
  stripped: Record<string, unknown>,
):
  | { ok: true; req: BrowserPipelineExtractRequest }
  | { ok: false; failure: ParseFailure } {
  if (typeof stripped.url !== "string" || stripped.url.trim() === "") {
    return {
      ok: false,
      failure: { kind: "invalid_request", field: "url", reason: "required non-empty string" },
    };
  }

  const urlParsed = parseHttpUrl(stripped.url);
  if (urlParsed === null) {
    return {
      ok: false,
      failure: {
        kind: "invalid_request",
        field: "url",
        reason: "must be a valid http or https URL",
      },
    };
  }

  const renderMode = parseRenderMode(stripped.renderMode);
  if ("kind" in renderMode) {
    return { ok: false, failure: renderMode };
  }

  const userAgent = parseUserAgent(stripped.userAgent);
  if ("kind" in userAgent) {
    return { ok: false, failure: userAgent };
  }

  const extraHeaders = parseExtraHeaders(stripped.extraHeaders);
  if ("kind" in extraHeaders) {
    return { ok: false, failure: extraHeaders };
  }

  const outputFormat = parseOutputFormat(stripped.outputFormat);
  if ("kind" in outputFormat) {
    return { ok: false, failure: outputFormat };
  }

  const maxBodyChars = parseMaxBodyChars(stripped.maxBodyChars);
  if ("kind" in maxBodyChars) {
    return { ok: false, failure: maxBodyChars };
  }

  const includeLinks = parseBooleanOpt(stripped.includeLinks, "includeLinks");
  if ("kind" in includeLinks) {
    return { ok: false, failure: includeLinks };
  }

  const includeImages = parseBooleanOpt(stripped.includeImages, "includeImages");
  if ("kind" in includeImages) {
    return { ok: false, failure: includeImages };
  }

  const includeStructured = parseBooleanOpt(stripped.includeStructured, "includeStructured");
  if ("kind" in includeStructured) {
    return { ok: false, failure: includeStructured };
  }

  const waitTimeoutMs = parseWaitTimeoutMs(stripped.waitTimeoutMs);
  if ("kind" in waitTimeoutMs) {
    return { ok: false, failure: waitTimeoutMs };
  }

  const waitFor = parseWaitFor(stripped.waitFor);
  if ("kind" in waitFor) {
    return { ok: false, failure: waitFor };
  }

  const scroll = parseScroll(stripped.scroll);
  if ("kind" in scroll) {
    return { ok: false, failure: scroll };
  }

  const cookies = parseCookies(stripped.cookies);
  if ("kind" in cookies) {
    return { ok: false, failure: cookies };
  }

  const blockResources = parseBlockResources(stripped.blockResources);
  if ("kind" in blockResources) {
    return { ok: false, failure: blockResources };
  }

  const req: BrowserPipelineExtractRequest = { url: urlParsed.href };
  if (renderMode.value !== undefined) {
    req.renderMode = renderMode.value;
  }
  if (userAgent.value !== undefined) {
    req.userAgent = userAgent.value;
  }
  if (extraHeaders.value !== undefined) {
    req.extraHeaders = extraHeaders.value;
  }
  if (outputFormat.value !== undefined) {
    req.outputFormat = outputFormat.value;
  }
  if (maxBodyChars.value !== undefined) {
    req.maxBodyChars = maxBodyChars.value;
  }
  if (includeLinks.value !== undefined) {
    req.includeLinks = includeLinks.value;
  }
  if (includeImages.value !== undefined) {
    req.includeImages = includeImages.value;
  }
  if (includeStructured.value !== undefined) {
    req.includeStructured = includeStructured.value;
  }
  if (waitTimeoutMs.value !== undefined) {
    req.waitTimeoutMs = waitTimeoutMs.value;
  }
  if (waitFor.value !== undefined) {
    req.waitFor = waitFor.value;
  }
  if (scroll.value !== undefined) {
    req.scroll = scroll.value;
  }
  if (cookies.value !== undefined) {
    req.cookies = cookies.value;
  }
  if (blockResources.value !== undefined) {
    req.blockResources = blockResources.value;
  }

  return { ok: true, req };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

function getAutoUpgradeMinChars(cfg: WebFetchServerConfig): number {
  return cfg.browser.autoUpgradeMinChars;
}

function isBrowserPoolLike(v: unknown): v is BrowserPool {
  return (
    typeof v === "object" &&
    v !== null &&
    "isAvailable" in v &&
    typeof (v as BrowserPool).isAvailable === "function"
  );
}

function resolvePoolAndDeps(
  poolOrDeps?: BrowserPool | null | ExtractRouteDeps,
  maybeDeps?: ExtractRouteDeps,
): { pool: BrowserPool | null; deps: ExtractRouteDeps | undefined } {
  if (maybeDeps !== undefined) {
    return { pool: (poolOrDeps as BrowserPool | null | undefined) ?? null, deps: maybeDeps };
  }
  if (poolOrDeps === undefined) {
    return { pool: null, deps: undefined };
  }
  if (poolOrDeps === null) {
    return { pool: null, deps: undefined };
  }
  if (isBrowserPoolLike(poolOrDeps)) {
    return { pool: poolOrDeps, deps: undefined };
  }
  return { pool: null, deps: poolOrDeps as ExtractRouteDeps };
}

function throwPipelineError(
  err: unknown,
  effectiveReq: BrowserPipelineExtractRequest,
  traceId: string,
  extractTimeoutMs: number,
  cfg: WebFetchServerConfig,
): never {
  if (err instanceof ExtractTimeoutError) {
    throw err;
  }
  if (err instanceof SsrfBlockedError) {
    throw err;
  }
  if (err instanceof DomainNotAllowedError) {
    throw err;
  }
  if (err instanceof InvalidUrlError) {
    throw err;
  }
  if (isAbortError(err)) {
    throw new WebFetchServerError(
      "REQUEST_TIMEOUT",
      408,
      "Extract pipeline timed out",
      traceId,
      { timeoutMs: extractTimeoutMs, phase: "extract" },
    );
  }
  if (err instanceof Error && err.message.startsWith("RESPONSE_TOO_LARGE:")) {
    const actual = Number.parseInt(err.message.split(":")[1] ?? "0", 10);
    throw new WebFetchServerError(
      "RESPONSE_TOO_LARGE",
      413,
      "Upstream response body exceeds configured limit",
      traceId,
      { limit: cfg.limits.maxBodyBytes, actual },
    );
  }
  if (err instanceof TypeError) {
    const hostname = (() => {
      try {
        return new URL(effectiveReq.url).hostname;
      } catch {
        return "";
      }
    })();
    throw new WebFetchServerError(
      "UPSTREAM_ERROR",
      502,
      "Failed to fetch the target URL",
      traceId,
      { upstreamStatus: 0, hostname },
    );
  }
  throw new WebFetchServerError(
    "INTERNAL_ERROR",
    500,
    "Internal server error",
    traceId,
    internalDetailForExtract(err),
  );
}

/** 路由层可选依赖（主要用于测试注入 pipeline / logger）。 */
export interface ExtractRouteDeps {
  runStaticPipeline?: typeof import("../pipeline/static-pipeline.js").runStaticPipeline;
  runBrowserPipeline?: typeof runBrowserPipeline;
  /** Optional request-scoped logger; defaults to a no-op logger when omitted. */
  logger?: Logger;
}

/**
 * 处理 POST /v1/extract：按 `renderMode` 分派静态 / 浏览器 / auto。
 *
 * @param pool 浏览器池；`null` 表示未装配浏览器。
 * @param deps 可选依赖；未提供时使用模块默认 pipeline。
 */
export async function handleExtract(
  req: Request,
  cfg: WebFetchServerConfig,
  poolOrDeps?: BrowserPool | null | ExtractRouteDeps,
  maybeDeps?: ExtractRouteDeps,
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

    const stripped = stripUnknownKeys(rawJson);
    const traceField = parseTraceId(stripped.traceId);
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

    const built = buildPipelineRequest(stripTraceField(stripped));
    if (!built.ok) {
      const f = built.failure;
      if (f.field === "url" && f.reason.includes("http")) {
        throw new WebFetchServerError(
          "INVALID_URL",
          400,
          "URL must use http or https scheme",
          traceId,
          { url: typeof rawJson.url === "string" ? rawJson.url : "" },
        );
      }
      throw new WebFetchServerError(
        "INVALID_REQUEST",
        400,
        "Request validation failed",
        traceId,
        { field: f.field, reason: f.reason },
      );
    }

    const pipelineReq = built.req;
    const effectiveReq: BrowserPipelineExtractRequest = { ...pipelineReq, traceId };

    const { pool, deps } = resolvePoolAndDeps(poolOrDeps, maybeDeps);
    const extractTimeoutMs = cfg.timeouts.requestMs;
    const runStatic = deps?.runStaticPipeline ?? runStaticPipeline;
    const runBrowser = deps?.runBrowserPipeline ?? runBrowserPipeline;
    const log = (deps?.logger ?? noopLogger).child({
      traceId,
      url: effectiveReq.url,
    });

    const mode = effectiveReq.renderMode ?? "auto";
    const browserAvailable = pool !== null && pool.isAvailable();
    log.info("extract.dispatch", {
      mode,
      outputFormat: effectiveReq.outputFormat ?? "markdown",
      browserAvailable,
      includeLinks: effectiveReq.includeLinks !== false,
      includeImages: effectiveReq.includeImages === true,
    });

    if (mode === "browser") {
      if (!browserAvailable) {
        log.warn("extract.browser.unavailable", {
          reason: pool === null ? "pool-null" : "pool-not-launched",
        });
        throw new WebFetchServerError(
          "BROWSER_NOT_AVAILABLE",
          503,
          "Browser rendering is not available in this server build",
          traceId,
          {},
        );
      }
      try {
        const signal = AbortSignal.timeout(extractTimeoutMs);
        const t = performance.now();
        const result = await runBrowser(effectiveReq, cfg, pool!, signal);
        log.info("extract.done", {
          mode: "browser",
          renderedWith: result.renderedWith,
          status: result.status,
          wordCount: result.wordCount,
          truncated: result.truncated,
          warnings: result.warnings,
          durationMs: Math.round(performance.now() - t),
        });
        const out = { ...result, traceId };
        return new Response(JSON.stringify(out), { status: 200, headers: JSON_HEADERS });
      } catch (err) {
        log.error("extract.pipeline.failed", {
          mode: "browser",
          err: err instanceof Error ? err.message : String(err),
        });
        throwPipelineError(err, effectiveReq, traceId, extractTimeoutMs, cfg);
      }
    }

    if (mode === "static") {
      try {
        const signal = AbortSignal.timeout(extractTimeoutMs);
        const t = performance.now();
        const result = await runStatic(effectiveReq, cfg, signal);
        log.info("extract.done", {
          mode: "static",
          renderedWith: result.renderedWith,
          status: result.status,
          wordCount: result.wordCount,
          truncated: result.truncated,
          warnings: result.warnings,
          durationMs: Math.round(performance.now() - t),
        });
        const out = { ...result, traceId };
        return new Response(JSON.stringify(out), { status: 200, headers: JSON_HEADERS });
      } catch (err) {
        log.error("extract.pipeline.failed", {
          mode: "static",
          err: err instanceof Error ? err.message : String(err),
        });
        throwPipelineError(err, effectiveReq, traceId, extractTimeoutMs, cfg);
      }
    }

    try {
      const signal = AbortSignal.timeout(extractTimeoutMs);
      const tStatic = performance.now();
      const staticResult = await runStatic(effectiveReq, cfg, signal);
      const minChars = getAutoUpgradeMinChars(cfg);
      const shouldUpgrade =
        browserAvailable &&
        (staticResult.body.length < minChars ||
          staticResult.warnings.includes("readability-failed"));
      log.info("extract.auto.static-done", {
        status: staticResult.status,
        wordCount: staticResult.wordCount,
        bodyChars: staticResult.body.length,
        warnings: staticResult.warnings,
        minCharsThreshold: minChars,
        browserAvailable,
        shouldUpgrade,
        durationMs: Math.round(performance.now() - tStatic),
      });
      if (!shouldUpgrade) {
        const out = { ...staticResult, traceId };
        return new Response(JSON.stringify(out), { status: 200, headers: JSON_HEADERS });
      }
      log.info("extract.auto.upgrade", {
        reason: staticResult.warnings.includes("readability-failed")
          ? "readability-failed"
          : "body-below-threshold",
      });
      const browserSignal = AbortSignal.timeout(extractTimeoutMs);
      const tBrowser = performance.now();
      const browserResult = await runBrowser(effectiveReq, cfg, pool!, browserSignal);
      log.info("extract.done", {
        mode: "auto",
        renderedWith: browserResult.renderedWith,
        status: browserResult.status,
        wordCount: browserResult.wordCount,
        truncated: browserResult.truncated,
        warnings: browserResult.warnings,
        durationMs: Math.round(performance.now() - tBrowser),
      });
      const out = { ...browserResult, traceId };
      return new Response(JSON.stringify(out), { status: 200, headers: JSON_HEADERS });
    } catch (err) {
      log.error("extract.pipeline.failed", {
        mode: "auto",
        err: err instanceof Error ? err.message : String(err),
      });
      throwPipelineError(err, effectiveReq, traceId, extractTimeoutMs, cfg);
    }
  } catch (err) {
    const fallback = headerRequestId ?? extendedTraceId ?? crypto.randomUUID();
    return toHttpResponse(err, traceId ?? fallback, { unknownInternal: "extract" });
  }
}
