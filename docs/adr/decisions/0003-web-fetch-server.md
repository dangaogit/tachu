# ADR 0003 — 独立 Web Fetch Server 与 `web-fetch` / `web-search` 工具

- Status: Accepted
- Date: 2026-04-20
- Target Release: `1.0.0-alpha.1`
- Applies to: `@tachu/extensions`, `@tachu/web-fetch-server`（新增包，**不发布 npm**）
- Complements: [ADR-0002](./0002-agentic-loop-builtin-subflow.md)（`tool-use` 循环是本 ADR 新工具的直接调用方）
- 附件（必读）:
  - [0003a — HTTP API 契约](./0003a-web-fetch-api-contract.md)
  - [0003b — TypeScript 类型契约](./0003b-web-fetch-types.md)
  - [0003c — 配置契约](./0003c-web-fetch-config.md)
  - [0003d — 错误码契约](./0003d-web-fetch-errors.md)

## 背景

既有的 `fetch-url` 工具是一个最小可用版本：

```ts
// packages/extensions/src/tools/fetch-url/executor.ts
1. Bun.fetch(url)
2. 正则剥 <script> / <style> / <noscript> / <svg> / <canvas> 与 HTML 注释
3. 合并空白 → 单行段落
4. 字符数硬截断到 32KB
```

对纯静态页勉强可用，但存在四类结构性缺陷：

1. **不跑 JavaScript**：React / Vue / Next-hydrated 等 SPA 抓回来基本是空骨架；Twitter / X embed、Notion 公开页、GitHub Discussions 等都白板
2. **结构信息全丢**：正则剥标签等价于"把一本书里所有标点和段落号拿掉再压成一行"——标题层级、列表、代码块、表格、链接 URL、图片 alt 全部丢失，LLM 拿到一坨噪声文本难以再引用原文结构
3. **无正文识别**：博客 / 文档 / 新闻页的侧边栏、导航、页脚、广告位、cookie 横幅会连同正文一起塞给 LLM，信噪比极低，token 成本高
4. **不能搜索**：Agent 拿到"请帮我查一下 X"这类请求时无可用工具；当前只能让 LLM 幻觉一个猜测性答复或让用户手动找 URL 喂进来

之前讨论过 5 种升级路线，经决策选择**方案 D：独立远端渲染服务**。其他方案已在"不采取的方案"章节记录否决原因。

## 决定

新增**独立包** `@tachu/web-fetch-server`（Bun.serve + Playwright 驱动），同时在 `@tachu/extensions` 新增 **`web-fetch`** 与 **`web-search`** 两个瘦客户端工具，**保留现有 `fetch-url` 工具不动**。

### 决定 1：包结构与发布策略

| 包 | 定位 | 版本 | 发布 |
|---|---|---|---|
| `@tachu/web-fetch-server` | 独立 Bun.serve 渲染服务，**新建 package**，`packages/web-fetch-server/` | 与主线同步 | **`private: true`**，不发 npm；仅发 Docker 镜像 / `bunx git+...` 直装 |
| `@tachu/extensions` | 新增 `web-fetch` / `web-search` tool + descriptor | 随主线节奏 | 照常发 npm |
| `@tachu/core` / `@tachu/cli` | **不改动** | — | — |

- `scripts/publish.sh` 的 `PACKAGES=("core" "extensions" "cli")` 白名单**不变**，新包天然被排除；`package.json` 同时设 `private: true` 做双保险
- CLI 不新增 `tachu serve` 子命令，避免 CLI 与 server 产生依赖耦合（Q7）

### 决定 2：`fetch-url` 与 `web-fetch` 双工具并存（不合并、不废弃）

- `fetch-url`：语义为"受控 HTTP 调用"，不只用于抓网页（也用于打 API、下载 JSON、调 webhook）
- `web-fetch`：语义为"抓网页 → 返回 AI 友好的 Markdown + 结构化元信息"
- 两者 **descriptor 互相引用**：`fetch-url.description` 补一句"若目标是渲染网页正文请优先使用 web-fetch"；`web-fetch.description` 补一句"若仅需调用 REST API 请使用 fetch-url"
- LLM 看到两个语义明确的工具，调度命中率优于单一"万能工具"

