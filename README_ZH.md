# Tachu

**正在积极开发中的 Agentic 引擎——目标是成为将任何 LLM 变为可靠、可观测 Agent 的 *Harness*。**

[![npm version](https://img.shields.io/npm/v/@tachu/core?label=%40tachu%2Fcore)](https://www.npmjs.com/package/@tachu/core)
[![status: rc](https://img.shields.io/badge/status-rc-blue)](#项目状态project-status)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](#许可证license)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

> **项目状态 —— Release Candidate。** 9 阶段主干、Registry、Prompt 组装、CLI、OpenAI / Anthropic / Qwen / Gemini Adapter、MCP Adapter、向量存储与可观测性 Emitter 已完成接线并有测试覆盖。Phase 3（意图分析）是真实 LLM 调用，Phase 5 会把复杂且具备可见工具的请求路由到内置 `tool-use` loop，Phase 8 运行 deterministic 验证规则并支持可选 semantic judge。Runtime provider fallback 与 semantic judge 生产级策略属于 rc 后续加固。请使用 `@rc` dist-tag 安装。

---

## 什么是 Tachu？

**太初有道，万物之始。以声明式描述符创造 Agent 万物。**

Tachu 的目标是成为一个**你可以基于它做真实产品的 Agentic 引擎**——不是 Demo 玩具，不是 API 薄封装。它是等式 **Agent = Model + Harness** 中的 *Harness*：提供结构骨架（协议、生命周期、安全、记忆、编排），让任何 LLM 都能成为可靠、可观测的 Agent。

引擎本身刻意**不感知业务领域**——它不知道你的业务逻辑、用户身份或领域词汇。取而代之的是，它定义了一套极简的核心抽象（Rules、Skills、Tools、Agents），业务通过这些抽象注入所有智能。Tachu 被设计来处理那些真正困难的部分：9 阶段执行主干、双平面语义匹配、上下文窗口管理、精确 Token 计数的 Prompt 组装、结构化重试/降级、取消传播，以及端到端可观测性。

Tachu 以 Bun 原生 TypeScript Monorepo 形式发布，包含三个已发布包：零依赖引擎核心（`@tachu/core`）、官方扩展库（`@tachu/extensions`），以及完整功能的 CLI 程序（`@tachu/cli`，同时也是参考实现）；另外有 `@tachu/host-defaults` 供 CLI 与嵌入式 host 共享默认装配，以及一个可选的私有 sidecar 包（`@tachu/web-fetch-server`），用于远端浏览器抓取类工具。

---

## 项目状态（Project Status）

**当前发布版本：** `1.0.0-rc.0`（`rc` dist-tag）

**版本术语：** 当前产品线为 **Tachu v1**。Release candidate 是 `1.0.0` 的稳定化构建，不是新的框架代际；`/v1/extract` 等仅为 HTTP API 版本。详见 [详细设计 · 版本与发布术语](docs/detailed-design.md#版本与发布术语必读)。

这是一次**架构骨架**发布——核心基础设施基本就绪，但 Result Validation 与若干生产化闭环仍未完成。下表仅为**可读性索引**；运行时行为、默认值与边界情况以所引用的源码与测试为准，不在此重复展开。

| 能力 | 状态 | 说明 |
|-----|------|-----|
| 9 阶段主干骨架（类型、编排器、状态机、Hook 链路） | ✅ 已实现 | `packages/core/src/engine` |
| Descriptor Registry（Rules / Skills / Tools / Agents） | ✅ 已实现 | Markdown + YAML frontmatter 加载、语义索引、启动校验 |
| Prompt 组装器（tiktoken、KV Cache 友好顺序） | ✅ 已实现 | `packages/core/src/prompt` |
| 任务调度器、DAG 校验、turn/task 重试簿记 | ✅ 已实现 | `packages/core/src/engine/scheduler.ts`；**LLM 失败时的 runtime provider fallback 未接线**（见 [LLM Provider](./docs/guides/providers-and-integrations.md)） |
| Session / Memory / Runtime-state / Safety / Model-router / Provider / Observability / Hooks 八大模块 | ✅ 已实现 | `packages/core/src/modules` |
| OpenAI / Anthropic / Qwen / Mock Provider Adapter | ✅ 已实现 | CLI 经 `@tachu/host-defaults` 自动装配；流式、函数调用、工具 Schema |
| Gemini Provider Adapter | ✅ 已实现（需手动接线） | `@tachu/extensions` 提供 `GeminiProviderAdapter` 与单测；**不会**被 CLI 默认 `buildProviderAdapter` 注册 —— 需 `createEngine(..., { providers: [new GeminiProviderAdapter(...)] })` 显式注入（见 [LLM Provider](./docs/guides/providers-and-integrations.md)） |
| `apiKey` / `baseURL` / `organization` / `timeoutMs` 配置（env var / `tachu.config.ts` / CLI flags） | ✅ 已实现 | 支持 Azure OpenAI / LiteLLM / OpenRouter / 自建网关 |
| 22 个内置 Tools + Terminal / File / Web Backend | ✅ 已实现 | `packages/extensions/src/tools/index.ts` |
| MCP stdio + SSE Adapter | ✅ 已实现 | `packages/extensions/src/mcp` |
| `LocalFsVectorIndexAdapter`（文件持久化）+ `QdrantVectorIndexAdapter`（REST） | ✅ 已实现 | |
| OTel / JSONL Emitter | ✅ 已实现 | |
| `tachu init` / `tachu run` / `tachu chat` CLI、流式渲染、Session 持久化、Ctrl+C 语义 | ✅ 已实现 | |
| **CLI 终端 Markdown 渲染** | ✅ **已实现** | 基于 `marked` + `marked-terminal` + `cli-highlight` 栈。作用于 `tachu chat` / `tachu run --output text` 的最终回复：TTY 环境自动开启，`NO_COLOR` / 非 TTY / `--no-color` 下自动关闭；`tachu run` 支持通过 `--markdown` / `--no-markdown` 显式开关。专用封装 `renderMarkdownToAnsi`（`packages/cli/src/renderer/markdown.ts`），附 12 个单测（`markdown.test.ts`）。 |
| **Phase 3 意图分析（LLM 调用，纯分类）** | ✅ **已实现** | 仅做分类（`IntentResult`）；面向用户的最终答复由 Phase 7 `direct-answer` 负责。**实现：** `packages/core/src/engine/phases/intent.ts`（`INTENT_SYSTEM_PROMPT_BASE`、快速路径、JSON 解析、启发式兜底）；测试：`intent.test.ts`。宿主可 **`config.intent.systemPromptBase`** 完整替换 base；可选追加 few-shot：`config.intent.fewShotExamples`（Agent Context / explicit selections 仍由 core 追加）。 |
| **Phase 5 任务规划（planning router）** | ✅ **已实现** | 强制 `plans[0].tasks.length >= 1`。规则：(1) `simple` 意图 → 单步 `direct-answer` 子流程任务；(2) `complex` + 有可见工具 → 单步 `tool-use` 子流程任务；(3) `complex` + 无可见工具 → 单步 `direct-answer` 子流程任务（携带 `warn: true`）；(4) 后置守护：上游回归导致 `tasks` 为空时自动兜底。多步行为由 `tool-use` 内部承担；未来可以继续演进 Plan Preview / Human Review，但主路径不存在单独的默认 LLM 预规划器。 |
| **`direct-answer` 内置子流程（Phase 7）** | ✅ **已实现** | `packages/core/src/engine/subflows/direct-answer.ts`。解析 `capabilityMapping.intent`（未命中时回退到 `fast-cheap`），组合 system + ≤10 条历史 + 用户 prompt，以合并后的 AbortSignal 调用 `ProviderAdapter.chat()`，单次超时 60s。System Prompt 强制**自然语言 + Markdown**、禁止 JSON 壳 / `"已识别请求：…"` 模板 / 4 空格缩进式代码块；`warn: true` 时子流程会坦诚说明"当前无匹配工具"。observability 事件统一以 `phase: "direct-answer"` 发出（`llm_call_start` / `llm_call_end`）。保留名机制：`DescriptorRegistry` 会把 `direct-answer` 列入保留名，业务侧注册 / 注销同名描述符将抛 `RegistryError.reservedName`。 |
| **Phase 8 结果验证 Outcome** | 🟡 **部分接线** | `ValidationOutcome` 联合类型 + `ValidationRuleRegistry`（**5 条 deterministic rules**，见 `buildDefaultValidationRuleRegistry()`，`packages/core/src/engine/phases/validation/index.ts`）。可选 `ProviderSemanticJudgeAdapter` / `BudgetedSemanticJudgeAdapter`。Engine 消费 `retry`（turn 循环，`decideTurnRetry`）、`degrade` / `handoff`（退出到 Output）。缺口：无独立 `ExecutionPolicy` 类型；runtime provider fallback 未实现，semantic judge 尚非 production-complete。 |
| **Phase 9 输出装配** | ✅ **已实现** | 内容选择顺序：`taskResults['task-direct-answer']` → 结构化 `{intent, taskResults}` JSON（工具链成功路径；语义层面的润色仍依赖真实 Phase 8）→ 中文诚实回退文案（validation 未通过）。内部 state JSON 不会再外泄到用户侧。专项测试见 `output.test.ts`。 |
| 真实环境端到端烟测（OpenAI / Anthropic / Azure 等） | 🟡 **已手工验证；可选脚本化** | CI 内 Adapter 以 Mock 单测为主；维护者已 **手工跑通** 真实 LLM 路径（含自建网关）。仓库提供 **可选** 脚本化 e2e —— 预先配置 `TACHU_REAL_E2E=1` 与 `TACHU_E2E_API_KEY` / `TACHU_E2E_API_BASE` / `TACHU_E2E_PROVIDER`（见[贡献指南](./CONTRIBUTING.md)）—— 但默认 CI 不发布签署记录。 |
| 生产加固（SLO、错误预算、故障注入、签名 provenance） | 🔴 未开展 | `1.0.0`（Tachu v1）目标。 |

图例：✅ 已实现并有测试 · 🟡 骨架存在、真实实现进行中 · 🔴 未开工。

---

## 核心亮点（Key Features）

- **9 阶段执行主干** — 会话管理 → 安全准入 → 意图分析（纯分类）→ 前置校验 → planning router → DAG 校验 → 子任务执行 → 结果验证 outcome → 输出规范；每个阶段类型安全、可挂钩，且每个请求（simple 或 complex）都会完整穿过 9 个阶段，Rules / Hooks / Observability / 预算熔断统一生效
- **任务计划 + 工具循环（Task Planning + Tool-use Loop）** — Phase 5 不预先生成完整的排序多步计划，而是把 `simple` 请求路由到 `direct-answer`，把 `complex + 可见工具` 路由进内置 `tool-use` Agentic Loop，由循环内部完成 LLM 工具选择 → 受控工具执行 → 工具结果回灌 → 最终答复。
- **`direct-answer` 内置子流程** — 对 simple 请求（以及 complex 但无匹配工具的请求），最终答复由一个引擎内置的一等公民子流程在 Phase 7 产出，不再由意图分析阶段捎带。
- **双平面匹配（Dual-Plane Matching）** — 语义发现（向量相似度）+ 确定性执行闸门（Scopes、白名单、审批），作用于所有 Rules、Skills、Tools 和 Agents
- **四大核心抽象** — 以 Markdown + YAML frontmatter 描述符声明 Rules、Skills、Tools、Agents；引擎自动解析、激活并编排
- **OpenAI 与 Anthropic Adapter** — 流式、函数调用、`baseURL` / `organization` / `timeoutMs` 可配置；可对接 Azure OpenAI / LiteLLM / OpenRouter / 任意自建网关
- **MCP 集成** — 通过 `McpToolAdapter` 接入任意 MCP 服务端（stdio 或 SSE）；MCP Tools 成为引擎一等公民
- **精确 Token 计数** — 基于 tiktoken 的精确 Token 统计；KV Cache 友好的 Prompt 布局；自动上下文压缩（Head-Middle-Tail 策略）
- **结构化记忆（Memory System）** — 会话上下文窗口（含可配置上限）；压缩前强制归档；长期向量记忆召回
- **OpenTelemetry 可观测性** — 每个阶段进入/退出、LLM 调用、Tool 调用、重试和降级都产出结构化 `EngineEvent`；内置 OTel 与 JSONL Emitter
- **交互式 CLI** — `tachu chat` / `tachu run` / `tachu init`，完整参数体系、流式渲染、Session 持久化、Ctrl+C 取消传播
- **终端 Markdown 渲染** —— 最终回复由 `marked` + `marked-terminal` + `cli-highlight` 渲染；支持标题、粗体 / 斜体、列表、块引用、链接、表格、带代码高亮的 fenced code block。`NO_COLOR` / 非 TTY / `--no-color` 下自动关闭；`tachu run` 可通过 `--markdown` / `--no-markdown` 显式控制。
- **Fail-Closed 安全基线** — 循环防护、预算熔断、基础输入校验硬编码于引擎核心，不可关闭
- **Qdrant 与 LocalFs 向量存储** — 多进程部署使用 Qdrant，本地/单进程使用文件持久化

---

## 愿景（Vision）

> 太初有道，万物之始。以声明式描述符创造 Agent 万物。

Tachu 的长期愿景是成为**通用 Agent 框架**：**引擎提供骨架，业务填充血肉**——任何组织都能基于稳定、可观测、可审计的基础设施构建生产级 Agentic 系统，而无需每次从头解决安全、上下文管理、重试逻辑和多 Provider 编排等困难问题。

Tachu 基于三个核心信念：

1. **Harness 才是难点。** 模型智能已经商品化；可靠的编排机制尚未。Tachu 深度投资引擎基础设施，让应用开发者专注领域逻辑。
2. **声明优于实现（Declaration over implementation）。** Rules、Skills、Tools、Agents 均以普通 Markdown 文件声明。引擎负责解析。无框架样板代码。
3. **默认可观测。** 每个内部事件都是结构化且可发出的。生产系统需要完整 Trace——Tachu 无需额外埋点即可提供。

---

## 核心抽象（Core Abstractions）

Rule、Skill、Tool、Agent 以 Markdown + YAML 描述符声明。语义发现给出候选，确定性闸门（尤其 Tool）决定是否执行。

详见 [概要设计 · 四大核心抽象](./docs/overview-design.md#三四大核心抽象) · [双平面匹配](./docs/overview-design.md#共享特性)。

---

## 架构概览（摘要）

请求经 **9 阶段主干**；复杂工具任务在 Phase 7 进入内置 `tool-use` Agentic Loop。

详见 [Pipeline 阶段详解](./docs/architecture/pipeline-phases.md) · [概要设计](./docs/overview-design.md)。

---

## 安装（Installation）

Tachu 需要 [Bun](https://bun.sh) 作为运行时。

> **请使用 `@rc` dist-tag 安装**（或固定到具体版本），直至 Tachu 进入稳定版。

```bash
# 安装引擎核心
bun add @tachu/core@rc

# 安装扩展库（Provider、Tools、Backend、向量存储）
bun add @tachu/extensions@rc

# 全局安装 CLI
bun add -g @tachu/cli@rc
```

安装完成后验证：

```bash
tachu --version   # 预期输出 1.0.0-rc.0 或更新
```

---

## 快速开始（Quick Start）

### CLI 方式

```bash
# 1. 初始化项目工作空间
tachu init --template minimal --provider openai

# 2. 设置 API Key
export OPENAI_API_KEY=sk-...

# 3. 单次执行 Prompt
tachu run "帮我总结最近 5 条 git commit 的内容"

# 4. 进入交互式对话
tachu chat

# 恢复最近一次 Session
tachu chat --resume
```


编程式接入见 [配置](./docs/guides/configuration.md) 与 `@tachu/host-defaults`。

---

## 文档（Documentation）

| 文档 | 说明 |
|------|------|
| [概要设计](./docs/overview-design.md) | 愿景、分层、抽象、主干流程 |
| [详细设计](./docs/detailed-design.md) | 类型、模块、配置 Schema |
| [技术设计](./docs/technical-design.md) | 工程结构与实现指南 |
| [Pipeline 阶段详解](./docs/architecture/pipeline-phases.md) | 9 阶段与 tool-use 循环 |
| [包结构](./docs/architecture/package-layout.md) | Monorepo 包与依赖 |
| [设计原则](./docs/architecture/design-principles.md) | 核心工程原则 |
| [CLI 参考](./docs/guides/cli.md) | 命令与参数 |
| [配置](./docs/guides/configuration.md) | `tachu.config.ts` |
| [Provider 与集成](./docs/guides/providers-and-integrations.md) | LLM、MCP、向量库 |
| [扩展指南](./docs/guides/extension-guide.md) | Rule / Skill / Tool / Agent |
| [可观测性与安全](./docs/guides/observability-and-safety.md) | 事件、OTel、安全 |
| [CONTEXT.md](./CONTEXT.md) | 产品术语 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发流程 |
| [Web Fetch Server](./packages/web-fetch-server/README.md) | 可选 sidecar |

---

## Web Fetch Server（可选）

浏览器渲染的 `web-fetch` / `web-search` 需可选 sidecar，见 [packages/web-fetch-server/README.md](./packages/web-fetch-server/README.md)。

```bash
bun run dev:server:install-browser
bun run dev:server
```

---

## 许可证（License）

[Apache License 2.0](./LICENSE) © 2026 Tachu Contributors

本项目采用 Apache License 2.0 许可证发布。许可证全文见 [LICENSE](./LICENSE) 文件，也可在 <http://www.apache.org/licenses/LICENSE-2.0> 获取。

除非适用法律要求或书面同意，按照本许可证分发的软件是按"原样"分发的，不附带任何明示或暗示的担保或条件。请参阅许可证以了解特定语言的管理权限和限制。
