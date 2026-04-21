# Agentic Engine 技术设计说明书

> 状态：大纲（待逐节评审） 最后更新：2026-04-16

本文档基于 [概要设计](./architecture-design.md) 和 [详细设计](./detailed-design.md) 的决策，给出可直接落地执行的技术方案。

**框架代号：Tachu（太初）** — 太初有道，万物之始。以声明式描述符创造 Agent 万物。

- npm scope：`@tachu/*`
- CLI 命令：`tachu`
- 配置目录：`.tachu/`

---

## 一、技术选型

### 1.1 运行时与语言

**决策：TypeScript + Bun**

- 详细设计全文接口已用 TypeScript 定义，无缝对接
- Bun 原生支持 TS，无需编译步骤即可开发
- Bun 内置测试、包管理、打包，工具链统一
- AI SDK 生态成熟（Vercel AI SDK、LangChain.js 等可参考）
- CLI 场景 Bun 启动速度快

### 1.2 包管理与构建

**决策：Bun workspace（monorepo）**

- Bun 原生支持 workspace，无需额外工具（turborepo / nx 等）
- 产物格式：ESM（`.ts` 直接运行，发包时构建为 `.js` + `.d.ts`）

### 1.3 向量化方案

**决策：内置轻量实现 + 扩展库 Adapter**

- 内置轻量实现：纯 TS 实现的余弦相似度 + 内存索引，零依赖，仅供 demo/调试
- 扩展库：先提供一个常用 Adapter（如 Qdrant 或 OpenAI Embeddings API）

### 1.4 状态存储

**决策：v1 默认内存**

- 运行状态（RuntimeState）：内存存储，v1 够用
- 记忆系统（MemorySystem）：内存 + 文件归档，长期记忆留给扩展库

### 1.5 流式通信

**决策：AsyncIterable / AsyncGenerator**

引擎本身是库，不是服务端：

- 引擎返回 `AsyncIterable<StreamChunk>`，消费方自行决定传输方式
- CLI 直接消费迭代器渲染终端
- 业务需要 SSE/WebSocket 时，由业务层自行桥接

### 1.6 可观测性

**决策：OpenTelemetry 规范**

- 引擎内部按 OTel 规范产出 Span/Event
- 核心只定义 `ObservabilityEmitter` 接口（零依赖）
- OTel SDK 集成放扩展库，业务按需引入

### 1.7 测试框架

**决策：Bun 内置 test runner（`bun test`）**

- 零额外依赖，与运行时统一
- 支持 mock、snapshot、watch 模式

---

## 二、工程结构

### 2.1 Monorepo 目录布局

```
tachu/
├── package.json              # workspace 根配置
├── bunfig.toml               # Bun 配置
├── packages/
│   ├── core/                 # @tachu/core
│   ├── extensions/           # @tachu/extensions
│   └── cli/                  # @tachu/cli
└── docs/
    └── adr/                  # 架构决策记录
```

### 2.2 core 包内部结构

```
core/src/
├── index.ts                  # 统一导出入口
├── types/                    # 核心类型定义
│   ├── descriptor.ts         #   BaseDescriptor / Rule / Skill / Tool / Agent
│   ├── context.ts            #   ExecutionContext / BudgetConstraint
│   ├── io.ts                 #   InputEnvelope / EngineOutput / StreamChunk
│   ├── execution.ts          #   ExecutionUnit / ExecutionTraits
│   └── config.ts             #   EngineConfig
├── engine/                   # 主干流程
│   ├── engine.ts             #   Engine 入口类
│   ├── phases/               #   各阶段实现
│   ├── orchestrator.ts       #   编排控制面
│   └── scheduler.ts          #   依赖调度器
├── registry/                 # 注册中心
├── modules/                  # 8 个核心模块（接口 + 默认实现）
│   ├── session.ts            #   会话管理
│   ├── memory.ts             #   记忆系统
│   ├── runtime-state.ts      #   运行状态
│   ├── model-router.ts       #   模型路由
│   ├── provider.ts           #   模型接入
│   ├── safety.ts             #   安全模块
│   ├── observability.ts      #   可观测性
│   └── hooks.ts              #   生命周期钩子
├── prompt/                   # Prompt 组装
└── vector/                   # VectorStore 接口 + 内置轻量实现
```

### 2.3 extensions 包内部结构

```
extensions/src/
├── providers/                # Provider Adapter（OpenAI / Anthropic 等）
├── tools/                    # 常用 Tools
├── backends/                 # 执行后端（Terminal / Web / File）
├── vector/                   # 向量数据库 Adapter
├── transformers/             # 输入转换器
└── rules/                    # 通用 Rules
```

### 2.4 cli 包内部结构

```
cli/src/
├── index.ts                  # CLI 入口
├── commands/                 # 命令定义
├── interactive.ts            # 终端交互循环
├── renderer.ts               # 流式输出渲染
└── config-loader.ts          # 本地配置加载
```

---

## 三、核心抽象实现

### 3.1 描述符文件格式

所有核心抽象统一使用 **Markdown + YAML frontmatter** 格式，与行业 SKILL.md 规范对齐。

#### 通用格式

```markdown
---
name: unique-name
description: 自然语言描述（用于语义发现）
tags: [tag1, tag2]
trigger: { type: always }
requires:
  - { kind: tool, name: read-file }
# ...各类型专属字段
---

Markdown 正文（内容 / 指令 / 规则文本）
```

- YAML frontmatter 承载结构化元信息（BaseDescriptor + 类型专属字段）
- Markdown body 承载自然语言内容

#### Rules

```markdown
---
name: no-sensitive-output
description: 禁止输出敏感信息
type: rule
scope: [output]
tags: [security]
---

不得在输出中包含 API Key、密码、证书等敏感信息。
违反时应将敏感部分替换为占位符。
```

#### Skills

对齐 SKILL.md 行业标准，支持附属资源目录：

```
skill-name/
├── SKILL.md
└── resources/
    ├── scripts/
    ├── references/
    └── assets/
```

```markdown
---
name: code-review
description: 代码审查技能，提供结构化的代码审查流程和检查清单
tags: [development]
requires:
  - { kind: tool, name: read-file }
---

## 审查流程

1. 先通读变更文件，理解整体意图
2. 按检查清单逐项审查
...
```

#### Tools

