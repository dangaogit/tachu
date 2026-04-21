# ADR 0003c — Web Fetch Server 配置契约

- Status: Proposed
- Date: 2026-04-20
- Parent: [ADR-0003](./0003-web-fetch-server.md)
- Applies to: `@tachu/web-fetch-server`, `@tachu/extensions`（`web-fetch` / `web-search` 工具客户端）

本文件**冻结**所有环境变量、配置默认值与优先级。subagent 实现 `config.ts` 时必须**严格按本清单**加载、校验、暴露默认值。**新增 / 删除 / 重命名环境变量都必须先更新本文档**。

## 1. 配置优先级

1. **CLI flag**（预留位，**Stage 1 暂不实现**）
2. **环境变量**（主通道）
3. **配置文件** `tachu-web-fetch-server.config.ts` / `.json`（预留位，**Stage 1 暂不实现**）
4. **默认值**（代码常量）

Stage 1-4 只实现环境变量通道；其他通道在附加 ADR 决策后补充。

## 2. Server 端环境变量（完整清单）

### 2.1 服务基础

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_FETCH_HOST` | string | `127.0.0.1` | 监听地址。**未设 `WEB_FETCH_TOKEN` 时，任何非 `127.0.0.1` 值启动期报错拒绝绑定** |
| `WEB_FETCH_PORT` | number | `8787` | 监听端口 |
| `WEB_FETCH_TOKEN` | string | *(空)* | Bearer token。空 = 未启用鉴权 = **强制绑定 127.0.0.1** |
| `NODE_ENV` | string | `development` | `production` 时启用更严格的启动期检查 |

### 2.2 超时与限制

| 变量 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `WEB_FETCH_REQUEST_TIMEOUT_MS` | number | `60000` | 5000..180000 | 单请求硬超时 |
| `WEB_FETCH_DEFAULT_WAIT_TIMEOUT_MS` | number | `15000` | 1000..60000 | 默认 waitFor 超时（`/v1/extract` 请求未传 `waitTimeoutMs` 时使用） |
| `WEB_FETCH_MAX_BODY_BYTES` | number | `10485760` (10 MB) | 524288..104857600 | 目标站响应体硬上限（字节） |
| `WEB_FETCH_MAX_REQUEST_BYTES` | number | `1048576` (1 MB) | 65536..5242880 | 入站请求 body 上限（字节） |
| `WEB_FETCH_DEFAULT_MAX_BODY_CHARS` | number | `32768` | 1024..524288 | 默认 maxBodyChars（请求未传时使用） |

### 2.3 并发与限流

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_FETCH_MAX_CONCURRENCY` | number | `4` | 同时渲染请求数上限（Semaphore） |
| `WEB_FETCH_ACQUIRE_TIMEOUT_MS` | number | `30000` | 等待池中 context 的超时；超过抛 `BROWSER_POOL_EXHAUSTED` |
| `WEB_FETCH_RATE_LIMIT_RPM` | number | `60` | 单 IP 每分钟请求上限；0 禁用限流 |
| `WEB_FETCH_RATE_LIMIT_BURST` | number | `10` | 令牌桶 burst 容量 |

### 2.4 浏览器池

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_FETCH_BROWSER_ENABLED` | boolean | `true` | 是否启用浏览器模式；`false` 时只做 static，强制 browser 请求返回 `INVALID_REQUEST` |
| `WEB_FETCH_BROWSER_IDLE_MS` | number | `30000` | Context 空闲回收时间 |
| `WEB_FETCH_BROWSER_RECYCLE_AFTER` | number | `500` | Browser 渲染 N 次后强制回收 |
| `WEB_FETCH_BROWSER_RECYCLE_INTERVAL_MS` | number | `1800000` (30 min) | Browser 定时回收间隔 |
| `WEB_FETCH_STEALTH` | boolean | `false` | 服务级 stealth 默认开关（Q3） |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | string | *(空)* | 覆盖 Chromium 可执行路径（Q4）；Docker 内指向 `/usr/bin/chromium` |
| `WEB_FETCH_UA_POOL` | string | *(空)* | 逗号分隔的 UA 池；空时使用内置默认 UA 列表 |

### 2.5 安全

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_FETCH_ALLOWED_DOMAINS` | string | *(空)* | 逗号分隔的域名白名单；**空 = 只走 SSRF 黑名单防御**；设置后**只允许**这些域名 |
| `WEB_FETCH_BLOCKED_DOMAINS` | string | *(空)* | 逗号分隔的域名黑名单；优先级高于白名单 |
| `WEB_FETCH_ALLOW_LOOPBACK` | boolean | `false` | 是否放行 127.0.0.1 / localhost（**仅集成测试用**，生产必须 `false`） |

