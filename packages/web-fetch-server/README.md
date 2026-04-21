# @tachu/web-fetch-server

## 1. 简介与定位（Overview）

Tachu Web Fetch & Search **远端渲染服务**：为 `@tachu/extensions` 的 `web-fetch` / `web-search` 工具提供 HTTP API，将网页转为 AI 友好的 Markdown（Bun.serve + Playwright + Mozilla Readability + Turndown）。

- **本包 `private: true`，不发布 npm**；通过本仓库、`bunx git+...` 或 Docker 部署。
- 协议、类型、配置与错误码以 ADR 为准（见下文「相关契约」）。

## 2. 安装（Install）

在**仓库根目录**（monorepo）执行依赖安装，并为本机安装 Chromium（首次必须）：

```bash
bun install
bun run dev:server:install-browser
```

等价于对子包执行 `bun run --filter '@tachu/web-fetch-server' install:browser`（内部为 `playwright install chromium --with-deps`）。

## 3. 启动（Run）

### 开发（热重载）

在仓库根目录：

```bash
bun run dev:server
```

或在 `packages/web-fetch-server` 目录：

```bash
bun run dev
```

### 生产（无 watch）

```bash
NODE_ENV=production bun run --filter '@tachu/web-fetch-server' start
```

未设置 `WEB_FETCH_TOKEN` 时，服务**仅允许**绑定 `127.0.0.1`；对外监听前必须配置 token（见环境变量表）。

## 4. 环境变量全表（Environment）

下列变量与 [ADR-0003c](../../docs/adr/decisions/0003c-web-fetch-config.md) 一致；默认值与校验范围以 ADR 为准。

### 4.1 服务基础

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_FETCH_HOST` | string | `127.0.0.1` | 监听地址。未设 `WEB_FETCH_TOKEN` 时，非 `127.0.0.1` 将启动失败 |
| `WEB_FETCH_PORT` | number | `8787` | 监听端口 |
| `WEB_FETCH_TOKEN` | string | *(空)* | Bearer token；空 = 未启用鉴权 = 强制绑定 `127.0.0.1` |
| `NODE_ENV` | string | `development` | `production` 时启用更严格启动期检查 |

### 4.2 超时与限制

| 变量 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `WEB_FETCH_REQUEST_TIMEOUT_MS` | number | `60000` | 5000..180000 | 单请求硬超时 |
| `WEB_FETCH_DEFAULT_WAIT_TIMEOUT_MS` | number | `15000` | 1000..60000 | 默认 waitFor 超时 |
| `WEB_FETCH_MAX_BODY_BYTES` | number | `10485760` | 524288..104857600 | 目标站响应体上限（字节） |
| `WEB_FETCH_MAX_REQUEST_BYTES` | number | `1048576` | 65536..5242880 | 入站 body 上限（字节） |
| `WEB_FETCH_DEFAULT_MAX_BODY_CHARS` | number | `32768` | 1024..524288 | 默认 `maxBodyChars` |

### 4.3 并发与限流

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_FETCH_MAX_CONCURRENCY` | number | `4` | 同时渲染请求上限 |
| `WEB_FETCH_ACQUIRE_TIMEOUT_MS` | number | `30000` | 等待浏览器 context 超时 |
| `WEB_FETCH_RATE_LIMIT_RPM` | number | `60` | 单 IP 每分钟上限；`0` 禁用 |
| `WEB_FETCH_RATE_LIMIT_BURST` | number | `10` | 令牌桶 burst |

### 4.4 浏览器池

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_FETCH_BROWSER_ENABLED` | boolean | `true` | `false` 时仅 static，browser 请求返回 `INVALID_REQUEST` |
| `WEB_FETCH_BROWSER_IDLE_MS` | number | `30000` | Context 空闲回收时间 |
| `WEB_FETCH_BROWSER_RECYCLE_AFTER` | number | `500` | 渲染 N 次后回收 Browser |
| `WEB_FETCH_BROWSER_RECYCLE_INTERVAL_MS` | number | `1800000` | 定时回收间隔 |
| `WEB_FETCH_STEALTH` | boolean | `false` | 服务级 stealth 默认 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | string | *(空)* | Chromium 路径覆写（Docker 常见 `/usr/bin/chromium`） |
| `WEB_FETCH_UA_POOL` | string | *(空)* | 逗号分隔 UA 池 |

### 4.5 安全

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_FETCH_ALLOWED_DOMAINS` | string | *(空)* | 逗号分隔白名单；空 = 仅 SSRF 黑名单 |
| `WEB_FETCH_BLOCKED_DOMAINS` | string | *(空)* | 逗号分隔黑名单 |
| `WEB_FETCH_ALLOW_LOOPBACK` | boolean | `false` | 是否放行 localhost（生产须 `false`） |