```markdown
---
name: read-file
description: 读取指定路径的文件内容
sideEffect: readonly
idempotent: true
requiresApproval: false
timeout: 5000
inputSchema:
  type: object
  properties:
    path: { type: string }
  required: [path]
execute: readFile
---

读取文件并返回文本内容。支持 UTF-8 编码的文本文件。
```

#### Agents

```markdown
---
name: code-assistant
description: 代码辅助 Agent，可阅读代码库并给出修改建议
sideEffect: write
idempotent: false
requiresApproval: false
timeout: 120000
maxDepth: 1
availableTools: [read-file, write-file, search-code]
---

你是一个代码辅助助手。接收用户的代码修改需求后：
1. 先阅读相关代码，理解当前实现
2. 分析修改方案
3. 给出具体的代码变更建议
```

### 3.2 注册中心

- 统一的 `Registry` 类，管理四类描述符的注册/注销/查询
- 启动时批量扫描配置目录，解析 Markdown 文件并注册
- 运行时支持动态注册/注销（如 MCP 工具动态发现）
- 启动校验逻辑（name 唯一性、requires 完整性、失败时向上层确认）
- **内置 Sub-flow 保留名**：
  - 引擎维护一份 `INTERNAL_SUBFLOW_NAMES`（当前为 `['direct-answer', 'tool-use']`）
  - 启动期由引擎自动调用 `Registry.register` 注入占位 descriptor（`kind: 'sub-flow'`）
  - 业务侧调用 `Registry.register` 注册同名 Sub-flow → 抛 `RegistryError.reservedName(name)`
  - 业务侧调用 `Registry.unregister('sub-flow', <reserved>)` → 抛 `RegistryError.reservedName(name)`
  - 真正的执行函数挂在 `InternalSubflowRegistry`（独立于 `Registry`，内置映射不可扩展）

### 3.2.1 `InternalSubflowRegistry`

```typescript
interface InternalSubflowContext {
  providers: Map<string, ProviderAdapter>;
  modelRouter: ModelRouter;
  memorySystem: MemorySystem;
  observability: ObservabilityEmitter;
  config: EngineConfig;
  signal: AbortSignal;
  traceId: string;
  sessionId: string;
  prebuiltPrompt?: AssembledPrompt;
  onProviderUsage?: (usage: ChatUsage) => void;

  // 仅 tool-use 子流程消费
  registry?: Registry;
  taskExecutor?: TaskExecutor;
  executionContext?: ExecutionContext;
  onToolLoopEvent?: (chunk: StreamChunk) => void;
  onToolCall?: (record: ToolCallRecord) => void;
  onBeforeToolCall?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
}

type InternalSubflowHandler = (
  input: Record<string, unknown>,
  ctx: InternalSubflowContext,
) => Promise<string>;

interface InternalSubflowRegistry {
  has(ref: string): boolean;
  execute(ref: string, input: Record<string, unknown>, ctx: InternalSubflowContext): Promise<string>;
}
```

- 启动期硬编码注册 `direct-answer` 与 `tool-use`（见 §4.4 与详细设计 §7.11 / §7.12）
- 不对外暴露 `register` / `unregister` 接口，业务扩展请走普通 Sub-flow 描述符
- 默认 `TaskExecutor`（`Engine.buildLayeredTaskExecutor` 构造）内部持有 `InternalSubflowRegistry` 引用；命中内置 Sub-flow 时把 `registry` / `taskExecutor` / `executionContext` / `onToolLoopEvent` / `onToolCall` / `onBeforeToolCall` 等运行期依赖注入后转交执行，否则回落到业务 fallback executor

### 3.2.2 Provider 协议扩展

`ChatRequest` / `ChatResponse` / `ChatStreamChunk` 原生支持 Function Calling，协议对称，覆盖非流式与流式两种调用：

```typescript
interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];        // 新增：工具声明列表
}

interface ChatResponse {
  content: string;                 // 自然语言回复（可为空，当 toolCalls 非空时）
  usage: ChatUsage;
  toolCalls?: ToolCallRequest[];   // 模型请求调用的工具列表
  finishReason?: ChatFinishReason; // "stop" | "length" | "tool_calls" | "content_filter" | "error"
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;         // 严格 JSON Schema，驱动 Provider 的结构化输出
}

interface ToolCallRequest {
  id: string;                      // 由 Provider 产出的稳定标识，用于绑定后续 tool 消息
  name: string;
  arguments: Record<string, unknown>;
}

type ChatStreamChunk =
  | { type: "delta"; content: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "finish"; finishReason: ChatFinishReason; usage?: ChatUsage };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallRequest[];   // 仅 role === "assistant" 时可填
  toolCallId?: string;              // 仅 role === "tool" 时必填，绑定前一轮的 toolCall.id
  name?: string;                    // 仅 role === "tool" 时填，等于被调用工具的名称
}
```

- 三个内置 Provider Adapter（OpenAI / Anthropic / Mock）都按上述协议实现；Anthropic 的 `tool_use` / `tool_result` block 在 adapter 内被翻译为统一的 `toolCalls` / `tool` 消息语义
- `MockProviderAdapter` 支持 `MockScriptedReply[]`：按序返回预置 `ChatResponse`（含 `toolCalls`），用于驱动 `tool-use` 的单测与集成测试
- 非流式 `chat` 是 `tool-use` 子流程唯一使用的入口——为了避免在流式累积 `tool-call-delta` 时处理边缘态，`tool-use` 故意不走 `chatStream`；`direct-answer` 则保留流式路径

### 3.3 双平面匹配实现

- 语义发现面：向量化可用时走 VectorStore 索引；不可用时降级为全量扫描（遍历描述符做文本匹配）
- Tool 闸门：实现为一条责任链（scopes → 白名单/黑名单 → 审批），每一环返回通过/拒绝

---

## 四、主干流程实现

### 4.1 引擎入口（Engine）

```typescript
class Engine {
  constructor(config: EngineConfig);

  run(input: InputEnvelope, context: ExecutionContext): Promise<EngineOutput>;
  runStream(input: InputEnvelope, context: ExecutionContext): AsyncIterable<StreamChunk>;
  cancel(sessionId: string): void;
}
```

- `run` 内部调用 `runStream` 收集完整结果，保证单一执行路径
- 构造时注入所有模块（Registry、SessionManager、MemorySystem 等），通过 config 装配

### 4.2 阶段编排

各阶段实现为独立函数，由 Engine 按序串联调用：

```typescript
type PhaseHandler<TIn, TOut> = (input: TIn, ctx: PhaseContext) => Promise<TOut>;
```

