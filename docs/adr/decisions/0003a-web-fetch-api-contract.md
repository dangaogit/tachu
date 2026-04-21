# ADR 0003a — Web Fetch Server HTTP API 契约

- Status: Proposed
- Date: 2026-04-20
- Parent: [ADR-0003](./0003-web-fetch-server.md)
- Applies to: `@tachu/web-fetch-server`, `@tachu/extensions`（`web-fetch` / `web-search` 工具客户端）

本文件**冻结** server 对外 HTTP 协议。所有 subagent（无论是实现 server 路由、还是实现 tool executor）必须严格按本契约编码。**任何字段新增 / 重命名 / 语义调整都必须先更新本文档并通知主 agent 解冻**。

## 总览

| Endpoint | 方法 | 用途 | 状态 |
|---|---|---|---|
| `/healthz` | GET | 健康检查 + 浏览器池状态暴露 | P0 必做 |
| `/v1/extract` | POST | 渲染 URL + 正文识别 + Markdown，**`web-fetch` 工具主调用** | P0/P1 |
| `/v1/search` | POST | 搜索 + 可选批量 extract top-N，**`web-search` 工具主调用** | P3 |
| 其它任何路径 | * | 统一返回 `404 NOT_FOUND` | — |

**通用规则**：

- 所有请求 / 响应均为 `Content-Type: application/json; charset=utf-8`
- 所有响应包含 `x-request-id: <uuid>` 响应头，用于日志关联
- 所有字符串字段均为 UTF-8，二进制内容必须 base64 编码
- 时间字段均为 ISO 8601 字符串（UTC），毫秒级时长字段为 `number`
- 未知字段在请求侧被**忽略**（不抛错）；响应侧**严格按 schema**，不额外附加字段
- **无 CORS 支持**：所有 OPTIONS 预检统一返回 `403`

## 鉴权

### 机制

- 请求头：`Authorization: Bearer <token>`
- 服务端通过 `WEB_FETCH_TOKEN` 环境变量配置（见 0003c）
- 未配置 token 时，服务端**强制绑定 127.0.0.1**；尝试绑定到其它 interface 时启动期报错并退出
- `/healthz` **始终免鉴权**（供 Docker / K8s 健康检查使用）

