# Tachu

**An agentic engine under active development — the *Harness* that aims to turn any LLM into a reliable, observable Agent.**

[![npm version](https://img.shields.io/npm/v/@tachu/core?label=%40tachu%2Fcore)](https://www.npmjs.com/package/@tachu/core)
[![status: rc](https://img.shields.io/badge/status-rc-blue)](#project-status)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](#license)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

> **Project Status — Release Candidate.** The engine follows a **loop spine**: `turnStart` guard → deterministic `tool-routing` prep → the **`tool-use` deep single agentic loop** (the only multi-step LLM decision surface) → `turnStop` validation → output normalization. Registry, prompt assembler, CLI, OpenAI / Anthropic / Qwen / Gemini adapters, MCP adapters, vector stores and observability emitters are wired up and tested. `tool-routing` makes no LLM call and always constructs a single `tool-use` task; inside the loop the LLM decides whether to call tools, dispatch a read-only sub-agent, or answer directly; `validation` runs deterministic rules (with optional semantic judge) as a `turnStop` guard via the unified `HookAction` seam. Runtime provider fallback and semantic judge production hardening remain post-rc work. Install via the `@rc` dist-tag.

---

## What is Tachu?

Tachu aims to be an **agentic engine you can build a real product on** — not a toy demo, not a thin wrapper. It is the *Harness* in the equation **Agent = Model + Harness**: it provides the structural skeleton (protocol, lifecycle, safety, memory, orchestration) so that any LLM becomes a reliable, observable Agent.

The engine is intentionally **domain-agnostic**: it knows nothing about your business logic, your users, or your domain vocabulary. Instead, it defines a small set of core abstractions (Rules, Skills, Tools, Agents) through which your business fills in all the intelligence. Tachu is designed to handle the hard parts — a deep single agentic loop with a loop-lifecycle guard surface, dual-plane semantic matching, context window management, token-precise prompt assembly, structured retry/fallback, cancellation propagation, and end-to-end observability.

Tachu ships as a Bun-native TypeScript monorepo with three published packages — the zero-dependency engine core (`@tachu/core`), an official extensions library (`@tachu/extensions`), and a fully-featured CLI program (`@tachu/cli`) that doubles as the reference implementation — plus `@tachu/host-defaults` for shared CLI/embedded host wiring, and an optional private sidecar package (`@tachu/web-fetch-server`) for remote browser-backed web tools.

---

## Project Status

**Current release:** `1.0.0-rc.13` on the `rc` dist-tag.

**Version terminology:** The product line is **Tachu v1**. Release candidates are stabilization builds for `1.0.0`, not a separate framework generation. HTTP paths like `/v1/extract` are API versions only. See [detailed-design § version glossary](docs/detailed-design.md#版本与发布术语必读).

This is a **release candidate**. The table below is a readability index only; runtime behavior, defaults, and edge cases are authoritative in the cited source files and tests.

| Capability | Status | Notes |
|-----------|--------|-------|
| Loop spine + deep single agentic loop (orchestrator, state machine, 9 loop-lifecycle hooks) | ✅ Implemented | `packages/core/src/engine`; internal modules still map to `EnginePhase` (`session/safety/tool-routing/execution/validation/output`); public narrative uses loop-lifecycle vocabulary |
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
| **`tool-routing` — deterministic routing (no LLM call)** | ✅ **Implemented** | Replaces the former `intent`/`precheck`/`planning`/`graph-check` phases (physically deleted). Always constructs a single `RankedPlan` (`rank: 1`) with one `{ type: "sub-flow", ref: "tool-use" }` task, narrows the visible tool set via `ToolActivator.visibleTools`, and runs a minimal dependency-graph check inline (`validatePlan`). **Implementation:** `packages/core/src/engine/phases/tool-routing.ts`; tests: `tool-routing.test.ts`. |
| **`tool-use` — deep single agentic loop (唯一主干)** | ✅ **Implemented** | The LLM decides each turn whether to call tools, dispatch a read-only sub-agent (`dispatch_agent`), or answer directly — a tool-call-free turn naturally becomes the final answer (`terminalDraft`), so there is no separate "direct answer" sub-flow. Loop-lifecycle hooks (`turnStart`/`preLLM`/`postLLM`/`preToolUse`/`postToolUse`/`turnStop`/`preSubagent`/`postSubagent`/`preCompact`) fire at every step; per-step context-budget auto-compact and a `shortTaskRoute` cheap-model fast path are built in. **Implementation:** `packages/core/src/engine/subflows/tool-use.ts`. |
| **Subagent dispatch (`dispatch_agent`, ADR-0006 D6)** | ✅ **Implemented** | Built-in Task-style tool lets the loop LLM spawn a **read-only** sub-agent (Single-Writer Rule: `allowedTools` deterministically filtered to `readonly`, fail-closed for unknown tools); returns a **summary-only** result (`output` + `evidence`, no full sub-loop transcript); `maxDepth` defaults to `1` (no nested spawning). |
| **`turnStop` guard — Result Validation** | 🟡 **Partially wired** | `ValidationOutcome` union + `ValidationRuleRegistry` with **5 deterministic rules** via `buildDefaultValidationRuleRegistry()` (`packages/core/src/engine/phases/validation/index.ts`), surfaced at `turnStop` via the unified `HookAction` guard seam (`{ type: "guard"; decision: pass/block/degrade/annotate }`). Optional `ProviderSemanticJudgeAdapter` / `BudgetedSemanticJudgeAdapter`. Engine consumes `retry` via a turn-level do-while loop (`decideTurnRetry`, opt-in via `runtime.maxTurnRetries`, default `0`), `degrade` / `handoff` (exit to `output`). Gaps: runtime provider fallback is not implemented and semantic judge is not production-complete. |
| **`output` — Output Assembly** | ✅ **Implemented** | Content selector: `candidateAnswer.content` (the loop's `terminalDraft`, validation passing) → agent-dispatch synthesis text → `{intent, taskResults}` structured JSON (fallback path) → honest local-template fallback (validation failed; **never** calls an LLM per ADR-0006 D4). Internal state JSON is never leaked to end users. Covered by `output.test.ts`. |
| Real-world smoke tests against OpenAI / Anthropic / Azure | 🟡 **Manually verified; opt-in automated** | Mock unit tests cover adapters in CI. Maintainers have **hand-run** real LLM paths (custom gateways included). An **opt-in** scripted e2e exists — set `TACHU_REAL_E2E=1` plus `TACHU_E2E_API_KEY` / `TACHU_E2E_API_BASE` / `TACHU_E2E_PROVIDER` (see [Contributing](./CONTRIBUTING.md)) — but default CI does not publish signed recordings. |
| Production hardening (SLO, error budgets, failure injection, signed provenance) | 🔴 Not yet | Target for `1.0.0` (Tachu v1). |

Legend: ✅ implemented and tested · 🟡 stub / placeholder present, real implementation in progress · 🔴 not yet started.

---

## Key Features

- **Deep Single Agentic Loop** — `turnStart` → safety → deterministic `tool-routing` → the `tool-use` loop → `turnStop` validation → output; every request follows the same **loop spine** with Rules / Hooks / Observability / budget accounting mounted on loop-lifecycle events; multi-step LLM decisions happen only inside the loop (see [ADR-0006](https://github.com/tachu-project/tachu-docs/blob/main/adr/decisions/0006-loop-lifecycle-harness-surface.md))
- **Loop-Lifecycle Guard Surface** — 9 hook points (`turnStart`/`preLLM`/`postLLM`/`preToolUse`/`postToolUse`/`turnStop`/`preSubagent`/`postSubagent`/`preCompact`) replace the old per-phase hooks; pre/post guards at `turnStart`/`turnStop` use the unified `HookAction` seam (`guard`/`finding`/`mutate`/`approve`/`deny`, fail-closed) with built-in SafetyModule baseline and Result Validation
- **Subagent Dispatch** — the loop LLM can spawn a read-only sub-agent via the built-in `dispatch_agent` tool (Single-Writer Rule, summary-only contract, `maxDepth` defaults to 1)
- **Dual-Plane Matching** — semantic discovery (vector similarity) + deterministic execution gate (scopes, whitelist, approval) for every Rule, Skill, Tool, and Agent
- **Four Core Abstractions** — declare Rules, Skills, Tools, and Agents as Markdown + YAML frontmatter descriptors; the engine resolves, activates, and orchestrates them automatically
- **OpenAI & Anthropic Adapters** — streaming, function calling, configurable `baseURL` / `organization` / `timeoutMs`; works with Azure OpenAI, LiteLLM, OpenRouter, or any self-hosted gateway
- **MCP Integration** — connect any MCP server (stdio or SSE) via `McpToolAdapter`; MCP tools become first-class engine Tools
- **Token-Precise Prompt Assembly** — tiktoken-based exact token counting; KV-cache-friendly prompt layout; automatic context compression (Head-Middle-Tail strategy)
- **Structured Memory** — session context window with configurable limits; archive-before-summarize guarantee; vector recall for long-term memory
- **OpenTelemetry Observability** — loop-spine vocabulary first: `loop_step_enter`/`loop_step_exit` (in-turn module boundaries), flat per-step loop events (`tool_loop_step_*` / `tool_call_*` / `llm_call_*` / `hook_fired`) with `parentStepId` correlation; retry and fallback all emit structured `EngineEvent`s; OTel and JSONL emitters included
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

Every request follows the **loop spine**: `turnStart` guard → deterministic `tool-routing` → the built-in **`tool-use` deep single agentic loop** (the only multi-step LLM surface) → `turnStop` validation → output. Cross-cutting concerns (Rules / Hooks / budget / observability) mount on 9 loop-lifecycle events, not the old phase pipeline.

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
tachu --version   # expect 1.0.0-rc.13 or newer
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
| [Pipeline & loop spine](./docs/architecture/pipeline-phases.md) | Loop lifecycle, hook mount surface, and the tool-use deep single loop |
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