- 阶段间数据通过明确的输入/输出类型传递，不共享可变状态
- **流水线同构**：所有请求（无论 `complexity`）必须完整穿过 Phase 1–9；不存在"simple 跳过 Phase 4–8"的快速通道
- 每个阶段前后触发对应 HookPoint

### 4.3 意图分析

- 使用 `ModelRouter` 解析 `intent` 能力标签获取模型（未配置时回退到 `fast-cheap`；仍未命中抛 `RegistryError.modelNotFound(...)`）
- Prompt 模板由引擎内置（`INTENT_SYSTEM_PROMPT`），要求 LLM 输出 3 字段 `IntentResult`（`complexity` + `intent` + `contextRelevance`），**不再**输出 `directAnswer`
- LLM 返回 JSON，引擎以"宽容解析 + 严格兜底"策略处理：
  1. 首选直接解析完整响应为 JSON
  2. 次选剥离 Markdown fenced code 块后解析
  3. 再次选正则抽取嵌入式 JSON 对象
  4. 全部失败时，将原始文本保留为"疑似 simple 的意图摘要"，`complexity` 固定为 `simple`，`intent` 截断到 ≤200 字符
- 解析到 JSON 后，对 `complexity`、`contextRelevance` 做白名单校验；任一字段缺失或非法视为解析失败，走上文第 4 步兜底

### 4.4 任务拆分与依赖图

- **兜底契约实现**（Phase 5 只负责路由到内置 Sub-flow，不再静态编排多步 Tool 序列）：
  - `complexity === 'simple'` → 引擎直接构造 1 条 `direct-answer` Sub-flow 任务的 `PlanningResult`
  - `complexity === 'complex'` 且 Registry 存在 ≥1 个可见 Tool → 引擎构造 1 条指向 `tool-use` 的单步 Plan；真正的"调哪些工具、调几次"由 Phase 7 内部的 Agentic Loop 与 LLM 协商
  - `complexity === 'complex'` 但 Registry 为空 → 引擎构造带 `input.warn=true` 的 `direct-answer` 兜底 Plan
- Plan 模式：引擎生成 PlanningResult 后通过回调/事件返回上层，等待确认信号
- 环检测：Kahn 算法（拓扑排序），O(V+E)
- **后置守护**：Phase 5 返回前强制断言 `plans[0].tasks.length >= 1`；为空时引擎日志 `warning` 并覆盖为 direct-answer 兜底 Plan
- **为什么不再做静态 Tool 序列编排**：多步 Tool 序列在工具池扩张时极易因"LLM 判断 ≠ 静态模板"而失败；改为 `tool-use` 循环后，Phase 5 的规划职责收敛到"选哪个 Sub-flow"，后续每轮"调哪个工具、并发度多少、是否调用完就停"由 LLM 与 Agentic Loop 自己决定，符合现代 Function Calling 模型能力的利用方式

### 4.5 依赖调度器

```typescript
class TaskScheduler {
  execute(plan: RankedPlan, context: ExecutionContext): AsyncIterable<TaskResult>;
}
```

- 维护每个任务的入度计数
- 入度为 0 的任务并行发起（`Promise.all`）
- 任务完成后更新下游入度，新的入度 0 任务立即发起
- 通过 `AsyncIterable` 逐个产出结果
- **Sub-flow 路由**：默认 `TaskExecutor` 识别 `TaskNode.type === 'sub-flow'`：
  - 若 `ref` 属于 `InternalSubflowRegistry`（内置 Sub-flow，即 `direct-answer` 或 `tool-use`），转交 `InternalSubflowRegistry.execute(ref, input, ctx)`
  - 否则按业务 Sub-flow 路由（未注册则抛 `TaskExecutionError.unknownRef(ref)`）
- **`tool-use` 在执行层的特殊性**：`InternalSubflowRegistry` 在执行 `tool-use` 时**复用主干的 TaskExecutor** 作为工具调度器——循环里每次真实工具调用都包装成 `TaskNode { type: 'tool', ref, input }` 再交还 TaskScheduler 侧的 executor。这样得到几个关键收益：
  - **统一审批**：外层 `withDefaultGate` 或业务自定义 gate 对所有 tool 调用（无论是 Phase 5 静态编排的还是 `tool-use` 循环里动态发起的）一视同仁
  - **统一预算**：每次工具调用都走同一个 `ExecutionOrchestrator` 预算记账路径
  - **统一取消**：TaskScheduler 的 AbortSignal 链式传递覆盖 Agentic Loop 里每一次 Provider.chat 与 Tool 执行
- **`onBeforeToolCall` 审批钩子（`tool-use` 专属）**：
  - `EngineDependencies.onBeforeToolCall?: (req: ToolApprovalRequest) => Promise<ToolApprovalDecision>`
  - 触发条件：`descriptor.requiresApproval === true` 或 `config.runtime.toolLoop.requireApprovalGlobal === true`
  - 返回 `{ type: "deny", reason? }` → `tool-use` 合成一条"用户拒绝"tool 消息回灌 LLM，循环继续；工具调用记录的 `errorCode = TOOL_LOOP_APPROVAL_DENIED`
  - CLI 侧默认注入的实现：TTY 交互下弹出 `y/N` 提示；非 TTY / `NO_TTY=1` 环境下默认拒绝（避免无人值守批准破坏性操作）

### 4.6 结果验证

- 使用 LLM 对执行结果做验证（Prompt 中注入原始意图 + 各步骤结果）
- LLM 返回结构化 ValidationResult（passed + diagnosis）
- 配置关闭时整个阶段跳过

### 4.7 编排控制面

- 预算追踪：每次 LLM 调用 / Tool 调用后累加 tokenUsage 和 durationMs
- 方案管理：维护 `plans[]` 数组和当前索引，失败时递增
- 熔断：预算用完时抛出 `BudgetExhaustedError`，Engine 捕获后走终止路径

### 4.8 取消传播

- 使用 `AbortController` / `AbortSignal`（Bun 原生支持）
- Engine 为每个 session 维护当前 `AbortController`
- 新消息到达 → `controller.abort()` → 所有子任务监听 signal 终止
- **MCP 取消传播（v1 约定）**：v1 的 `McpToolAdapter.executeTool(name, args)` 接口**不接受** `signal` 参数；业务侧 TaskExecutor 在 `signal.aborted` 后需**显式调用** `mcp.cancel(requestId)` 触发 stdio/SSE 传输层的取消（见 §9.2）。v2 计划在 `executeTool(name, args, options?: { signal?: AbortSignal })` 中桥接 signal 自动触发 `cancel`，演进路径见未来 ADR

