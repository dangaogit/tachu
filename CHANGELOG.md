# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
