/**
 * HTTP 分发与装配：解析路径、鉴权、限流并委派路由处理器。
 * @see .cursor/web-fetch-workflow/contracts/s1-c3-server-main-entry.md
 */

import type { WebFetchServerConfig } from "./config/index.js";
import type { BrowserPool } from "./browser/pool.js";
import { createLogger, noopLogger, type Logger } from "./observability/logger.js";
import {
  ForbiddenError,
  RateLimitedError,
  UnauthorizedError,
} from "./security/errors.js";
import { createRateLimiter, type RateLimiter } from "./security/rate-limit.js";
import { verifyBearer } from "./security/auth.js";
import { handleHealthz } from "./routes/healthz.js";
import { toHttpResponse } from "./errors/unifier.js";
import { handleExtract, type ExtractRouteDeps } from "./routes/extract.js";
import { handleSearch } from "./routes/search.js";
import { SearchProviderRegistry } from "./search/provider.js";

/** 装配层可选依赖（主要用于测试注入 pipeline / logger）。 */
export interface CreateServerDeps {
  runStaticPipeline?: typeof import("./pipeline/static-pipeline.js").runStaticPipeline;
  runBrowserPipeline?: ExtractRouteDeps["runBrowserPipeline"];
  /**
   * Optional structured logger. When omitted the server constructs one from
   * `cfg.observability.logLevel`, writing JSONL to stdout. Tests can pass
   * {@link noopLogger} to silence output.
   */
  logger?: Logger;
}

function isBrowserPoolLike(v: unknown): v is BrowserPool {
  return (
    typeof v === "object" &&
    v !== null &&
    "isAvailable" in v &&
    typeof (v as BrowserPool).isAvailable === "function"
  );
}

function resolveCreateServerPoolAndDeps(
  poolOrOpts?: BrowserPool | null | CreateServerDeps,
  maybeOpts?: CreateServerDeps,
): { pool: BrowserPool | null; deps: CreateServerDeps | undefined } {
  if (maybeOpts !== undefined) {
    return { pool: (poolOrOpts as BrowserPool | null | undefined) ?? null, deps: maybeOpts };
  }
  if (poolOrOpts === undefined) {
    return { pool: null, deps: undefined };
  }
  if (poolOrOpts === null) {
    return { pool: null, deps: undefined };
  }
  if (isBrowserPoolLike(poolOrOpts)) {
    return { pool: poolOrOpts, deps: undefined };
  }
  return { pool: null, deps: poolOrOpts as CreateServerDeps };
}

export type WebFetchServerHandle = {
  fetch: (req: Request) => Promise<Response>;
  shutdown: () => Promise<void>;
};

function readRequestId(req: Request): string {
  const existing = req.headers.get("x-request-id");
  if (existing !== null && existing.trim() !== "") {
    return existing.trim();
  }
  return crypto.randomUUID();
}

function withRequestId(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  headers.set("x-request-id", requestId);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function errorPayload(
  code: string,
  message: string,
  requestId: string,
  detail?: Record<string, unknown>,
): Record<string, unknown> {
  const err: Record<string, unknown> = { code, message, requestId };
  if (detail !== undefined && Object.keys(detail).length > 0) {
    err.detail = detail;
  }
  return { error: err };
}

function jsonBodyResponse(
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return withRequestId(new Response(JSON.stringify(body), { status, headers }), requestId);
}

function clientKeyFromRequest(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf !== null && xf.trim() !== "") {
    const first = xf.split(",")[0];
    if (first !== undefined && first.trim() !== "") {
      return first.trim();
    }
  }
  return "127.0.0.1";
}

function createRateLimiterFromConfig(cfg: WebFetchServerConfig): RateLimiter | null {
  const rpm = cfg.concurrency.rateLimitRpm;
  if (rpm === 0) {
    return null;
  }
  const burst = cfg.concurrency.rateLimitBurst;
  return createRateLimiter({
    capacity: burst,
    refillPerSec: rpm / 60,
  });
}

