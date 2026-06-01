---
kind: tool
name: write-file
description: 写入工作区内文件内容
sideEffect: write
idempotent: false
requiresApproval: true
timeout: 5000
inputSchema:
  type: object
  properties:
    path:
      type: string
    content:
      type: string
    encoding:
      type: string
      enum: [utf-8, base64]
    createDirs:
      type: boolean
  required: [path, content]
outputSchema:
  type: object
  properties:
    bytesWritten:
      type: number
execute: write-file
---

向工作区写入文件，支持 UTF-8 与 base64 输入。