### 错误响应

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid Authorization header",
    "requestId": "req_01HY..."
  }
}
```

- `401 UNAUTHORIZED`：缺失 header / Bearer 格式错误
- `403 FORBIDDEN`：token 不匹配

## Endpoint 1: `GET /healthz`

### 请求

无 body。无认证。

### 响应（200 OK）

```json
{
  "status": "ok",
  "version": "1.0.0-alpha.1",
  "uptimeMs": 123456,
  "browser": {
    "enabled": true,
    "inUse": 2,
    "idle": 2,
    "maxConcurrency": 4,
    "totalRendered": 1024,
    "lastRecycleAt": "2026-04-20T09:00:00.000Z"
  },
  "search": {
    "provider": "stub",
    "configured": false
  }
}
```

- `status`: `"ok"` | `"degraded"` | `"unhealthy"`
  - `degraded`：浏览器池耗尽或磁盘缓存 IO 异常，但仍能服务请求
  - `unhealthy`：浏览器进程崩溃且自愈失败；Kubernetes readiness probe 应将此节点下线
- `browser.enabled`: 若 Playwright 尚未初始化（懒加载模式）则为 `false`，所有数值字段为 `null`
- `search.provider`: 当前启用的 provider 名（`"stub"` / `"tavily"` / `"brave"` / `"serper"` / ...）
- `search.configured`: `provider !== "stub"` 即为 `true`

### 响应（503 UNHEALTHY）

```json
{
  "status": "unhealthy",
  "version": "1.0.0-alpha.1",
  "uptimeMs": 12345,
  "reason": "BROWSER_POOL_CRASH_UNRECOVERABLE"
}
```

## Endpoint 2: `POST /v1/extract`

`web-fetch` 工具主调用端点。**请求侧最大 body 1MB；响应侧最大 body 10MB**。

### 请求 schema

```jsonc
{
  // === 必填 ===
  "url": "https://example.com/article",

  // === 渲染控制 ===
  "renderMode": "auto",          // "static" | "browser" | "auto"；默认 "auto"
  "waitFor": "networkidle",      // browser 模式下的等待策略；见下方详解
  "waitTimeoutMs": 15000,        // 渲染等待超时；默认 15000；硬上限 60000
  "scroll": false,               // false | true | { steps: number; delayMs: number }
  "userAgent": null,             // 覆盖 UA；null 使用服务端 UA 池
  "extraHeaders": {},            // 额外 HTTP 头；静态模式直接传；浏览器模式作为 route header
  "cookies": [],                 // 注入 cookies；browser 模式生效
  "blockResources": [            // 资源拦截；仅 browser 模式生效
    "image", "font", "media"
  ],
  "stealth": null,               // null=继承服务级；true|false=请求级覆盖（Q3）

  // === 输出控制 ===
  "outputFormat": "markdown",    // "markdown" | "text" | "html" | "structured"
  "includeLinks": true,          // 输出中是否包含 links[]
  "includeImages": false,        // 输出中是否包含 images[]
  "includeStructured": false,    // 输出中是否包含 JSON-LD structured 字段
  "maxBodyChars": 32768,         // body 字符上限；默认 32768；硬上限 524288 (512KB)

  // === 追踪 ===
  "traceId": null                // 可选；未传则服务端生成
}
```

#### `renderMode` 语义

- `"static"`：只走 Bun.fetch，不触发浏览器
- `"browser"`：强制走 Playwright，即使 URL 是静态页
- `"auto"`（默认）：先走 static；若 `article.length < 200` 或 script 标签密度 > 80% 或响应是 5xx，自动升级到 browser 重试（仅重试 1 次）

#### `waitFor` 语义

仅 browser 模式生效：

- `"load"`：Playwright 的 `load` 事件
- `"domcontentloaded"`：DOM 解析完
- `"networkidle"`（默认）：500ms 内无 ≥ 2 个网络请求
- `{ "selector": ".article-body" }`：等待特定 CSS selector 可见
- `{ "timeMs": 2000 }`：固定等待时长（最差体验，仅用于实在没辙的站）

#### `scroll` 语义

仅 browser 模式生效，用于触发懒加载：

- `false`（默认）：不滚动
- `true`：滚动到底部 1 次（相当于 `{ steps: 1, delayMs: 500 }`）
- `{ steps: 10, delayMs: 300 }`：分 10 步滚动，每步间隔 300ms

#### `blockResources` 默认值

仅 browser 模式生效。**若字段未显式传入，默认拦截 `["image", "font", "media"]`**（提速优先）；显式传空数组 `[]` 表示不拦截。合法值：`"image"` / `"font"` / `"media"` / `"stylesheet"` / `"other"`。

### 响应 schema（200 OK）

```jsonc
{
  "url": "https://example.com/article",
  "finalUrl": "https://example.com/article?utm=",    // 跟随重定向后的最终 URL
  "status": 200,                                     // HTTP 状态码
  "renderedWith": "static",                          // "static" | "browser"
  "renderedAtMs": 234,                               // 渲染耗时

  // === 正文 ===
  "title": "Example Article",
  "description": "The meta description of this page",
  "siteName": "Example",
  "lang": "en",
  "byline": "John Doe",
  "publishedTime": "2026-04-20T00:00:00.000Z",       // ISO 8601；提取失败为 null
  "body": "# Example Article\n\n...",                // 按 outputFormat 的主体内容
  "wordCount": 1234,
  "truncated": false,                                // body 是否因 maxBodyChars 被截断

  // === 可选结构化字段 ===
  "links": [                                          // 仅 includeLinks=true 时返回
    { "text": "Read more", "href": "https://example.com/next" }
  ],
  "images": [                                         // 仅 includeImages=true 时返回
    { "alt": "Hero image", "src": "https://...", "width": 1200, "height": 630 }
  ],
  "structured": {                                     // 仅 includeStructured=true 时返回
    "@type": "Article",
    "@context": "https://schema.org",
    "author": { "@type": "Person", "name": "John Doe" }
  },

  // === 追踪 ===
  "warnings": [],                                     // 非致命告警，如 "readability-failed"
  "traceId": "req_01HY..."
}
```

#### `outputFormat` 对应的 `body` 内容

- `"markdown"`（默认）：GFM 风格 Markdown，含 heading / list / code block / table / link
- `"text"`：纯文本（去 Markdown 标记），保留段落分隔
- `"html"`：Readability 清洗后的 HTML 片段（未经 Turndown）
- `"structured"`：JSON-LD 结构化数据（等价于 `includeStructured=true` 且返回时将 `structured` 内容合并到 body 字段为字符串化 JSON）

#### 截断规则

- `maxBodyChars` 是**字符数上限**（不是字节）
- 超长时在**块边界**截断（代码块不切一半、表格行不切一半）
- 截断时 `body` 末尾追加：`\n\n... [content truncated, original length: N chars]`
- `truncated: true`

### 错误响应

所有错误响应遵循统一结构：

```jsonc
{
  "error": {
    "code": "SSRF_BLOCKED",
    "message": "URL points to a private network address",
    "detail": { "hostname": "127.0.0.1" },
    "requestId": "req_01HY..."
  }
}
```

| HTTP Status | code | 含义 |
|---|---|---|
| 400 | `INVALID_REQUEST` | JSON 解析失败 / schema 校验失败 |
| 400 | `INVALID_URL` | `url` 字段不是合法 http/https URL |
| 401 | `UNAUTHORIZED` | 缺失 / 格式错 Authorization header |
| 403 | `FORBIDDEN` | token 不匹配 |
| 403 | `SSRF_BLOCKED` | URL 指向私网 / 云元数据 / 黑名单域名 |
| 403 | `DOMAIN_NOT_ALLOWED` | URL 域名不在白名单 |
| 408 | `REQUEST_TIMEOUT` | 渲染超过 `waitTimeoutMs` 或硬超时 |
| 413 | `RESPONSE_TOO_LARGE` | 目标站响应体超 10MB 硬上限 |
| 422 | `RENDER_FAILED` | Playwright 导航失败（DNS / 连接重置 / 证书错等） |
| 429 | `RATE_LIMITED` | 触发 IP 令牌桶限流 |
| 500 | `INTERNAL_ERROR` | 未分类服务端错误 |
| 502 | `UPSTREAM_ERROR` | 目标站 5xx / 目标站主动断连 |
| 503 | `BROWSER_POOL_EXHAUSTED` | 浏览器池用尽且超过等待阈值 |
| 503 | `BROWSER_CRASHED` | Browser 进程崩溃（自愈中） |

**错误码完整语义见** [0003d](./0003d-web-fetch-errors.md)。

## Endpoint 3: `POST /v1/search`

`web-search` 工具主调用端点。**默认 provider 为 stub**，所有请求返回 `503 PROVIDER_NOT_CONFIGURED`（除非运维显式配置真实 provider）。

### 请求 schema

```jsonc
{
  // === 必填 ===
  "query": "bun runtime vs nodejs",

  // === 搜索控制 ===
  "maxResults": 10,              // 返回结果数；默认 10；上限 30
  "language": null,              // 搜索语言；null 由 provider 决定
  "region": null,                // 地区偏好；null 由 provider 决定
  "timeRange": null,             // "day" | "week" | "month" | "year" | null
  "safeSearch": "moderate",      // "off" | "moderate" | "strict"
  "includeDomains": [],          // 仅搜这些域名；优先级高于黑名单
  "excludeDomains": [],          // 排除这些域名

  // === 批量渲染（关键特性）===
  "fetchTopN": 0,                // 渲染前 N 条结果为 Markdown；0 不渲染；上限 5
  "fetchOptions": {              // 若 fetchTopN > 0，透传给 /v1/extract（见上方 schema）
    "renderMode": "auto",
    "maxBodyChars": 8192
  },

  // === 追踪 ===
  "traceId": null
}
```

### 响应 schema（200 OK）

```jsonc
{
  "query": "bun runtime vs nodejs",
  "provider": "stub",                        // 实际使用的 provider
  "results": [
    {
      "title": "Bun vs Node.js — a comprehensive comparison",
      "url": "https://example.com/bun-vs-node",
      "snippet": "Bun is a fast all-in-one JavaScript runtime...",
      "publishedAt": "2026-04-01T00:00:00.000Z",
      "score": 0.95,
      // 若 fetchTopN > 0 且本结果在 top N，则包含完整 extract 结果
      "extract": {
        "status": 200,
        "renderedWith": "static",
        "title": "Bun vs Node.js...",
        "body": "# Bun vs Node.js\n\n...",
        "wordCount": 1234,
        "truncated": false
      }
    }
  ],
  "totalResults": 1024,                       // provider 估算总数；stub 返回 0
  "searchedAtMs": 456,
  "warnings": [],                             // 如 "fetch-failed-for-result-3"
  "traceId": "req_01HY..."
}
```

### 错误响应

在通用错误码基础上，`/v1/search` 特有错误：

| HTTP Status | code | 含义 |
|---|---|---|
| 400 | `INVALID_REQUEST` | query 为空 / 格式非法 |
| 503 | `PROVIDER_NOT_CONFIGURED` | 当前 provider 为 stub 或初始化失败 |
| 502 | `PROVIDER_UPSTREAM_ERROR` | 真实 provider 返回非 2xx |
| 504 | `PROVIDER_TIMEOUT` | 调用 provider 超时 |

## 请求/响应大小约束

| 位置 | 上限 | 越限行为 |
|---|---|---|
| 请求 body | 1 MB | 413 `REQUEST_TOO_LARGE` |
| 目标站响应体读取 | 10 MB | 413 `RESPONSE_TOO_LARGE` |
| `body` 字段字符数 | `maxBodyChars`（默认 32KB，上限 512KB） | 按块边界截断，`truncated: true` |
| `links` / `images` 条数 | 各自上限 1000 | 超出部分丢弃，`warnings` 添加 `too-many-links` |

## 版本化策略

- 路径版本前缀 `/v1/...`：**不兼容变更**必须升 `/v2/...`，旧版保留至少 1 个 minor
- 字段**新增**不算不兼容（客户端必须忽略未知字段）
- 字段**删除 / 重命名 / 语义变更**算不兼容
- 响应头 `x-api-version: v1` 明示当前版本

## Content Negotiation（保留）

当前版本仅支持 `application/json`。保留以下扩展位：

- `Accept: text/markdown`（未来版本返回 body 纯 Markdown，无 JSON 包裹）
- `Accept: text/event-stream`（未来版本支持流式渲染，按阶段推送进度）

当前版本对上述 Accept 一律返回 `406 NOT_ACCEPTABLE`。

## 关联文档

- 父 ADR：[0003](./0003-web-fetch-server.md)
- TS 类型定义：[0003b](./0003b-web-fetch-types.md)
- 配置：[0003c](./0003c-web-fetch-config.md)
- 错误码：[0003d](./0003d-web-fetch-errors.md)