### 决定 3：`web-search` 采用"占位实现 + provider 抽象"策略

- Provider 抽象接口 `SearchProvider` 落地（见 0003b）
- **默认绑定 `stub` provider**，返回明确的 `PROVIDER_NOT_CONFIGURED` 错误体（见 0003d）
- `/v1/search` 路由完整实现，协议已定型
- `web-search` tool executor / descriptor 完整实现（语义 = "搜索 + 可选批量渲染 top-N 为 Markdown"）
- 未来接入 Tavily / Brave / Serper / SearXNG 时，**只需新增 provider 文件并在工厂中注册，不改变 API 协议与 tool 协议**
- 未配置任何真实 provider 的环境下，LLM 调用 `web-search` 会收到"未配置，请配置 `WEB_SEARCH_PROVIDER` 环境变量"的结构化错误消息，可以继续对话（不中断循环）

### 决定 4：远端服务的核心能力契约

详细 HTTP schema 见 [0003a](./0003a-web-fetch-api-contract.md)；此处只列**能力边界**：

| 能力 | 必须支持 | 备注 |
|---|---|---|
| 静态页抓取（Bun.fetch） | ✅ P0 | 复用 `@tachu/extensions/common/net` 的 SSRF 防御 |
| 正文识别（Mozilla Readability） | ✅ P0 | `linkedom` + `@mozilla/readability` |
| HTML → Markdown（含 GFM） | ✅ P0 | `turndown` + `turndown-plugin-gfm`；按 block 边界截断 |
| JSON-LD 结构化数据提取 | ✅ P0 | `structured-data` 字段可选返回 |
| 浏览器渲染（Playwright） | ✅ P1 | 一个 Browser + N Context 池；每 500 次或 30 分钟自动回收 |
| `renderMode: auto` 自动降级 | ✅ P1 | 静态抓到的正文 < 200 字或 script 密度 > 80% 时自动升级 browser |
| 资源拦截（image/font/media/stylesheet） | ✅ P1 | 默认开启 image/font/media 拦截，提速 3-5 倍 |
| 懒加载触发（scroll） | ✅ P1 | `scroll: { steps, delayMs }` 入参 |
| Stealth 反检测 | ✅ P2（默认关） | `playwright-extra` + `puppeteer-extra-plugin-stealth`；服务级 + 请求级两级开关，请求级覆盖服务级（Q3） |
| Bearer token 鉴权 | ✅ P2 | 未配置 token 时**强制绑定 127.0.0.1**（开发默认安全） |
| 限流（IP 令牌桶） | ✅ P2 | 内存实现，单实例部署；多实例部署后续迭代 |
| 域名白名单 / 黑名单 | ✅ P2 | 通过环境变量配置 |
| 磁盘 LRU 缓存 | ✅ P2（默认关） | 通过 `WEB_FETCH_CACHE_TTL_MS > 0` 启用 |
| OpenTelemetry Span + Metrics | ✅ P2 | 复用 catalog 里的 `@opentelemetry/api` |
| JSON Lines 结构化日志 | ✅ P2 | 与 `@tachu/extensions/observability/jsonl-emitter` 风格对齐 |
| 搜索（provider 抽象 + stub） | ✅ P3 | 见决定 3 |
| 截图 | ❌（不做） | 由后续独立 ADR 决策；如需给 Vision 工具链用，走 `@tachu/extensions/transformers/image-to-text` |

### 决定 5：安全红线（不可妥协）

1. **SSRF 双层防御**：入口 URL 和每一跳重定向 URL 都经过 `assertPublicUrl`；浏览器模式下通过 `page.on('request')` 拦截每个导航请求
2. **云元数据地址硬黑名单**：`169.254.169.254` / `metadata.google.internal` / `fd00:ec2::254` 等进入硬编码黑名单，**即使域名白名单放开也拒绝**
3. **未配 token 时强制 127.0.0.1**：开发默认安全；生产部署必须显式配 `WEB_FETCH_TOKEN`
4. **无 CORS**：服务为 server-to-server 场景设计，所有跨域预检（OPTIONS）统一 403
5. **非 http/https 一律拒绝**：`file://` / `ftp://` / `data:` 等协议在入口处拒绝
6. **Context 隔离**：每个请求启用新 incognito Context，抓完立即销毁 cookie / storage
7. **资源上限**：响应体硬上限 10MB；请求硬超时 60s；步数 / 超时 / 并发三维预算

