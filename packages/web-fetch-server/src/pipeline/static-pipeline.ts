/**
 * Static HTTP fetch pipeline: SSRF guard, Bun/global fetch, readability, output formats.
 * @see .cursor/web-fetch-workflow/contracts/s1-b4-server-pipeline-static.md
 */

import type { WebFetchServerConfig } from "../config/index.js";
import type { AssertSafeUrlOptions } from "../security/ssrf-guard.js";
import { assertSafeUrl } from "../security/ssrf-guard.js";
import { extractReadable } from "../extractors/readability.js";
import { htmlToMarkdown } from "../extractors/to-markdown.js";
import { extractStructured } from "../extractors/structured.js";
import type { StructuredData } from "../extractors/structured.js";
import type { ReadableArticle } from "../extractors/types.js";

/** POST /v1/extract request (0003b). Contract s1-b4 adds runtime handling for `json`. */
export interface ExtractRequest {
  url: string;
  renderMode?: "static" | "browser" | "auto";
  userAgent?: string | null;
  extraHeaders?: Record<string, string>;
  outputFormat?: "markdown" | "text" | "html" | "structured" | "json";
  includeLinks?: boolean;
  includeImages?: boolean;
  includeStructured?: boolean;
  maxBodyChars?: number;
  traceId?: string | null;
}

export interface LinkRef {
  text: string;
  href: string;
}

export interface ImageRef {
  alt: string;
  src: string;
  width?: number;
  height?: number;
}

/** POST /v1/extract success body (0003b). */
export interface ExtractResponse {
  url: string;
  finalUrl: string;
  status: number;
  renderedWith: "static" | "browser";
  renderedAtMs: number;
  title?: string;
  description?: string;
  siteName?: string;
  lang?: string;
  byline?: string;
  publishedTime?: string | null;
  body: string;
  wordCount: number;
  truncated: boolean;
  links?: LinkRef[];
  images?: ImageRef[];
  structured?: Record<string, unknown>;
  warnings: string[];
  traceId: string;
}

const DEFAULT_PUBLIC_UA =
  "Mozilla/5.0 (compatible; TachuWebFetch/0.1; +https://github.com/dangaogit/tachu)";

type ResolvedFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

function getFetchImpl(): ResolvedFetch {
  return globalThis.fetch.bind(globalThis) as ResolvedFetch;
}

function resolveUserAgent(req: ExtractRequest, cfg: WebFetchServerConfig): string {
  if (req.userAgent != null && req.userAgent !== "") {
    return req.userAgent;
  }
  const pool = cfg.browser.userAgents;
  if (pool.length > 0) {
    return pool[0]!;
  }
  return DEFAULT_PUBLIC_UA;
}

function isProbablyHtml(contentType: string | null, body: string): boolean {
  if (contentType !== null && /html/i.test(contentType)) {
    return true;
  }
  const head = body.trimStart().slice(0, 800).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
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

/**
 * Best-effort truncation at block boundaries (paragraphs, fenced code blocks).
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md §截断规则
 */
export function truncateAtBlockBoundary(
  body: string,
  maxChars: number,
): { text: string; truncated: boolean; originalLength: number } {
  const originalLength = body.length;
  if (body.length <= maxChars) {
    return { text: body, truncated: false, originalLength };
  }
  const suffix = `\n\n... [content truncated, original length: ${originalLength} chars]`;
  const budget = maxChars - suffix.length;
  if (budget < 32) {
    return { text: body.slice(0, maxChars - suffix.length) + suffix, truncated: true, originalLength };
  }
  let slice = body.slice(0, budget);
  const lastFenceClose = slice.lastIndexOf("\n```");
  if (lastFenceClose > budget * 0.65) {
    slice = slice.slice(0, lastFenceClose);
  } else {
    const lastTableRow = slice.lastIndexOf("\n|");
    if (lastTableRow > budget * 0.6) {
      slice = slice.slice(0, lastTableRow);
    } else {
      const lastPara = slice.lastIndexOf("\n\n");
      if (lastPara > budget * 0.45) {
        slice = slice.slice(0, lastPara);
      }
    }
  }
  return { text: slice + suffix, truncated: true, originalLength };
}

/**
 * Runs the static extract pipeline. Does not create an AbortSignal; uses the one provided.
 */
export async function runStaticPipeline(
  req: ExtractRequest,
  cfg: WebFetchServerConfig,
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

  const fetchFn = getFetchImpl();
  const ua = resolveUserAgent(req, cfg);
  const headers = new Headers();
  headers.set("User-Agent", ua);
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  if (req.extraHeaders) {
    for (const [k, v] of Object.entries(req.extraHeaders)) {
      if (v !== undefined) {
        headers.set(k, v);
      }
    }
  }

  const response = await fetchFn(req.url, { signal, headers });
  const buf = await response.arrayBuffer();
  if (buf.byteLength > cfg.limits.maxBodyBytes) {
    throw new Error(`RESPONSE_TOO_LARGE:${buf.byteLength}`);
  }

  const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const finalUrl = response.url;
  const status = response.status;
  const contentType = response.headers.get("content-type");

  const warnings: string[] = [];
  let readable: ReadableArticle | null = null;
  if (isProbablyHtml(contentType, bodyText)) {
    readable = extractReadable(bodyText, finalUrl);
    if (readable === null) {
      warnings.push("readability-failed");
      readable = rawBodyAsReadable(bodyText);
    }
  } else {
    readable = rawBodyAsReadable(bodyText);
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
    const htmlForStructured = isProbablyHtml(contentType, bodyText)
      ? bodyText
      : `<html><body><pre>${escapeForPre(bodyText)}</pre></body></html>`;
    const structured = extractStructured(htmlForStructured);
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
    const htmlForStructured = isProbablyHtml(contentType, bodyText)
      ? bodyText
      : `<html><body><pre>${escapeForPre(bodyText)}</pre></body></html>`;
    structuredOut = structuredToRecord(extractStructured(htmlForStructured));
  }

  const renderedAtMs = Math.round(performance.now() - t0);

  const out: ExtractResponse = {
    url: req.url,
    finalUrl,
    status,
    renderedWith: "static",
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