---

## 五、核心模块实现

### 5.1 会话管理

- `SessionManager` 默认实现使用内存 `Map<string, Session>` 存储
- 并发锁：每个 session 维护一个 `AbortController`，新消息到达时 abort 旧的，替换新的
- Session 超时：可配置闲置超时，到期自动 `suspend`
- **MCP 取消桥接**：SessionManager 的 `cancel(sessionId)` 会 `abort` 当前 `AbortController`，触发业务 TaskExecutor 的 signal listener；业务侧需在 listener 里对所有未完成的 MCP requestId 显式调用 `mcp.cancel(requestId)`，引擎不自动穿透到 MCP 层（见 §4.8 与 §9.2 的"取消传播"章节）

### 5.2 记忆系统

#### 5.2.1 抽象与内存实现

- `MemorySystem` 接口：`load / append / compress / recall / archive / getSize / trim / clear`
- 默认实现 `InMemoryMemorySystem`：内存中维护 `ContextWindow`（进程结束即失效）
- `append` 时自动计算 tokenCount（调用 Tokenizer）
- 接近阈值（`compressionThreshold * contextTokenLimit`）时自动触发 `compress`
- H-M-T 压缩策略：Head/Tail 条数可配置，Middle 部分调用 LLM（`compress` 能力，降级到 `fast-cheap`）生成摘要
- `archive`：默认写入本地文件（JSON Lines 格式，单文件 `archivePath`），供长期记忆向量召回
- `recall`：有 VectorStore 时走向量召回，否则跳过
- `clear`：幂等删除 session 在 MemorySystem 中的所有内容（内存 window + 若有的底层副作用）；用于 CLI `/reset` `/clear`

#### 5.2.2 跨进程持久化契约（patch-02-session-persistence）

`MemorySystem` 是会话历史的 **唯一权威持久层**。core 不直接依赖文件系统，而是通过依赖注入接受任意 `MemorySystem` 实现（instance 或 factory）。

`Engine` 支持两种注入形式：

```ts
type MemorySystemInjection =
  | MemorySystem
  | ((deps: MemorySystemFactoryDeps) => MemorySystem);

interface MemorySystemFactoryDeps {
  config: EngineConfig;
  tokenizer: Tokenizer;
  modelRouter: ModelRouter;
  providers: Map<string, ProviderAdapter>;
  vectorStore: VectorStore;
}
```

factory 形式允许上层（CLI、SDK）在 engine 构造时拿到 core 内部依赖后组装组合型 `MemorySystem`（典型如把 `InMemoryMemorySystem` 包到 `FsMemorySystem` 里），保持 core 不引入 `node:fs`。

`config.memory` 新增两个字段：

| 字段 | 默认 | 作用 |
| ---- | ---- | ---- |
| `persistence` | `"fs"` | CLI 默认文件持久化；SDK 可设 `"memory"` 退化为纯内存 |
| `persistDir` | `".tachu/memory"` | 文件持久化根目录（相对 cwd） |

CLI 默认注入 `@tachu/extensions` 提供的 `FsMemorySystem`，它组合一个内部 `InMemoryMemorySystem`：

- **热路径**：每次 `append` 先同步 `jsonl`（append-only，crash-safe 前缀），再 hydrate 进内存 window
- **首次 `load`**：检测到磁盘有 `<persistDir>/<sessionId>.jsonl` 时一次性 hydrate 全部 entries（`InMemoryMemorySystem.hydrate` 公共方法，旁路 per-entry 压缩触发）
- **compress / trim 后**：atomic rewrite 整个 `jsonl`（写 `<path>.tmp` + `rename`），保证「盘 = 内存」一致
- **clear**：先清内存 window，再幂等删除 `jsonl`
- **并发**：同一 session 上的 `load/append/compress/trim` 通过 per-session promise chain 串行化，跨 session 独立

#### 5.2.3 职责分离

- `config.memory.persistDir`（`FsMemorySystem` 拥有）= **热路径**：每次 append 立即落盘，用于 CLI `--resume` / `chat --session <id>`
- `config.memory.archivePath`（`InMemoryMemorySystem` 拥有）= **冷路径**：仅在 `archive()` 时追加到大 jsonl，供跨 session 向量召回

两者互不覆盖，保留既有 `archivePath` 语义不动。

#### 5.2.4 CLI 侧职责

- `FsSessionStore`（`packages/cli/src/session-store/`）降级为仅保存 session 元数据（`version: 2`，含 `id/createdAt/lastActiveAt/context/budget/checkpoint`，**不再携带 messages**）
- `FsSessionStore.loadAndMigrate` / `loadLatestAndMigrate`：遇到老 schema（v1，含 `messages`）自动把老消息灌入 `MemorySystem` 并落盘 v2 session，完成后 v1 数据源不再被读取
- CLI 命令（`/history` / `/export` / `/stats`）全部通过 `engine.getMemorySystem()` 取数，或通过 `MessageCounter` 回调从 jsonl 直读计数（非交互模式免得起 engine）

### 5.3 运行状态

- 默认内存 `Map<string, ExecutionState>` 存储
- 每次阶段转换时自动 `update`
- 任务完成或 session 关闭时 `cleanup`

### 5.4 模型路由

- 配置中的 `capabilityMapping` 作为映射表
- `resolve` 查表返回 model-name，未找到时抛错
- `checkCapabilities` 从已注册的 ProviderAdapter 调用 `listAvailableModels` 获取

### 5.5 模型接入

- ProviderAdapter 注册到引擎，按 name 索引
- `chat` / `chatStream` 统一错误处理：网络异常 / 超时 → 抛出标准 `ProviderError`
- 降级切换：Engine 捕获 `ProviderError` 后按 `providerFallbackOrder` 切换 Adapter 重试

### 5.6 安全模块

`SafetyModule` 在 v1 包含**5 项基线**（硬编码、不可关闭）：

