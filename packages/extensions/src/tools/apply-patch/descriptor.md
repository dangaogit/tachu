---
kind: tool
name: apply-patch
description: 应用 unified diff 补丁并支持失败回滚
sideEffect: write
idempotent: false
requiresApproval: true
timeout: 10000
inputSchema:
  type: object
  properties:
    patch:
      type: string
    basePath:
      type: string
  required: [patch]
outputSchema:
  type: object
  properties:
    applied:
      type: array
    success:
      type: boolean
execute: apply-patch
---

解析 unified diff，逐文件应用 hunk。任意文件失败时回滚全部已应用文件。
