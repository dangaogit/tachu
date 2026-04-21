# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-alpha.1] - 2026-04-21

First public alpha of the Tachu Agentic Engine. Ships four workspace packages
(`@tachu/core`, `@tachu/extensions`, `@tachu/cli`, `@tachu/web-fetch-server`)
with end-to-end coverage of the descriptor-driven, 9-phase execution pipeline,
the two built-in sub-flows (`direct-answer` / `tool-use`), MCP integration,
vector stores and an optional browser-rendering sidecar.

### Added

#### `@tachu/core`

- **9-phase execution pipeline** — input / intent / planning / task / execution /
  validation / output / observation / archive. Per-phase hooks, streaming events
  (`phase-start` / `phase-end` / `delta` / `tool-call` / `artifact` / `error`
  / `done`) and structured `EngineError` codes for every failure mode.
- **Two built-in sub-flows** — `direct-answer` handles simple intents with
  streaming LLM replies; `tool-use` runs a full agentic loop (tool selection,
  approval, execution, feedback, termination) that shares the same descriptor
  registry and safety controls.
- **Descriptor registry** — declarative schema for tools, rules, providers,
  vector stores, transformers, backends, MCP servers and observability
  emitters; `DescriptorRegistry` resolves runtime handlers and powers the
  capability-driven task planner.
- **Prompt assembler** — deterministic assembly of system rules, retrieval
  context, tool schemas, message history and capability hints, with precise
  token accounting via `tiktoken` and trimming strategies that respect
  provider-reported context windows.
- **Safety & approval** — per-tool approval policy (`auto` / `require-approval`
  / `deny`), redaction hooks, cancellation propagation via `AbortSignal`, and
  structured audit events for every tool call.
- **Observability** — pluggable emitters for OpenTelemetry spans, JSONL event
  logs and console tracing; every phase, tool call and LLM chunk carries a
  trace id.
- **Structured image contract** — `ChatResponse.images` and
  `EngineOutput.metadata.generatedImages` wired through provider adapters,
  sub-flows and output assembly so that text-to-image capabilities surface in
  the same shape regardless of provider.

#### `@tachu/extensions`

- **Provider adapters** — `OpenAIProviderAdapter` (chat, streaming, tools,
  vision, embeddings), `AnthropicProviderAdapter` (chat, streaming, tools,
  vision) and `QwenProviderAdapter` (DashScope chat, streaming, tools,
  embeddings, text-to-image via both `multimodal-generation` and async
  `image-synthesis` endpoints).
- **Nine built-in tools** — `read-file`, `write-file`, `list-dir`,
  `search-code`, `fetch-url`, `web-fetch`, `web-search`, `run-shell`,
  `apply-patch`; each with a descriptor, safety policy
  (`readonly` / `write` / `irreversible`) and unit / integration tests.
- **MCP integration** — `McpStdioAdapter` and `McpSseAdapter` built on the
  official `@modelcontextprotocol/sdk`; declarative `mcpServers` in
  `tachu.config.ts` auto-discovers remote tools, routes calls and tears down
  connections on shutdown.
- **Vector stores** — `LocalFsVectorStore` (on-disk JSON, no external deps) and
  `QdrantVectorStore` (via `@qdrant/js-client-rest`); both implement the same
  `VectorStore` interface exposed by `@tachu/core`.
- **Transformers** — `VisionTransformer` (image captioning through the active
  provider) and `DocumentToTextTransformer` (PDF / DOCX extraction via
  `pdf-parse` and `mammoth`).
- **Observability emitters** — `OtelEmitter` (OTLP traces), `JsonlEmitter`
  (append-only event log) and `ConsoleEmitter` (human-readable debugging).
- **Rule library** — four default rules (reasoning hygiene, tool discipline,
  output format, safety) loadable by descriptor id.

#### `@tachu/cli`

- **`tachu init`** — scaffolds `tachu.config.ts`, `.env.local` template and an
  example skill / rule layout.
- **`tachu run`** — single-shot execution with streaming progress, approval
  UI for write / irreversible tool calls, `--output text|json|jsonl`,
  `--markdown` / `--no-markdown` controls and a `--save-image <path>` flag
  that materialises `EngineOutput.metadata.generatedImages` to disk
  (base64 `data:` URLs and remote URLs both supported).
- **`tachu chat`** — interactive REPL with session persistence under
  `.tachu/sessions/`, `--resume` / `--session <id>`, `--history`, `--export`,
  slash commands (`/help`, `/exit`, `/clear`, `/history`, `/draw` …),
  double-Ctrl+C exit semantics and cancellation of in-flight turns.
- **Terminal Markdown renderer** — final assistant replies rendered via
  `marked` + `marked-terminal` + `cli-highlight`; headings, lists,
  block quotes, links, tables and syntax-highlighted fenced code blocks.
  Automatically disabled under `NO_COLOR`, non-TTY or `--no-color`.
- **Descriptor scanner** — loads `.tachu/` directory contents (skills, rules,
  tools) into the registry at startup.
- **Config loader** — resolves `tachu.config.ts` with type safety, environment
  overlay and helpful error messages on missing required fields.

#### `@tachu/web-fetch-server`

- **Optional HTTP sidecar** for JavaScript-rendered page fetching; consumed by
  the `web-fetch` and `web-search` tools in `@tachu/extensions` via a plain
  REST contract, so the core SDK stays free of browser dependencies.
- **Dual pipeline** — static pipeline (Mozilla Readability + Turndown over
  `linkedom`) for cheap HTML extraction and a browser pipeline
  (`playwright-core` + `playwright-extra` + stealth plugin) for SPAs.
- **Browser pool** — bounded concurrency, per-context idle eviction, SSRF
  guard, per-request token auth and rate limiting.
- **Observability** — structured logging, OTLP metrics / traces and graceful
  shutdown on `SIGINT` / `SIGTERM`.

### Docs

- English README (`README.md`) and Chinese README (`README_ZH.md`) covering
  installation, quick start, package layout, provider setup, MCP config,
  CLI reference, configuration schema, benchmarks and roadmap.
- Architecture Decision Records under `docs/adr/`:
  `architecture-design.md`, `technical-design.md`, `detailed-design.md`,
  and decision records `0001`–`0005` covering the two built-in sub-flows,
  the web fetch server split and the text-to-image routing.
- Apache License 2.0.

[1.0.0-alpha.1]: https://github.com/dangaogit/tachu/releases/tag/v1.0.0-alpha.1
