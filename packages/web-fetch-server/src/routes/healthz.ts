import type { WebFetchServerConfig } from "../types/config.js";

import pkg from "../../package.json" with { type: "json" };

let browserAvailability: () => boolean = () => false;

/**
 * 由 Stage 2 浏览器池注入可用性探测；Stage 1 默认为 `false`。
 */
export function setBrowserAvailability(fn: () => boolean): void {
  browserAvailability = fn;
}

/**
 * `GET /healthz`：返回 JSON 健康体（免鉴权，由上层路由挂载）。
 *
 * @param _cfg 运行期配置快照；Stage 1 未读取字段，保留供后续与 `HealthResponse.search` 等对齐。
 * @see docs/adr/decisions/0003a-web-fetch-api-contract.md — GET /healthz
 * @see docs/adr/decisions/0003b-web-fetch-types.md — HealthResponse
 */
export function handleHealthz(_cfg: WebFetchServerConfig): Response {
  const body = {
    status: "ok" as const,
    version: pkg.version,
    uptimeSec: process.uptime(),
    browser: { available: browserAvailability() },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
