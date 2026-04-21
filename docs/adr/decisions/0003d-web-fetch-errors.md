# ADR 0003d — Web Fetch Server 错误码契约

- Status: Proposed
- Date: 2026-04-20
- Parent: [ADR-0003](./0003-web-fetch-server.md)
- Applies to: `@tachu/web-fetch-server`, `@tachu/extensions`（`web-fetch` / `web-search` 工具客户端）

本文件**冻结**所有错误码、HTTP 状态映射、`detail` 字段 schema、`userMessage` 文案模板。subagent 实现错误处理时必须**严格按本表**映射。**新增错误码必须先更新本文档**。

## 1. 通用错误响应结构

所有错误响应（无论 endpoint、无论 HTTP status）均为：

```json
{
  "error": {
    "code": "SSRF_BLOCKED",
    "message": "URL points to a private network address",
    "detail": { "hostname": "127.0.0.1" },
    "requestId": "req_01HY..."
  }
}
```

- `code`: `WebFetchErrorCode` 联合类型成员（见 0003b §4）
- `message`: 面向开发者的英文短句，**不含 URL / token 等敏感值**
- `detail`: 可选，结构化上下文；**必须 JSON 可序列化**；敏感字段（authorization / cookies）禁止出现
- `requestId`: UUID 或 `req_<ulid>`；贯穿整条请求的日志链

## 2. 错误码全表

### 2.1 Server 端错误（HTTP 响应）

| code | HTTP | 何时抛出 | `detail` 字段 | 建议用户处置 |
|---|---|---|---|---|
| `INVALID_REQUEST` | 400 | JSON 解析失败 / Schema 校验失败 / 不支持的 `renderMode` 组合 | `{ field: string; reason: string }` | 修正请求体后重试 |
| `INVALID_URL` | 400 | `url` 不是合法 http/https URL | `{ url: string }` | 确认 URL 格式 |
| `REQUEST_TOO_LARGE` | 413 | 入站 body 超 `WEB_FETCH_MAX_REQUEST_BYTES` | `{ limit: number; actual: number }` | 减小请求体 |
| `UNAUTHORIZED` | 401 | 缺 Authorization header 或格式错 | `{}` | 检查 header |
| `FORBIDDEN` | 403 | token 不匹配 | `{}` | 检查 token |
| `SSRF_BLOCKED` | 403 | URL 或任一跳转落到私网 / 云元数据 / localhost | `{ hostname: string; reason: "private-ipv4" \| "private-ipv6" \| "localhost" \| "cloud-metadata" \| "redirect-chain"; chain?: string[] }` | 仅可访问公网 URL |
| `DOMAIN_NOT_ALLOWED` | 403 | URL 域名被 blocked 或不在 allowed 白名单 | `{ hostname: string; reason: "blocked" \| "not-in-allowlist" }` | 调整域名列表 |
| `REQUEST_TIMEOUT` | 408 | 请求处理超过 `WEB_FETCH_REQUEST_TIMEOUT_MS` 或 `waitTimeoutMs` | `{ timeoutMs: number; phase: "fetch" \| "render" \| "extract" }` | 增大超时 / 换 `waitFor` 策略 |
| `RESPONSE_TOO_LARGE` | 413 | 目标站响应体超 `WEB_FETCH_MAX_BODY_BYTES` | `{ limit: number }` | 换 URL / 降低 maxBodyChars |
| `RENDER_FAILED` | 422 | Playwright 导航失败（DNS / 证书 / 连接重置 / 目标页 crash） | `{ phase: "navigate" \| "wait" \| "scroll"; originalError: string }` | 重试或改 renderMode |
| `RATE_LIMITED` | 429 | 触发 IP 令牌桶 | `{ retryAfterMs: number; limitRpm: number }` | 退避重试 |
| `UPSTREAM_ERROR` | 502 | 目标站返回 5xx 且重试后仍失败 | `{ upstreamStatus: number; hostname: string }` | 稍后重试 |
| `BROWSER_POOL_EXHAUSTED` | 503 | 等待 context 超过 `WEB_FETCH_ACQUIRE_TIMEOUT_MS` | `{ inUse: number; maxConcurrency: number; waitedMs: number }` | 降低并发或扩容 |
| `BROWSER_CRASHED` | 503 | Browser 进程异常退出（自愈中） | `{ recoveryInFlight: boolean }` | 立即重试一般成功 |
| `INTERNAL_ERROR` | 500 | 未分类服务端异常 | `{ trace?: string }`（仅 dev 环境） | 查服务端日志 |