### 4.6 缓存（可选）

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_FETCH_CACHE_TTL_MS` | number | `0` | `0` = 禁用 |
| `WEB_FETCH_CACHE_DIR` | string | `.cache/web-fetch` | 缓存目录 |
| `WEB_FETCH_CACHE_MAX_ENTRIES` | number | `1000` | LRU 条目上限 |
| `WEB_FETCH_CACHE_MAX_SIZE_MB` | number | `512` | 磁盘上限（MB） |

### 4.7 可观测性

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_FETCH_LOG_LEVEL` | string | `info` | `debug` / `info` / `warn` / `error` |
| `WEB_FETCH_LOG_FORMAT` | string | `jsonl` | `jsonl` / `pretty` |
| `WEB_FETCH_OTLP_ENDPOINT` | string | *(空)* | OTLP collector；空 = 配置层禁用 |
| `WEB_FETCH_OTLP_HEADERS` | string | *(空)* | `k1=v1,k2=v2` |
| `WEB_FETCH_SERVICE_NAME` | string | `tachu-web-fetch-server` | OTel service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string | *(空)* | 指标等 OTLP HTTP 端点（OpenTelemetry 约定） |
| `OTEL_EXPORTER_OTLP_HEADERS` | string | *(空)* | `k1=v1,k2=v2` |

### 4.8 搜索（占位，Stage 4）

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_SEARCH_PROVIDER` | string | `stub` | 当前仅 `stub`；后续扩展见 ADR |
| `WEB_SEARCH_PROVIDER_API_KEY` | string | *(空)* | 真实 provider API Key |
| `WEB_SEARCH_PROVIDER_ENDPOINT` | string | *(空)* | 自建 endpoint |
| `WEB_SEARCH_DEFAULT_MAX_RESULTS` | number | `10` | 默认返回条数 |

### 4.9 客户端工具（`@tachu/extensions`）

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TACHU_WEB_FETCH_ENDPOINT` | string | `http://127.0.0.1:8787` | 工具侧 Server 地址 |
| `TACHU_WEB_FETCH_TOKEN` | string | *(空)* | 与 `WEB_FETCH_TOKEN` 对齐 |
| `TACHU_WEB_FETCH_DEFAULT_TIMEOUT_MS` | number | `70000` | 客户端整体超时，须 ≥ 服务端请求超时 |

可复制同目录 [`.env.example`](./.env.example) 为 `.env` 后按需填写。

## 5. API 概览（HTTP）

| Endpoint | 方法 | 用途 |
| --- | --- | --- |
| `/healthz` | GET | 健康检查 + 浏览器池状态（免鉴权） |
| `/v1/extract` | POST | 抓取与正文抽取；`web-fetch` 主路径 |
| `/v1/search` | POST | 搜索 + 可选批量 extract；`web-search` 主路径（stub 行为见 ADR） |

详细 JSON schema、鉴权与大小限制见 [ADR-0003a](../../docs/adr/decisions/0003a-web-fetch-api-contract.md)。

## 6. Docker 部署（Docker Compose）

1. 在 `packages/web-fetch-server` 准备环境变量文件：  
   `cp .env.example .env`  
   至少填入 **`WEB_FETCH_TOKEN`**（容器内通常绑定 `0.0.0.0`，无 token 会因安全校验无法启动）。
2. 在**仓库根目录**构建并启动（与根脚本一致）：

```bash
bun run docker:server
```

或直接指定 compose 文件：

```bash
docker compose -f packages/web-fetch-server/docker-compose.yml up --build
```

健康检查：`GET http://localhost:8787/healthz`。

镜像构建与多阶段说明见同目录 `Dockerfile`（s3-i6）与 `docker-compose.yml`（s3-i7）。

## 7. Troubleshooting（常见问题）