| # | 基线 | 触发条件 | 严重度 | 错误码 |
| --- | --- | --- | --- | --- |
| 1 | 输入大小 | `Buffer.byteLength(JSON.stringify(input.content)) > safety.maxInputSizeBytes` | error | `SAFETY_INPUT_TOO_LARGE` |
| 2 | 递归深度 | `context.recursionDepth > safety.maxRecursionDepth` | error | `SAFETY_RECURSION_TOO_DEEP` |
| 3 | 预算熔断 | 任意一项预算耗尽（token / toolCalls / wallTime） | error | `BUDGET_TOKEN_EXHAUSTED` / `BUDGET_TOOL_CALL_EXHAUSTED` / `BUDGET_WALL_TIME_EXHAUSTED` |
| 4 | 路径遍历防护 | 文件后端访问的 `path` 解析后超出 `safety.workspaceRoot` | error | `SAFETY_PATH_TRAVERSAL` |
| 5 | Prompt 注入告警 | 输入文本匹配 `safety.promptInjectionPatterns` 中任一正则 | **warning（不阻断）** | 无（仅 ObservabilityEmitter 发 `prompt_injection_warning`） |

> 第 5 项是软告警：默认 `promptInjectionPatterns: []`；业务可通过配置追加正则做可疑输入审计。

**业务策略链**：

- `checkBusiness` 内部维护策略列表，业务通过 `safety.registerPolicy({ id, scope, check })` 动态注入；`registerPolicy` 返回取消函数
- 同 `id` 重复注册视为**更新**（覆盖既有策略）
- 策略按 `scope` 分组在 `input` / `execution` / `output` 三个阶段触发；同 scope 内按注册顺序执行，任一返回 `passed: false` 即终止当前阶段

### 5.7 可观测性

- `ObservabilityEmitter` 默认实现：基于 EventEmitter 模式
- 引擎各关键点（阶段进入/退出、LLM 调用、Tool 调用、错误、重试）埋入 `emit` 调用
- 实时进度流：订阅 emitter，过滤后转为 `StreamChunk.progress` 推出
- 结构化追踪：扩展库提供 OTel 适配，将 EngineEvent 映射为 OTel Span

### 5.8 Hooks

- `HookRegistry` 内部维护 `Map<HookPoint, Handler[]>`
- subscribe handler：同步调用，不等待返回，异常静默忽略
- register handler：`Promise.race([handler(), timeout])` 控制超时
- 执行顺序：遍历数组，引擎内置 handler 先注册保证排前

---

## 六、Prompt 组装实现

### 6.1 组装管线

按详细设计 §11.1 的优先级顺序拼接 `Message[]`：

```
System Prompt:
  1. Rules（type: 'rule'，硬约束）     ← 最高优先级，头部
  2. Rules（type: 'preference'，软偏好）
  3. Skills（激活的知识/指令）
  4. Tool 定义（可用 Tool 的描述和 Schema）

Messages:
  5. 会话上下文（经记忆系统管理的历史）
  6. 当前输入                           ← 末尾
```

### 6.2 Token 预算分配

```
总预算 = 模型 maxContextTokens
  ├── System Prompt 区（Rules + Skills + Tool 定义）
  ├── 会话上下文区
  └── 预留输出空间（默认 4096 tokens，可配置）
```

超预算裁剪策略（按序执行）：

1. 压缩会话上下文（触发记忆系统 compress）
2. 裁剪低优先级 Skills（按语义相关度排序，从低到高移除）
3. 裁剪 Tool 定义（移除本轮意图未涉及的 Tool）

### 6.3 Token 计数

**决策：tiktoken（WASM 版本，兼容 Bun 运行时）+ 抽象 `Tokenizer` 接口注入**

`PromptAssembler` 通过 `Tokenizer` 接口（详细签名见详细设计 §11.4）做精确 token 计数；默认实现 `createTiktokenTokenizer(model)` 位于 `packages/core/src/prompt/tokenizer.ts`。

**模型名 → encoding 映射策略**：

| 模型 family（按 `model.startsWith`） | tiktoken encoding | 说明 |
| --- | --- | --- |
| `gpt-4o*` / `o1*` / `o3*` | `o200k_base` | OpenAI 2024+ 系列原生 encoding |
| `gpt-4*` / `gpt-3.5*` | `cl100k_base` | OpenAI 经典系列 |
| `claude*` | `cl100k_base` | Anthropic 未公开官方 tokenizer，使用 cl100k 作为近似（误差 < 5%） |
| 其它 / 未知 | `cl100k_base` | 默认回退（与 OpenAI 经典系列对齐） |

**回退矩阵**：

1. **`encoding_for_model(name)` 抛错** → 捕获后改用 `get_encoding('cl100k_base')`，发 `warning` 事件 `tokenizer_fallback { reason: 'unknown_model', model }`
2. **tiktoken WASM 加载失败**（极端 IO / 平台限制） → 回退到 `ByteEstimateTokenizer`（`Math.ceil(text.length / 4)`，误差 ±20%），发 `warning` 事件 `tokenizer_fallback { reason: 'wasm_load_failed', cause }`
3. **后续观测调优**：通过 `ObservabilityEmitter` 订阅 `warning` 事件可统计 fallback 频率，必要时按模型新增映射

---

## 七、输入输出实现

### 7.1 输入信封处理

Engine 入口处将原始输入包装为 `InputEnvelope`：

- 自动推断 `modality` 和 `mimeType`
- 支持常规内容类型：

| 类型 | modality | 处理方式 |
| --- | --- | --- |
| 纯文本 | `text` | 直接透传 |
| 图片 | `image` | 检查模型是否支持多模态，不支持则调用 InputTransformer 降级 |
| 文件 | `file` | 读取文件内容，按 mimeType 决定处理方式 |
| 混合（文本 + 附件） | `composite` | 拆分为多部分，各部分独立处理 |

**文本中的引用识别**：

用户在文本消息中可能通过自然语言描述引用外部资源（如"帮我看看 src/index.ts 这个文件"）。引擎在输入信封化阶段提供引用提取机制：

- 引擎定义 `ReferenceExtractor` 接口，从文本中提取引用线索
- 提取结果作为 `InputMetadata.references` 附加到信封中
- 引用的具体解析方案（文件路径、URL 等）由业务层实现 `ReferenceExtractor`
- 引擎不自行解析引用内容，只确保提取的引用数据可在后续阶段被访问

> **v1 实现范围**：核心层（`@tachu/core`）**仅定义** `ReferenceExtractor` / `ExtractedReference` 接口与 `engine.registerReferenceExtractor(extractor)` 注册通道；**不提供**任何默认实现。业务侧通过 `@tachu/extensions` 或自写 Extractor 注册 `file` / `url` / `symbol` 等类型的解析策略。未注册时，`InputMetadata.references` 保持 `undefined`，引擎不做任何处理，下游阶段保持兼容。

