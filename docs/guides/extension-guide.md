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
scope: [execution]
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
