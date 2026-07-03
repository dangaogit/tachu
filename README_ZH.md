# Tachu

**正在积极开发中的 Agentic 引擎——目标是成为将任何 LLM 变为可靠、可观测 Agent 的 *Harness*。**

[![npm version](https://img.shields.io/npm/v/@tachu/core?label=%40tachu%2Fcore)](https://www.npmjs.com/package/@tachu/core)
[![status: rc](https://img.shields.io/badge/status-rc-blue)](#项目状态project-status)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](#许可证license)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)

> **项目状态 —— Release Candidate。** 引擎以 **loop spine** 为执行主轴：`turnStart` 守卫 → 确定性 `tool-routing` 预处理 → **`tool-use` 深单 agentic loop**（唯一多步 LLM 决策面）→ `turnStop` 结果验证 → 输出规范。Registry、Prompt 组装、CLI、OpenAI / Anthropic / Qwen / Gemini Adapter、MCP Adapter、向量存储与可观测性 Emitter 已完成接线并有测试覆盖。`tool-routing` 不含 LLM 调用，恒构造单个 `tool-use` 任务；loop 内 LLM 自主决定调用工具、派发只读 subagent 还是直接作答；`validation` 经统一 `HookAction` guard seam 在 `turnStop` 运行 deterministic 规则并支持可选 semantic judge。Runtime provider fallback 与 semantic judge 生产级策略属于 rc 后续加固。请使用 `@rc` dist-tag 安装。

---

## 什么是 Tachu？

**太初有道，万物之始。以声明式描述符创造 Agent 万物。**

Tachu 的目标是成为一个**你可以基于它做真实产品的 Agentic 引擎**——不是 Demo 玩具，不是 API 薄封装。它是等式 **Agent = Model + Harness** 中的 *Harness*：提供结构骨架（协议、生命周期、安全、记忆、编排），让任何 LLM 都能成为可靠、可观测的 Agent。

引擎本身刻意**不感知业务领域**——它不知道你的业务逻辑、用户身份或领域词汇。取而代之的是，它定义了一套极简的核心抽象（Rules、Skills、Tools、Agents），业务通过这些抽象注入所有智能。Tachu 被设计来处理那些真正困难的部分：深单 agentic loop + loop-lifecycle 守卫面、双平面语义匹配、上下文窗口管理、精确 Token 计数的 Prompt 组装、结构化重试/降级、取消传播，以及端到端可观测性。

Tachu 以 Bun 原生 TypeScript Monorepo 形式发布，包含三个已发布包：零依赖引擎核心（`@tachu/core`）、官方扩展库（`@tachu/extensions`），以及完整功能的 CLI 程序（`@tachu/cli`，同时也是参考实现）；另外有 `@tachu/host-defaults` 供 CLI 与嵌入式 host 共享默认装配，以及一个可选的私有 sidecar 包（`@tachu/web-fetch-server`），用于远端浏览器抓取类工具。

---

## 项目状态（Project Status）

**当前发布版本：** `1.0.0-rc.12`（`rc` dist-tag）

**版本术语：** 当前产品线为 **Tachu v1**。Release candidate 是 `1.0.0` 的稳定化构建，不是新的框架代际；`/v1/extract` 等仅为 HTTP API 版本。详见 [详细设计 · 版本与发布术语](docs/detailed-design.md#版本与发布术语必读)。

这是一次**架构骨架**发布——核心基础设施基本就绪，但 Result Validation 与若干生产化闭环仍未完成。下表仅为**可读性索引**；运行时行为、默认值与边界情况以所引用的源码与测试为准，不在此重复展开。

| 能力 | 状态 | 说明 |
|-----|------|-----|
| Loop spine + 深单 agentic loop（编排器、状态机、9 个 loop-lifecycle Hook） | ✅ 已实现 | `packages/core/src/engine`；内部模块仍映射 `EnginePhase`（`session/safety/tool-routing/execution/validation/output`），对外叙事以 loop 生命周期为准 |
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
| **`tool-routing` 确定性路由（不含 LLM 调用）** | ✅ **已实现** | 取代原 `intent`/`precheck`/`planning`/`graph-check` 四个 phase（均已物理删除）。恒产出单个 `RankedPlan`（`rank: 1`），内含一个 `{ type: "sub-flow", ref: "tool-use" }` 任务；经 `ToolActivator.visibleTools` 收窄工具集，并内联做最小依赖图校验（`validatePlan`）。**实现：** `packages/core/src/engine/phases/tool-routing.ts`；测试：`tool-routing.test.ts`。 |
| **`tool-use` 深单 agentic loop（唯一主干）** | ✅ **已实现** | 每一步由 LLM 自主决定调用工具、派发只读 subagent（`dispatch_agent`）还是直接作答——无工具调用的一步自然成为终答（`terminalDraft`），因此不再有独立的"直接回答"子流程。loop-lifecycle 9 个 Hook（`turnStart`/`preLLM`/`postLLM`/`preToolUse`/`postToolUse`/`turnStop`/`preSubagent`/`postSubagent`/`preCompact`）在每一步触发；内置 per-step 上下文预算自动压缩与 `shortTaskRoute` 低价模型快速路径。**实现：** `packages/core/src/engine/subflows/tool-use.ts`。 |
| **Subagent 派发（`dispatch_agent`，ADR-0006 D6）** | ✅ **已实现** | 内置 Task-style 工具，允许 loop LLM 派发**只读** subagent（Single-Writer Rule：`allowedTools` 确定性过滤为 `readonly`，未知工具 fail-closed 排除）；返回**summary-only** 结果（`output` + `evidence`，不含完整子 loop transcript）；`maxDepth` 默认 `1`（禁止嵌套派发）。 |
| **`turnStop` guard —— 结果验证** | 🟡 **部分接线** | `ValidationOutcome` 联合类型 + `ValidationRuleRegistry`（**5 条 deterministic rules**，见 `buildDefaultValidationRuleRegistry()`，`packages/core/src/engine/phases/validation/index.ts`），经统一 `HookAction` guard seam（`{ type: "guard"; decision: pass/block/degrade/annotate }`）挂载在 `turnStop`。可选 `ProviderSemanticJudgeAdapter` / `BudgetedSemanticJudgeAdapter`。Engine 通过 turn 级 do-while 循环消费 `retry`（`decideTurnRetry`，经 `runtime.maxTurnRetries` 显式开启，默认 `0`）、`degrade` / `handoff`（退出到 `output`）。缺口：runtime provider fallback 未实现，semantic judge 尚非 production-complete。 |
| **`output` 输出装配** | ✅ **已实现** | 内容选择顺序：`candidateAnswer.content`（loop 的 `terminalDraft`，validation 通过）→ agent 派发汇总文案 → 结构化 `{intent, taskResults}` JSON（兜底路径）→ 本地确定性模板兜底（validation 未通过；ADR-0006 D4 起**绝不**调用 LLM）。内部 state JSON 不会再外泄到用户侧。专项测试见 `output.test.ts`。 |
| 真实环境端到端烟测（OpenAI / Anthropic / Azure 等） | 🟡 **已手工验证；可选脚本化** | CI 内 Adapter 以 Mock 单测为主；维护者已 **手工跑通** 真实 LLM 路径（含自建网关）。仓库提供 **可选** 脚本化 e2e —— 预先配置 `TACHU_REAL_E2E=1` 与 `TACHU_E2E_API_KEY` / `TACHU_E2E_API_BASE` / `TACHU_E2E_PROVIDER`（见[贡献指南](./CONTRIBUTING.md)）—— 但默认 CI 不发布签署记录。 |
| 生产加固（SLO、错误预算、故障注入、签名 provenance） | 🔴 未开展 | `1.0.0`（Tachu v1）目标。 |

图例：✅ 已实现并有测试 · 🟡 骨架存在、真实实现进行中 · 🔴 未开工。

---

## 核心亮点（Key Features）

- **深单 Agentic Loop** — `turnStart` → 安全准入 → 确定性 `tool-routing` → `tool-use` loop → `turnStop` 验证 → 输出规范；每个请求沿同一 **loop spine** 走通，Rules / Hooks / Observability / 预算熔断挂在 loop-lifecycle 事件上，多步 LLM 决策只发生在 loop 内部（完整动机见 [ADR-0006](https://github.com/tachu-project/tachu-docs/blob/main/adr/decisions/0006-loop-lifecycle-harness-surface.md)）
- **Loop-Lifecycle 守卫面** — 9 个 Hook 点（`turnStart`/`preLLM`/`postLLM`/`preToolUse`/`postToolUse`/`turnStop`/`preSubagent`/`postSubagent`/`preCompact`）取代原先按 phase 挂载的 Hook；`turnStart`/`turnStop` 的 pre/post guard 走统一 `HookAction` seam（`guard`/`finding`/`mutate`/`approve`/`deny`，fail-closed），内置 SafetyModule baseline 与 Result Validation
- **Subagent 派发** — loop 内 LLM 可通过内置 `dispatch_agent` 工具派发只读 subagent（Single-Writer Rule、summary-only 契约、`maxDepth` 默认 1）
- **双平面匹配（Dual-Plane Matching）** — 语义发现（向量相似度）+ 确定性执行闸门（Scopes、白名单、审批），作用于所有 Rules、Skills、Tools 和 Agents
- **四大核心抽象** — 以 Markdown + YAML frontmatter 描述符声明 Rules、Skills、Tools、Agents；引擎自动解析、激活并编排
- **OpenAI 与 Anthropic Adapter** — 流式、函数调用、`baseURL` / `organization` / `timeoutMs` 可配置；可对接 Azure OpenAI / LiteLLM / OpenRouter / 任意自建网关
- **MCP 集成** — 通过 `McpToolAdapter` 接入任意 MCP 服务端（stdio 或 SSE）；MCP Tools 成为引擎一等公民
- **精确 Token 计数** — 基于 tiktoken 的精确 Token 统计；KV Cache 友好的 Prompt 布局；自动上下文压缩（Head-Middle-Tail 策略）
- **结构化记忆（Memory System）** — 会话上下文窗口（含可配置上限）；压缩前强制归档；长期向量记忆召回
- **OpenTelemetry 可观测性** — 以 loop spine 词汇为主：`loop_step_enter`/`loop_step_exit`（turn 内模块边界）、loop 内扁平 per-step 事件（`tool_loop_step_*` / `tool_call_*` / `llm_call_*` / `hook_fired`，以 `parentStepId` 关联）；重试和降级都产出结构化 `EngineEvent`；内置 OTel 与 JSONL Emitter
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

每个请求沿 **loop spine** 走通：`turnStart` 守卫 → 确定性 `tool-routing` → 内置 **`tool-use` 深单 agentic loop**（唯一多步 LLM 决策面）→ `turnStop` 验证 → 输出规范。横切能力（Rules / Hooks / 预算 / 可观测性）挂在 9 个 loop-lifecycle 事件上，而非旧的 phase 流水线。

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
tachu --version   # 预期输出 1.0.0-rc.12 或更新
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
| [Pipeline 与 loop spine](./docs/architecture/pipeline-phases.md) | loop 生命周期、Hook 挂载面与 `tool-use` 深单 loop |
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