```typescript
interface ReferenceExtractor {
  extract(text: string): Promise<ExtractedReference[]>;
}

interface ExtractedReference {
  raw: string;           // 原始引用文本
  type: string;          // 引用类型（file / url / symbol 等，业务定义）
  resolved?: unknown;    // 解析后的内容（由业务填充）
}
```

### 7.2 标准输出构造

- Engine 在输出阶段收集各子任务 `StepStatus`
- 汇总 `metadata`（toolCalls、durationMs、tokenUsage）
- 组装最终 `EngineOutput`

### 7.3 流式输出

- `runStream` 内部使用 `AsyncGenerator`，各阶段通过 `yield` 推出 `StreamChunk`
- 背压：消费方控制迭代速度，`AsyncGenerator` 天然支持背压（消费方未 pull 时生产方暂停）

---

## 八、向量化子系统实现

### 8.1 VectorStore 内置轻量实现

纯 TS 实现，零外部依赖，仅供 demo/调试：

- `embed`：简单的词频向量（TF），对 description 文本分词后生成稀疏向量
- `search`：余弦相似度排序，返回 topK
- 存储：内存中维护 `Map<string, { vector, metadata }>`

**内存管理**：

- 设置索引条目上限（默认 10000 条），超限时拒绝新增并输出警告
- 提供 `clear()` 方法手动释放
- 引擎启动时预估内存占用并在日志中报告
- 生产环境应替换为扩展库中的外部向量数据库 Adapter

### 8.2 索引管理

- Registry 注册描述符时同步调用 `VectorStore.upsert`
- Registry 注销描述符时同步调用 `VectorStore.delete`
- 引擎启动时一次性批量索引所有已注册描述符

---

## 九、执行后端与 MCP 实现

### 9.1 ExecutionBackend 规范

- 扩展库中各后端实现 `ExecutionBackend` 接口
- 通过 Registry 按 name 注册
- 子任务执行时按 `TaskNode.type` 路由到对应后端

### 9.2 McpToolAdapter 实现

基于 MCP SDK（`@modelcontextprotocol/sdk`）；v1 在 `@tachu/extensions/mcp` 提供两种 transport 实现 `McpStdioAdapter` 与 `McpSseAdapter`。两者共享同一 `McpToolAdapter` 接口，差异如下：

| 维度 | `McpStdioAdapter` | `McpSseAdapter` |
| --- | --- | --- |
| 连接方式 | spawn 子进程，通过 stdin / stdout 收发 JSON-RPC | HTTP `text/event-stream` 长连接到远端 endpoint |
| 进程生命周期 | Adapter 全权管理子进程：`connect` 启动、`disconnect` 杀死；进程意外退出立即触发 `error` 事件 | 不管理远端进程；`connect` 仅建立 SSE 流，`disconnect` 关闭流即可 |
| 鉴权 | 子进程通过环境变量（`MCP_TOKEN` 等）继承；可在 spawn options 设置 `env` | HTTP 头：`Authorization: Bearer <token>` 或自定义头；可在构造时配置 |
| 断线重连 | 子进程意外退出 → Adapter 执行 **3 次指数退避重连**（500ms / 1s / 2s），全部失败后抛 `error`；可通过构造参数 `reconnect: false` 关闭 | SSE 连接断开 → Adapter 执行 **3 次指数退避重连**（500ms / 1s / 2s），全部失败后抛 `error`；可通过构造参数 `reconnect: false` 关闭 |
| 事件传递 | stdout 行流解析为 JSON-RPC 消息；`progress` notification 自动转 `StreamChunk.progress` | SSE event 字段映射：`event: notification` → progress；`event: result` → 任务完成；`event: error` → 错误 |
| 取消传播 | `cancel(requestId)` 通过 stdin 发送 JSON-RPC `notifications/cancelled` | `cancel(requestId)` 通过额外 HTTP DELETE/POST 发送 cancel 请求 |
| 超时管理 | 单请求超时由调用方传入；超时后自动调用 `cancel` | 同左；额外受连接级 keep-alive timeout 影响 |
| 适用场景 | 本地命令行 MCP server（如 `@modelcontextprotocol/server-filesystem`）、安全沙箱场景 | 远端 SaaS MCP server、需 HTTP 鉴权的场景 |

**取消传播的桥接约定**：

- v1 的 `McpToolAdapter` 接口签名：`listTools()` / `executeTool(name, args)` / `cancel(requestId)`，**未在 `executeTool` 上接受 `signal?: AbortSignal`**
- 业务 TaskExecutor 在收到 `AbortSignal.abort()` 后，需要**显式调用** `mcp.cancel(requestId)` 才会触发上表的取消传播
- v2 计划在 `executeTool(name, args, options?: { signal?: AbortSignal })` 中加入 signal 桥接，自动联动 `cancel(requestId)`，详见未来 ADR `decisions/000x-mcp-signal-bridge.md`

`listTools` 将 MCP tool schema 映射为 `ToolDescriptor` 注册到 Registry；引擎启动期可调用 `mcp.listTools()` 一次性批量注册。

---

## 十、配置体系实现

### 10.1 配置文件格式

- 引擎配置文件：`tachu.config.ts`，导出 `EngineConfig` 对象，类型安全
- 配置文件位于项目根目录
- `EngineConfig` 由九个顶级键构成（`providers` 可选）：

```
registry / runtime / memory / budget / safety / models / providers? / observability / hooks
```

**字段总览**（与 `packages/core/src/types/config.ts` 完全一致；详细字段语义与默认值见详细设计 §14.1）：

