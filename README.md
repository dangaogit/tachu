# Tachu

**An agentic engine under active development — the *Harness* that aims to turn any LLM into a reliable, observable Agent.**

[![npm version](https://img.shields.io/npm/v/@tachu/core?label=%40tachu%2Fcore)](https://www.npmjs.com/package/@tachu/core)
[![status: rc](https://img.shields.io/badge/status-rc-blue)](#project-status)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](#license)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

> **Project Status — Release Candidate.** The 9-phase pipeline, registry, prompt assembler, CLI, OpenAI / Anthropic / Qwen / Gemini adapters, MCP adapters, vector stores and observability emitters are wired up and tested. Phase 3 (Intent Analysis) is a real LLM call, Phase 5 routes complex tool-capable requests to the built-in `tool-use` loop, and Phase 8 runs deterministic validation rules with optional semantic judge. Runtime provider fallback and semantic judge production hardening remain post-rc work. Install via the `@rc` dist-tag.

---

## What is Tachu?

Tachu aims to be an **agentic engine you can build a real product on** — not a toy demo, not a thin wrapper. It is the *Harness* in the equation **Agent = Model + Harness**: it provides the structural skeleton (protocol, lifecycle, safety, memory, orchestration) so that any LLM becomes a reliable, observable Agent.

The engine is intentionally **domain-agnostic**: it knows nothing about your business logic, your users, or your domain vocabulary. Instead, it defines a small set of core abstractions (Rules, Skills, Tools, Agents) through which your business fills in all the intelligence. Tachu is designed to handle the hard parts — 9-phase execution pipeline, dual-plane semantic matching, context window management, token-precise prompt assembly, structured retry/fallback, cancellation propagation, and end-to-end observability.

Tachu ships as a Bun-native TypeScript monorepo with three published packages — the zero-dependency engine core (`@tachu/core`), an official extensions library (`@tachu/extensions`), and a fully-featured CLI program (`@tachu/cli`) that doubles as the reference implementation — plus `@tachu/host-defaults` for shared CLI/embedded host wiring, and an optional private sidecar package (`@tachu/web-fetch-server`) for remote browser-backed web tools.

---

## Project Status

**Current release:** `1.0.0-rc.0` on the `rc` dist-tag.

**Version terminology:** The product line is **Tachu v1**. Release candidates are stabilization builds for `1.0.0`, not a separate framework generation. HTTP paths like `/v1/extract` are API versions only. See [detailed-design § version glossary](docs/detailed-design.md#版本与发布术语必读).

This is the **first release candidate**. The table below is a readability index only; runtime behavior, defaults, and edge cases are authoritative in the cited source files and tests.

| Capability | Status | Notes |
|-----------|--------|-------|
| 9-phase pipeline skeleton (types, orchestrator, state machine, hooks) | ✅ Implemented | `packages/core/src/engine` |
| Descriptor Registry (Rules / Skills / Tools / Agents) | ✅ Implemented | Markdown + YAML frontmatter loader, semantic indexing, startup validation |
| Prompt assembler (tiktoken, KV-cache-friendly ordering) | ✅ Implemented | `packages/core/src/prompt` |
| Task scheduler, DAG validator, turn/task retry bookkeeping | ✅ Implemented | `packages/core/src/engine/scheduler.ts`; **runtime provider fallback on LLM errors is not wired** (see [Providers guide](./docs/guides/providers-and-integrations.md)) |
| Session / Memory / Runtime-state / Safety / Model-router / Provider / Observability / Hooks modules | ✅ Implemented | `packages/core/src/modules` |
| OpenAI / Anthropic / Qwen / Mock Provider adapters | ✅ Implemented | CLI auto-wires via `@tachu/host-defaults`; streaming, function calling, tool schemas |
| Gemini Provider adapter | ✅ Implemented (manual wiring) | `GeminiProviderAdapter` in `@tachu/extensions` with unit tests; **not** registered by default CLI / `buildProviderAdapter` — inject via `createEngine(..., { providers: [new GeminiProviderAdapter(...)] })` (see [Providers guide](./docs/guides/providers-and-integrations.md)) |
| `apiKey` / `baseURL` / `organization` / `timeoutMs` configuration (env var / `tachu.config.ts` / CLI flags) | ✅ Implemented | Azure OpenAI / LiteLLM / OpenRouter / self-hosted gateways supported |
| 22 built-in tools + Terminal / File / Web backends | ✅ Implemented | `packages/extensions/src/tools/index.ts` |
| MCP stdio + SSE adapters | ✅ Implemented | `packages/extensions/src/mcp` |
| `LocalFsVectorIndexAdapter` (file-backed) + `QdrantVectorIndexAdapter` (REST) | ✅ Implemented | |
| OTel / JSONL emitters | ✅ Implemented | |
| `tachu init` / `tachu run` / `tachu chat` CLI surface, streaming renderer, session persistence, Ctrl+C semantics | ✅ Implemented | |
| **CLI terminal Markdown rendering** | ✅ **Implemented** | `marked` + `marked-terminal` + `cli-highlight` stack. Applied to the final assistant reply in `tachu chat` / `tachu run --output text` when stdout is a TTY; automatically disables under `NO_COLOR` / non-TTY / `--no-color`. Explicit control via `--markdown` / `--no-markdown` on `tachu run`. Dedicated `renderMarkdownToAnsi` wrapper (`packages/cli/src/renderer/markdown.ts`) with 12 unit tests in `markdown.test.ts`. |
| **Phase 3 — Intent Analysis (LLM call, pure classification)** | ✅ **Implemented** | Pure classification only (`IntentResult`); final user reply is Phase 7 `direct-answer`. **Implementation:** `packages/core/src/engine/phases/intent.ts` (`INTENT_SYSTEM_PROMPT_BASE`, fast paths, JSON parse, heuristic fallback); tests: `intent.test.ts`. Hosts may **`config.intent.systemPromptBase`** to replace the base wholesale; optional extra few-shots: `config.intent.fewShotExamples` (Agent Context / explicit selections still appended by core). |
| **Phase 5 — Task Planning (planning router)** | ✅ **Implemented** | Enforces `plans[0].tasks.length >= 1`. Rules: (1) `simple` intent → single `direct-answer` sub-flow task; (2) `complex` + visible tools → single `tool-use` sub-flow task; (3) `complex` + no visible tool → single `direct-answer` sub-flow task with `warn: true`; (4) defensive post-guard catches upstream regressions that leave `tasks` empty. Multi-step behavior lives inside `tool-use`; optional plan preview / human review may still evolve, but there is no separate default LLM pre-planner on the main path. |
| **`direct-answer` built-in Sub-flow (Phase 7)** | ✅ **Implemented** | `packages/core/src/engine/subflows/direct-answer.ts`. Resolves `capabilityMapping.intent` (fallback to `fast-cheap`), composes system + ≤10 memory-history entries + user prompt, calls `ProviderAdapter.chat()` with a 60 s per-call timeout merged with the phase abort signal. System prompt mandates **natural-language Markdown**, forbids JSON wrappers / `"已识别请求：…"` templates / 4-space indented code blocks, and supports a `warn: true` flag for honest tool-missing disclaimers. Emits `llm_call_start` / `llm_call_end` observability events under `phase: "direct-answer"`. Non-overridable: `DescriptorRegistry` registers `direct-answer` as a reserved name and rejects business registration / unregistration with `RegistryError.reservedName`. |
| **Phase 8 — Result Validation Outcome** | 🟡 **Partially wired** | `ValidationOutcome` union + `ValidationRuleRegistry` with **5 deterministic rules** via `buildDefaultValidationRuleRegistry()` (`packages/core/src/engine/phases/validation/index.ts`). Optional `ProviderSemanticJudgeAdapter` / `BudgetedSemanticJudgeAdapter`. Engine consumes `retry` (turn loop via `decideTurnRetry`), `degrade` / `handoff` (exit to Output). Gaps: no standalone `ExecutionPolicy` type; runtime provider fallback is not implemented and semantic judge is not production-complete. |
| **Phase 9 — Output Assembly** | ✅ **Implemented** | Content selector: `taskResults['task-direct-answer']` → `{intent, taskResults}` structured JSON (tool-chain success path; semantic polish still depends on real Phase 8) → honest-fallback plain-language message with recognized intent + internal diagnosis + *"rephrase as simple"* suggestion (validation failed). Internal state JSON is never leaked to end users. Covered by `output.test.ts`. |
| Real-world smoke tests against OpenAI / Anthropic / Azure | 🟡 **Manually verified; opt-in automated** | Mock unit tests cover adapters in CI. Maintainers have **hand-run** real LLM paths (custom gateways included). An **opt-in** scripted e2e exists — set `TACHU_REAL_E2E=1` plus `TACHU_E2E_API_KEY` / `TACHU_E2E_API_BASE` / `TACHU_E2E_PROVIDER` (see [Contributing](./CONTRIBUTING.md)) — but default CI does not publish signed recordings. |
| Production hardening (SLO, error budgets, failure injection, signed provenance) | 🔴 Not yet | Target for `1.0.0` (Tachu v1). |

Legend: ✅ implemented and tested · 🟡 stub / placeholder present, real implementation in progress · 🔴 not yet started.

---

## Key Features

- **9-Phase Execution Pipeline** — session management → safety → intent analysis (pure classification) → pre-check → planning router → DAG validation → execution → result validation outcome → output normalization; each phase is a typed, hookable stage, and every request — simple or complex — flows through all nine phases with uniform Rules / Hooks / Observability / budget accounting
- **Task Planning + Tool-use Loop** — Phase 5 does not precompute a ranked multi-step plan. It routes `simple` requests to `direct-answer`, routes `complex + visible tools` into the built-in `tool-use` Agentic Loop, and lets that loop perform iterative LLM tool selection → gated tool execution → tool-result feedback → final answer.
- **`direct-answer` built-in Sub-flow** — answers to simple requests (and to complex requests with no matching tool) are produced by a first-class engine-internal Sub-flow running in Phase 7, not baked into the intent prompt.
- **Dual-Plane Matching** — semantic discovery (vector similarity) + deterministic execution gate (scopes, whitelist, approval) for every Rule, Skill, Tool, and Agent
- **Four Core Abstractions** — declare Rules, Skills, Tools, and Agents as Markdown + YAML frontmatter descriptors; the engine resolves, activates, and orchestrates them automatically
- **OpenAI & Anthropic Adapters** — streaming, function calling, configurable `baseURL` / `organization` / `timeoutMs`; works with Azure OpenAI, LiteLLM, OpenRouter, or any self-hosted gateway
- **MCP Integration** — connect any MCP server (stdio or SSE) via `McpToolAdapter`; MCP tools become first-class engine Tools
- **Token-Precise Prompt Assembly** — tiktoken-based exact token counting; KV-cache-friendly prompt layout; automatic context compression (Head-Middle-Tail strategy)
- **Structured Memory** — session context window with configurable limits; archive-before-summarize guarantee; vector recall for long-term memory
- **OpenTelemetry Observability** — every phase entry/exit, LLM call, tool call, retry, and fallback emits a structured `EngineEvent`; OTel and JSONL emitters included
- **Interactive CLI** — `tachu chat` / `tachu run` / `tachu init` with full parameter sets, streaming render, session persistence, and Ctrl+C cancellation
- **Terminal Markdown rendering** — final assistant replies are rendered via `marked` + `marked-terminal` + `cli-highlight`; headings, bold / italic, lists, block quotes, links, tables and fenced code blocks (with syntax highlighting) are all supported. Automatically disabled under `NO_COLOR` / non-TTY / `--no-color`; explicitly controllable with `--markdown` / `--no-markdown` on `tachu run`.
- **Fail-Closed Safety Baseline** — loop protection, budget circuit-breaker, and basic input validation are hardwired into the engine and cannot be disabled
- **Qdrant & LocalFs Vector Stores** — plug in Qdrant for multi-process deployments or use the file-backed store for local/single-process setups

---

## Vision

> *太初有道，万物之始。以声明式描述符创造 Agent 万物。*
> *In the beginning was the Tao — all things arise from it. With declarative descriptors, conjure Agent capability from nothing.*

The long-term vision of Tachu is a universal Agent framework where **the engine provides the skeleton and business provides the blood**: any organization can build production-grade agentic systems on top of a stable, observable, auditable foundation without re-solving the hard problems of safety, context management, retry logic, and multi-provider orchestration every time.

Tachu is built around three convictions:

1. **The Harness is the hard part.** Model intelligence is commoditized; reliable orchestration is not. Tachu invests deeply in the engine infrastructure so application developers can focus on domain logic.
2. **Declaration over implementation.** Rules, Skills, Tools, and Agents are declared as plain Markdown files. The engine resolves them. No framework-specific boilerplate.
3. **Observable by default.** Every internal event is structured and emittable. Production systems need complete traces — Tachu provides them without opt-in instrumentation.

---

## Core Abstractions

Rules, Skills, Tools, and Agents are Markdown + YAML descriptors. Semantic discovery proposes candidates; deterministic gates authorize execution (especially Tools).

Details: [Overview · abstractions](./docs/overview-design.md#三四大核心抽象) · [Dual-plane matching](./docs/overview-design.md#共享特性).

---

## Architecture (summary)

Requests flow through a **9-phase pipeline**. Complex tool work enters the built-in `tool-use` loop in Phase 7.

Details: [Pipeline phases](./docs/architecture/pipeline-phases.md) · [Overview design](./docs/overview-design.md).

---

## Installation

Tachu requires [Bun](https://bun.sh) as the runtime.

> **Install via the `@rc` dist-tag** (or an exact version) until Tachu reaches stable.

```bash
# Install the engine core
bun add @tachu/core@rc

# Install the extensions library (providers, tools, backends, vector stores)
bun add @tachu/extensions@rc

# Install and use the CLI globally
bun add -g @tachu/cli@rc
```

After global installation, verify with:

```bash
tachu --version   # expect 1.0.0-rc.0 or newer
```

---

## Quick Start

### CLI

```bash
# 1. Initialize a new project workspace
tachu init --template minimal --provider openai

# 2. Set your API key (used by the OpenAI provider adapter)
export OPENAI_API_KEY=sk-...

# 3. Run a single prompt
tachu run "Summarize the last 5 git commits in this repository"

# 4. Start an interactive chat session
tachu chat

# Resume the most recent session
tachu chat --resume
```


Programmatic embedding: see [Configuration](./docs/guides/configuration.md) and `@tachu/host-defaults`.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Overview Design](./docs/overview-design.md) | Vision, layers, abstractions, pipeline concepts |
| [Detailed Design](./docs/detailed-design.md) | Types, modules, configuration schema |
| [Technical Design](./docs/technical-design.md) | Engineering structure and implementation guide |
| [Pipeline phases](./docs/architecture/pipeline-phases.md) | 9-phase pipeline and tool-use loop |
| [Package layout](./docs/architecture/package-layout.md) | Monorepo packages and dependencies |
| [Design principles](./docs/architecture/design-principles.md) | Core engineering principles |
| [CLI reference](./docs/guides/cli.md) | All commands and flags |
| [Configuration](./docs/guides/configuration.md) | `tachu.config.ts` / `EngineConfig` |
| [Providers & integrations](./docs/guides/providers-and-integrations.md) | LLM, MCP, vector stores |
| [Extension guide](./docs/guides/extension-guide.md) | Rules, Skills, Tools, Agents |
| [Observability & safety](./docs/guides/observability-and-safety.md) | OTel, events, safety |
| [CONTEXT.md](./CONTEXT.md) | Product vocabulary |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development workflow |
| [Web Fetch Server](./packages/web-fetch-server/README.md) | Optional browser sidecar |

---

## Web Fetch Server (optional)

For browser-backed `web-fetch` / `web-search`, run the private sidecar — see [packages/web-fetch-server/README.md](./packages/web-fetch-server/README.md).

```bash
bun run dev:server:install-browser
bun run dev:server
```

---

## License

[Apache License 2.0](./LICENSE) © 2026 Tachu Contributors

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this project except in compliance with the License. A copy of the License is included in the [LICENSE](./LICENSE) file or may be obtained at <http://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
