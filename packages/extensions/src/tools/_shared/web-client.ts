/**
 * Web Fetch / Web Search 工具共享的 endpoint、鉴权与超时读取逻辑。
 *
 * @see docs/adr/decisions/0003c-web-fetch-config.md
 */

let warnedMissingEndpoint = false;

/**
 * 解析 Web Fetch Server 根 URL（去尾斜杠）。未设置 `TACHU_WEB_FETCH_ENDPOINT` 时回退 `http://127.0.0.1:8787` 并告警一次。
 */
export function getWebFetchEndpointBase(): string {
  const raw = process.env.TACHU_WEB_FETCH_ENDPOINT?.trim();
  if (!raw) {
    if (!warnedMissingEndpoint) {
      warnedMissingEndpoint = true;
      console.warn(
        "[@tachu/extensions] TACHU_WEB_FETCH_ENDPOINT is not set; using default http://127.0.0.1:8787",
      );
    }
    return "http://127.0.0.1:8787";
  }
  return raw.replace(/\/$/, "");
}

/**
 * 客户端整体超时：优先 `inputTimeoutMs`，否则 `TACHU_WEB_FETCH_TIMEOUT_MS`，默认 70000。
 */
export function readWebFetchClientTimeoutMs(inputTimeoutMs?: number): number {
  if (inputTimeoutMs != null) return inputTimeoutMs;
  const raw = process.env.TACHU_WEB_FETCH_TIMEOUT_MS?.trim();
  if (!raw) return 70000;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 70000;
}

/**
 * JSON POST 请求头：Content-Type + 可选 `Authorization: Bearer`（`TACHU_WEB_FETCH_TOKEN`）。
 */
export function buildWebFetchJsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  const token = process.env.TACHU_WEB_FETCH_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