| 顶级键 | 关键字段 | 默认值（参考） | 用途 |
| --- | --- | --- | --- |
| `registry` | `descriptorPaths: string[]`、`enableVectorIndexing: boolean` | `['.tachu']` / `false` | 描述符根目录、是否启动期写入向量索引 |
| `runtime` | `planMode`、`maxConcurrency`、`defaultTaskTimeoutMs`、`failFast` | `false` / `4` / `120_000` / `false` | Plan 模式、并发度、子任务超时、快失败 |
| `memory` | `contextTokenLimit`、`compressionThreshold`、`headKeep`、`tailKeep`、`archivePath`、`vectorIndexLimit` | `8000` / `0.8` / `4` / `12` / `'.tachu/archive.jsonl'` / `10000` | 上下文窗口、压缩策略、归档与向量索引上限 |
| `budget` | `maxTokens`、`maxToolCalls`、`maxWallTimeMs` | `50_000` / `50` / `300_000` | 单次执行预算（token / tool 调用 / 墙钟） |
| `safety` | `maxInputSizeBytes`、`maxRecursionDepth`、`workspaceRoot`、`promptInjectionPatterns` | `1_000_000` / `10` / `process.cwd()` / `[]` | 输入/递归/路径/注入告警五项基线（详见 §5.6） |
| `models` | `capabilityMapping: Record<string, ModelRoute>`、`providerFallbackOrder: string[]` | `{}` / `[]` | 能力标签 → 模型映射、Provider 降级顺序 |
| `providers?` | `openai? / anthropic? / [name]?`：`{ apiKey?, baseURL?, organization?, project?, timeoutMs?, extra? }` | `undefined` | 内置 Provider 连接参数；缺省走环境变量 + SDK 默认 |
| `observability` | `enabled`、`maskSensitiveData` | `true` / `true` | 事件 emit 与脱敏 |
| `hooks` | `writeHookTimeout`、`failureBehavior` | `5000` / `'continue'` | 可写 Hook 超时与失败策略 |

> **历史草案差异**：早期草案曾使用 `retry / planning / agent / context / execution / storage` 顶级键；该草案在 v1 实现中被废弃。详细原因见详细设计 §14.1 的"v1 与历史草案的差异"段。任何 README、`tachu init` 模板、教程都必须使用本节九键结构，否则 `validateConfig` 在引擎启动时会抛 `VALIDATION_INVALID_CONFIG`。

### 10.2 配置加载与合并

- 加载顺序：引擎内置默认值（`config-schema.ts:DEFAULT_ENGINE_CONFIG`）→ `tachu.config.ts` 用户配置 → 深度合并
- 启动时通过 `validateEngineConfig()` 校验：缺失非必填项使用默认值；不合法值（如 `maxConcurrency < 1`、`compressionThreshold` 不在 [0, 1]）抛 `VALIDATION_INVALID_CONFIG`
- 加载实现位于 `packages/core/src/utils/config-schema.ts`

### 10.3 默认值

所有配置项的默认值由 `packages/core/src/utils/config-schema.ts:DEFAULT_ENGINE_CONFIG` 集中维护，详见详细设计 §14.1。CLI 通过 `loadConfig(cwd)` 读取 `tachu.config.ts`，自动补齐缺省项。

---

## 十一、CLI 实现

### 11.1 命令设计

CLI 命令通过 `tachu` 调用：

- `tachu chat` — 进入交互式对话
- `tachu run <prompt>` — 单次执行
- `tachu init` — 初始化项目配置（生成 `tachu.config.ts` + `.tachu/` 目录结构）

### 11.2 终端交互

- readline 循环，消费 `runStream` 的 `AsyncIterable`
- `delta` chunk 实时打印，`progress` chunk 显示阶段提示
- Ctrl+C 触发当前任务取消

### 11.3 本地配置加载

统一配置目录 `.tachu/`：

```
.tachu/
├── rules/        # Rule 描述符（*.md）
├── skills/       # Skill 描述符（SKILL.md 目录结构）
├── tools/        # Tool 描述符（*.md）
└── agents/       # Agent 描述符（*.md）
```

- CLI 启动时扫描 `.tachu/` 下各子目录，解析 Markdown 文件注册到 Registry
- 支持嵌套子目录（如 `.tachu/skills/code-review/SKILL.md`）

---

## 十二、错误处理实现

### 12.1 错误类型体系

基础 `EngineError` 类，子类按场景划分：

| 错误类型 | 场景 | 错误码前缀 |
| --- | --- | --- |
| `SafetyError` | 安全检查拒绝 | `SAFETY_` |
| `ProviderError` | LLM Provider 调用失败 | `PROVIDER_` |
| `BudgetExhaustedError` | token/时间预算耗尽 | `BUDGET_` |
| `ValidationError` | 结果验证不通过 | `VALIDATION_` |
| `TimeoutError` | 执行超时 | `TIMEOUT_` |
| `RegistryError` | 注册/依赖校验失败 | `REGISTRY_` |
| `PlanningError` | 任务拆分/依赖图校验失败 | `PLANNING_` |

所有错误携带 `code`（错误码）、`message`（开发者描述 / 日志用）、`cause`（原始错误，可选）、`context`（结构化上下文，可选），以及 **`userMessage`（面向终端用户的中文短文本，必填，自 patch-01-fallback 起）**。

#### 12.1.1 `userMessage` 字段（用户可见 vs 内部诊断分层）

- 构造时若未显式传入 `options.userMessage`，由 `code + context` 经内置中文模板表（`USER_MESSAGE_ZH`）自动解析，覆盖所有已注册 error code
- 未知 code 走 `__DEFAULT__` 兜底文案，绝不会崩溃
- 所有 `userMessage` 满足三条硬约束（由 `fallback-contract.test.ts` 强制）：
  1. **长度** ≥ 15 字且 ≤ 220 字（适配单屏 CLI 展示）
  2. **禁用术语**：`task-tool-\d+` / `Phase \d+` / `direct-answer 子流程` / `capability 路由` / `Tool / Agent 描述符` 等引擎内部概念
  3. **必含可行下一步**：明确告诉用户"可以做什么"（重试 / 调整配置 / 简化请求 / 等）
- i18n hook：`setErrorLocale("en-US")` 预留，当前英文表回退到中文；后续补英文模板时调用方无需改动
- 对 UI 层暴露的投影 `toUserFacing()` 只返回 `{ code, userMessage, retryable }`，**不**暴露 `message` / `stack` / `cause` / `context`

### 12.2 重试与降级实现（v1 范围）

> **v1 降级约定**：ADR-0001 & detailed-design §8.1 明确，v1 仅落地 **Provider Fallback** 与 **Phase 8 validation 诊断信号**；完整的"任务级 / 系统级重试循环"延后到 v2。本节描述 v1 实际实现：