1. **Chromium 未安装 / 启动浏览器失败**  
   执行 `bun run dev:server:install-browser`，或设置正确的 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。Docker 内使用带 Chromium 的基础镜像。

2. **`403 SSRF_BLOCKED` / 无法访问目标 URL**  
   目标落在私网、元数据地址或被 SSRF 规则拦截属预期。仅抓取公网 URL；必要时配置 `WEB_FETCH_ALLOWED_DOMAINS` / `WEB_FETCH_BLOCKED_DOMAINS`（格式见 ADR-0003c）。

3. **`401` / `403 FORBIDDEN`（鉴权）**  
   服务端设置 `WEB_FETCH_TOKEN` 后，请求须带 `Authorization: Bearer <token>`。`/healthz` 始终免鉴权。

4. **`429 RATE_LIMITED`**  
   单 IP 触发令牌桶。可降低并发、调整 `WEB_FETCH_RATE_LIMIT_RPM` / `WEB_FETCH_RATE_LIMIT_BURST`，或稍后重试。

5. **容器内健康检查失败或无法从宿主机访问**  
   确认 `ports` 映射、`WEB_FETCH_HOST` 与防火墙；健康探针应请求容器内可达的 `http://127.0.0.1:8787/healthz`（取决于 compose 网络配置）。

## 8. 错误码速查（Server HTTP）

摘自 [ADR-0003d](../../docs/adr/decisions/0003d-web-fetch-errors.md)；完整 `detail` 与处置见 ADR。

| code | HTTP | 摘要 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | JSON / schema / 参数不合法 |
| `INVALID_URL` | 400 | `url` 非合法 http(s) |
| `REQUEST_TOO_LARGE` | 413 | 入站 body 超限 |
| `UNAUTHORIZED` | 401 | 缺少或格式错误的 Authorization |
| `FORBIDDEN` | 403 | token 不匹配 |
| `SSRF_BLOCKED` | 403 | 私网 / 元数据 / localhost 等 |
| `DOMAIN_NOT_ALLOWED` | 403 | 域名不在白名单或被黑名单拒绝 |
| `REQUEST_TIMEOUT` | 408 | 处理超时 |
| `RESPONSE_TOO_LARGE` | 413 | 上游响应体过大 |
| `RENDER_FAILED` | 422 | 浏览器导航 / 渲染失败 |
| `RATE_LIMITED` | 429 | 限流 |
| `INTERNAL_ERROR` | 500 | 未分类服务端错误 |
| `UPSTREAM_ERROR` | 502 | 上游 5xx 等 |
| `BROWSER_POOL_EXHAUSTED` | 503 | 池耗尽且等待超时 |
| `BROWSER_CRASHED` | 503 | 浏览器进程异常（自愈中） |
| `PROVIDER_NOT_CONFIGURED` | 503 | `/v1/search` stub 或未配置 provider |
| `PROVIDER_UPSTREAM_ERROR` | 502 | 搜索 provider 非 2xx |
| `PROVIDER_TIMEOUT` | 504 | 搜索 provider 超时 |

## 9. 与 `web-fetch` / `web-search` 工具的关系

- **web-fetch**：客户端实现在 [`packages/extensions/src/tools/web-fetch/`](../extensions/src/tools/web-fetch/)，通过 `TACHU_WEB_FETCH_ENDPOINT` 等环境变量连接本服务，主调 `POST /v1/extract`。
- **web-search**：与 web-fetch **共用同一 Server 基址与 token**，主调 `POST /v1/search`；当前默认 provider 为 stub，行为以 [ADR-0003a §Endpoint 3](../../docs/adr/decisions/0003a-web-fetch-api-contract.md) 为准。

## 相关契约（Further reading）

- [ADR-0003](../../docs/adr/decisions/0003-web-fetch-server.md) — 主决策  
- [ADR-0003a](../../docs/adr/decisions/0003a-web-fetch-api-contract.md) — HTTP API  
- [ADR-0003b](../../docs/adr/decisions/0003b-web-fetch-types.md) — TypeScript 类型  
- [ADR-0003c](../../docs/adr/decisions/0003c-web-fetch-config.md) — 配置  
- [ADR-0003d](../../docs/adr/decisions/0003d-web-fetch-errors.md) — 错误码  
