---
kind: rule
name: require-tool-verification
description: 对事实性判断必须先调用工具验证
type: rule
scope: [planning, execution]
tags: [accuracy]
version: 1.0.0
---

涉及文件存在性、命令可用性、URL 可达性等事实判断时，必须先调用对应工具验证，不得凭记忆给出结论。