- **Provider Fallback（已落地）**：ProviderAdapter 调用处捕获 `ProviderError` 后，按 `config.models.providerFallbackOrder` 顺序切换下一个 Adapter 重新调用；同 Provider 内**不做**自动重试（避免叠加超时），业务如需同 Provider 重试可自行在 Adapter 层包装
- **Phase 8 诊断（已落地）**：结果验证阶段对输出做**确定性失败扫描**（格式、schema、明显异常），命中即输出 `ValidationResult.passed = false` 加 `diagnosis.type`；引擎**不**自动重执行或切换方案，仅将诊断信号 emit 给 ObservabilityEmitter + StreamChunk，由业务决定后续动作
- **任务级重试循环（v2）**：引擎在 `passed: false` 后按 `diagnosis.type` 决定重执行当前方案或切换下一方案的循环**v1 未实现**；相关 diagnosis schema 已预留，v2 将在 `RuntimeConfig.autoRetryPolicy` 启用后激活
- **系统级重试（v2）**：跨 Provider 的智能重试策略（指数退避、调用模式感知、熔断保护）**v1 未实现**，v1 仅做 Provider 切换

### 12.3 预算熔断实现

- 编排控制面每次 LLM/Tool 调用后累加消耗，检查剩余预算
- 不足时抛出 `BudgetExhaustedError`
- Engine 捕获后终止所有执行（`AbortController.abort()`），收集已完成步骤状态输出

### 12.4 Fallback & User-Facing Contract（patch-01-fallback）

> 对应 `patch-01-fallback`。动机：当 Phase 8 `validation.passed === false` 且 `task-direct-answer` 也未产出答复时，引擎必须保证用户**仍然拿到一段有价值的自然语言答复**，而不是"failed + 内部诊断"。本节把这一契约显式化为源码层可执行的规则。

#### 12.4.1 分层职责（三道防线）

| 层 | 位置 | 职责 |
| --- | --- | --- |
| L1 源头 | `engine-error.ts` 的 `userMessage` 模板表 | 任何 `EngineError` 抛出即具备"用户可读版本" |
| L2 聚合 | `phases/output.ts` 的 `ensureFallbackText()` | `status ∈ {partial, failed}` 时强制产出 ≥ 30 字的自然语言答复 |
| L3 最终屏蔽 | `phases/output.ts` 的 `sanitizeInternalTerms()` + `cli/renderer/stream-renderer.ts` 的 `sanitizeUserText()` | 双层正则过滤，兜住任何 L1/L2 漏网的内部术语 |

#### 12.4.2 `ensureFallbackText()` 算法（Phase 9）

```
1. 尝试 LLM best-effort summary（DP-2 方案 B）
   - 能力路由：intent
   - 超时：5s（紧，避免放大失败面）
   - 重试：0 次（失败路径不得继续失败）
   - System Prompt 硬约束：禁止内部术语 / 禁止假执行 / 80-200 字 / 三段结构
   - 失败/超时/空输出/< 30 字 → 返回 null
2. null → 降级本地模板（纯字符串拼接，不调 LLM）
   - 结构：一句承认未能完成 + 可能原因 + 三条具体下一步
3. 最终结果统一过一次 sanitizeInternalTerms() 再返回
```

`tryLLMFallbackSummary()` **不得**抛异常（用 `safeEmit` 包裹所有 observability 调用）。这是 Phase 9 的底线不变式。

#### 12.4.3 Intent Phase 启发式降级强化（FIX-A）

LLM 不可用时的 `inferComplexityFallback()` 采用"白名单 > 长度 > 弱 complex 关键词"三级判定：

1. **强 simple 白名单**（优先级最高）：命中 `^(我需要|我想要|给我|帮我|i need|i want|help me|write|list|explain…)` 等陈述句开头立即判 `simple`，不再看长度
2. **长度 / 弱 complex 关键词**：未命中白名单且长度 > 120 字 或出现 `然后/并且/步骤/拆分/workflow/pipeline` 等，判 `complex`
3. **兜底**：其余归 `simple`（保守归类，避免错走失败工具链）

动机：alpha.1 中 `i need a pig img` 曾被错判为 `complex`，随后走 planning 的"盲取前 N 个 tool"分支失败，本轮强化杜绝此类回归。

#### 12.4.4 Validation Phase 脱敏（FIX-C.2）

`validation.diagnosis.reason` 严禁包含 `task-tool-*` 等内部步骤 ID，改为脱敏描述 `"执行过程中有 N 个步骤未成功完成"`；原始任务 ID 单独记录在 `diagnosis.failedTaskIds: string[]` 供 orchestrator / observability 消费。

#### 12.4.5 CLI Renderer 最后屏蔽（FIX-D）

`StreamRenderer.finalize(text|markdown)` 与 `error` chunk 都会先过 `sanitizeUserText()`；`finalize(json)` 跳过脱敏（JSON 面向程序消费，需保留完整内部字段）。

错误渲染优先使用 `chunk.error.userMessage`，其次才 fallback 到 `message`：

```ts
const rawText = err.userMessage?.trim() || err.message;
process.stderr.write(`[error:${err.code}] ${sanitizeUserText(rawText)}\n`);
```

#### 12.4.6 验收硬门槛

`packages/core/src/engine/phases/fallback-contract.test.ts` 定义 4 组契约（55 个断言），任意失败即 CI 红灯：

1. **Contract 1**：46 个已知 error code 的 `userMessage` 长度 / 禁用术语 / `toUserFacing()` 投影字段都合规
2. **Contract 2**：`validation.reason` 脱敏 / `failedTaskIds` 保留
3. **Contract 3**：`runOutputPhase` non-success 返回的 `content` ≥ 30 字、无内部术语、含下一步、不 stringify 内部 state；原始 bug 场景 `i need a pig img` 重现并验证
4. **Contract 4**：`sanitizeInternalTerms` 幂等、不误杀普通文本、替换精准

---

## 十三、开发规范

### 13.1 代码规范

- 文件名：kebab-case（如 `model-router.ts`）
- 类型/类名：PascalCase（如 `ModelRouter`）
- 函数/变量名：camelCase（如 `resolveModel`）
- 每个模块通过 `index.ts` 统一导出
- core 包零外部依赖，所有第三方依赖限制在 extensions / cli

### 13.2 测试规范

- 测试框架：`bun test`
- 单元测试文件与源码同目录（`*.test.ts`）
- 集成测试放 `__tests__/` 目录
- LLM 调用通过 mock ProviderAdapter 测试，不依赖真实 API
- 核心流程需覆盖：正常路径、错误路径、重试路径、熔断路径

### 13.3 文档规范

- 公开接口使用 TSDoc 注释
- 变更日志随版本发布维护（CHANGELOG.md）
