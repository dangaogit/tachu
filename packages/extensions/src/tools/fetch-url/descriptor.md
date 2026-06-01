---
kind: tool
name: fetch-url
description: 发送 HTTP 请求并返回响应内容
sideEffect: readonly
idempotent: false
requiresApproval: false
timeout: 15000
inputSchema:
  type: object
  properties:
    url:
      type: string
    method:
      type: string
      enum: [GET, POST]
    headers:
      type: object
    body:
      type: string
    timeoutMs:
      type: number
  required: [url]
outputSchema:
  type: object
  properties:
    status:
      type: number
    headers:
      type: object
    body:
      type: string
    truncated:
      type: boolean
    contentType:
      type: string
execute: fetch-url
---

执行受控网络请求，默认阻止私网地址并限制响应体大小。

响应体返回给 LLM 前会经过两道处理：
1. `Content-Type: text/html` / `application/xhtml+xml` 时，会剥掉 `<script>` / `<style>` / `<noscript>` / `<svg>` / `<canvas>` 及 HTML 注释，再合并空白，得到一段信噪比更高的正文；
2. 无论类型，都会按字符数上限（32KB 字符）截断；超出时在末尾追加 `... [内容已截断，完整长度 N 字符]` 提示。`truncated=true` 表示字节层或字符层任一发生了截断。
