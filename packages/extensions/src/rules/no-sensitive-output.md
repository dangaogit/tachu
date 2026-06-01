---
kind: rule
name: no-sensitive-output
description: 禁止在输出中包含敏感信息
type: rule
scope: [output]
tags: [security]
version: 1.0.0
---

不得在输出中包含 API Key、密码、证书、token 等敏感信息。若需要引用，使用 `<REDACTED>` 占位符。
