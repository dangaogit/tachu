# Contributing to Tachu

Thank you for helping improve Tachu. This file is the canonical contributor guide; [`README.md`](./README.md) and [`README_ZH.md`](./README_ZH.md) summarize the product and link here for PR expectations.

## Requirements

- [Bun](https://bun.sh) >= 1.3.14
- TypeScript 5.x (via workspace devDependencies)

## Development workflow

```bash
git clone https://github.com/dangaogit/tachu.git
cd tachu
bun install

# Run all tests (offline / mock providers by default)
bun test

# Type check all packages
bun run typecheck

# Build all packages
bun run build

# Run tests for one package
bun test --filter packages/core
```

## Opt-in real-provider e2e

Default CI and `bun test` stay offline. To smoke-test a real LLM gateway locally:

```bash
TACHU_REAL_E2E=1 \
TACHU_E2E_PROVIDER=openai \
TACHU_E2E_API_KEY=sk-... \
TACHU_E2E_API_BASE=https://your-gateway.example.com/v1 \
TACHU_E2E_MODEL=gpt-4o-mini \
bun test packages/cli/__tests__/integration/real-provider.e2e.test.ts
```

Supported `TACHU_E2E_PROVIDER` values: `openai`, `anthropic`, `qwen`, `gemini`. When `TACHU_E2E_API_KEY` is omitted, the test falls back to `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DASHSCOPE_API_KEY` / `QWEN_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY` respectively. This does **not** run in default CI.

## Code conventions

| Item | Convention |
|------|------------|
| File names | `kebab-case` |
| Classes / types | `PascalCase` |
| Functions / variables | `camelCase` |
| Constants | `SCREAMING_SNAKE_CASE` |
| Tests | Co-located `*.test.ts`; integration tests under `__tests__/` |
| Public APIs | TSDoc with `@param`, `@returns`, `@throws`, `@example` where applicable |

## Pull request checklist

Before opening a PR:

1. `bun test` — all tests pass
2. `bun run typecheck` — zero TypeScript errors
3. Coverage thresholds met (≥ 80% line, ≥ 70% branch) when touching covered packages
4. TSDoc on any new or changed public API
5. README / CHANGELOG updates when user-visible behavior or release notes change

## Documentation map

| Document | Purpose |
|----------|---------|
| [README.md](./README.md) | Product overview, project status table, CLI reference |
| [CHANGELOG.md](./CHANGELOG.md) | Release and unreleased changes |
| [docs/overview-design.md](./docs/overview-design.md) | Architecture overview and 6-phase skeleton + deep single loop |
| [docs/detailed-design.md](./docs/detailed-design.md) | TypeScript interfaces, module specs, configuration schema |
| [docs/technical-design.md](./docs/technical-design.md) | Technology choices, engineering structure, implementation guide |
| [docs/architecture/pipeline-phases.md](./docs/architecture/pipeline-phases.md) | Phase-by-phase implementation reference |
| [docs/architecture/package-layout.md](./docs/architecture/package-layout.md) | Monorepo packages and dependencies |
| [docs/guides/cli.md](./docs/guides/cli.md) | CLI commands and flags |
| [docs/guides/configuration.md](./docs/guides/configuration.md) | `tachu.config.ts` / `EngineConfig` |
| [docs/guides/providers-and-integrations.md](./docs/guides/providers-and-integrations.md) | LLM, MCP, vector stores, backends |
| [docs/guides/extension-guide.md](./docs/guides/extension-guide.md) | Rules, Skills, Tools, Agents |
| [docs/guides/observability-and-safety.md](./docs/guides/observability-and-safety.md) | Events, OTel, safety module |

Questions or large design changes: open an issue first when the change touches public API contracts or the design docs above.