### 2.6 缓存（可选，默认关）

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_FETCH_CACHE_TTL_MS` | number | `0` | 0 = 禁用缓存；> 0 = 启用磁盘 LRU 缓存，TTL |
| `WEB_FETCH_CACHE_DIR` | string | `.cache/web-fetch` | 缓存目录（相对当前工作目录或绝对路径） |
| `WEB_FETCH_CACHE_MAX_ENTRIES` | number | `1000` | LRU 条目上限 |
| `WEB_FETCH_CACHE_MAX_SIZE_MB` | number | `512` | 磁盘空间上限（MB） |

### 2.7 可观测性

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_FETCH_LOG_LEVEL` | string | `info` | `debug` / `info` / `warn` / `error` |
| `WEB_FETCH_LOG_FORMAT` | string | `jsonl` | `jsonl`（生产） / `pretty`（开发） |
| `WEB_FETCH_OTLP_ENDPOINT` | string | *(空)* | OTel collector 地址；空 = 禁用 OTel |
| `WEB_FETCH_OTLP_HEADERS` | string | *(空)* | OTLP headers，格式 `k1=v1,k2=v2` |
| `WEB_FETCH_SERVICE_NAME` | string | `tachu-web-fetch-server` | OTel service name |

### 2.8 搜索（占位，Stage 4）

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WEB_SEARCH_PROVIDER` | string | `stub` | 当前启用的 provider 名（Stage 4 仅接受 `stub`；后续支持 `tavily` / `brave` / `serper` / `searxng`） |
| `WEB_SEARCH_PROVIDER_API_KEY` | string | *(空)* | 真实 provider 的 API Key |
| `WEB_SEARCH_PROVIDER_ENDPOINT` | string | *(空)* | 自建 provider 的 endpoint（如 SearXNG） |
| `WEB_SEARCH_DEFAULT_MAX_RESULTS` | number | `10` | 请求未传 maxResults 时使用 |

## 3. 启动期验证规则

Server 在 `config.ts` 的 `loadConfig()` 函数中执行以下校验（失败一律 `process.exit(1)` 并打印清晰错误）：

1. **绑定安全**：`WEB_FETCH_HOST !== '127.0.0.1'` 且 `WEB_FETCH_TOKEN` 为空 → **拒绝启动**，提示 `若绑定非 localhost 必须设置 WEB_FETCH_TOKEN`
2. **端口合法性**：`WEB_FETCH_PORT` 不在 1..65535 → 报错
3. **超时范围**：每个 `*_MS` / `*_TIMEOUT` 变量按 2.2 表格的 `范围` 列校验；越界报错并给出允许区间
4. **`MAX_BODY_CHARS` ≤ 524288**：超过硬上限报错
5. **UA 池非空校验**：`WEB_FETCH_UA_POOL` 非空时按逗号分隔，每项 strip 后非空，否则报错
6. **域名白/黑名单格式**：每条必须符合 `^[a-z0-9.-]+$`（小写 host 字符）
7. **Log level 合法性**：只接受 4 个枚举值
8. **Search provider 可用性**：`WEB_SEARCH_PROVIDER !== 'stub'` 但在 Stage 4 的 provider registry 中找不到 → **warn 并降级为 stub**（不硬退出，保持服务可用）

## 4. 运行期只读快照

`loadConfig()` 返回一个**冻结后的**配置对象，全局单例通过 `getConfig()` 读取。**禁止运行期修改**（除测试 setup 用 `_overrideConfigForTests` helper）。

```ts
export interface WebFetchServerConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string | null;

  readonly timeouts: {
    readonly requestMs: number;
    readonly defaultWaitMs: number;
  };

  readonly limits: {
    readonly maxBodyBytes: number;
    readonly maxRequestBytes: number;
    readonly defaultMaxBodyChars: number;
  };

  readonly concurrency: {
    readonly max: number;
    readonly acquireTimeoutMs: number;
    readonly rateLimitRpm: number;
    readonly rateLimitBurst: number;
  };

  readonly browser: {
    readonly enabled: boolean;
    readonly idleMs: number;
    readonly recycleAfter: number;
    readonly recycleIntervalMs: number;
    readonly stealthDefault: boolean;
    readonly executablePath: string | null;
    readonly userAgents: string[];
  };

  readonly security: {
    readonly allowedDomains: ReadonlySet<string>;
    readonly blockedDomains: ReadonlySet<string>;
    readonly allowLoopback: boolean;
  };

  readonly cache: {
    readonly ttlMs: number;
    readonly dir: string;
    readonly maxEntries: number;
    readonly maxSizeMb: number;
  };

  readonly observability: {
    readonly logLevel: "debug" | "info" | "warn" | "error";
    readonly logFormat: "jsonl" | "pretty";
    readonly otlpEndpoint: string | null;
    readonly otlpHeaders: Record<string, string>;
    readonly serviceName: string;
  };

  readonly search: {
    readonly provider: string;
    readonly apiKey: string | null;
    readonly endpoint: string | null;
    readonly defaultMaxResults: number;
  };
}
```

## 5. Client 端环境变量（`@tachu/extensions` 侧）

### 5.1 `web-fetch` 工具

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `TACHU_WEB_FETCH_ENDPOINT` | string | `http://127.0.0.1:8787` | Server 地址；未显式配时首次调用打印一次 warn（Q2） |
| `TACHU_WEB_FETCH_TOKEN` | string | *(空)* | 与 server 的 `WEB_FETCH_TOKEN` 对齐 |
| `TACHU_WEB_FETCH_DEFAULT_TIMEOUT_MS` | number | `70000` | client 端整体超时；必须 ≥ server 端请求超时（Q6） |

