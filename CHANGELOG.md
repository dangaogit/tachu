# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-alpha.6] - 2026-05-15

### Added

#### `@tachu/core`

- **Streaming protocol** — `phase-enter` / `phase-exit` chunks plus `reasoning-delta` streaming aligned with the engine orchestrator.
- **Session scope + model overrides** — `SessionScope` wiring and `modelOverride` resolution through the model router for session/tenant-aware model selection.
- **LLM usage telemetry** — lightweight usage capture with `stepId` attribution for phase-level observability.
- **Multimodal outputs** — `GeneratedMedia`, `EngineOutput.metadata.generatedMedia`, `ChatStreamChunk` `media` parts, and `direct-answer` / engine sinks for non-image artifacts (audio/video/file) alongside legacy `GeneratedImage`.
- **Provider protocol expansion** — optional `embed` / `rerank`, structured-output request metadata, response modalities, `Message` `file` content parts, and opaque `providerMetadata` on messages, tool calls, stream tool deltas, and finish chunks for adapter-specific round-trips (e.g. Gemini thought signatures).

#### `@tachu/extensions`

- **`GeminiProviderAdapter`** — first-party Gemini integration on `@google/genai`, exported from the package entrypoint, with dedicated unit tests.

### Changed

#### `@tachu/core`

- **Tool-use loop** — structured tool results vs final assistant streaming split, parallel tool-approval budgeting with active tool-loop timers, streamed `providerMetadata` merged into persisted assistant tool calls, and streaming correctness fixes.
- **Prompt assembler** — memory history preserves `MessageContentPart[]` when present; `file` parts render as stable placeholders instead of being stringified blindly.

### Housekeeping

- **`.gitignore`** — ignore `docs/superpowers/` for local draft material.

#### Docs

- **README / README_ZH / CHANGELOG** — milestone bumped to `1.0.0-alpha.6` with an English-first release note for this cut.

## [1.0.0-alpha.5] - 2026-05-11

### Added

#### `@tachu/core`

- **Descriptor governance fields** — `BaseDescriptor` 新增可选 `version` / `displayName` / `deprecated` / `deprecatedMessage`，用于版本治理与迁移提示
- **Version-aware registry APIs** — `DescriptorRegistry` 新增 `get(kind,name,version)`、`getLatest(kind,name)`、`listVersions(kind,name)`，支持同名多版本共存与精确查询
- **Timeout policy split** — 新增 `llmWaitFirstTokenMs`、`llmStreamingMs`、`maxToolLoopActiveMs` 三类预算项，并支持 `runtime.timeouts.byPhase` 分阶段覆盖
- **LLM timeout utility layer** — 新增 `engine/llm-timeouts.ts`，统一 LLM 调用超时解析与信号构造

#### `@tachu/extensions`

- **`search-code` regex self-healing** — 当正则语法非法时自动降级为 fixed-string 搜索，减少因参数细节导致的整轮失败

### Changed

#### `@tachu/core`

- **DescriptorRegistry storage model** — 从单一 `name -> descriptor` 升级为 `name -> version -> descriptor`；重复冲突判定调整为 `kind + name + version`
- **Latest selection semantics** — `get(kind,name)` 保持向后兼容但改为 latest 解析（稳定版优先；无稳定版时取最高 pre-release）
- **Unknown field passthrough contract** — `RegistryLoader` 与 `DescriptorRegistry` 明确保留未知顶层字段，`register -> get` 往返不丢失扩展字段
- **Deprecation consistency check** — `deprecated === true` 且缺失 `deprecatedMessage` 时在 `registry.register()` 统一抛出 `RegistryError`
- **Tool-loop budget accounting** — 新增“活跃时长”统计，审批/HITL/交互等待记为阻塞时间并从 tool-loop 预算中扣除

#### `@tachu/cli`

- **`tachu init` template budget defaults** — 默认预算更新为 12h 级运行兜底，并生成 LLM 超时拆分字段与 phase 覆盖注释模板

#### Docs

