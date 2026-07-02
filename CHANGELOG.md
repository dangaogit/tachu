# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-rc.10] - 2026-07-03

### Changed

#### `@tachu/core`

- **ADR-0006 — deep single loop refactor**: the 9-phase homogeneous pipeline collapsed into "one deep `tool-use` agentic loop as the sole execution spine + a loop-lifecycle guard/mount surface". `EnginePhase` converged from 9 to 6 (`session · safety · tool-routing · execution · validation · output`). See ADR-0006 (`tachu-docs/adr/decisions/0006-loop-lifecycle-harness-surface.md`).
- `HookPoint` redefined from 14 phase-named points (of which only `afterPlanning` ever fired) to 9 loop-lifecycle events: `turnStart · preLLM · postLLM · preToolUse · postToolUse · turnStop · preSubagent · postSubagent · preCompact`, each with a real fire site and tests.
- `RuleScope` collapsed from 7 phase names to the loop-lifecycle vocabulary `{ turnStart, preLLM, turnStop, * }`, shared with `HookPoint`; output-format rules move to `preLLM` and shape the `terminalDraft` directly.
- Added a symmetric `Guardrail` seam (`types/guardrail.ts`) mounted at `turnStart` (pre-guard, default `SafetyModule` baseline) and `turnStop` (post-guard, default Result Validation), fail-closed with `pass / block / degrade / annotate` semantics.
- Added the Engine Seatbelt: after each free-mutation hook (`preLLM`/`postLLM`) the engine runs a structural normalize/re-validate so a malformed conversation never reaches the Provider.
- Added per-step context compaction (`preCompact`) inside the loop, replacing the single pre-loop context-budget decision.
- Added the built-in Task-style `dispatch_agent` tool for read-only subagent dispatch, governed by the Single-Writer Rule (`maxDepth` defaults to 1).

### Removed

#### `@tachu/core`

- Removed the standalone `intent` (LLM simple/complex classification), `precheck`, `planning`, and `graph-check` phases (`intent.ts` / `precheck.ts` / `planning.ts` / `graph-check.ts` and their tests physically deleted); their routing role is now covered by the single deterministic `tool-routing` phase.
- Removed the built-in `direct-answer` sub-flow; a no-tool turn is now handled by the `tool-use` loop's first step producing no `tool_call`.
- Removed the `candidate-answer` final-answer writer LLM; the loop's `terminalDraft` is delivered directly as the candidate answer, eliminating format drift.
- Removed `IntentResult.complexity` / `contextRelevance`, `STRONG_*_MARKERS`, and `inferComplexityFallback`; turn-policy-as-LLM-manifest dropped — soft routing moves into the Layered System Prompt while hard tool/skill gating stays deterministic (host explicit selection / config / agent snapshot).
- **Public type-surface consolidation** (BREAKING for downstream importing these types): collapsed `PlanningResult` / `RankedPlan` into a single `ExecutionRoute { tasks; edges; visibleTools? }`; removed the `IntentResult` type entirely (`ToolRoutingPhaseOutput.intent` is now `{ intent: string }`); renamed `ValidationSignals.finalAnswerHasClaims` → `answerHasClaims`; collapsed `ValidationOutcome.target` `same-plan` / `next-plan` → `retry-turn`; renamed the `plan-preview` StreamChunk field `plan` → `route`, `ExecutionState.activePlan` → `activeRoute`, and `ValidationRuleContext.plan` → `route`; removed the dead `tool-use-final-answer` context scope; dropped `planning_issue` from `ValidationResult.diagnosis.type`; removed the internal `buildToolUseLocalFallbackText` soft fallback (validation failure now uses the deterministic `ensureFallbackText` template). See `tachu-docs/migration/loop-refactor-downstream-guide.md` (§ 进一步 API 收敛).

### Notes

- Version bumped to `1.0.0-rc.10` in lockstep across `@tachu/core`, `@tachu/extensions`, `@tachu/host-defaults`, `@tachu/cli`, and `@tachu/web-fetch-server`.
- ADR-0006 records `0.2.0` as its historical design target-release label; the actual published release line is `1.0.0-rc`.

## [1.0.0-rc.2] - 2026-06-13

### Fixed

- Align published `@tachu/*` workspace dependency versions with the lockstep release (extensions, host-defaults, and cli no longer resolve `@tachu/core` to `1.0.0-rc.0` when published as `1.0.0-rc.1`).
- Add release validation that fails when `bun.lock` workspace versions drift from `package.json` after a version bump.

## [1.0.0-rc.1] - 2026-06-13

### Fixed

#### `@tachu/core`

- Load `tiktoken` via static ESM import so Bun `--compile` standalone binaries bundle the tokenizer and WASM instead of silently degrading to byte-estimate token counting.

## [1.0.0-rc.0] - 2026-06-01

### Added

#### `@tachu/core`

- 9-phase execution pipeline with session management, minimum safety, intent analysis, planning, graph validation, sub-task execution, candidate-answer synthesis, result validation, and output normalization.
- Built-in `direct-answer` and `tool-use` sub-flows, including tool-loop execution, streaming deltas, cancellation propagation, and turn retry bookkeeping.
- Descriptor Registry for Rules, Skills, Tools, and Agents, including version-aware descriptor lookup and deterministic activation gates.
- Prompt assembly with token accounting, context budgeting hooks, multimodal resource placeholders, and provider-bound reference materialization.
- Result Validation contracts: `EvidenceEntry`, `ClaimEntry`, `CandidateAnswer`, `ValidationOutcome`, deterministic validation rules, optional semantic judge adapter, and degrade / handoff / retry outcomes.
- Turn Policy support for tool include/exclude, skill pin/exclude, explicit skill priority, final-answer skill inheritance, and visualization metadata passthrough.
- Resource Reference Pool, token-level Resource Demand routing, multimodal memory fidelity for new sessions, and provider image carrier support.

#### `@tachu/extensions`

- OpenAI, Anthropic, Qwen, Gemini, and Mock provider adapters with streaming, tool calling, configurable base URLs, timeouts, and embedding support where implemented.
- Built-in tools for file, terminal, search, web, git, task tracking, and typecheck/test execution workflows.
- MCP stdio and SSE adapters, OpenTelemetry / JSONL emitters, Qdrant and local vector index adapters, and file-backed memory with projection outbox support.

#### `@tachu/host-defaults`

- Shared host wiring for CLI and embedded hosts: provider inference, capability checks, semantic retrieval facade setup, semantic judge resolution, and memory projection stack helpers.

#### `@tachu/cli`

- `tachu init`, `tachu run`, `tachu chat`, and approval-management commands.
- Interactive session persistence, streaming renderer, terminal Markdown rendering, configuration loading, provider setup, and opt-in real-provider end-to-end test path.

#### `@tachu/web-fetch-server`

- Private optional sidecar for browser-backed `web-fetch` and `web-search` workflows, with Playwright-based rendering and Docker runtime alignment.

### Changed

- Workspace packages now publish in lockstep as `1.0.0-rc.0`.
- Public package publish order is `@tachu/core` → `@tachu/extensions` → `@tachu/host-defaults` → `@tachu/cli`.
- Release artifact validation checks public package metadata, mirrored package docs, executable bins, built artifacts, private sidecar exclusion, and Web Fetch Docker / Playwright runtime alignment.
- Package descriptions and install guidance now use release-candidate terminology.

### Known Limitations

- Runtime provider fallback after `ProviderError` is not implemented in this release candidate.
- Semantic judge support is available but not production-complete.
- The Web Fetch sidecar remains private and is not published to npm.