### 5.2 `web-search` 工具

与 `web-fetch` 共用上述 3 个变量。不额外引入变量——搜索 endpoint 就是同一个 server。

## 6. Docker / docker-compose 默认值差异

Dockerfile 内预设以下 ENV：

```dockerfile
ENV NODE_ENV=production
ENV WEB_FETCH_HOST=0.0.0.0
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV WEB_FETCH_LOG_FORMAT=jsonl
```

但 **不预设 `WEB_FETCH_TOKEN`**——docker-compose 示例中标注**必须**由用户通过 `.env` 注入，否则 container 启动会因"绑定 0.0.0.0 但未配 token"被 config 校验拒绝。

docker-compose.yml 的 `environment:` 段须包含：

```yaml
environment:
  WEB_FETCH_TOKEN: ${WEB_FETCH_TOKEN:?WEB_FETCH_TOKEN must be set for non-localhost binding}
```

## 7. 配置来源的可追溯性

Server 启动日志**必须**打印一次完整的**生效配置快照**（token 字段脱敏为 `****...<后4位>`）。示例：

```
[info] config loaded
  host=0.0.0.0 port=8787 token=****af3b
  timeouts: request=60000ms defaultWait=15000ms
  limits: bodyBytes=10MB maxBodyChars=32768
  concurrency: max=4 rateLimit=60rpm
  browser: enabled=true stealth=false executablePath=/usr/bin/chromium
  security: allowedDomains=(unlimited) blockedDomains=3 allowLoopback=false
  cache: disabled
  observability: level=info format=jsonl otlp=disabled
  search: provider=stub configured=false
```

## 关联文档

- 父 ADR：[0003](./0003-web-fetch-server.md)
- HTTP API 契约：[0003a](./0003a-web-fetch-api-contract.md)
- TS 类型：[0003b](./0003b-web-fetch-types.md)
- 错误码：[0003d](./0003d-web-fetch-errors.md)
