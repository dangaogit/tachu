# Agentic Engine 概要设计文档

> 状态：Release Candidate 基线 最后更新：2026-07-02（ADR-0006 落地）
>
> **职责边界**：概念架构与主干流程。类型规格与配置 Schema 见 [详细设计](./detailed-design.md)；工程落地见 [技术设计](./technical-design.md)。
>
> **执行模型架构说明**：§七「主干流程」已随 ADR-0006（Harness 挂载面：多阶段流水线 → 深单 loop + loop-lifecycle 守卫面）落地改写为当前实现（`0.2.0`，深单 agentic loop + loop-lifecycle 守卫面）；历史 9 阶段流水线版本见 tachu-docs 仓库 `adr/decisions/0001-direct-answer-as-builtin-subflow.md`、`0002-agentic-loop-builtin-subflow.md` 原文。

**版本术语**：Tachu 当前产品线为 **Tachu v1**；`1.0.0-rc.0` 是 `1.0.0` 的稳定化候选版本，不是新的框架代际。详见 [详细设计 · 版本与发布术语](./detailed-design.md#版本与发布术语必读)。

---

## 一、项目定位

Agentic Engine 是一个**通用的 Agent 框架引擎**（本质是
Harness）。引擎自身不包含过多实际功能，只负责定义和约束整体架构核心，确保上层业务可以快速接入。

- 引擎提供骨架（协议、流程、生命周期），业务填充血肉（规则、工具、技能、领域逻辑）
- 适用领域不限：ToB、ToC、代码生成等，引擎本身具备通用性
- 引擎只与上层业务打交道，不感知终端用户的概念
- Agent = Model + Harness，引擎就是 Harness

---

## 二、三层发布结构

```mermaid
graph TD
    subgraph "业务层"
        A[业务规则 / 业务工具 / 自定义 Adapter / 领域技能 / Agent]
    end
    subgraph "引擎扩展库 (官方)"
        B[通用 Provider Adapter / 常用 Tools / 执行后端封装 / 通用规则 / 向量数据库 Adapter / 输入转换器等]
    end
    subgraph "引擎核心"
        C[协议定义 / 主干流程 / 生命周期 / 会话 / 记忆 / 安全 / 路由 / 状态]
    end
    A --> B
    B --> C
```

```
┌─ 业务层 ──────────────────────────────────────────────────┐
│  业务规则、业务工具、自定义 Adapter、领域技能、Agent          │
├─ 引擎扩展库（官方）──────────────────────────────────────────┤
│  通用 Provider Adapter、常用 Tools、执行后端封装、            │
│  通用规则、向量数据库 Adapter、输入转换器等                   │
├─ 引擎核心 ────────────────────────────────────────────────────┤
│  协议定义、主干流程、生命周期、会话、记忆、安全、路由、状态   │
└──────────────────────────────────────────────────────────────┘
```

- **引擎核心**：协议、流程骨架、生命周期，不含具体实现
- **引擎扩展库**：官方提供的通用实现（Provider
  Adapter、Tools、执行后端、向量数据库 Adapter 等）
- **业务层**：基于核心 + 扩展库构建领域应用

---

## 三、四大核心抽象

引擎中有 4 个可注册的核心概念，**平级独立，贯穿全引擎**：

| 概念       | 本质                   | 作用域                           |
| ---------- | ---------------------- | -------------------------------- |
| **Rules**  | 约束与指导             | 注入 LLM 各阶段                  |
| **Skills** | 知识与指令             | 注入 LLM 上下文                  |
| **Tools**  | 原子可执行操作         | 任务执行阶段调用                 |
| **Agents** | 自然语言驱动的执行单元 | 递归使用引擎能力，动态创建子任务 |

### 共享特性

- **最小公共元信息**：所有概念共享以下公共字段

  ```yaml
  name: 唯一标识
  description: 自然语言描述（用于语义发现）
  tags: 标签（用于过滤和分类）
  trigger: 激活条件
  requires: 显式依赖引用
  ```

  各概念在此基础上扩展**类型专属字段**（见各概念详细说明）。

- **双平面匹配模型**：

  引擎对核心抽象的激活采用"发现"与"执行"分离的双平面机制：

```mermaid
graph LR
    Context[上下文输入] --> Discovery[语义发现面]
    Discovery --> Index[(向量化索引)]
    Index --> Candidates[候选集]
    Candidates --> Gate[确定性执行闸门]
    Gate -- 显式引用/白名单/权限检查 --> Execution[执行面]
```

- **语义发现面**：基于 description
  向量化索引，通过上下文相似度匹配产生候选集，辅助决策
- **确定性执行面**：最终激活需经过确定性闸门（显式引用、白名单、权限检查等）

不同概念的闸门强度不同：

| 概念   | 语义发现 | 执行闸门     | 理由                             |
| ------ | -------- | ------------ | -------------------------------- |
| Rules  | ✓        | 直接激活     | 只影响 Prompt 内容，无副作用     |
| Skills | ✓        | 直接激活     | 只影响 Prompt 内容，无副作用     |
| Tools  | ✓        | **必须过闸** | 有副作用的原子操作               |
| Agents | ✓        | 可激活       | Agent 最终通过 Tool 闸门间接管控 |

Tool 的执行闸门是全局统一的——无论 Tool 被直接调用还是被 Agent
间接调用，执行前都必须经过闸门校验。

> **默认 TaskExecutor 与 Tool 闸门的关系**：引擎核心提供的默认 `TaskExecutor`（见 `packages/core/src/engine/engine.ts` 的占位实现 + CLI 的 `buildTaskExecutor`）**不内置 scopes / 白名单 / requiresApproval 的统一中间层**——它把"全局统一闸门"实现为一个**插入点**，而不是默认行为。生产侧宿主必须二选一兑现闸门：
>
> - **方式 A（推荐）**：通过 `SafetyModule.registerPolicy({ scope: 'execution', check })` 注入业务侧的执行闸门策略，覆盖审批、scopes、白名单等关注点；
> - **方式 B**：自建 TaskExecutor，在调用任意 Tool 前显式做权限/审批校验，再委托执行。
>
> 引擎仅保证 `tool-use` 等内置 Sub-flow 走 `InternalSubflowRegistry` 独立通道，不会绕开生产侧自建的闸门；其它 Tool/Agent 的执行强度完全由方式 A/B 决定。`@tachu/extensions` 提供 `withDefaultGate(executor, { policies })` 默认闸门组合器供业务侧按需包裹，但不会强制注入到 core，以保持引擎的"Harness"定位。

- **激活方式**：
  - 输入中显式指定 → 精确激活
  - 未显式指定 → 各阶段按双平面机制匹配
  - 启动时校验所有显式引用的完整性

### 各概念详细说明

#### Rules

- 约束与指导，投喂给所有 LLM 环节
- 通过 `scope` 配置作用于全部或特定阶段
- 区分两种类型：
  - `type: rule`（硬约束）：引擎内置 > 业务配置，不可被覆盖
  - `type: preference`（软偏好）：业务配置 > 引擎默认值
- **类型专属字段**：`scope`、`type`

#### Skills

- 轻量的知识/指令包，激活后注入 LLM 上下文
- 可声明引用其他核心抽象（Skills、Rules、Tools、Agents）
- 各阶段按需匹配激活
- **类型专属字段**：当前无，后续按需扩展

#### Tools

- 原子可执行操作，使用通用协议定义
- 引擎可内置必要的基础工具
- 扩展库提供常用工具实现
- 执行前必须经过确定性闸门校验（权限、白名单等）
- 支持 MCP 工具通过 McpToolAdapter 接入（见 §十三）
- **类型专属字段**：副作用类别、是否幂等、是否需审批、超时约束（详见 §五
  执行单元规格）

#### Agents

- 上层业务通过自然语言描述定义
- 符合统一执行规格（input → process → output）
- 递归使用引擎能力（任务拆分 → 执行 → 验证）
- 嵌套深度可配置，默认只支持一级（主 Agent → sub-agent）
- Agent 执行过程中调用的 Tool 仍需经过 Tool 闸门
- **类型专属字段**：最大嵌套深度、可用工具范围

---

## 四、执行上下文

业务调用引擎时注入的上下文信封，引擎负责全链路传播但不解读其业务语义。

| 维度                        | 说明                             |
| --------------------------- | -------------------------------- |
| **请求标识**                | request_id、session_id、trace_id |
| **调用方身份（Principal）** | 引擎不解读，只透传和用于审计     |
| **预算约束**                | token 预算、时间预算等           |
| **授权范围（Scopes）**      | 引擎用于 Tool 执行闸门的裁决依据 |

设计原则：

- 引擎层面只做基础的上下文传播和 Tool 闸门校验（基于 scopes 的粗粒度准入）
- 更复杂的业务权限校验，由 Tool 自身在执行时根据执行上下文组合判定
- 业务可沉淀专门的"权限校验 Tool"，其他 Tool 执行前先调用它
- 这保持了引擎"不感知业务权限"的边界

---

## 五、执行单元规格

所有可执行单元（Tool、Agent、执行后端）遵循统一的执行规格。

对于 Agent，声明维度描述的是**能力上界**（如"该 Agent
可能产生写操作"），而非精确的运行时行为。Agent 的实际副作用取决于运行时调用的
Tool，具体管控在 Tool 执行闸门层完成。

### 基本契约

```
input → process → output
```

### 声明维度

除基本输入/输出外，执行单元需声明以下维度，作为引擎调度和安全决策的依据：

| 维度       | 说明                     | 用途                   |
| ---------- | ------------------------ | ---------------------- |
| 副作用类别 | 只读 / 写 / 不可逆       | 重试策略、安全决策     |
| 是否幂等   | 相同输入重复执行是否安全 | 重试时是否可直接重执行 |
| 是否需审批 | 执行前是否需暂停等待确认 | 自动执行 vs 人工确认   |
| 超时约束   | 最大执行时长             | 调度和资源管控         |

例如："不可逆"的 Tool 在重试时需要特殊处理，"需审批"的 Tool
在自动执行前要暂停等待确认。

---

## 六、输入输出设计

### 输入层

设计理念：**宽进**——不限定输入类型，支持多模态。

引擎内部使用统一的**输入信封**：

| 层           | 说明                                                 |
| ------------ | ---------------------------------------------------- |
| **内容层**   | 业务传入的原始输入（文本、图片等），不做类型枚举限制 |
| **元信息层** | 模态提示、内容大小、来源标识等                       |

输入信封与执行上下文互补：执行上下文是"谁在调用、有什么权限"，输入信封是"本次传入了什么内容"。

```
输入进入引擎
  ↓
输入信封化（附加元信息）
  ↓
判断模态 + 检查目标模型能力
  ├── 模型原生支持（如图片 → 多模态 LLM）→ 直接透传
  └── 模型不支持 → 调用输入转换器（Adapter）按需降级
```

- 输入转换器（Adapter 模式）：引擎扩展库提供通用转换器，业务可自定义
- 原则：**能直传就直传，不做多余转换**
- **资源引用池**：图片/文件等重内容在入口被装配为正文中的占位 token `[[ref:<kind>:<key>]]` + 旁路 Resource Pool；`tool-routing` 等无需重内容的确定性阶段只看占位 token（渲染为 `[Image #N]`，零物化），仅在 **Provider 边界**按需物化（保真为默认；能力不匹配或解析失败时按 D6 三级降级）。

### 输出层

设计理念：**严出**——有类型枚举，下游需要知道产出了什么。

```
标准输出结构：
├── type           — 输出内容类型（引擎内置枚举）
├── content        — 主体内容
├── status         — 执行状态（成功 / 部分完成 / 失败）
├── steps          — 步骤级完成状态（各子任务完成/未完成/失败及原因）
├── metadata       — 元信息（工具调用记录、耗时、token 用量等）
├── artifacts      — 附件产物（文件、图片等）
├── trace_id       — 关联到结构化追踪
└── delivery_mode  — 交付方式（完整返回 / 流式推送）
```

输出内容类型枚举（引擎内置，可扩展）：

| 类型       | 说明                  |
| ---------- | --------------------- |
| text       | 文本                  |
| image      | 图片                  |
| file       | 文件/文档             |
| structured | 结构化数据（JSON 等） |
| composite  | 混合类型              |
| custom     | 业务自定义            |

交付方式（delivery_mode）与内容类型正交——任何内容类型都可以完整返回或流式推送。

> **字段命名约定**：本章字段以概念名（snake_case，如 `trace_id` / `delivery_mode`）示例，便于阅读与协议描述。代码实现统一遵循 TypeScript 驼峰惯例：`trace_id → traceId`、`delivery_mode → deliveryMode`、`tool_calls → toolCalls` 等。两者一一对应、语义等价；序列化协议（如对外 JSON Schema）若有 snake_case 需求，由业务层在边界处显式映射。详细类型定义见 detailed-design §6.3 与 `packages/core/src/types/io.ts`。

---

## 七、主干流程

> **流水线同构原则（ADR-0006 塌陷版）**：一个**深单 agentic loop 是唯一主干 spine**。所有请求：`turnStart` 前置守卫 → 确定性预处理（`tool-routing`）→ 进入同一个 `tool-use` loop；loop 内 LLM 自主决定调用工具、派发子代理，还是直接给出终答。「无工具的纯回答」由 loop step-1 无 `tool_call` 自然承接，不再有独立的 `direct-answer` 子流程或独立的 `intent`/`planning` 分类 phase。
>
> 横切能力（Rules / Hooks / Guardrail / 预算 / 可观测性）不再挂在 phase 名前后，而是统一挂在 **loop-lifecycle 事件**上；这保证了它们在所有请求上具备一致覆盖，且不再有"定义了却从不触发"的死挂载面。

```mermaid
graph TD
    Start[业务请求] --> Session[会话管理]
    Session --> Safety[最小安全准入]
    Safety --> TurnStart{turnStart 守卫}
    TurnStart -- block --> Abort[中止整轮]
    TurnStart -- pass / degrade / annotate --> ToolRouting[tool-routing 确定性预处理]
    ToolRouting --> PreLLM
    subgraph Loop[execution：tool-use 深单 Agentic Loop]
        direction TB
        PreLLM[preLLM] --> LLMDecide[LLM 决策：终答 / 调工具 / 派子代理]
        LLMDecide --> ToolCall{有 tool_call？}
        ToolCall -- 是 --> PreToolUse[preToolUse 审批]
        PreToolUse --> ExecTools[并行执行工具 / dispatch_agent]
        ExecTools --> PostToolUse[postToolUse]
        PostToolUse --> CompactCheck{上下文超阈值？}
        CompactCheck -- 是 --> PreCompact[preCompact 自动压缩]
        PreCompact --> PreLLM
        CompactCheck -- 否 --> PreLLM
        ToolCall -- 否 --> PostLLM[postLLM]
        PostLLM --> Terminal[terminalDraft 即候选答案]
    end
    Terminal --> Validate[结果验证]
    Validate --> TurnStop{turnStop 守卫}
    TurnStop -- block --> Reject[拒绝交付]
    TurnStop -- pass / degrade / annotate --> Output[输出规范]
    Output --> End[结果输出]
```

```
业务请求（携带执行上下文 + 输入信封）
  ↓
[ 会话管理 ] ← 引擎内部机制，非流程阶段
  ├── 新会话 → 创建 session，空上下文
  └── 已有会话 → 加载上下文
  ↓
最小安全准入（所有路径必经）
  ├── 输入安全检查（引擎固有基线）
  ├── 配额/预算检查
  ├── 基础权限校验（基于执行上下文中的 scopes）
  └── 业务前置安全挂载点（可选，业务可通过 Hooks 挂载轻量级安全策略）
  ↓
turnStart（pre-guard，恒 fail-closed，见「loop-lifecycle 挂载面」）
  ├── 内置默认 guard：SafetyModule baseline（前置安全检查产出的 violations → annotate/degrade/block）
  ├── 业务可通过 EngineDependencies.guardrails.turnStart 追加 guard（合规 / 内容策略 / 自定义门禁）
  ├── block → 中止整轮
  └── pass / degrade / annotate → 携带说明前缀继续
  ↓
tool-routing（确定性预处理，取代原 intent 分类 / precheck / planning / graph-check 四个 phase）
  ├── turnPolicy 规范化（只消费显式 scope / 已 pre-seed 的 metadata，不做模型猜测）
  ├── 工具集通过 ToolActivator.visibleTools 确定性收窄
  ├── 显式 @agent 提及 → agent-batch 快路径（与主干 loop 并行的独立确定性能力）
  └── 其余情况 → 构造单个 tool-use 任务，交给唯一主干 loop（零匹配工具时 loop 仍会执行，
        LLM 在无 tool_call 情况下自然产出纯文本答复）
  ↓
execution：tool-use 深单 Agentic Loop（唯一主干 spine）
  ├── 每个 step：preLLM → LLM 决策 → 有 tool_call？
  │     ├── 是 → preToolUse 审批 → 并行执行工具 / dispatch_agent → postToolUse → 结果回灌 → 下一 step
  │     │        （上下文超阈值时先过 preCompact 自动压缩再回灌）
  │     └── 否 → postLLM → terminalDraft（在完整 prebuiltPrompt 下写就，即候选答案正文）
  ├── 「无工具的纯回答」由 step-1 无 tool_call 自然承接（subsumes 已删除的 direct-answer）
  └── 达到 maxSteps 上限 / 预算耗尽 / 收到取消信号 → 循环退出并按可恢复性分流
  ↓
结果验证（Result Validation，默认开启，可配置关闭）
  ├── 通过 → 进入 turnStop
  └── 不通过 → 诊断 → 重试（回到 tool-routing 重新执行，上限可配置，默认 3 次）
               → 仍失败 → Output 阶段的本地确定性兜底模板
  ↓
turnStop（post-guard，恒最后跑、fail-closed，见「loop-lifecycle 挂载面」）
  ├── 内置默认 guard：Result Validation（evidence/claims → deliver/retry/degrade）
  ├── 业务可通过 EngineDependencies.guardrails.turnStop 追加 guard
  ├── block → 拒绝交付
  └── pass / degrade / annotate → 携带说明前缀继续
  ↓
输出规范 → 结果输出
```

### Plan（规划模式）

Plan 不是核心抽象；ADR-0006 塌陷深单 loop 后也**不再有「规划循环 / 多方案迭代审阅」**。`tool-routing` 确定性阶段恒产出**单步 `ExecutionRoute`**（`tasks.length >= 1`），不做 LLM 拆分。仅保留一个轻量**预览模式**：

- `runtime.planMode === true` 时，流在 `tool-routing` 产出单步 route 并通过最小图校验后发出 `plan-preview`，随即以 `done` 结束、**不进入** `execution` 阶段（供上层「先看要做什么、再决定是否执行」）
- `planMode === false`（默认）时，单步 route 直接交给唯一主干 `tool-use` loop 执行
- 已删除：「上层修正 Plan → 引擎再调整」的迭代循环，以及作为「规划循环输入」的预定义 Plan 模板

### 编排控制面

编排控制面**不再是「多方案规划 / 计划切换」角色**（`planning` phase 已随 ADR-0006 删除），退化为承载 `tool-routing` 单步输出的确定性管道，负责：

- **单步 route 承载**：持有并校验 `tool-routing` 产出的单一 `ExecutionRoute`（恒 `tasks.length >= 1`）
- **最小图校验**：对单步 route 做确定性校验（节点完整性 + 拓扑排序），由 `tool-routing` 内联完成（`validateRoute`，取代原独立 graph-check phase）
- **预算管控**：追踪全局预算消耗，达到上限时触发熔断
- **降级决策**：当 turn 级重试耗尽时，交由 `turnStop` 守卫与 Output 阶段的确定性兜底模板收口

### loop-lifecycle 挂载面

多阶段流水线塌陷为深单 loop 后（ADR-0006），横切能力从"挂在 phase 名前后"归位到"挂在 loop 生命周期事件上"，覆盖面不减反增——9 个 `HookPoint` 均有真实 fire 位（不再有旧版 14 个点里 13 个从未触发的死点）。

**对称守卫 seam（Guardrail）**：一个通用 `Guardrail` 契约同时承载 pre-guard（`turnStart`）与 post-guard（`turnStop`）；单个 guard 是做合规检查、内容策略还是质量校验由宿主消费方决定，core 只区分挂载点、不区分语义。处置结果恒 **fail-closed**，四态：

- `pass`：放行，无附加处置
- `block`：拒付——`turnStart` 场景中止整轮；`turnStop` 场景拒绝交付候选答案
- `degrade`：放行但降级说明，`userVisibleReason` 前缀拼进最终 `candidateAnswer.content`
- `annotate`：放行但附加简短前缀说明，不改写正文其余部分

刻意不提供"静默重排版"语义——想改格式是显式 transform，不是 guard 的职责。内置默认 guard：`turnStart` = `SafetyModule` baseline（前置安全检查产出的 violations 映射为 annotate/degrade/block）+ 业务通过 `EngineDependencies.guardrails.turnStart` 追加的策略；`turnStop` = Result Validation（evidence/claims → deliver/retry/degrade）。

**Rule 激活轴与生命周期挂载面正交**：Rule 的唯一产物是注入 prompt 的文本，`RuleDescriptor.activation` 只回答「规则正文**何时**进 prompt」（`always` / `manual` / `semantic` / `path`），终点永远是 prompt。`block`/`annotate`/`validate` 这类阶段动作属于本节的对称 Guardrail seam 与 `HookPoint`，由它们承担——**Rule 不是生命周期挂载点**，不要把 rule 与 hook 混为一谈。输出格式类约束用 `always` 规则常驻 system prompt（每步都在 → 直接塑形 `terminalDraft`）；`turnStart`/`turnStop` 的准入与质量把关交给 Guardrail / `ValidationRule`，不写成 rule。该激活模型对齐业界 rule 系统（Cursor / Copilot / Continue / Cline）。

**subagent 派发（Single-Writer Rule）**：loop 内 LLM 可通过内置 Task-style 工具 `dispatch_agent` 自决派发只读子代理，复用既有 Agent runtime（`agentRunId` history-scope 隔离、`decideSubAgentBudget`、同一 `toolUseExecutor`），零新增架构面：

- **Single-Writer Rule**：`Engine.filterReadonlyToolNames` 确定性过滤掉非 `readonly` 工具（registry 查不到的工具名 fail-closed 排除），写操作留给主 loop
- **summary-only 契约**：子代理只回 `output` + `evidence` 摘要，不回子 loop 完整 transcript
- **maxDepth 默认 1**（`DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH`）：禁止嵌套 spawn，可通过 `runtime.toolLoop.subagentDispatch.maxDepth` 配置放宽
- `preSubagent` / `postSubagent` 在「显式 `@agent` 提及」与「loop 内 `dispatch_agent` 调用」两条路径下均一致触发

**tool-use loop 吸收的能力**（原 `direct-answer` 独有能力，随其删除一并并入唯一主干）：

- **chat-response 产图 / media passthrough**：`response.images` / `response.media` 经 `onGeneratedImages` / `onGeneratedMedia` 回调透传，最终出现在 `OutputMetadata.generatedImages` / `generatedMedia`
- **no-empty-promise 护栏**：写入 base 元 system prompt 的强制条款（而非动态 rule），要求模型不得输出"我将稍后查一下"之类的空承诺
- **cheap route（`shortTaskRoute`）**：命中"单工具调用 + 简短 prompt"阈值时，确定性把能力路由从 `high-reasoning` 降级到 `fast-cheap` 等廉价能力标签

**工具暴露收窄**：loop 默认工具集 = `ToolActivator.visibleTools`（相关性收窄后的结果），而非全量 registry，同时控制 trivial 请求的工具列表膨胀与弱模型幻觉调用。

**取消传播 / 预算熔断 / 可观测性**（既有能力保留，挂载点由「phase 前后」改为「loop 生命周期事件」）：

- 同一 session 新消息到达时 last-message-wins，自动停止当前执行
- 硬预算（token / time / tool 累计）熔断保持 turn 级累计；context-window 决策（trim/compress/degrade）改为 per-step 复检 + 超阈值自动 compact（`preCompact`）
- observability 的 `phase_enter`/`phase_exit` 保留，但语义从"14 个 phase 各自的进入/退出"收窄为仅标记 6 个 `EnginePhase` 的宏观边界；`tool-use` loop 内部不再重新发明子阶段事件，改用扁平 per-step 事件（`tool_loop_step_*` / `tool_call_*` / `llm_call_*` / `hook_fired`）+ `parentStepId` 关联

### 关键流程特性

- **深单 loop 主干**：所有请求统一经 `turnStart` 守卫 → 确定性 `tool-routing` 预处理 → 进入同一个 `tool-use` Agentic Loop；不再有 simple/complex 分类，不再有独立 `intent`/`planning` phase
- **无工具纯回答由 loop 承接**：零工具调用的纯文本答复由 loop step-1 无 `tool_call` 自然产出（`terminalDraft`），不再有独立的 `direct-answer` 子流程
- **terminalDraft 即终答**：loop 终止消息在完整 `prebuiltPrompt`（persona + rules + active skills + memory + tools）下写就，直接作为候选答案正文，不再有独立的 final-answer 写手 LLM 重写它
- **对称守卫 fail-closed**：`turnStart`/`turnStop` 两处 guardrail 恒 `pass/block/degrade/annotate`，`turnStop` 恒最后跑
- **loop-lifecycle 覆盖面**：Rules（`turnStart`/`preLLM`/`turnStop`/`*`）、Hooks（9 个 `HookPoint`）、预算、可观测性对所有请求等效覆盖，无死挂载面
- **确定性工具路由**：`tool-routing` 用显式 @agent/@tool 名称匹配 + `ToolActivator.visibleTools` 收窄一次性替代原 intent 分类 + precheck + planning + graph-check 四个 phase
- **subagent 安全阀**：loop 内可自决派发只读子代理（`dispatch_agent`），Single-Writer Rule + summary-only 契约 + maxDepth 默认 1
- **per-step 上下文管理**：超阈值时 `preCompact` 自动压缩，长 loop 不再溢出 context window
- **事不过三**：turn 级重试有上限，可配置（回到 `tool-routing` 重新执行）
- **步骤级状态输出**：全部失败时，输出各步骤的完成状态而非笼统的"可靠部分"
- **取消传播**：同一 session 新消息到达时，自动停止当前执行（last-message-wins），在已有上下文基础上处理新输入
- **弱模型鲁棒性靠提示词而非框架硬解**：no-empty-promise 护栏、failureRecovery 护栏、确定性工具收窄，而非固定内置 LLM 判定

### 内置 Sub-flow：tool-use（唯一主干）

> `0.1.x` 曾有 `direct-answer` 与 `tool-use` 两类内置 Sub-flow；ADR-0006 起 `direct-answer` 已删除、`tool-use` 升为引擎唯一主干 spine。

`tool-use` 是引擎当前**唯一**的内置 Sub-flow：所有请求统一路由到它，由 loop 内的 LLM 自主决定调用工具、派发子代理，还是直接产出自然语言答复。它仍然**不是**四类核心抽象（Rules/Skills/Tools/Agents）中的任何一种：

- 引擎在启动期通过 `Registry` 的 `reservedNames` 机制把 `tool-use` 锁定为引擎保留名；业务端任何 `register('xxx', { name: 'tool-use', ... })` 都会抛 `RegistryError.reservedName`
- 执行函数由独立的 `InternalSubflowRegistry`（`packages/core/src/engine/subflows/registry.ts`）维护，**不进入** `DescriptorRegistry` 的四类 descriptor 表
- `tool-routing` 之后，主干通过 `buildLayeredTaskExecutor` 优先匹配 `task.type === "sub-flow" && InternalSubflowRegistry.has(task.ref)`，命中即走内部通道；未命中再回落到业务/默认 TaskExecutor

`tool-use` Sub-flow 的核心运行契约（详见 detailed-design §7.12）：

- **循环上限**：`runtime.toolLoop.maxSteps`（默认 25）与 `parallelism`（默认 4）；全局 `requireApprovalGlobal` 可强制每次工具调用都先触发审批
- **审批协议**：当工具描述符 `requiresApproval: true` 或全局开关打开时，引擎在真正执行工具前触发 `preToolUse` hook；回调返回 `deny` 时合成 tool 消息告知 LLM 并继续循环，不会中断整条 loop
- **失败恢复护栏**：`failureRecoveryRetries`（默认 1）——某步 terminal（模型停止且无 `toolCalls`）但本轮"有工具失败且零成功结果"时，注入一条纠错 system 提示并强制再走一步，防止弱模型首次工具失败即放弃或编造
- **观测事件**：每一轮思考 / 每一次工具调用 / 整个循环结束都会产出结构化流式事件（`tool-loop-step` / `tool-call-start` / `tool-call-end` / `tool-loop-final`），供 CLI 与 SDK 渲染进度
- **预算与取消**：循环内每次 Provider.chat 与每次工具执行都透传主干的 `AbortSignal` 与 `ExecutionContext.budget`；任意一次调用耗尽预算或收到取消都会让循环立即退出并以相应错误上报
- **subagent 派发**：内置 Task-style 工具 `dispatch_agent`（`AGENT_DISPATCH_TOOL_NAME`），Single-Writer Rule + summary-only 契约 + maxDepth 默认 1（详见上文「loop-lifecycle 挂载面」）
- **chat-response 产图 / media passthrough**：`onGeneratedImages` / `onGeneratedMedia` 回调接在 loop step 内
- **no-empty-promise 护栏**：写入 base 元 system prompt 的强制条款
- **cheap route**：`shortTaskRoute` 命中简单任务阈值时确定性降级到低价模型能力标签

### 生命周期钩子（Hooks）

多阶段流水线塌陷为深单 loop 后，14 个 phase 命名的 `HookPoint`（旧版仅 `afterPlanning` 真正被 fire，其余 13 个是从未触发的死点）被替换为 9 个 loop-lifecycle 事件，每个点都有真实 fire 位 + 精确 action 语义 + 专项测试：

```
turnStart · preLLM · postLLM · preToolUse · postToolUse · turnStop · preSubagent · postSubagent · preCompact
```

| HookPoint | 语义 | Fire 位 |
| --- | --- | --- |
| `turnStart` | pre-guard：一轮开始前，承载 `SafetyModule` baseline + 业务策略 | `engine.ts` |
| `preLLM` / `postLLM` | free-mutation：loop 每个 step 调用 LLM 前后，host 可改写 messages/response | `tool-use.ts` |
| `preToolUse` / `postToolUse` | 工具调用审批（approve/deny）与结果事件 | `tool-use.ts` |
| `turnStop` | post-guard：一轮结束前，承载 Result Validation，恒 fail-closed 最后跑 | `engine.ts` |
| `preSubagent` / `postSubagent` | 子代理派发前后 | `engine.ts` |
| `preCompact` | loop per-step 上下文超阈值、即将自动压缩前 | `tool-use.ts` |

两类语义边界：

- **free-mutation**（`preLLM`/`postLLM`）：host 拥有全权改写能力，但引擎守两条底线（**Engine Seatbelt**）——① 每次 mutation 后跑结构化 normalize/re-validate，拒绝 dangling tool_call / role 顺序错误 / provider 协议非法，绝不把畸形对话喂给 Provider；② 所有 mutation 记入 observability 审计
- **guardrail**（`turnStart`/`turnStop`）：对称守卫 seam，处置结果限定为 `pass/block/degrade/annotate` 四态，恒 fail-closed，不提供"静默重排版"能力（见上文「loop-lifecycle 挂载面」）

- **订阅模式（推荐）**：只读，观察各事件发生了什么
- **注册模式（支持）**：可写，在事件点注入逻辑（`HookAction`：`continue`/`abort`/`modify`/`approve`/`deny`/`replace`/`enrich`）
- 订阅 Hook 是可观测性实时进度流的数据源之一
- 运行约束详见 §九.8 Hooks

---

## 八、错误处理与状态流转

> **当前实现范围（`0.2.0`，ADR-0006 落地后）**：`tool-routing` 现恒产出**单个** `ExecutionRoute`（单步 route，不再生成多候选方案排名列表）。原「切换下一方案」的多方案竞选机制已随 ADR-0006 彻底移除（`ExecutionOrchestrator` 退化为纯预算 / 计时追踪器，不再持有 plan、不再有 `switchToNextPlan`）。任务级重试因而收敛为 **turn 级重试**：`turnStop` guardrail（Result Validation）判定不通过时，Engine 主循环 `continue` 整个 turn，把上一轮失败摘要（`PreviousTurnAttempt`）注入下一轮 `tool-routing`，重新构造单步 route 并重新进入 loop。Provider 级重试尚未形成统一 ExecutionPolicy。

### 两套独立重试体系

|              | turn 级重试                                                  | 系统级重试                             |
| ------------ | ----------------------------------------------------------- | -------------------------------------- |
| **触发**     | `turnStop` guardrail（Result Validation）判定不通过          | API 超时 / 报错 / 崩溃                 |
| **默认上限** | 3 次                                                        | 2 次                                   |
| **策略**     | `decideTurnRetry` 判定可重试 → 重新执行 `tool-routing → loop` 整个 turn | 同 Provider 重试 → 降级到备用 Provider |
| **兜底**     | 仍失败则输出步骤级完成状态（`output` 阶段确定性兜底模板）    | 透传错误给业务方                       |

### 状态流转示意

```mermaid
stateDiagram-v2
    [*] --> 执行中
    执行中 --> 系统异常
    系统异常 --> 系统级重试
    系统级重试 --> 执行中: 成功
    系统级重试 --> Provider降级: 失败 (上限2次)
    Provider降级 --> 执行中: 有备用
    Provider降级 --> [*]: 无备用 (透传错误)
    
    执行中 --> 执行完成
    执行完成 --> turnStop守卫
    turnStop守卫 --> [*]: 通过
    turnStop守卫 --> 诊断问题: 不通过
    诊断问题 --> turn级重试: decideTurnRetry 判定可重试
    turn级重试 --> 执行中: (上限3次，重新走 tool-routing)
    诊断问题 --> 本地兜底模板: 重试耗尽
    本地兜底模板 --> [*]: 输出步骤级完成状态
```

```
子任务执行
  │
  ├── 执行中发生系统异常
  │     ↓
  │   系统级重试（同 Provider，上限 2 次）
  │     ├── 成功 → 继续执行
  │     └── 仍失败 → Provider 降级（**v1.x+ 规划； 未实现**）
  │                   ├── 有备用 → 切换 Provider，当前计划继续执行
  │                   └── 无备用 → 透传错误
  │
  └── 执行完成 → turnStop 守卫（Result Validation）
                  ├── 通过 → 完成
                  └── 不通过 → 诊断问题
                       └── decideTurnRetry 判定可重试 → turn 级重试
                            ├── 未耗尽（上限 3 次）→ 携 PreviousTurnAttempt 重新走 tool-routing → loop
                            └── 已耗尽 → 输出步骤级完成状态（output 阶段确定性兜底模板）

  ⚠ 全局预算贯穿所有机制 → 任意时刻预算耗尽即熔断终止
```

### Provider 降级（v1.x+ 规划； 未实现）

> **当前代码树**：LLM 调用失败时不自动切换 provider。`models.providerFallbackOrder` 仅用于启动期注册 provider 与 CLI 默认连接 target。下列为**目标行为**，供 v1.x+ 实现时对齐。

- 降级后当前计划继续执行，不因降级本身触发重规划
- 若降级后执行结果不达标，在正常的结果验证环节捕获，走正常重试/重规划 loop
- 降级事件记录到可观测性追踪中（`provider_fallback` 事件类型已预留）

### 错误传递通道

- 流式标准错误输出（实时）
- 事件订阅（Hooks）
- 最终结果中的 status + steps 信息

### 兜底输出契约（Fallback & User-Facing Contract）

> 自 patch-01-fallback 起，**任何 non-success 返回都必须产出可用于用户决策的自然语言答复**，不得把内部步骤 ID / Phase 编号 / 子流程名泄漏到终端视野。

- 引擎 / SDK / CLI 三层都有脱敏防线：
  1. **L1 源头**：所有 `EngineError` 自带 `userMessage`（见 technical-design §12.1.1）
  2. **L2 聚合**：`output` 阶段的 `ensureFallbackText()` 始终返回本地确定性模板（不调用 LLM，ADR-0006 落地后：不可恢复错误走诚实报错文案，不再有旧版的 LLM best-effort summary 路径），统一 ≥ 30 字
  3. **L3 最终屏蔽**：CLI `StreamRenderer` 对 `text / markdown` 输出与 `error` chunk 再做一次正则过滤
- 验收门槛：`packages/core/src/engine/phases/fallback-contract.test.ts` 对契约做硬验证（55 断言，CI 红灯 block）
- 详细实现见 technical-design §12.4

---

## 九、核心模块（8 个）

### 9.1 会话管理

引擎核心模块，业务无需关心隔离细节：

- **会话解析**：根据 session_id 判断新建或恢复
- **上下文加载**：从记忆系统获取对应 session 的上下文
- **会话间隔离**：每个 session 独立的上下文空间、执行状态、资源追踪，互不干扰
- **生命周期**：创建 → 活跃 → 挂起 → 关闭
- **同 session 并发输入**：遵循 last-message-wins
  策略——新消息到达时停止当前执行，在已有上下文基础上处理新输入

会话管理与记忆系统的边界：**会话管理负责"哪个
session、什么时机"，记忆系统负责"存什么、怎么存"**。

跨 session 上下文关联属于记忆系统的职责；ADR-0006 塌陷主干后，原「意图分析」阶段的上下文相关性判定（`contextRelevance`）已随该 phase 一并删除，不再有独立的历史相关性判定环节——会话上下文的取舍统一由记忆系统的窗口管理 / 压缩策略承担。

### 9.2 记忆系统

引擎定义记忆系统的**标准能力接口**（存储、压缩、召回），提供默认实现，业务可通过标准接口替换。

- **会话上下文**：
  - 支持配置上下文上限
  - 接近上限时触发压缩策略
  - 压缩策略是**可插拔的抽象接口**，业务可替换实现，官方后续也可能提供新的压缩实现
  - 引擎默认压缩策略为 **Head-Middle-Tail**：
    - Head — 保留最早的上下文（任务起点、关键设定）
    - Middle — 中间部分只保留关键节点摘要（LLM 压缩）
    - Tail — 保留最近的对话（当前工作焦点）
  - 压缩的**引擎级约束**（不随策略实现改变）：
    - **archive-before-summarize**：压缩前先归档原始内容，压缩有损但原始内容不丢
    - **结构化锚点不参与压缩**：任务目标、关键约束、已确认的外部写入结果等关键事实始终保留
  - 超限后对历史内容做归档或向量化存储
  - 支持清空上下文（= 开启新 Session）
- **长期记忆**：
  - 支持归档或向量化存储
- **存储位置由上层业务配置**，记忆能力接口是引擎核心

#### 持久化契约（跨进程）

`MemorySystem` 是会话历史的 **唯一权威持久层**。引擎通过依赖注入接受 `MemorySystem` 实现（instance 或 factory），core 不直接依赖文件系统。

- 官方提供两档实现：
  - **内存版 `InMemoryMemorySystem`**（核心包内置，进程级，适合 SDK 嵌入场景）
  - **文件版 `FsMemorySystem`**（扩展包 `@tachu/extensions` 提供，`.jsonl` 分片落盘，CLI 默认注入，用于 `--resume` 等跨进程需求）
- 配置两个开关：`memory.persistence`（`memory`/`fs`，默认 `fs` 由 CLI 强制）、`memory.persistDir`（默认 `.tachu/memory`）
- **append-on-write + atomic rewrite-on-compress**：热路径 append-only 落盘（崩溃安全），`compress`/`trim` 后通过 `tmp + rename` 整体重写，保证「盘 = 内存」一致
- **首次 load 一次性 hydrate**：新进程首次访问 session 时，从磁盘读回全部 entries 旁路 per-entry 压缩，之后读路径全部在内存
- **热 / 冷路径分离**：`persistDir` 为热路径（每次 append 即落盘，供 `--resume`）；`archivePath` 为冷路径（仅 `archive()` 一次性写入供跨 session 向量召回），两者互不覆盖
- SDK 侧亦可以 `persistence: "memory"` 退化为纯内存，或注入自定义 `MemorySystem`（如 Redis、SQLite 等），保持同样的热 / 冷路径契约

上下文完整生命周期：

```mermaid
graph LR
    Chat[实时对话] --> Limit{接近上限?}
    Limit -- 是 --> Compress[压缩策略执行]
    Compress --> Archive[归档原始内容]
    Archive --> Window[保持窗口可用]
    Limit -- 超限 --> LongTerm[归档 / 向量化]
    LongTerm --> Storage[(长期存储)]
```

```
实时对话 → 接近上限 → 压缩策略执行（保持窗口可用）
                       ↓ 压缩前先归档原始内容
                  超限 → 归档 / 向量化（长期存储，可召回）
```

### 9.3 运行状态

独立于记忆系统，面向引擎自身消费：

- **职责**：执行进度、Checkpoint、重试计数、子任务完成情况
- **特点**：结构化数据，非语义化
- **生命周期**：自动维护，任务完成后清理
- **存储方式**：引擎自行选择（内存 / SQLite / 文件等）

与记忆系统的区分：**记忆系统存对话记忆（给 LLM
看），运行状态存引擎状态（给引擎看）**。

### 9.4 模型路由

- 引擎内部使用**抽象能力标签**（如
  `high-reasoning`、`fast-cheap`），不绑定具体模型名称
- 通过模型配置（映射层）将能力标签映射到具体 model-name
- 业务配置的规则中可直接指定具体 model-name 覆盖默认映射
- 各 LLM 调用点可按需使用不同能力标签
- 同时提供模型能力检查（输入层按需判断是否需要 Adapter）

### 9.5 模型接入（Provider/Adapter）

- 引擎定义标准 LLM 调用协议
- 标准协议包含 `listAvailableModels()` 接口，上层实现后一键装配所有可用模型
- 也支持手动逐个配置模型
- Provider Adapter 模式：引擎定义接口，业务提供驱动
- 扩展库提供通用 Adapter（如 OpenAI、Anthropic 等）
- **Provider 运行时降级**：系统异常时自动切换到备用 Provider —— **v1.x+ 规划**；`1.0.0` 稳定版前不实现（见 detailed-design §8.1）

### 9.6 安全模块

安全模块分为两层：

#### 引擎固有基线（不可关闭、不可置空）

引擎自身保证运行安全的最小集，不依赖业务注入：

| 维度         | 说明                             |
| ------------ | -------------------------------- |
| 循环防护     | 防无限循环、递归深度限制         |
| 预算熔断     | Token / 时间预算达上限时强制终止 |
| 基础输入校验 | 输入大小限制等基本健全性检查     |

原则：**fail-closed**——即使业务什么都不配，引擎自身也不会失控。

#### 业务可注入策略（可配置、可扩展）

引擎提供挂载点，业务按需注入：

| 维度     | 说明                           |
| -------- | ------------------------------ |
| 输入安全 | Prompt 注入检测、恶意内容过滤  |
| 执行安全 | 工具调用权限校验、敏感操作拦截 |
| 输出安全 | 防泄露敏感信息、内容合规检查   |
| 业务权限 | 领域级权限规则                 |

注意：这是引擎级安全机制，不是业务权限系统。

### 9.7 可观测性

双通道设计：

| 通道                    | 用途                    | 特点   |
| ----------------------- | ----------------------- | ------ |
| 实时进度流（Streaming） | 推送给上层做 UI 展示    | 低延迟 |
| 结构化追踪（Trace Log） | 完整链路，事后排查/审计 | 完整性 |

核心设计要素：

- 引擎定义**标准事件体系**，所有阶段的关键动作（阶段进入/退出、LLM 调用、Tool
  调用、错误等）产出结构统一的事件
- 实时进度流和结构化追踪消费同一套事件，只是用途不同
- **脱敏能力**：引擎提供脱敏挂载点，具体脱敏策略由业务注入
- 覆盖：每个阶段、每次 LLM 调用、每次 Tool 调用的完整执行过程透明化

### 9.8 Hooks（生命周期钩子）

引擎在主干流程各阶段前后暴露钩子挂载点。

**两种模式**：

- **订阅模式（推荐）**：只读，观察各阶段事件
- **注册模式（支持）**：可写，注入自定义逻辑

**运行约束**：

- 可写 Hook 有超时限制，超时后引擎按默认策略继续，不阻塞主干
- Hook 执行顺序：引擎安全基线 → 引擎内置 Hook → 业务注册 Hook
- 安全相关阶段的结论对后续 Hook 只读，防止被篡改
- 单个 Hook 失败默认不中断主干流程（可配置为中断）

订阅 Hook 是可观测性实时进度流的数据源之一。

---

## 十、向量化能力

```
向量化能力：
├── 标准接口（embed + search）— 引擎定义
├── 内置轻量实现（本地小模型 + 内存索引）— 仅供 demo / 开发调试，不建议生产使用
├── 引擎扩展库 — 常见向量数据库 Adapter
└── 业务自实现 — 生产环境推荐
```

应用场景：

- 语义发现（Rules/Skills/Tools/Agents 的 description
  索引，用于双平面匹配的候选召回面）
- 记忆归档（超限上下文的向量化存储与召回）
- 长期记忆（跨会话历史的向量化存储）

---

## 十一、Prompt 组装与上下文工程

引擎负责将激活的各类上下文组装成完整的 LLM 调用 Prompt。

### 组装输入

- 激活的 Rules（按 scope 和阶段筛选）
- 激活的 Skills（注入知识/指令）
- 工具定义（可用 Tool 的描述和调用协议）
- 会话上下文（经记忆系统管理）
- 当前输入内容

### 设计原则

- 引擎负责组装策略，确保各类上下文按合理顺序和优先级进入 Prompt
- 组装过程对业务透明，业务通过注册 Rules/Skills/Tools 间接影响 Prompt 内容
- 具体组装策略和优化手段（如 KV Cache 友好排列、Token 预算分配）留给细纲

---

## 十二、上下文分发策略

编排控制面按"需要知道"原则裁剪上下文：

```
┌─ 全局上下文（引擎维护）──────────────┐
│  业务输入、会话历史、各阶段产出...     │
└──────────────────────────────────────┘
          │
    编排控制面决定投递量
    （减少上下文污染，节约 Token）
          │
    ┌─────┼─────┐
    ↓     ↓     ↓
  子任务A 子任务B 子任务C
  (精简)  (精简)  (精简)
```

---

## 十三、执行后端与 MCP 适配

### 执行后端

引擎定义执行后端的标准接口，不关心具体后端类型：

```
引擎核心：
└── 执行后端标准接口（遵循执行单元规格）

引擎扩展库（官方）：
├── TerminalBackend  — 终端/沙箱执行
├── WebBackend       — 浏览器/外部 API
├── FileBackend      — 文件系统操作
└── ...

业务层：
└── CustomBackend    — 业务自行实现
```

### MCP 适配

MCP（Model Context Protocol）工具通过 **McpToolAdapter**
接入引擎，对引擎而言仍是 Tool。

适配器负责处理 MCP 特有语义：

- **Session 管理**：MCP 连接的生命周期管理
- **能力协商**：MCP 服务端能力的发现与协商
- **进度/取消传播**：将引擎的取消信号传播到 MCP 服务端
- 具体协议映射留给细纲

---

## 十四、配置体系

### 设计原则

**一切行为参数皆可配置，引擎提供合理默认值。**

### 优先级模型

引擎只管两级关系：

```
硬规则（约束/护栏）：引擎内置 > 业务配置     ← 安全性不可被覆盖
软配置（偏好/参数）：业务配置 > 引擎默认值    ← 业务优先
```

引擎不感知终端用户。业务内部如何处理用户优先级是业务的事。

### 已识别的配置点

| 配置项            | 默认值 | 说明                                |
| ----------------- | ------ | ----------------------------------- |
| turn 级重试上限   | 3      | `turnStop` guardrail（Result Validation）判定不通过时的最大重试轮数 |
| 系统重试上限      | 2      | 系统级异常的最大重试次数            |
| Provider 降级顺序 | —      | `providerFallbackOrder`：启动注册 + CLI 默认 target；runtime 切换 **v1.x+** |
| 方案数量          | 1      | `tool-routing` 确定性生成的 Plan 数（恒为 1，见 §八）|
| 结果验证开关      | 开启   | 是否启用结果验证环节                |
| Agent 嵌套深度    | 1      | 默认只支持主 Agent → sub-agent 一级 |
| 上下文上限        | —      | 会话上下文的 Token / 条数限制       |
| 压缩触发阈值      | —      | 触发压缩策略的上下文占比            |
| 超时时间          | —      | 子任务执行超时                      |
| 模型能力映射      | —      | 各阶段的能力标签 → 具体模型         |
| 安全策略          | —      | 业务注入的各维度校验实现            |
| 存储引擎          | —      | 归档 / 向量化的存储位置             |
| 压缩策略实现      | H-M-T  | 上下文压缩策略，可替换              |
| ...               | ...    | 持续扩充                            |

### 规则激活条件

> **激活轴**：`RuleDescriptor.activation` 回答「规则正文**何时**被注入 prompt」，与业界 rule 系统（Cursor / Copilot / Continue / Cline）的激活模型对齐。它**不是**生命周期挂载点——`turnStart`/`turnStop` 的阶段动作（block/annotate/validate）属于 `HookPoint` / `Guardrail` / `ValidationRule`，不由 Rule 表达。缺省无活跃输入时 fail-closed 不注入；loader 对未知 `mode` 显式报错。

| `activation.mode` | 含义 | 注入条件 |
| ----------------- | ---- | -------- |
| `always`   | 总是注入（≈ Cursor `alwaysApply`）| 恒进 system prompt |
| `manual`   | 手动点名（≈ `@rule` 引用）        | 命中 `SessionScope.explicitRuleNames` |
| `semantic` | 语义相关（≈ agent-requested）      | 命中调用方给出的活跃集（缺省不注入）|
| `path`     | 路径匹配（≈ `globs` 自动附着）     | 命中 `globs` 的文件出现在本轮上下文 |

### Descriptor 协议扩展契约（MUST）

- Registry 作为协议层基础设施，必须允许同名 Descriptor 的多版本共存；冲突定义为 `kind + name + version` 全相同。
- `BaseDescriptor.version` 使用 semver；未声明版本时按 `0.0.0` 参与治理。
- 默认查询 `get(kind, name)` 必须向后兼容：返回 latest（稳定版优先；若无稳定版则取最高 pre-release）。
- 显式查询 `get(kind, name, version)` 必须是精确匹配，不做 range 解析。
- Registry 必须保留 Descriptor 的未知顶层字段，并在 `get(...)` 返回时原样可读，保障下游扩展契约稳定。
- 业务扩展字段命名建议：`x-<vendor>-<field>` 或命名空间块（如 `x-acme: { ... }`）。

---

## 十五、技术选型

当前采用：运行时 **TypeScript / Bun**、向量存储 **Qdrant** 与本地文件索引、状态存储文件持久化、流式 **SSE**、追踪 **OpenTelemetry**。下表记录各方向的备选与选型理由。

| 方向           | 候选                       | 适合理由                        |
| -------------- | -------------------------- | ------------------------------- |
| **运行时**     | TypeScript/Bun             | 全栈统一、类型安全、AI 生态丰富 |
|                | Python                     | AI/ML 生态最成熟                |
|                | Rust                       | 高性能、并发安全                |
|                | Go                         | 高并发、部署简单                |
| **向量数据库** | Milvus / Qdrant / Pinecone | 生产级向量存储                  |
|                | SQLite + 向量扩展          | 轻量级本地方案                  |
| **状态存储**   | SQLite / Redis             | 运行状态持久化                  |
| **消息/流式**  | SSE / WebSocket            | 实时进度流                      |
| **追踪**       | OpenTelemetry              | 结构化追踪标准                  |

---

## 十六、参考资料

> 以下资料为设计灵感来源，不作为已核验事实。引用仅表示"借鉴了其思路"，具体设计以本文档正文为准。

| 来源                | 借鉴方向                                                   |
| ------------------- | ---------------------------------------------------------- |
| Hermes Agent 架构   | 分层架构、Session Routing、安全侧通道、执行后端分类        |
| Harness Engineering | Agent = Model + Harness 理念、核心组件划分、Hooks 生命周期 |
