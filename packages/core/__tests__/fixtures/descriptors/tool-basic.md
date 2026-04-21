---
kind: tool
name: echo-tool
description: echo tool
tags: [dev]
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 3000
inputSchema:
  type: object
  properties:
    text:
      type: string
execute: echo
---

返回输入文本。

