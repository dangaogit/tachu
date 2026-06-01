---
kind: tool
name: search-code
description: 在工作区内按模式搜索代码
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 10000
inputSchema:
  type: object
  properties:
    pattern:
      type: string
    path:
      type: string
    fileGlob:
      type: string
    maxResults:
      type: number
    caseSensitive:
      type: boolean
  required: [pattern]
outputSchema:
  type: object
  properties:
    matches:
      type: array
execute: search-code
---

优先使用 ripgrep 搜索；若系统不存在 rg，则回退到 JS 递归搜索。