### 决定 6：本地开发"一键启动"体验

用户显式诉求——本仓库内必须能直接开发启动，不依赖外部服务：

1. 根目录脚本：`bun run dev:server`
2. 首次启动若检测不到 Chromium：打印引导命令 `bun run dev:server:install-browser`
3. Dockerfile + docker-compose.yml 提供"带 token + 带 OTel collector"的完整生产栈模板
4. 启动日志打印清晰的"工具端配置提示"：`export TACHU_WEB_FETCH_ENDPOINT=http://127.0.0.1:8787`

### 决定 7：客户端默认 endpoint 策略（Q2）

```ts
const endpoint = process.env.TACHU_WEB_FETCH_ENDPOINT ?? "http://127.0.0.1:8787";
```

- 未显式配置时 fallback 到 `http://127.0.0.1:8787`（开发友好）
- **首次调用时**在 context logger 打印一条 warn：`使用 web-fetch 默认 endpoint，生产部署请显式配置 TACHU_WEB_FETCH_ENDPOINT`
- 连接失败时错误消息引导用户：`请先启动渲染服务（bun run dev:server），或通过 TACHU_WEB_FETCH_ENDPOINT 配置远端服务地址`

### 决定 8：超时对齐（Q6）

- server 端：单请求硬超时 60s（`WEB_FETCH_REQUEST_TIMEOUT_MS`）
- client 端：默认超时 70s（server + 10s 网络余量）
- client 超时时优先抛 `TIMEOUT_WEB_FETCH`，server 超时时返回 `REQUEST_TIMEOUT` 错误码（见 0003d）
- 文档**必须**明确说明 `client ≥ server`；反之会导致 server 还在渲染 client 已 abort，资源浪费

## 不采取的方案

| 方案 | 简述 | 弃用原因 |
|---|---|---|
| **A：仅方案 A（HTMLRewriter 流式清洗）** | Bun 原生 HTMLRewriter + 自研 Markdown 转换器 | 0 依赖但不跑 JS，SPA 抓不到；且自研 Markdown 规则到 90 分成本高于用 Readability+Turndown |
| **B：仅方案 B（本地 Readability + Turndown）** | `@mozilla/readability` + `linkedom` + `turndown` 内嵌到 extensions | 仍不跑 JS；且把 250KB 依赖打进 `@tachu/extensions` 会污染 SDK 用户的 bundle |
| **C：本地 Playwright 内嵌到 extensions** | 让 `@tachu/extensions` optionalDependency 加 playwright-core | Chromium 180MB 二进制，CLI 用户 `bun install` 体验极差；且 CI / 容器场景需要额外 `bunx playwright install` 步骤 |
| **E：合并 fetch-url 与 web-fetch** | 只保留 `web-fetch`，让它同时支持 `mode: 'raw' | 'render'` | LLM 在面对单一"万能工具"时调度命中率显著低于双工具；且会破坏现有依赖 `fetch-url` 的集成测试 |
| **F：直接依赖某个 provider 的托管 web tool** | 复用上游提供的服务端抓取工具 | 锁定在单一 provider；与 `@tachu/core` 的 provider 无关架构背离；成本不可控 |

## 影响

### 破坏性变更

**无**。本 ADR 纯新增：

- `fetch-url` 行为 / 协议不变（保留现有测试）
- `@tachu/core` / `@tachu/cli` 不变
- `@tachu/extensions` 只新增两个工具文件 + 在 `tools/index.ts` 追加两个条目

### 非破坏性收益

- SPA / SSR-hydrated / 懒加载页面可被有效抓取
- LLM 拿到 Markdown 结构化正文（标题 / 列表 / 代码块 / 表格 / 链接），引用准确度显著提升
- 侧边栏 / 广告 / 页脚被 Readability 滤除，token 成本下降 30-50%
- JSON-LD / meta tags 自动提取为 `structured` 字段，支持"抓商品页→拿到价格"类结构化任务
- `web-search` 协议先落地，未来接真实 provider 只是一个 PR 的工作
- 默认 endpoint fallback 使"抓测试样本"这类场景完全零配置
- 独立部署 / 独立扩容 / 独立安全审计，和主 SDK 解耦