/**
 * 构造可挂到 {@link Bun.serve} 的 fetch 处理器与关闭钩子。
 *
 * @param cfg — {@link loadConfig} 冻结后的配置
 * @param poolOrOpts — 可选 {@link BrowserPool}，或测试/装配依赖（仅含 `runStaticPipeline` / `runBrowserPipeline` 字段的对象）
 * @param maybeOpts — 当第一参数为 pool 时，可再传入 pipeline 依赖
 */
export function createServer(
  cfg: WebFetchServerConfig,
  poolOrOpts?: BrowserPool | null | CreateServerDeps,
  maybeOpts?: CreateServerDeps,
): WebFetchServerHandle {
  const { pool, deps } = resolveCreateServerPoolAndDeps(poolOrOpts, maybeOpts);
  const rateLimiter = createRateLimiterFromConfig(cfg);
  const searchRegistry = new SearchProviderRegistry();
  const rootLogger: Logger =
    deps?.logger ?? createLogger({ level: cfg.observability.logLevel });

  async function dispatch(req: Request): Promise<Response> {
    const requestId = readRequestId(req);
    const url = new URL(req.url);
    const pathname = url.pathname;
    const t0 = performance.now();
    const rlog = rootLogger.child({
      requestId,
      method: req.method,
      path: pathname,
    });
    rlog.info("http.request", {
      ua: req.headers.get("user-agent") ?? "",
      client: clientKeyFromRequest(req),
    });

    const emitDone = (res: Response): Response => {
      const durationMs = Math.round(performance.now() - t0);
      const level = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
      rlog[level]("http.response", {
        status: res.status,
        durationMs,
      });
      return res;
    };

    try {
      if (req.method === "OPTIONS") {
        return emitDone(
          jsonBodyResponse(
            403,
            errorPayload(
              "FORBIDDEN",
              "CORS preflight is not supported",
              requestId,
            ),
            requestId,
          ),
        );
      }

      if (req.method === "GET" && pathname === "/healthz") {
        return emitDone(withRequestId(handleHealthz(cfg), requestId));
      }

      if (req.method === "POST" && pathname === "/v1/extract") {
        verifyBearer(req, cfg.token);
        if (rateLimiter !== null) {
          rateLimiter.acquire(clientKeyFromRequest(req));
        }
        const rd: ExtractRouteDeps = { logger: rlog };
        if (deps?.runStaticPipeline !== undefined) {
          rd.runStaticPipeline = deps.runStaticPipeline;
        }
        if (deps?.runBrowserPipeline !== undefined) {
          rd.runBrowserPipeline = deps.runBrowserPipeline;
        }
        const res = await handleExtract(req, cfg, pool, rd);
        return emitDone(withRequestId(res, requestId));
      }

      if (req.method === "POST" && pathname === "/v1/search") {
        verifyBearer(req, cfg.token);
        if (rateLimiter !== null) {
          rateLimiter.acquire(clientKeyFromRequest(req));
        }
        const res = await handleSearch(req, cfg, searchRegistry);
        return emitDone(withRequestId(res, requestId));
      }

      return emitDone(
        jsonBodyResponse(
          404,
          errorPayload("NOT_FOUND", "Not Found", requestId),
          requestId,
        ),
      );
    } catch (err) {
      const isSecurity =
        err instanceof UnauthorizedError ||
        err instanceof ForbiddenError ||
        err instanceof RateLimitedError;
      if (isSecurity) {
        rlog.warn("http.security.rejected", {
          kind: err.constructor.name,
          msg: err instanceof Error ? err.message : String(err),
        });
      } else {
        rlog.error("http.unhandled", {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
      return emitDone(toHttpResponse(err, requestId, { unknownInternal: "dispatch" }));
    }
  }

  return {
    fetch: (req: Request) => dispatch(req),
    shutdown: async () => {
      await Promise.resolve();
    },
  };
}

if (import.meta.main) {
  await import("./main.js");
}
