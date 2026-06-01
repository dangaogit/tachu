/**
 * 搜索 provider 共享工具（限流、错误映射）。
 */

import { WebFetchServerError } from "../../errors/unifier.js";

/** 与 §Endpoint 3 一致：单请求结果上限 30。 */
export const MAX_WEB_SEARCH_RESULTS = 30;

export function clampSearchMaxResults(n: number | undefined, fallback: number): number {
  const base = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(Math.max(base, 1), MAX_WEB_SEARCH_RESULTS);
}

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: string }).name;
  return name === "AbortError";
}

export function assertOkJsonResponse(
  res: Response,
  provider: string,
  traceId: string,
): void {
  if (res.ok) {
    return;
  }
  throw new WebFetchServerError(
    "PROVIDER_UPSTREAM_ERROR",
    502,
    "Search provider returned an error",
    traceId,
    { provider, upstreamStatus: res.status },
  );
}

export async function readJsonBody(
  res: Response,
  provider: string,
  traceId: string,
): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new WebFetchServerError(
      "PROVIDER_UPSTREAM_ERROR",
      502,
      "Search provider returned invalid JSON",
      traceId,
      { provider, upstreamStatus: res.status, malformedJson: true },
    );
  }
}

export function rethrowSearchProviderError(
  err: unknown,
  provider: string,
  traceId: string,
  timeoutMs: number,
): never {
  if (isAbortError(err)) {
    throw new WebFetchServerError(
      "PROVIDER_TIMEOUT",
      504,
      "Search provider request timed out",
      traceId,
      { provider, timeoutMs },
    );
  }
  throw err;
}
