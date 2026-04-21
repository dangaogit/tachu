---
kind: tool
id: web-fetch
name: web-fetch
version: "0.1.0"
category: "web"
dangerous: true
description: |
  通过 @tachu/web-fetch-server 远程渲染并结构化抓取 URL：服务端以 Bun.fetch（静态）或 Playwright（浏览器）拉取页面，经 Readability/Turndown 等管线输出标题、正文与可选链接/图片/JSON-LD；`renderMode` 为 auto 时可在静态不足时自动升级到浏览器重试一次。
sideEffect: readonly
idempotent: false
requiresApproval: true
timeout: 120000
inputSchema:
  type: object
  properties:
    url:
      type: string
      description: 目标 http(s) URL（协议层唯一必填；将发往服务端并由 SSRF 规则校验）
    renderMode:
      type: string
      enum: [static, browser, auto]
      description: 渲染模式；默认 auto（先 static，不满足条件时浏览器重试一次）
    waitFor:
      description: |
        仅 browser 模式：等待策略。可为 load / domcontentloaded / networkidle，
        或 { "selector": "<css>" } 等待元素可见，或 { "timeMs": <number> } 固定等待。
      oneOf:
        - type: string
          enum: [load, domcontentloaded, networkidle]
        - type: object
          required: [selector]
          properties:
            selector:
              type: string
        - type: object
          required: [timeMs]
          properties:
            timeMs:
              type: number
    waitTimeoutMs:
      type: number
      description: 渲染等待超时（毫秒）；默认 15000，硬上限 60000
    scroll:
      description: |
        仅 browser：是否滚动以触发懒加载。false | true |
        { "steps": number, "delayMs": number }
      oneOf:
        - type: boolean
        - type: object
          required: [steps, delayMs]
          properties:
            steps:
              type: number
            delayMs:
              type: number
    userAgent:
      type: string
      description: 覆盖 User-Agent；请求中可省略或显式传 null 以使用服务端 UA 池
    extraHeaders:
      type: object
      additionalProperties:
        type: string
      description: 额外 HTTP 头；静态模式直传；浏览器模式作为 route 注入
    cookies:
      type: array
      description: 注入 Cookie 列表（仅 browser 模式生效；元素形状由服务端解析）
      items:
        type: object
        additionalProperties: true
    blockResources:
      type: array
      description: |
        仅 browser：资源拦截类型。未传时服务端默认 ["image","font","media"]；传 [] 表示不拦截。
      items:
        type: string
        enum: [image, font, media, stylesheet, other]
    stealth:
      type: boolean
      description: 可省略或传 null 继承服务级；传 true/false 为请求级覆盖
    outputFormat:
      type: string
      enum: [markdown, text, html, structured]
      description: 正文形态；markdown 为默认 GFM
    includeLinks:
      type: boolean
      description: 是否在输出中包含 links[]
    includeImages:
      type: boolean
      description: 是否在输出中包含 images[]
    includeStructured:
      type: boolean
      description: 是否包含 JSON-LD structured 字段
    maxBodyChars:
      type: number
      description: body 字符上限；默认 32768，硬上限 524288
    traceId:
      type: string
      description: 可选追踪 ID；省略或 null 时由服务端生成
  required: [url]
outputSchema:
  type: object
  description: 对应 POST /v1/extract 200 响应（字段随选项省略）
  properties:
    url:
      type: string
    finalUrl:
      type: string
    status:
      type: number
    renderedWith:
      type: string
      enum: [static, browser]
    renderedAtMs:
      type: number
    title:
      type: string
    description:
      type: string
    siteName:
      type: string
    lang:
      type: string
    byline:
      type: string
    publishedTime:
      type: string
    body:
      type: string
    wordCount:
      type: number
    truncated:
      type: boolean
    links:
      type: array
    images:
      type: array
    structured:
      type: object
      additionalProperties: true
    warnings:
      type: array
      items:
        type: string
    traceId:
      type: string
execute: web-fetch
---

## 常用字段说明

协议上仅 **`url`** 必填。实际调用中常与其他字段组合使用，例如：

- **`renderMode`**：静态站用 `static` 省资源，强 JS 页用 `browser` 或默认 `auto`
- **`outputFormat`**：需要 Markdown 摘要时用 `markdown`（默认），只要纯文本用 `text`
- **`waitTimeoutMs` / `waitFor`**：浏览器渲染时的超时与就绪条件
- **`maxBodyChars`**：控制返回给模型的正文长度，避免上下文爆炸
- **`includeLinks` / `includeImages` / `includeStructured`**：按需打开结构化附属字段

## 输出结构示例（200 成功，节选）

```json
{
  "url": "https://example.com/article",
  "finalUrl": "https://example.com/article",
  "status": 200,
  "renderedWith": "browser",
  "renderedAtMs": 234,
  "title": "示例文章",
  "description": "页面 meta 描述",
  "siteName": "Example",
  "lang": "zh",
  "byline": null,
  "publishedTime": "2026-04-20T00:00:00.000Z",
  "body": "# 示例文章\n\n正文 Markdown …",
  "wordCount": 1234,
  "truncated": false,
  "links": [{ "text": "下一页", "href": "https://example.com/next" }],
  "images": [],
  "structured": null,
  "warnings": [],
  "traceId": "req_01HY..."
}
```

## 安全提示

1. **客户端须配置 Web Fetch Server 的 endpoint 与鉴权**：工具通过 HTTP 调用服务端；需正确设置服务地址与 `Authorization: Bearer <token>` 所用 token（与部署环境一致）。未配置 token 时服务端仅允许绑定本机回环，运维需按环境变量与网络策略部署。
2. **URL 会经服务端 SSRF 校验**：私网、元数据地址、黑名单域名等会被拒绝（如 `SSRF_BLOCKED` / `DOMAIN_NOT_ALLOWED`）；请勿将本工具用于探测内网。
3. **robots.txt 与爬取礼仪**：是否遵守 robots 及额外策略由 **服务端实现与配置** 决定，本工具不在客户端重复裁决。

## 与 `fetch-url` 的区别

| 维度 | `web-fetch` | `fetch-url` |
| --- | --- | --- |
| 数据形态 | 结构化正文（标题、Markdown/文本/HTML、可选链接与 JSON-LD） | 原始响应体 + 简单 HTML 清洗 |
| 依赖 | 需要可用的 `@tachu/web-fetch-server` | 仅需受控直连，无需独立 fetch 服务 |
| 渲染 | 支持静态与浏览器渲染管线 | 单次 HTTP，无浏览器渲染 |