- **ADR contract updates** — `architecture-design.md` 与 `detailed-design.md` 补充 Descriptor 扩展字段契约与版本治理规则
- **README / README_ZH roadmap** — 当前里程碑更新为 `1.0.0-alpha.5`，新增本版本交付摘要

## [1.0.0-alpha.4] - 2026-05-07

### Added

#### `@tachu/extensions`

- **`edit-file` tool** — 精确字符串替换，含唯一性校验、fuzzy 宽容匹配（行首空白差异）、`replaceAll` 批量替换；错误时返回 `matchCount` 辅助 LLM 调整 `oldString`
- **`multi-edit` tool** — 在同一文件中原子地应用多处字符串替换；任一失败则全部回滚，不写磁盘
- **`glob` tool** — 基于 `Bun.Glob` 的文件名模式查找，支持 `ignore` 排除、`maxResults` 截断
- **`todo-write` / `todo-read` tool** — 会话级任务清单，持久化到 `.tachu/sessions/<id>/todos.json`；`merge=true` 按 id 合并，`false` 全量覆盖
- **`git-status` tool** — `git status --porcelain=v2` 结构化输出，含分支、ahead/behind、staged/unstaged/untracked
- **`git-diff` tool** — 支持 staged / ref 范围 / 指定文件，结构化 `FileDiff[]` 输出
- **`git-log` tool** — 支持 limit/since/until/author/path 过滤，结构化 commit 列表
- **`git-blame` tool** — `--porcelain` 格式逐行 author/commit 映射
- **`git-show` tool** — 单 commit 元信息 + diff，支持 `maxBytes` 截断
- **`git-branch` tool** — 本地/远端分支列表，含 upstream/ahead/behind
- **`run-typecheck` tool** — 自动识别 `typecheck` script 或回退到 `bunx tsc --noEmit`，结构化错误列表（file/line/col/code/severity）
- **`run-tests` tool** — 自动识别 `bun test` 或 `package.json test` script，结构化通过/失败/跳过数和失败用例详情
- **`read-file` 升级** — 新增 `offset`/`limit` 分段读取、`withLineNumbers`（默认 true）6 位右对齐行号前缀；新增出参 `totalLines`/`hasMore`
- **`apply-patch` 升级** — 上下文行宽容匹配（trim + ±3 行偏移容忍），减少 patch 因空白差异导致的 `VALIDATION_PATCH_CONFLICT`

#### `@tachu/cli`

- **授权持久化** — `ApprovalStore` JSONL 持久化（project 级 `.tachu/approvals.jsonl` + user 级 `~/.tachu/approvals.jsonl`）；`ApprovalMatcher` 支持 `any` / `argPattern` / `shellCommand` 三种匹配粒度；user 级路径通过 `new ApprovalStore(cwd, { userStoreDir })` 可注入，便于隔离测试
- **审批提示升级** — 从 `y/N` 扩展为 `y/a/p/s/N`：`[a]` 始终允许工具（项目级）、`[p]` 允许此路径模式（项目级）、`[s]` 仅本 session 内允许；命中持久化授权时自动通过，不弹提示
- **`tachu approval` 子命令组** — `list` / `revoke` / `clear` / `promote` / `add` / `export` / `import` 管理持久化授权记录

#### `@tachu/core`

- **`EngineConfig.intent` 可扩展字段** — `additionalComplexPatterns: string[]`（正则源串，编译后与内置 complex 规则取并集）、`fewShotExamples`（追加到 intent system prompt 末尾的 few-shot 示例）；业务层按领域注入，core 不内置任何领域知识
- **`EngineConfig.toolUse` 可扩展字段** — `systemPromptSuffix: string`，追加到 tool-use system prompt 末尾的补充指令（如编码工作流指南），不污染 core

### Changed

#### `@tachu/core`