### 2.2 `/v1/search` 专用

| code | HTTP | 何时抛出 | `detail` | 处置 |
|---|---|---|---|---|
| `PROVIDER_NOT_CONFIGURED` | 503 | 当前 provider 为 `stub` 或无 API key | `{ provider: string; hint: string }` | 配置 `WEB_SEARCH_PROVIDER` 与 API key |
| `PROVIDER_UPSTREAM_ERROR` | 502 | 真实 provider 返回非 2xx | `{ provider: string; upstreamStatus: number }` | 稍后重试或切换 provider |
| `PROVIDER_TIMEOUT` | 504 | 调用 provider 超时 | `{ provider: string; timeoutMs: number }` | 增大超时或切换 provider |

### 2.3 Client 端错误（`@tachu/extensions` 内部抛出，不走 HTTP 响应）

这些错误由 `web-fetch` / `web-search` executor 在 tool 层抛出，供 LLM 在 `tool-use` 循环中自省或向用户解释。

| code | 触发条件 | `detail` | userMessage (zh-CN) |
|---|---|---|---|
| `WEB_FETCH_ENDPOINT_NOT_CONFIGURED` | 工具端访问不到 endpoint（环境无 `TACHU_WEB_FETCH_ENDPOINT` 且默认 127.0.0.1:8787 也连接失败） | `{ endpoint: string; originalError: string }` | 未能连接到 Web Fetch 服务。请先启动渲染服务（`bun run dev:server`），或通过 `TACHU_WEB_FETCH_ENDPOINT` 配置远端服务地址。 |
| `WEB_FETCH_SERVER_UNREACHABLE` | DNS 解析失败 / 连接重置（network error） | `{ endpoint: string; originalError: string }` | 渲染服务不可达。请检查网络或服务端状态。 |
| `TIMEOUT_WEB_FETCH` | client 端整体超时触发（默认 70s） | `{ timeoutMs: number }` | 网页抓取超时。请缩短 `maxBodyChars` 或更换 URL 后重试。 |
| `TIMEOUT_WEB_SEARCH` | client 端整体超时触发 | `{ timeoutMs: number }` | 搜索超时。请缩短查询词或减少 `fetchTopN` 后重试。 |

## 3. Server 端实现规则

### 3.1 错误抛出

所有内部错误**必须**通过 `WebFetchError` 类抛出（见 0003b §4）：

```ts
throw new WebFetchError(
  "SSRF_BLOCKED",
  "URL points to a private network address",
  403,
  { hostname: "127.0.0.1", reason: "localhost" },
);
```

### 3.2 统一捕获中间件

`server.ts` 必须在路由外层注册统一错误处理：

```ts
async function errorMiddleware(req: Request, next: () => Promise<Response>): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? generateRequestId();
  try {
    const response = await next();
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (err) {
    const body = translateError(err, requestId);
    return new Response(JSON.stringify(body), {
      status: body.error.code in HTTP_STATUS_MAP ? HTTP_STATUS_MAP[body.error.code] : 500,
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
    });
  }
}
```

### 3.3 敏感字段脱敏

在 `translateError` 中，`detail` 字段**必须**过滤以下 key：`authorization` / `cookie` / `set-cookie` / `api_key` / `token`（任何包含这些子串的 key 都视为敏感，值替换为 `"***"`）。

### 3.4 Internal Error 的 trace 字段

- `NODE_ENV=production`：`detail.trace` **禁止输出**
- `NODE_ENV=development`：可输出 stack trace 前 10 行
- 任何环境下错误完整信息都**必须**记入 server 端日志

