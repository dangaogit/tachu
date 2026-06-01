---
kind: tool
name: read-file
description: 读取工作区内的文件内容
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 5000
inputSchema:
  type: object
  properties:
    path:
      type: string
    encoding:
      type: string
      enum: [utf-8, base64]
  required: [path]
outputSchema:
  type: object
  properties:
    content:
      type: string
    bytes:
      type: number
execute: read-file
---

读取工作区内文件内容。默认返回 UTF-8 文本，可选返回 base64。
