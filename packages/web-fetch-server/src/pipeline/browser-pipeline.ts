/**
 * Browser rendering pipeline: pooled Playwright context, navigation, optional scroll, then static extractors on DOM HTML.
 *
 * @see .cursor/web-fetch-workflow/contracts/s2-h4-server-pipeline-browser.md
 */

import type { BrowserContext, Page, Route } from "playwright-core";

import type { WebFetchServerConfig } from "../config/index.js";
import type { AssertSafeUrlOptions } from "../security/ssrf-guard.js";
import { assertSafeUrl } from "../security/ssrf-guard.js";
import { extractReadable } from "../extractors/readability.js";
import { htmlToMarkdown } from "../extractors/to-markdown.js";
import { extractStructured } from "../extractors/structured.js";
import type { StructuredData } from "../extractors/structured.js";
import type { ReadableArticle } from "../extractors/types.js";

import {
  truncateAtBlockBoundary,
  type ExtractRequest as StaticExtractRequest,
  type ExtractResponse,
} from "./static-pipeline.js";

const DEFAULT_PUBLIC_UA =
  "Mozilla/5.0 (compatible; TachuWebFetch/0.1; +https://github.com/dangaogit/tachu)";

/** @see docs/adr/decisions/0003b-web-fetch-types.md */
export type WaitStrategy =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | { selector: string }
  | { timeMs: number };

/** @see docs/adr/decisions/0003b-web-fetch-types.md */
export type ScrollStrategy = false | true | { steps: number; delayMs: number };

/** @see docs/adr/decisions/0003b-web-fetch-types.md */
export type ResourceType = "image" | "font" | "media" | "stylesheet" | "other";

/** @see docs/adr/decisions/0003b-web-fetch-types.md */
export interface CookieInit {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Extract request fields used by the browser pipeline (extends static extract with ADR browser controls).
 */
export type BrowserPipelineExtractRequest = StaticExtractRequest & {
  waitFor?: WaitStrategy;
  waitTimeoutMs?: number;
  scroll?: ScrollStrategy;
  cookies?: CookieInit[];
  blockResources?: ResourceType[];
};

/**
 * Thrown when Playwright navigation or wait strategy exceeds {@link BrowserPipelineExtractRequest.waitTimeoutMs}.
 * Aligns with contract `EXTRACT_TIMEOUT` (render phase).
 */
export class ExtractTimeoutError extends Error {
  override readonly name = "ExtractTimeoutError";
  readonly code = "EXTRACT_TIMEOUT" as const;
  readonly httpStatus = 408 as const;
  readonly detail: { timeoutMs: number; phase: "render" };

