# Extension Guide

> See also: [README](../../README.md) · [Detailed Design](../detailed-design.md)

Tachu is extended by creating Markdown descriptor files in the `.tachu/` directory. No code changes are required for Rules, Skills, and Tools — only Agents need executable functions registered separately.

### Custom Rule

```markdown
<!-- .tachu/rules/no-external-calls.md -->
---
name: no-external-calls
description: Prevent the agent from making external network calls without explicit approval
type: rule
activation:
  mode: always
tags: [security, network]
---

Do not make HTTP requests, DNS lookups, or any other external network calls unless
the tool being invoked has `requiresApproval: true` and the user has confirmed.
```

### Custom Skill

```markdown
<!-- .tachu/skills/git-workflow/SKILL.md -->
---
name: git-workflow
description: Git branching, commit, and PR workflow knowledge for this repository
tags: [development, git]
requires:
  - { kind: tool, name: run-command }
---

## Git Workflow

This repository follows trunk-based development with short-lived feature branches.

### Branch Naming
- Feature: `feat/<ticket>-<short-desc>`
- Fix: `fix/<ticket>-<short-desc>`

### Commit Convention
Use Conventional Commits: `type(scope): subject`
...
```

### Skill 对齐 agentskills.io 开放规范

Tachu 的 Skill 描述符跟随 [agentskills.io](https://agentskills.io) 开放规范（Claude Code、OpenAI Codex 等已采纳）：

- **目录约定表达资源类型**，不是 frontmatter 手写字段。放在 `scripts/` 的是可执行代码，`references/` 是按需读的文档，`assets/` 是模板/静态资源；三者都在 skill 加载时自动扫描，**不要**在 frontmatter 里手写 `resources:` 数组。

```text
git-workflow/
├── SKILL.md
├── scripts/
│   └── check-branch-name.sh
├── references/
│   └── commit-style.md
└── assets/
    └── pr-template.md
```

- **`name` 格式必须是小写字母、数字、连字符**（不能首尾或连续连字符）——加载时硬校验，不合规直接报错。此外建议 `name` 等于所在目录名（rule/tool/agent 是单文件描述符，建议 `name` 等于文件名去掉扩展名）；这条只是软提示，不一致只会在启动日志打一行 warning，不阻断加载（兼容历史上自由命名的描述符文件）。
- **可选 frontmatter**：`license`、`compatibility`（环境要求说明）、`metadata`（任意 key-value）、`allowed-tools`（预授权工具调用模式）。示例：

```markdown
<!-- .tachu/skills/git-workflow/SKILL.md -->
---
name: git-workflow
description: Git branching, commit, and PR workflow knowledge for this repository
tags: [development, git]
compatibility: Requires git and a POSIX shell
allowed-tools: "run-shell(^git (status|diff|log)(\\b|$))"
requires:
  - { kind: tool, name: run-command }
---
```

  `allowed-tools` 只有两种写法：裸工具名（如 `read-file`，命中该工具的任意调用）、`run-shell(<regex>)`（仅当 `arguments.command` 匹配且调用未带额外 `args` 字段时命中）。命中后，只要这个 skill 是当前 turn 的 Active Skill，core 的 `tool-use` 子流程会直接跳过 `onBeforeToolCall` 审批回调——这个豁免在 core 内部实现，对所有宿主天然生效，不需要任何宿主接线；作用域严格限定在当前 turn 的 Active Skill，不落盘、不跨 turn。
- **不存在专门的技能脚本执行工具**：`scripts/` 下的文件能否被跑起来，完全取决于宿主是否已经装配了 `run-shell` 这类通用执行工具——这与 Claude Code/Codex 的做法一致（模型用宿主已有的通用工具执行，而不是靠框架另造一个专用入口）。读取 `references/`/`assets/` 走 `read_skill_resource` 内置工具（白名单来自目录扫描，只读、不执行）。

详见 `docs/adr/0001-skill-agentskills-io-alignment.md`（本地文档，未纳入版本控制）。

### Custom Tool

```markdown
<!-- .tachu/tools/query-db.md -->
---
name: query-db
description: Execute a read-only SQL query against the application database
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 10000
inputSchema:
  type: object
  properties:
    sql:   { type: string, description: "SQL SELECT statement" }
    limit: { type: number, description: "Max rows to return", default: 100 }
  required: [sql]
execute: queryDatabase
---

Executes a parameterized read-only SQL query. Results are returned as a JSON array.
```

Register the execution function in your `engine-factory.ts`:

```typescript
engine.registry.registerExecutor('queryDatabase', async (input, ctx) => {
  const { sql, limit = 100 } = input as { sql: string; limit?: number };
  return db.query(sql).limit(limit).execute();
});
```

### Custom Agent

```markdown
<!-- .tachu/agents/code-reviewer.md -->
---
name: code-reviewer
description: Reviews pull request diffs and produces structured code review feedback
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 180000
maxDepth: 1
availableTools: [read-file, search-code, run-command]
---

You are a careful code reviewer. When given a diff or a set of files:
1. Understand the intent of the change
2. Review for correctness, clarity, security, and performance
3. Produce a structured review with severity levels: critical / major / minor / nit
```

---
