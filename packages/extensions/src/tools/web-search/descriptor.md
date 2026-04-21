---
kind: tool
id: web-search
name: web-search
version: "0.1.0"
category: "web"
dangerous: false
description: |
  通过 @tachu/web-fetch-server 调用 POST /v1/search：服务端编排搜索 provider 与可选的 top-N 网页抽取。**v0.1 默认 provider 为 stub**：在未正确配置真实搜索提供方与 API 密钥前，调用将返回 HTTP 503 与错误码 PROVIDER_NOT_CONFIGURED；运维需在服务端设置 WEB_SEARCH_PROVIDER、WEB_SEARCH_PROVIDER_API_KEY 等环境变量后方可获得真实结果。
sideEffect: readonly
idempotent: false
requiresApproval: false
timeout: 120000
inputSchema:
  type: object
  properties:
    query:
      type: string
      description: 搜索查询词（必填）
    maxResults:
      type: number
      description: 返回条数；默认 10，上限 30（由服务端校验）
    language:
      type: string
      description: 搜索语言偏好；省略由 provider 决定
    region:
      type: string
      description: 地区偏好；省略由 provider 决定
    timeRange:
      type: string
      enum: [day, week, month, year]
      description: 时间范围过滤
    safeSearch:
      type: string
      enum: [off, moderate, strict]
      description: 安全搜索级别；默认 moderate
    includeDomains:
      type: array
      items:
        type: string
      description: 仅包含这些域名
    excludeDomains:
      type: array
      items:
        type: string
      description: 排除域名
    fetchTopN:
      type: number
      description: 对前 N 条结果执行抽取；0 表示不抽取；上限 5
    fetchOptions:
      type: object
      description: fetchTopN > 0 时透传至抽取管线（如 renderMode、maxBodyChars）
      additionalProperties: true
    timeoutMs:
      type: number
      description: 客户端整体超时毫秒数；默认与 TACHU_WEB_FETCH_TIMEOUT_MS 或 70000 对齐
  required: [query]
outputSchema:
  type: object
  description: 对应 POST /v1/search 200 响应（省略 searchedAtMs、traceId 等追踪字段）
  properties:
    query:
      type: string
    provider:
      type: string
    results:
      type: array
    totalResults:
      type: number
    warnings:
      type: array
      items:
        type: string
execute: web-search
---

## 行为说明

- **Endpoint**：与 `web-fetch` 相同，使用 `TACHU_WEB_FETCH_ENDPOINT`（默认 `http://127.0.0.1:8787`），路径为 `/v1/search`。
- **鉴权**：可选 `TACHU_WEB_FETCH_TOKEN`，以 `Authorization: Bearer` 发送。
- **占位行为**：Stage 4 不提供真实第三方搜索；默认 stub 将返回「提供方未配置」，客户端会抛出带中文运维指引的错误。

## 与 `web-fetch` 的关系

| 维度 | web-search | web-fetch |
| --- | --- | --- |
| 能力 | 搜索 + 可选批量抽取 top-N | 单 URL 抽取 / 渲染 |
| 端点 | `/v1/search` | `/v1/extract` |
| v0.1 风险 | 默认 PROVIDER_NOT_CONFIGURED | 需可用渲染服务与 SSRF 策略 |