- **`runtime.toolLoop.maxSteps` 默认值** 从 8 改为 25，适应复杂代码编写任务（探索→多文件改→typecheck→fix 循环）
- **Intent phase — complex 信号拆分** — `STRONG_COMPLEX_MARKERS` 回归仅含真正普遍的信号（URL / 文件路径 / 反引号命令语法 / 实时数据）；原硬编码的命令名白名单（npm/bun/yarn 等）和领域词汇（package.json、dev script 等）从 core 撤出，改由 `config.intent.additionalComplexPatterns` 注入
- **Tool-use system prompt 架构修正** — 撤回 `### Code editing workflow` 硬编码段（该段直接引用了 extensions 层的工具名，违反层间依赖）；改由 `config.toolUse.systemPromptSuffix` 在 CLI/business 层注入

#### `@tachu/cli`

- **`run-shell` 升级** — 默认 env 白名单扩展（含 `NODE_ENV` / `BUN_INSTALL` / `PNPM_HOME`）；session 级持久 cwd（同 session 内 cd 生效）；内置危险命令黑名单（`rm -rf /`、`| sh` 等）；`TACHU_SHELL_ENV_ALLOWLIST` / `TACHU_SHELL_DENY_PATTERNS` 环境变量可配置
- **工具输出截断提示升级** — `read-file` 截断时给出 `offset/limit` 续读提示；其他工具给出缩小请求范围建议
- **`tachu.config.ts` 参考配置更新** — 通过 `intent.additionalComplexPatterns` 和 `toolUse.systemPromptSuffix` 注入编码 Agent 专用规则，保持 core 边界清晰
- **`tachu init` 模板更新** — 生成的 `tachu.config.ts` 含 `intent` / `toolUse` 注释示例，引导用户按领域扩展而非直接修改 core

## [1.0.0-alpha.3] - 2026-05-07

### Changed

#### `@tachu/core`

- **Internal system prompts** — intent, tool-use, direct-answer and fallback prompts are now English-first with explicit “mirror the user’s language” guidance; reduces prompt tokens and stabilizes instruction following.
- **Intent phase** — fast-path for strong simple vs strong complex heuristics (including timeliness / “current time” style queries) to skip redundant LLM classification when safe.
- **Planning / tool-use** — optional narrowing to `run-shell` for current-time style tasks; `toolLoop.shortTaskRoute` can route short single-tool loops to a `fast-cheap` capability; `safety.shellAutoApprovePatterns` auto-approves matching read-only shell commands (config-driven, validated by schema).
- **Prompt assembler** — tool listing in the system prompt keeps name + description only (drops full JSON Schema) to shrink every request.
- **Usage reporting** — propagates provider `cachedPromptTokens` into orchestrator totals and `OutputMetadata.tokenUsage.cached`.

#### `@tachu/cli`

- **Stream renderer** — shows cached input tokens when present and adjusts the rough cost estimate (cached counted at half weight vs uncached).
- **`tachu init`** — seeds `shortTaskRoute`, `shellAutoApprovePatterns`, and the `respond-in-user-language` rule file in the generated project template.

#### `@tachu/extensions`

- **OpenAI / Anthropic adapters** — map provider cache read fields into `ChatUsage.cachedPromptTokens`.
- **`run-shell` executor** — runs single-string commands that contain shell metacharacters via `/bin/sh -c` so quoting and pipelines work without login-shell profile noise.

## [1.0.0-alpha.2] - 2026-04-28

### Changed

#### `@tachu/core` / `@tachu/extensions`

- **Adapter 调用上下文（TACHU-GAP-01）** — `ProviderAdapter.chat` / `chatStream`、`VectorStore.search` / `hybridSearch`、`MemorySystem.load` / `append` 等 Port 增加 `AdapterCallContext`（`traceId` 必填；`tenant` / `scopeId` 等可选隔离维度）；引擎与阶段环境统一从 `ExecutionContext` 派生并下传。CLI 与测试已对齐新签名。

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

[1.0.0-alpha.6]: https://github.com/dangaogit/tachu/releases/tag/v1.0.0-alpha.6
[1.0.0-alpha.2]: https://github.com/dangaogit/tachu/releases/tag/v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/dangaogit/tachu/releases/tag/v1.0.0-alpha.1