### 性能影响

- **不启用 server 时**：`fetch-url` 行为不变，无任何回归
- **启用 server 后，static 分支**：单次请求 50-200ms（取决于目标站 + 网络）；相较当前 `fetch-url` 增加约 20-50ms（Readability + Turndown 处理开销）
- **启用 server 后，browser 分支**：单次请求 1-5s（冷启动 2-8s），通过 Context 复用和资源拦截控制在 1-3s
- **Context 池**：一个 Browser + 默认 4 Context；内存稳态 ~400MB；每 500 次或 30 分钟自动回收避免泄漏
- **token 成本**：Markdown 结构化输出相较当前 `stripHtmlForLlm` 的同等正文 token 数下降约 30%（Readability 滤除噪声）；累计 LLM 调用成本下降

### 运维复杂度

- 多一个可部署组件（server）
- Docker 镜像尺寸约 800MB（Debian + Chromium 字体库）
- 需要单独监控浏览器池健康（`/healthz` 暴露池状态）
- 文档必须覆盖"开发模式 vs 生产部署"两个场景

## 实现路线图

完整路线图见本 ADR 同目录下的 [执行流程文档](../../../.cursor/plans/web-fetch-server.md)（后续补充），此处只做节奏概述：

| Stage | 内容 | 并行度 | 主 agent 工作 |
|---|---|---|---|
| **Stage 0** | 契约冻结（本 ADR + 4 份附件 + 包骨架） | 0 | 独立完成 |
| **Stage 1** | P0 静态分支（server 脚手架 + static pipeline + client 工具 + 开发脚本） | 19 subagent | 依赖收口 + 门禁 |
| **Stage 2** | P1 浏览器池（Playwright + Context 池 + auto 降级 + stealth） | 7 subagent | 门禁 |
| **Stage 3** | P2 生产化（OTel + 缓存 + Dockerfile + 安全/压力测试 + README） | 10 subagent | 门禁 |
| **Stage 4** | P3 搜索（provider 抽象 + stub + `/v1/search` 路由 + `web-search` 工具） | 4 subagent | 门禁 |
| **Stage 5** | 文档同步（README / CHANGELOG / 主设计文档 / 冒烟验收） | 0 | 独立完成 |

**合计**：40 个并行 subagent 任务，分 4 批并行执行。

## 回滚策略

本 ADR 新增功能，无破坏性变更，回滚成本极低：

1. **仅回滚 `web-fetch` tool**：从 `packages/extensions/src/tools/index.ts` 中移除 `web-fetch` 与 `web-search` 两项条目；删除 `packages/extensions/src/tools/web-fetch/` 与 `web-search/` 目录。用户侧回退到 `fetch-url`
2. **回滚整个 server 包**：直接删除 `packages/web-fetch-server/` 目录；不影响任何现有功能
3. **保留协议 + 关闭实现**：server 继续部署但 client 工具下线，协议文件保留供未来复用
4. **catalog 依赖清理**：若已将 `playwright-core` 等加入根 catalog，回滚时从 catalog 移除即可（无 SDK 发布包依赖它们）

## 关联文档

- 概要设计 `docs/adr/architecture-design.md` §三（Tools 抽象）
- 详细设计 `docs/adr/detailed-design.md`（Stage 5 追加 §X.Y "web-fetch-server 独立服务"小节）
- 技术设计 `docs/adr/technical-design.md` §3.2 / §4.4
- [ADR-0002](./0002-agentic-loop-builtin-subflow.md) — `tool-use` 循环是本 ADR 两个新工具的直接调用方
- 相关源码：
  - `packages/extensions/src/tools/fetch-url/executor.ts` — 对照参考，保留不动
  - `packages/extensions/src/common/net.ts` — SSRF 防御复用
  - `packages/extensions/src/observability/` — 日志 / OTel 风格对齐
