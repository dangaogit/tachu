---
kind: agent
name: helper-agent
description: helper agent
tags: [dev]
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 10000
maxDepth: 1
availableTools: [echo-tool]
instructions: 协助完成简单问题。
requires:
  - kind: tool
    name: echo-tool
---

你是一个开发辅助 agent。