## 4. Client 端实现规则

### 4.1 HTTP 响应解析

```ts
if (!response.ok) {
  const text = await response.text();
  let errorBody: ErrorResponseBody | null = null;
  try {
    errorBody = JSON.parse(text) as ErrorResponseBody;
  } catch {
    // 非 JSON 响应（proxy / LB 返回的 HTML 错误页）
  }
  throw mapServerError(response.status, errorBody, { endpoint });
}
```

### 4.2 错误映射函数

```ts
function mapServerError(
  httpStatus: number,
  body: ErrorResponseBody | null,
  ctx: { endpoint: string },
): Error {
  const code = body?.error.code ?? inferCodeFromStatus(httpStatus);
  const userMessage = USER_MESSAGE_ZH[code]?.(body?.error.detail);
  // 返回统一的 WebFetchToolError，携带 code / userMessage / detail
  return new WebFetchToolError(code, userMessage ?? DEFAULT_MSG, body?.error.detail);
}
```

### 4.3 `userMessage` 对齐

Client 端所有错误文案**必须**对齐 `@tachu/core` 的 `USER_MESSAGE_ZH` 风格：

- 中文
- 20-200 字
- 不含 code 字面量
- 一句描述现象 + 一句建议动作
- 不引用内部术语（"渲染服务"可以说，但不应出现 "Bun.serve" / "Playwright" / "Chromium"）

### 4.4 Tool 错误的语义

Tool 在 `tool-use` 循环内抛出的所有错误**不应**被循环外 catch（见 ADR-0002 决定 2 §"工具错误不逃逸"）。即：

- Client 抛 `WebFetchToolError` → `tool-use` 循环捕获 → 转为 `role: "tool"` 消息回灌 LLM → LLM 决定重试 / 换工具 / 向用户解释

Client 端**不要**做重试（重试职责在 LLM 层决定；避免 tool 层静默消耗预算）。

## 5. HTTP 状态与 code 的反向映射

用于客户端在响应 body 缺失或损坏时根据 HTTP status 推断 code：

```ts
const HTTP_STATUS_TO_CODE: Record<number, WebFetchErrorCode> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",                // 注意：SSRF_BLOCKED / DOMAIN_NOT_ALLOWED 同为 403，无 body 时降级为 FORBIDDEN
  404: "INVALID_REQUEST",          // 路径不存在；归为 invalid request
  408: "REQUEST_TIMEOUT",
  413: "REQUEST_TOO_LARGE",        // 可能也是 RESPONSE_TOO_LARGE，无 body 时无法区分
  422: "RENDER_FAILED",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "UPSTREAM_ERROR",
  503: "BROWSER_POOL_EXHAUSTED",
  504: "PROVIDER_TIMEOUT",
};
```

## 6. 可观测性钩子

每个错误必须触发一次**结构化日志**：

```jsonl
{"ts":"2026-04-20T09:00:00.000Z","level":"error","requestId":"req_01HY...","code":"SSRF_BLOCKED","httpStatus":403,"detail":{"hostname":"127.0.0.1"},"path":"/v1/extract","method":"POST","durationMs":3}
```

并（若启用 OTel）为当前 span 设置 `error=true` 与 `error.code=<code>` 属性。

## 7. 兼容性承诺

- **code 字面量是公共契约**：不得改名、不得复用已废弃值
- **HTTP status 可升级**（如 429 → 503），不可降级（更严的状态是兼容的，更宽松的不兼容）
- **`detail` 字段可添加**，不可重命名或删除已发布字段
- **新增 code** 算非破坏变更；但 client 侧的默认 `userMessage` 模板必须同步更新到 fallback

## 关联文档

- 父 ADR：[0003](./0003-web-fetch-server.md)
- HTTP API 契约：[0003a](./0003a-web-fetch-api-contract.md)
- TS 类型：[0003b](./0003b-web-fetch-types.md)
- 配置：[0003c](./0003c-web-fetch-config.md)
- `@tachu/core` 错误体系参考：`packages/core/src/errors/engine-error.ts`