  constructor(timeoutMs: number, message = "Browser render timed out", options?: { cause?: unknown }) {
    super(message, options);
    this.detail = { timeoutMs, phase: "render" };
  }
}

/**
 * Minimal pool surface for tests to inject mocks without `mock.module`.
 */
export interface BrowserPipelinePool {
  acquire(signal?: AbortSignal): Promise<{
    context: BrowserContext;
    release(): Promise<void>;
  }>;
}

function resolveUserAgent(req: BrowserPipelineExtractRequest, cfg: WebFetchServerConfig): string {
  if (req.userAgent != null && req.userAgent !== "") {
    return req.userAgent;
  }
  const pool = cfg.browser.userAgents;
  if (pool.length > 0) {
    return pool[0]!;
  }
  return DEFAULT_PUBLIC_UA;
}

function resolveWaitTimeoutMs(req: BrowserPipelineExtractRequest, cfg: WebFetchServerConfig): number {
  const raw = req.waitTimeoutMs ?? cfg.timeouts.defaultWaitMs;
  return Math.min(60_000, Math.max(1, Math.floor(raw)));
}

function resolveBlockList(req: BrowserPipelineExtractRequest): ResourceType[] | null {
  if (req.blockResources === undefined) {
    return ["image", "font", "media"];
  }
  if (req.blockResources.length === 0) {
    return null;
  }
  return req.blockResources;
}

function resolveScroll(req: BrowserPipelineExtractRequest): { steps: number; delayMs: number } | null {
  const s = req.scroll;
  if (s === undefined || s === false) {
    return null;
  }
  if (s === true) {
    return { steps: 1, delayMs: 500 };
  }
  return { steps: s.steps, delayMs: s.delayMs };
}

function escapeForPre(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rawBodyAsReadable(body: string): ReadableArticle {
  return {
    title: "",
    contentHtml: `<pre>${escapeForPre(body)}</pre>`,
    textContent: body,
  };
}

function countWords(text: string): number {
  const t = text.trim();
  if (t === "") {
    return 0;
  }
  return t.split(/\s+/).length;
}

function structuredToRecord(data: StructuredData): Record<string, unknown> {
  const base: Record<string, unknown> = {
    jsonLd: data.jsonLd,
    openGraph: data.openGraph,
    twitter: data.twitter,
  };
  if (data.description !== undefined) {
    base.description = data.description;
  }
  return base;
}

function playwrightCookieFromInit(c: CookieInit, pageUrl: string): Parameters<BrowserContext["addCookies"]>[0][0] {
  const entry: Parameters<BrowserContext["addCookies"]>[0][0] = {
    name: c.name,
    value: c.value,
    url: pageUrl,
  };
  if (c.path !== undefined) {
    entry.path = c.path;
  }
  if (c.expires !== undefined) {
    entry.expires = c.expires;
  }
  if (c.httpOnly !== undefined) {
    entry.httpOnly = c.httpOnly;
  }
  if (c.secure !== undefined) {
    entry.secure = c.secure;
  }
  if (c.sameSite !== undefined) {
    entry.sameSite = c.sameSite;
  }
  return entry;
}

function shouldAbortForBlocklist(resourceType: string, blocked: ReadonlySet<ResourceType>): boolean {
  if (blocked.has("image") && resourceType === "image") {
    return true;
  }
  if (blocked.has("font") && resourceType === "font") {
    return true;
  }
  if (blocked.has("media") && resourceType === "media") {
    return true;
  }
  if (blocked.has("stylesheet") && resourceType === "stylesheet") {
    return true;
  }
  if (blocked.has("other") && resourceType === "other") {
    return true;
  }
  return false;
}

async function installResourceBlocking(page: Page, types: ResourceType[]): Promise<void> {
  const blocked = new Set(types);
  await page.route("**/*", (route: Route) => {
    const rt = route.request().resourceType();
    if (shouldAbortForBlocklist(rt, blocked)) {
      void route.abort();
      return;
    }
    void route.continue();
  });
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((r) => {
    setTimeout(r, ms);
  });
}

async function autoScroll(page: Page, steps: number, stepDelayMs: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await delayMs(stepDelayMs);
  }
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
}

function isPlaywrightTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

async function navigateWithWaitStrategy(
  page: Page,
  url: string,
  waitFor: WaitStrategy | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const strategy = waitFor ?? "networkidle";
  const gotoOpts = { timeout: timeoutMs, signal } as const;

  try {
    if (typeof strategy === "object" && "selector" in strategy) {
      await page.goto(url, { ...gotoOpts, waitUntil: "domcontentloaded" });
      await page.waitForSelector(strategy.selector, { state: "visible", timeout: timeoutMs });
      return;
    }
    if (typeof strategy === "object" && "timeMs" in strategy) {
      await page.goto(url, { ...gotoOpts, waitUntil: "load" });
      await delayMs(strategy.timeMs);
      return;
    }
    await page.goto(url, { ...gotoOpts, waitUntil: strategy });
  } catch (err) {
    if (isPlaywrightTimeout(err)) {
      throw new ExtractTimeoutError(timeoutMs, "Browser render timed out", { cause: err });
    }
    throw new ExtractTimeoutError(timeoutMs, "Browser render timed out", { cause: err });
  }
}

function buildExtractResponseFromHtml(params: {
  html: string;
  req: BrowserPipelineExtractRequest;
  cfg: WebFetchServerConfig;
  finalUrl: string;
  status: number;
  t0: number;
  traceId: string;
}): ExtractResponse {
  const { html, req, cfg, finalUrl, status, t0, traceId } = params;
  const warnings: string[] = [];

  let readable: ReadableArticle | null = extractReadable(html, finalUrl);
  if (readable === null) {
    warnings.push("readability-failed");
    readable = rawBodyAsReadable(html);
  }

  const includeLinks = req.includeLinks !== false;
  const includeImages = req.includeImages === true;
  const fmt = req.outputFormat ?? "markdown";

  let body: string;
  if (fmt === "markdown") {
    body = htmlToMarkdown(readable.contentHtml, { includeLinks, includeImages });
  } else if (fmt === "text") {
    body = readable.textContent;
  } else if (fmt === "html") {
    body = readable.contentHtml;
  } else if (fmt === "structured" || fmt === "json") {
    const structured = extractStructured(html);
    body =
      fmt === "structured"
        ? JSON.stringify(structuredToRecord(structured))
        : JSON.stringify(structuredToRecord(structured), null, 2);
  } else {
    body = htmlToMarkdown(readable.contentHtml, { includeLinks, includeImages });
  }

  const maxChars = req.maxBodyChars ?? cfg.limits.defaultMaxBodyChars;
  const { text: bodyFinal, truncated } = truncateAtBlockBoundary(body, maxChars);

  let structuredOut: Record<string, unknown> | undefined;
  if (req.includeStructured === true) {
    structuredOut = structuredToRecord(extractStructured(html));
  }

  const renderedAtMs = Math.round(performance.now() - t0);

  const out: ExtractResponse = {
    url: req.url,
    finalUrl,
    status,
    renderedWith: "browser",
    renderedAtMs,
    body: bodyFinal,
    wordCount: countWords(bodyFinal),
    truncated,
    warnings,
    traceId,
  };

  if (readable.title !== "") {
    out.title = readable.title;
  }
  if (readable.excerpt !== undefined) {
    out.description = readable.excerpt;
  }
  if (readable.lang !== undefined) {
    out.lang = readable.lang;
  }
  if (readable.byline !== undefined) {
    out.byline = readable.byline;
  }
  if (structuredOut !== undefined) {
    out.structured = structuredOut;
  }

  return out;
}

/**
 * Runs the browser extract pipeline: acquire context, navigate, optional scroll, then readability / turndown on rendered HTML.
 */
export async function runBrowserPipeline(
  req: BrowserPipelineExtractRequest,
  cfg: WebFetchServerConfig,
  pool: BrowserPipelinePool,
  signal: AbortSignal,
): Promise<ExtractResponse> {
  const t0 = performance.now();
  const traceId = req.traceId ?? crypto.randomUUID();

  const ssrfOpts: AssertSafeUrlOptions = {
    allowLocalhost: cfg.security.allowLoopback,
  };
  if (cfg.security.allowedDomains.size > 0) {
    ssrfOpts.allowedDomains = [...cfg.security.allowedDomains];
  }
  await assertSafeUrl(req.url, ssrfOpts);

  const waitTimeoutMs = resolveWaitTimeoutMs(req, cfg);
  const ua = resolveUserAgent(req, cfg);
  const headerBag: Record<string, string> = { "User-Agent": ua };
  if (req.extraHeaders) {
    for (const [k, v] of Object.entries(req.extraHeaders)) {
      if (v !== undefined) {
        headerBag[k] = v;
      }
    }
  }

  let lease: Awaited<ReturnType<BrowserPipelinePool["acquire"]>> | undefined;
  let page: Page | undefined;

  try {
    lease = await pool.acquire(signal);
    const { context } = lease;

    if (req.cookies !== undefined && req.cookies.length > 0) {
      await context.addCookies(req.cookies.map((c) => playwrightCookieFromInit(c, req.url)));
    }

    page = await context.newPage();
    await page.setExtraHTTPHeaders(headerBag);

    const blockList = resolveBlockList(req);
    if (blockList !== null) {
      await installResourceBlocking(page, blockList);
    }

    await navigateWithWaitStrategy(page, req.url, req.waitFor, waitTimeoutMs, signal);

    const scrollPlan = resolveScroll(req);
    if (scrollPlan !== null) {
      await autoScroll(page, scrollPlan.steps, scrollPlan.delayMs);
    }

    const html = await page.content();
    const htmlBytes = new TextEncoder().encode(html).byteLength;
    if (htmlBytes > cfg.limits.maxBodyBytes) {
      throw new Error(`RESPONSE_TOO_LARGE:${htmlBytes}`);
    }

    let finalUrl = req.url;
    try {
      if (typeof page.url === "function") {
        finalUrl = page.url();
      }
    } catch {
      finalUrl = req.url;
    }
    const status = 200;

    return buildExtractResponseFromHtml({
      html,
      req: { ...req, traceId },
      cfg,
      finalUrl,
      status,
      t0,
      traceId,
    });
  } finally {
    if (page !== undefined) {
      try {
        await page.close();
      } catch {
        /* page may already be closed */
      }
    }
    if (lease !== undefined) {
      await lease.release();
    }
  }
}
