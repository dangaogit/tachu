---
kind: tool
name: run-shell
description: 在受控环境中执行 shell 命令
sideEffect: irreversible
idempotent: false
requiresApproval: true
timeout: 30000
inputSchema:
  type: object
  properties:
    command:
      type: string
    args:
      type: array
      items:
        type: string
    cwd:
      type: string
    env:
      type: object
    timeoutMs:
      type: number
  required: [command]
outputSchema:
  type: object
  properties:
    stdout:
      type: string
    stderr:
      type: string
    exitCode:
      type: number
    durationMs:
      type: number
execute: run-shell
---

执行 shell 命令并返回 stdout/stderr，默认只继承 PATH/HOME/LANG 环境变量。
