---
kind: tool
name: list-dir
description: 列出工作区目录内容
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 3000
inputSchema:
  type: object
  properties:
    path:
      type: string
    recursive:
      type: boolean
    maxEntries:
      type: number
    pattern:
      type: string
  required: [path]
outputSchema:
  type: object
  properties:
    entries:
      type: array
execute: list-dir
---

列出目录下文件和子目录，支持递归和结果数量限制。
