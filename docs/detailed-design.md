# Agentic Engine 详细设计文档

> 状态：Release Candidate 基线 最后更新：2026-07-02（ADR-0006 落地）
>
> **职责边界**：接口与模块规格。愿景与分层见 [概要设计](./overview-design.md)；工程结构见 [技术设计](./technical-design.md)。
>
> **0.2.0 架构变更（ADR-0006 · loop-lifecycle harness surface）**：主干流程已从「9 阶段同构流水线」塌陷为「深单 agentic loop 唯一主干 + loop-lifecycle 守卫/挂载面」，详见 §七、§9.7、§9.8。

本文档严格对齐 [概要设计](./overview-design.md) 各章节，逐一细化为可落地执行的规格。

### 版本与发布术语（必读）

| 术语 | 含义 |
| --- | --- |
| **Tachu v1** | 当前框架代际；`1.0.0-rc.0` 是 `1.0.0` 的稳定化候选版本，不是下一代框架。 |
| **发布版本** | SemVer，如 `1.0.0-rc.0`（`rc` dist-tag）。能力是否已交付以 README 项目状态表为准。 |
| **当前实现 / 路线图** | 描述能力时用「当前已实现」「当前占位」「后续路线图」；**不要**用「框架 v2」指代尚未交付的特性。 |
| **HTTP `/v1/`、`/v2/`** | `@tachu/web-fetch-server` 的 REST API 版本前缀，与 Tachu 框架代际无关。 |
| **Session schema** | 磁盘会话文件格式代际（如含 `messages` 的旧格式 → 当前格式）。文档中写 **session schema**，避免与「Tachu v1」混用单独的「v1/v2 session」。 |

---

## 一、项目定位（无需细化）

见概要设计。定位已明确，无需在细纲中重复。

---

## 二、三层发布结构

### 2.1 包结构

```
@tachu/core        ← 引擎核心（协议、接口、流程骨架）
@tachu/extensions   ← 引擎扩展库（官方，单包）
@tachu/cli          ← CLI 程序（轻量业务使用方，v1 交付物）
```

- `extensions` 当前为单包，收纳所有官方扩展，后续按需拆分
- `cli` 是基于 core + extensions 构建的可工作的命令行程序，作为第一个版本的参考实现和验证载体

### 2.2 层间依赖规则

```
cli → extensions → core
cli → core
```

- `core` 零外部依赖，只导出协议、接口、流程骨架
- `extensions` 依赖 `core`，提供具体实现（Provider Adapter、Tools、执行后端封装等）
- `cli` 依赖 `core` + `extensions`，组装为可运行的 CLI 程序
- 外部业务层与 `cli` 同级，依赖 `core` + 按需引入 `extensions`

### 2.3 core 导出边界

| 导出类型 | 示例 |
| --- | --- |
| 接口/协议定义 | `ProviderAdapter`、`Tool`、`MemoryStrategy` 等 |
| 主干流程引擎 | `Engine` 入口 |
| 生命周期钩子类型 | `HookPoint`、`HookHandler` |
| 配置 Schema | `EngineConfig` |
| 内置基线实现 | 安全基线、默认压缩策略等不可替换的最小集 |

### 2.4 CLI 包职责

`cli` 作为 v1 的轻量业务使用方：

- 组装 core + extensions 为可工作的引擎实例
- 提供终端交互界面（对话式），CLI 命令：`tachu chat` / `tachu run` / `tachu init`
- 加载 `.tachu/` 目录下的本地配置文件（Rules、Skills、Tools、Agents）
- 作为引擎能力的验证载体和使用示范

---

## 三、四大核心抽象

### 3.1 公共元信息（BaseDescriptor）

```typescript
interface BaseDescriptor {
  name: string;              // 唯一标识
  description: string;       // 自然语言描述（用于语义发现）
  version?: string;          // semver；未声明时按 0.0.0 处理
  displayName?: string;      // 面向 UI/列表展示的人类可读名
  deprecated?: boolean;      // 治理标记：是否已废弃
  deprecatedMessage?: string; // deprecated=true 时必须提供迁移提示
  tags?: string[];           // 标签（过滤和分类）
  trigger?: TriggerCondition; // 激活条件
  requires?: DependencyRef[]; // 显式依赖引用
}
```

#### 描述符扩展字段契约（MUST）

- `DescriptorRegistry.register(descriptor)` 必须保留描述符的未知顶层字段（passthrough），不得在注册层剥离。
- `DescriptorRegistry.get(...)` 返回对象必须包含原始未知字段，保证协议向前兼容。
- 建议业务扩展字段使用 `x-<vendor>-<field>` 或命名空间块（如 `x-acme: { ... }`）避免与未来核心字段碰撞。
- 版本解析规则：`get(kind, name)` 返回 latest（稳定版优先；若无稳定版则取最高 pre-release）；显式 `get(kind, name, version)` 走精确匹配。

#### TriggerCondition

```typescript
type TriggerCondition =
  | { type: 'always' }                    // 始终激活
  | { type: 'keyword'; keywords: string[] } // 关键词匹配
  | { type: 'semantic'; threshold: number }  // 语义相似度阈值
  | { type: 'explicit' }                   // 仅显式引用时激活
  | { type: 'custom'; handler: string }     // 自定义判定（引用已注册的判定函数名）
```

#### DependencyRef

```typescript
interface DependencyRef {
  kind: 'rule' | 'skill' | 'tool' | 'agent';
  name: string;
}
```

### 3.2 Rules

```typescript
interface RuleDescriptor extends BaseDescriptor {
  type: 'rule' | 'preference';   // 硬约束 vs 软偏好
  scope: RuleScope[];             // 作用阶段
  content: string;                // 规则正文（注入 Prompt 的文本）
}

// ADR-0006 D5：RuleScope 塌陷为 loop-lifecycle 子集，与 §7.3 的 `HookPoint`
// 共用同一套词汇；旧 7 个 phase 名（safety/intent/precheck/planning/execution/
// validation/output）随 9 阶段流水线一并废弃。映射：safety/intent/precheck →
// turnStart；planning/execution → preLLM；validation/output → turnStop。
type RuleScope =
  | 'turnStart'        // 前置守卫：safety/intent/precheck 原本承载的准入类规则
  | 'preLLM'           // loop 每步 LLM 调用前：planning/execution 原本承载的输出塑形类规则
  | 'turnStop'         // 后置守卫：validation/output 原本承载的质量把关类规则（只 check/block/annotate，不 reformat）
  | '*';               // 全部生命周期事件
```

**优先级合并**：

- `type: 'rule'` → 引擎内置 > 业务配置（业务不可覆盖）
- `type: 'preference'` → 业务配置 > 引擎默认值

### 3.3 Skills

Skill 设计对齐行业通用规范（参考 SKILL.md 标准），采用**渐进式加载**的三层结构：

| 层级 | 内容 | 加载时机 | 大小建议 |
| --- | --- | --- | --- |
| 元信息层 | name + description（BaseDescriptor） | 始终在上下文中 | ~100 词 |
| 指令层 | Markdown 正文（instructions） | 技能被激活时加载 | < 500 行 |
| 资源层 | 附属资源（scripts / references / assets） | 按需加载 | 不限 |

```typescript
interface SkillDescriptor extends BaseDescriptor {
  instructions: string;              // Markdown 正文（激活后注入 LLM 上下文）
  resources?: SkillResource[];       // 加载时自动扫描生成，不接受手写声明
  sourceDir?: string;                // SKILL.md 所在目录（read_skill_resource 解析路径用）
  license?: string;                  // 可选，agentskills.io 超集字段
  compatibility?: string;            // 可选，环境要求说明
  metadata?: Record<string, string>; // 可选，任意 key-value
  allowedTools?: string[];           // 可选，预授权工具调用模式（见下）
}

interface SkillResource {
  path: string;   // 目录前缀即类型：scripts/x.sh、references/y.md、assets/z.md
}
```

**文件约定**（对齐 [agentskills.io](https://agentskills.io) 开放规范）：

```
skill-name/
├── SKILL.md          # 必须，YAML frontmatter（元信息）+ Markdown body（指令）
├── scripts/          # 可选，可执行脚本（确定性/重复性任务）
├── references/       # 可选，参考文档（按需加载到上下文）
└── assets/           # 可选，输出用素材（模板、图标等）
```

`resources` 由 loader 在加载时扫描 `scripts/` `references/` `assets/` 三个子目录自动生成（只对 `SKILL.md` 目录形态生效），**不支持**在 frontmatter 里手写 `resources:` 数组。`name` 格式必须是小写字母/数字/连字符（硬校验）；建议与所在目录名一致（不一致只 warn，不阻断加载）。

- 激活后，`instructions` + `requires` 引用的依赖内容一起注入 LLM 上下文
- 资源层内容不自动加载：`scripts/` 能否执行取决于宿主是否提供 shell 类通用工具（不是框架专用入口）；`references/`、`assets/` 通过内置 `read_skill_resource` 工具按需读取（白名单即扫描到的 `resources` 集合）
- `allowedTools`（frontmatter `allowed-tools`）：当该 Skill 是当前 turn 的 Active Skill 时，`tool-use` 子流程对匹配的工具调用（裸工具名，或 `run-shell(<regex>)`）跳过审批回调，作用域仅限当前 turn，不落盘。详见 `docs/adr/0001-skill-agentskills-io-alignment.md`（本地文档）
- `requires` 可引用其他 Skills、Rules、Tools、Agents

### 3.4 Tools

Tool 定义对齐行业通用规范（JSON Schema 描述输入输出，声明式元信息 + 执行引用分离）。

```typescript
interface ToolDescriptor extends BaseDescriptor {
  // 执行单元声明维度（见 §五）
  sideEffect: 'readonly' | 'write' | 'irreversible';
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;                 // ms

  // Tool 特有
  inputSchema: JSONSchema;         // 输入参数 Schema
  outputSchema?: JSONSchema;       // 输出 Schema（可选）
  execute: string;                 // 引用已注册的执行函数名或工具名（不含具体实现）
}
```

- `execute` 仅为引用标识，指向在引擎中独立注册的执行函数或外部工具名
- 描述符是纯声明式数据，不携带可执行代码

### 3.5 Agents

```typescript
interface AgentDescriptor extends BaseDescriptor {
  // 执行单元声明维度（描述能力上界）
  sideEffect: 'readonly' | 'write' | 'irreversible';
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;

  // Agent 特有
  maxDepth: number;               // 最大嵌套深度
  availableTools?: string[];      // 可用工具范围（name 列表，空 = 全部）
  instructions: string;           // 自然语言指令（Agent 的行为定义）
}
```

### 3.6 双平面匹配模型

#### 语义发现面

```
注册时：description → 向量化 → 写入索引
匹配时：当前上下文 → 向量化 → topK 候选召回
```

- 索引维护时机：注册/注销时增量更新
- 召回参数：topK 可配置，默认 10

**降级策略**：当无可用的向量化能力注册时，语义发现面自动降级为全量扫描模式：

- 遍历所有已注册描述符，基于 `description` / `tags` / `trigger` 做文本匹配
- 同时从输入上下文中提取意图信号（如用户直接指定了一个未注册的技能名称，引擎需能识别出该意图并给出明确反馈）
- 降级对上层透明，不影响后续确定性闸门逻辑

#### 确定性执行闸门

| 概念 | 闸门策略 |
| --- | --- |
| Rules | 候选命中即激活，无闸门 |
| Skills | 候选命中即激活，无闸门 |
| Tools | 必须经过闸门：scopes 准入 → 白名单/黑名单 → 审批检查 |
| Agents | 激活后，内部 Tool 调用仍经过 Tool 闸门 |

#### Tool 闸门校验流程

```
Tool 调用请求
  → scopes 准入检查（执行上下文中的 scopes 是否包含该 Tool 所需权限）
  → 白名单/黑名单检查
  → requiresApproval? → 暂停等待外部确认
  → 通过 → 执行
```

### 3.7 启动时校验

引擎启动时遍历所有已注册描述符：

- 校验 `requires` 引用的目标是否已注册
- 校验 `name` 唯一性（同类型内不重复）
- 校验失败 → 输出明确错误信息，向上层确认是否继续尝试工作（带缺陷启动）
  - 上层确认继续 → 引擎启动，缺失的依赖在运行时按需报错
  - 上层拒绝 → 引擎终止启动

---

## 四、执行上下文

```typescript
interface ExecutionContext {
  requestId: string;
  sessionId: string;
  traceId: string;
  principal: Record<string, unknown>;  // 调用方身份，引擎不解读
  budget: BudgetConstraint;
  scopes: string[];                    // 授权范围，用于 Tool 闸门裁决
}

interface BudgetConstraint {
  maxTokens?: number;
  maxDurationMs?: number;
}
```

**传播规则**：

- 主任务 → 子任务：继承 `sessionId`、`traceId`、`principal`、`scopes`
- 子任务各自生成独立 `requestId`
- `budget` 由编排控制面按消耗动态扣减后分配给子任务

---

## 五、执行单元规格

### 5.1 统一契约

```typescript
interface ExecutionUnit<TInput, TOutput> {
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}
```

### 5.2 声明维度类型

```typescript
interface ExecutionTraits {
  sideEffect: 'readonly' | 'write' | 'irreversible';
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;  // ms
}
```

### 5.3 各声明维度对引擎行为的影响

| 维度值 | 引擎行为 |
| --- | --- |
| `sideEffect: 'irreversible'` | 重试前需特殊确认逻辑 |
| `idempotent: false` | 重试时不可直接重执行，需走诊断路径 |
| `requiresApproval: true` | 执行前暂停，向上层发审批请求，等待确认 |
| `timeout` 到期 | 强制终止执行，标记超时错误 |

---

## 六、输入输出设计

### 6.1 输入信封

```typescript
interface InputEnvelope {
  content: unknown;              // 原始输入内容（引擎不约束类型）
  metadata: InputMetadata;
}

interface InputMetadata {
  modality?: string;             // 模态提示（text / image / audio / ...）
  size?: number;                 // 内容大小（字节）
  source?: string;               // 来源标识
  mimeType?: string;             // MIME 类型
}
```

### 6.2 输入转换器接口

```typescript
interface InputTransformer {
  canHandle(metadata: InputMetadata, modelCapabilities: ModelCapabilities): boolean;
  transform(envelope: InputEnvelope): Promise<InputEnvelope>;
}
```

判断流程：`canHandle` 返回 false → 模型原生支持，直接透传；返回 true → 调用 `transform` 降级。

### 6.3 标准输出结构

```typescript
interface EngineOutput {
  type: OutputType;
  content: unknown;
  status: 'success' | 'partial' | 'failed';
  steps: StepStatus[];
  metadata: OutputMetadata;
  artifacts?: Artifact[];
  traceId: string;
  deliveryMode: 'complete' | 'streaming';
}

type OutputType = 'text' | 'image' | 'file' | 'structured' | 'composite' | 'custom';

interface StepStatus {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  reason?: string;              // 失败/跳过原因
}

interface OutputMetadata {
  toolCalls: ToolCallRecord[];
  durationMs: number;
  tokenUsage: { input: number; output: number; total: number };
}

interface Artifact {
  name: string;
  type: string;                 // MIME 类型
  content: unknown;
}
```

### 6.4 流式输出协议

> **ADR-0006 更新**：`plan-preview` 的 `phase` 字段随 `planning` 塌陷进 `tool-routing`（§7.2）而由 `'planning'` 改为 `'tool-routing'`；`delta` 的生产者从已删除的 `direct-answer` Sub-flow 改为唯一主干 `tool-use` loop；新增一组 loop-lifecycle 专属 chunk（`phase-enter`/`phase-exit`/`reasoning-delta`/`tool-loop-*`/`tool-call-*`/`usage`），供 CLI/SDK 对 loop 内部进展做细粒度渲染。以下为当前真实类型（`packages/core/src/types/io.ts`）：

```typescript
type StreamChunkPayload =
  | { type: 'progress';     phase: string; message: string }
  | { type: 'delta';        content: string }
  | { type: 'artifact';     artifact: Artifact }
  | { type: 'error';        error: EngineError }
  | { type: 'plan-preview'; phase: 'tool-routing'; route: ExecutionRoute }
  | PhaseEnterChunk        // { type: 'phase-enter'; phase: EnginePhase }
  | PhaseExitChunk         // { type: 'phase-exit';  phase: EnginePhase }
  | ReasoningDeltaChunk    // loop 内 LLM 推理增量（可选，供支持 reasoning 的模型使用）
  | ToolLoopStepChunk      // 一步 loop 迭代开始
  | ToolLoopDeltaChunk     // loop 内 LLM 文本增量
  | ToolLoopStepEndChunk   // 一步 loop 迭代结束
  | ToolCallStartChunk     // 单次工具调用开始
  | ToolCallEndChunk       // 单次工具调用结束（成功/失败）
  | ToolLoopFinalChunk     // loop 收敛，terminalDraft 产出
  | UsageChunk             // Provider usage 快照
  | { type: 'done';        output: EngineOutput };

type StreamChunk = StreamChunkPayload & StreamEnvelope; // StreamEnvelope 附带 correlation 等公共字段
```

**chunk 类型语义（节选，完整枚举见类型定义）**：

| `type` | 触发时机 | 生产者 | 消费提示 |
| --- | --- | --- | --- |
| `progress` | 每个 `EnginePhase` 进入时 / 关键里程碑 | Engine 主循环 | UI 显示阶段提示，不影响最终输出 |
| `phase-enter`/`phase-exit` | 6 个 `EnginePhase`（session/safety/tool-routing/execution/validation/output）边界 | Engine 主循环 | 结构化阶段边界事件，`progress` 的类型安全替代 |
| `plan-preview` | `tool-routing` 确定性阶段产出单步 Plan 后 | `phases/tool-routing.ts` | UI 可在执行前先展示 Plan；Plan 模式下消费完即可结束 |
| `delta`/`tool-loop-delta` | loop 内 LLM 产出文本增量时 | `subflows/tool-use.ts` | UI 增量渲染 |
| `tool-loop-step`/`tool-loop-step-end` | loop 每步迭代的开始/结束 | `subflows/tool-use.ts` | UI 展示 loop 进度（第几步/共几步） |
| `tool-call-start`/`tool-call-end` | 单次工具调用的开始/结束 | `subflows/tool-use.ts` | UI 折叠展示工具调用详情与耗时 |
| `artifact` | 子任务产出文件 / 二进制内容 | TaskExecutor / Backends | UI 提供下载或预览 |
| `error` | 任意未捕获错误（含预算熔断、Provider 失败） | Engine 主循环 catch | UI 提示并停止后续渲染 |
| `done` | 流末尾（成功或失败的最终 EngineOutput） | Engine 主循环 finally | UI 解锁输入；`output.status` 决定后续行为 |

**注意**：`plan-preview` 仅在 `runtime.planMode === false` 且 `tool-routing` 产出的 Plan 通过最小图校验时发出；Plan 模式（`planMode: true`）下流以 `plan-preview` 之后立刻 `done` 结束，不进入 `execution` 阶段。

---

## 七、主干流程

### 7.1 阶段定义

> **深单 loop 主干契约（ADR-0006，`0.2.0` 起）**：多阶段流水线已塌陷为「**一个深单 agentic loop 作为唯一主干 spine** + **一套 loop-lifecycle 守卫/挂载面**」。原 9 阶段收敛为 **6 个 `EnginePhase`**：`session · safety · tool-routing · execution · validation · output`。原 `intent`（意图分析）/ `precheck`（前置校验）/ `planning`（任务拆分）/ `graph-check`（依赖图校验）四个 phase 已**物理删除**（`intent.ts` / `precheck.ts` / `planning.ts` / `graph-check.ts` 及其孤儿测试均已移除），由单一确定性阶段 `tool-routing` 顶替其路由职责；`direct-answer` 内置 Sub-flow 与 `simple`/`complex` 分类也已删除，所有请求统一构造单个 `tool-use` 任务，零工具调用的纯回答由 loop step-1 无 `tool_call` 自然承接。

| # | 阶段（`EnginePhase`） | 入口 | 出口 | LLM 调用 |
| --- | --- | --- | --- | --- |
| 1 | `session` | 业务请求 | 带上下文的请求 | 否 |
| 2 | `safety` | 带上下文的请求 | 通过/拒绝 + `violations` | 否 |
| 3 | `tool-routing` | 安全检查后的请求 | 单步 `ExecutionRoute`（`tasks.length === 1`） | 否（确定性） |
| 4 | `execution` | 路由产出的 `ExecutionRoute` | `task-tool-use` 的 `ToolUseResult`（或显式 `@agent` 快路径的 agent-run 结果） | **是**（loop 内多轮） |
| 5 | `validation` | 执行结果 + `candidateAnswer` | 通过/不通过 + 诊断 | 否；semantic judge 为可选扩展 |
| 6 | `output` | 执行结果 + 验证结论 | 标准输出 | 否 |

### 7.2 `tool-routing`：确定性路由阶段

**`tool-routing` 不含 LLM 调用**，一次性顶替原 `intent` 分类 + `precheck` 前置校验 + `planning` 的 simple/complex 路由分支 + `graph-check` 依赖图校验：

1. **turnPolicy 规范化**：只消费 `scope` / 已 pre-seed 的 `input.metadata.turnPolicy`（如 CLI 显式指定），不再有 `llm` 分量——hard enforcement（工具 allow/deny、技能 pin/exclude）仅由 host 显式 / config / agent snapshot 驱动，不做模型猜测。
2. **工具收窄**：调用 `ToolActivator.activate()` 产出 `visibleTools`（相关性收窄，而非全量 registry），供 loop 默认工具集使用（见 §7.11）。
3. **路由分流**（`ToolRoutingPhaseOutput`）：
   - 显式 `@agent` 提及 → 确定性 agent-batch 任务（与 complexity 分类无关的独立能力，ADR-0006 未要求删除）；
   - 其余情况一律单步 `tool-use` 任务（`task-tool-use`），工具集经 `explicitToolNames`/`includeTools`/discovery-expansion 等确定性策略进一步收窄；零匹配工具时 loop 仍会执行，LLM 在无 `tool_call` 时自然产出纯文本答复（subsumes 原 `direct-answer`）。
4. **最小图校验**（取代原 `graph-check`）：校验任务引用的 tool/agent 存在于 registry，并跑一次拓扑排序（单任务/单边场景恒通过，为未来任务数增多预留）。
5. **输出约束**：`route.tasks.length >= 1`（单一 `ExecutionRoute`，不再有多方案 `plans[]`）；输出的 `intent` 字段**不是**已删除的 `IntentResult`（无 `complexity`/`contextRelevance`/LLM 分类），仅保留一句从用户输入原样抽取的摘要文本，供 §7.4 结果验证、`output` 阶段兜底文案等既有下游读取点沿用同样的 `.intent.intent` 访问路径。

```typescript
interface ToolRoutingPhaseOutput {
  intent: { intent: string };     // 摘要文本，非 LLM 分类
  route: ExecutionRoute;
}

// ADR-0006：单一执行路由，取代历史 PlanningResult{plans:RankedPlan[]} 多方案结构
interface ExecutionRoute {
  tasks: TaskNode[];               // 约束：tasks.length >= 1
  edges: TaskEdge[];               // 单任务场景为空数组
  visibleTools?: ToolDescriptor[]; // ToolActivator 收窄结果
}

interface TaskNode {
  id: string;
  type: 'tool' | 'agent' | 'sub-flow';
  ref: string;                     // 引用的 Tool/Agent/Sub-flow name
  input: Record<string, unknown>;
  contextSlice?: unknown;          // 编排控制面裁剪的上下文
}

interface TaskEdge {
  from: string;                    // 前置任务 id
  to: string;                      // 后续任务 id
}
```

> 历史脚注：`0.1.x` 曾有独立 `intent`（Phase 3，LLM 输出 `IntentResult.complexity/intent/contextRelevance`）、`precheck`（Phase 4，资源可用性/Provider 连通性校验）、`planning`（Phase 5，`direct-answer`/`tool-use` 双路由 + 兜底契约）、`graph-check`（Phase 6，环检测）四个独立 phase；`simple` 分支路由到内置 `direct-answer` Sub-flow 产出自然语言回复。ADR-0006 D1 判定这是「浅路由 + 死挂载面」：`STRONG_SIMPLE_MARKERS`/`STRONG_COMPLEX_MARKERS` 正则兜底自证分类不稳，`direct-answer` 又对 `tool-use` 已经写就的 `terminalDraft` 重新发起一次独立 LLM 改写，导致格式漂移。四者已随 0.2.0 一并删除，详见 ADR-0006。

### 7.3 loop-lifecycle 挂载面

`HookPoint`（`types/hooks.ts`）由历史 14 个 phase 命名收敛为 **9 个 loop-lifecycle 事件**，每个点都必须有真实 fire 位 + 精确 action 语义 + 测试：

```typescript
type HookPoint =
  | "turnStart"     // 一轮开始，pre-guard
  | "preLLM"        // loop 每 step 调 LLM 前，free-mutation
  | "postLLM"       // loop 每 step 调 LLM 后，free-mutation
  | "preToolUse"    // loop 每次工具调用前，approve/deny 审批语义
  | "postToolUse"   // loop 每次工具调用后
  | "turnStop"      // 一轮结束前，post-guard + Result Validation，恒 fail-closed 最后跑
  | "preSubagent"   // 派发 subagent 前
  | "postSubagent"  // subagent 收敛后
  | "preCompact";   // loop per-step 上下文超阈值、即将自动压缩前

interface HookEvent<TData = unknown> {
  point: HookPoint;
  timestamp: number;
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
  data: TData;
}
```

**逐点 fire 位 + payload 形状**（`data` 字段的实际结构）：

| HookPoint | 触发时机 | 真实 fire 位 | `data` 形状 | 语义 |
| --- | --- | --- | --- | --- |
| `turnStart` | 一轮开始，`session`/`safety` phase 之后、`tool-routing` 之前 | `engine.ts`（`Engine.runStream`） | `{ input: InputEnvelope }` | pre-guard；`deny`/`abort` 中止整轮，`modify`/`replace` 改写 `input` |
| `preLLM` | loop 每 step 调用 LLM 前 | `subflows/tool-use.ts` | `{ conversation: Message[]; step: number; stepId: string }` | free-mutation（见 §7.4）；`deny`/`abort` 抛 `TOOL_LOOP_PRE_LLM_DENIED` |
| `postLLM` | loop 每 step 调用 LLM 后 | `subflows/tool-use.ts` | `{ response: ToolUseStepResponse; step: number; stepId: string }` | free-mutation；`usage` 字段恒以 Provider 真值为准，mutation 无法覆盖 |
| `preToolUse` | loop 每次工具调用前 | `subflows/tool-use.ts` | `{ tool: string; callId: string; arguments: Record<string, unknown>; parentStepId: string }` | 归位既有 `onBeforeToolCall` 审批语义；`deny`/`abort` 时合成"已被拒绝"tool 消息回灌 LLM，不中断循环 |
| `postToolUse` | loop 每次工具调用后 | `subflows/tool-use.ts` | `{ tool: string; callId: string; parentStepId: string; result: ExecutedToolRecord }` | `modify`/`replace` 可改写 `result.content`（校验后合法才生效） |
| `turnStop` | 一轮结束前，`validation` phase 之后 | `engine.ts`（`Engine.runStream`） | `{ candidateAnswer: CandidateAnswer; validation: ValidationResult }` | post-guard + Result Validation，恒 fail-closed 最后跑；`deny`/`abort` 拒绝交付，`modify`/`replace` 改写 `candidateAnswer.content` |
| `preSubagent` | 真正 spawn subagent 前（`task.type === "agent"` 快路径与 `dispatch_agent` 工具两条路径共用） | `engine.ts`（`Engine.runSubAgent`） | `{ agent: string; objective: string; taskId: string }` | `deny`/`abort` 时短路，不真正 spawn，也不消耗 budget 决策 |
| `postSubagent` | subagent 收敛后 | `engine.ts`（`Engine.runSubAgent`） | `{ agent: string; taskId: string; status: AgentRunResult["status"] }` | 只读订阅/审计用途，不支持改写 result（summary-only 契约由 runtime 自身保证） |
| `preCompact` | loop per-step 估算上下文超过 `0.85 × maxContextTokens` 阈值时 | `subflows/tool-use.ts` | `{ conversation: Message[]; step: number; stepId: string; estimatedTokens: number; maxContextTokens: number; threshold: number }` | host 可返回 `replace` mutation 自定义压缩；未处理或 mutation 不合法时套用默认压缩（丢最老一轮完整 assistant+tool 往返） |

**free-mutation 与 guardrail 语义的区分**：

- `preLLM`/`postLLM`/`preToolUse`/`postToolUse`/`preCompact` 是 **free-mutation** 点——host 可通过 `modify`/`replace` 任意改写数据，但受 **Engine Seatbelt**（§7.4）约束。
- `turnStart`/`turnStop` 是 **guardrail 挂载点**——除了原始 `HookAction`（`deny`/`abort`/`modify`/`replace`）外，还额外挂一套通用 `Guardrail` 契约（§7.5），语义更收敛（`pass`/`block`/`degrade`/`annotate`，不支持"静默重排版"）。

`DefaultHookRegistry.fire()`（`modules/hooks.ts`）每次调用无条件发一条 `hook_fired` observability 事件（即使当前无人订阅/注册），防止"定义了却查不出是否真被触发"的死面问题重演；单个 handler 失败按 `HookFailureBehavior`（`'continue'` 吞错 + 发 `error` 事件 / `'abort'` 抛出）处理。详细的 Action 类型与适用矩阵见 §9.8。

### 7.4 Engine Seatbelt

`preLLM`/`postLLM`（以及 `preCompact`）是 free-mutation 点——host 有全权改写，但引擎守两条底线（`subflows/tool-use.ts` 的 `applyConversationMutation`/`applyResponseMutation`）：

1. **每次 mutation hook 后跑结构化 normalize/re-validate**：`isValidConversationMutation` 校验 mutation 后的 `conversation` 是否仍是合法 `Message[]`（非空数组、每条消息 `role` ∈ `system/user/assistant/tool`、`content` 类型合法）；`isValidResponseMutation` 校验 `postLLM` mutation 后的 response 是否仍保留 `content: string`。校验失败时**丢弃这次 mutation 并继续用 mutation 前的值**，绝不把畸形对话喂给 Provider，同时通过 observability 发一条 `warning`（`reason: "hook-mutation-rejected"`）。
2. **`turnStop` guards 恒最后跑、fail-closed**：`turnStop` 的 raw `HookAction` 与 `Guardrail` 组合器（§7.5）都在 `validation` phase 之后、`EngineOutput` 产出之前执行，mutation 不能绕过合规。
3. **所有 mutation 记入 observability 审计**：`postLLM`/`preLLM` 的 mutation 拒绝会发 `warning` 事件；`preCompact` 的自动压缩会发 `warning`（`reason: "context-auto-compact"`，携带 `estimatedTokensBefore`/`messageCountBefore`/`messageCountAfter`）。

`usage`（token 计费）字段被硬性排除在 `postLLM` mutation 之外——`applyResponseMutation` 始终以 mutation 前的 Provider 真值覆盖候选 mutation 里的 `usage`，防止 host mutation 污染计费/预算。

### 7.5 对称守卫 seam（Guardrail 契约）

`types/guardrail.ts` 定义了一个通用 guardrail 契约，挂 `turnStart`（pre-guard）与 `turnStop`（post-guard）：单个 guard 干合规检查、内容策略、还是质量 validation，由宿主消费方决定，core 不区分语义，只区分挂载点。

```typescript
type GuardrailPoint = "turnStart" | "turnStop";

type GuardrailDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "block"; readonly reason: string; readonly userVisibleReason?: string }
  | { readonly kind: "degrade"; readonly reason: string; readonly userVisibleReason: string }
  | { readonly kind: "annotate"; readonly prefix: string };

interface GuardrailContext {
  readonly point: GuardrailPoint;
  readonly correlation: ExecutionCorrelation;
  readonly subject?: ExecutionSubject | undefined;
  readonly data: unknown;   // turnStart: { input, context, violations }；turnStop: { candidateAnswer, validation }
}

interface Guardrail {
  readonly id: string;
  run(ctx: GuardrailContext): GuardrailDecision | Promise<GuardrailDecision>;
}
```

四种处置结果恒 **fail-closed**：

- `pass`：放行，无附加处置。
- `block`：拒付。`turnStart` 场景中止整轮；`turnStop` 场景拒绝交付候选答案。
- `degrade`：放行但降级说明（如"仅确认部分内容"），`userVisibleReason` 会前缀到最终 `candidateAnswer.content`。
- `annotate`：放行但附加简短前缀说明（如安全警告），不改写正文其余部分。

刻意不提供"静默重排版"语义——想改格式是显式 transform，不是 guard 的职责。

`runGuardrails()`（`modules/guardrail.ts`）组合运行一组 guardrail：任一 guard 返回 `block` → 立即短路返回；无 `block` 时若存在 `degrade` → 返回第一个 `degrade`（优先级高于 `annotate`）；都没有 `degrade` 时若存在一个或多个 `annotate` → 合并前缀（空格分隔）返回；全部 `pass` → 返回 `pass`。

**内置默认 guard**：

| 挂载点 | 内置 guard | 语义 |
| --- | --- | --- |
| `turnStart` | `createSafetyViolationsGuardrail`（`builtin.safety-violations`） | 把 `SafetyModule` baseline（前 4 项 throw、injection 走 warning）+ business policy 已产出的 warning 级 `violations` 映射为 `annotate`，不再静默丢弃 |
| `turnStop` | `createResultValidationGuardrail`（`builtin.result-validation`） | 把 §7.6 结果验证的 `ValidationOutcome` 映射为 guardrail 决策：`pass`→`pass`，`degrade`→`degrade`，`handoff`→`block`（人工接手），`retry`→`pass`（retry 是 §8.1 turn-level 重试循环职责，不在 guardrail 词汇表内） |

内置 guard 恒跑在对应挂载点最前；`EngineDependencies.guardrails.turnStart`/`turnStop` 注入的宿主 guard 在其后按顺序执行。对齐 OpenAI Agents SDK `input/output_guardrails` + tripwire、Claude Code `Stop` hook（可 block→强制继续）语义。

### 7.6 子任务执行

- 依赖调度器根据 `ExecutionRoute.edges` 自动编排：无依赖的任务并行，有依赖的串行等待
- `tool-routing`（§7.2）产出的 Plan 目前恒为**单任务**（`task-tool-use`）或**显式 `@agent` 提及触发的线性 agent-batch 链**（多个 agent 任务，`edges` 为顺序依赖）——不再有 LLM 动态拆分产出的复杂多分支 DAG。调度器本身的并行/串行编排能力保留，供未来任务数增多或业务自定义 `TaskExecutor` 场景使用
- 编排控制面按"需要知道"原则裁剪 `contextSlice`
- 每个子任务遵循统一执行规格（§五）

### 7.7 结果验证

```typescript
interface ValidationResult {
  passed: boolean;
  diagnosis?: {
    type: 'execution_issue' | 'planning_issue';
    reason: string;
    failedTaskIds?: string[];  // 当前：仅 execution_issue 时填充
  };
}
```

**当前实现范围**：

- `validation` phase 仍以**确定性失败扫描**为主：遍历 `taskResults`，若任意 task 的 `status === 'failed'`，产出 `diagnosis = { type: 'execution_issue', reason, failedTaskIds }`，否则 `passed: true`；`policyMode` 可选接入 semantic judge 做语义层判定，是非强制的可选扩展
- 验证结论通过 `ValidationOutcome`（`pass` / `degrade` / `handoff` / `retry`）承载，既接入 §7.5 的 `turnStop` guardrail，也接入 §8.1 的 turn 级重试判定（`decideTurnRetry`）——`retry` 不再是"只产出一次、不触发实际重试"的死信号

### 7.8 编排控制面

`ExecutionOrchestrator`（`engine/orchestrator.ts`）职责清单：

| 职责 | 说明 |
| --- | --- |
| route 承载 | 接收 `tool-routing` 产出的单步 `ExecutionRoute`（含显式 agent-batch 场景） |
| 图校验 | 调用 `tool-routing` 内置的确定性最小图校验逻辑（拓扑排序 + 引用完整性） |
| 重试收口 | 多方案切换已随 ADR-0006 移除（`ExecutionOrchestrator` 退化为纯预算/计时追踪器）；`validation` 不通过统一走 turn 级重试（回 `tool-routing`） |
| 预算管控 | 追踪全局 token/时间消耗（turn 级累计），触发熔断 |
| 降级决策 | 预算不足或 `turnStop` guard 判定 `degrade`/`block` 时决定终止路径 |
| 上下文裁剪 | 按"需要知道"原则为子任务分发精简上下文 |

### 7.9 取消传播

- 同一 session 新消息到达 → 引擎向当前执行发取消信号
- 所有正在执行的子任务（含 `tool-use` loop 内的工具调用与 subagent 派发）收到取消 → 尽快终止
- 在已有上下文基础上处理新输入（last-message-wins）

### 7.10 生命周期钩子

生命周期钩子挂载点即 §7.3 的 9 个 `HookPoint`；接口、Action 类型与运行约束详见 §9.8。

### 7.11 `tool-use` loop 执行规格

**名称**：`tool-use`（保留名，业务不可覆盖，ADR-0006 起是引擎**唯一**主干执行通道）
**用途**：深单 Agentic Loop——LLM 多轮规划、动态调用工具/派发 subagent，直到给出自然语言最终回复；无工具调用的纯回答由 loop step-1 无 `tool_call` 自然承接（subsumes 原 `direct-answer`）。

**输入契约**：

```typescript
interface ToolUseInput {
  prompt: string;         // tool-routing 传入的用户诉求摘要
  toolNames?: string[];   // 确定性收窄后的可见工具名列表
  hint?: string;          // 可选的宿主附加指令
}
```

**运行时配置**：`EngineConfig.runtime.toolLoop`（`types/config.ts`）

```typescript
interface ToolLoopConfig {
  maxSteps?: number;                 // 单次请求最大循环步数；超出抛 TOOL_LOOP_STEPS_EXHAUSTED（默认 25，范围 1..64）
  parallelism?: number;              // 单轮并发执行工具的上限（默认 4，范围 1..16）
  requireApprovalGlobal?: boolean;   // 全局强制把所有工具视作 requiresApproval=true（默认 false）
  shortTaskRoute?: {
    enabled?: boolean;               // 是否启用短任务路由降级（默认 false）
    capability?: string;             // 命中后路由到的能力标签（默认 "fast-cheap"）
    maxToolNames?: number;           // 命中条件：toolNames 数量上限（默认 1）
    maxPromptChars?: number;         // 命中条件：prompt 字符长度上限（默认 120）
  };
  failureRecoveryRetries?: number;   // 失败恢复护栏至多注入次数（默认 1，0 即回退到「terminal 即终止」历史语义）
  subagentDispatch?: {
    enabled?: boolean;               // 是否暴露 dispatch_agent 工具（默认 true；registry 无 agent 时无论此值为何都不暴露）
    maxDepth?: number;               // 允许的最大派发深度（默认 1，见 §7.12）
  };
}
```

> 上表默认值以 `utils/config-schema.ts` 的 `validateEngineConfig` 与 `subflows/tool-use.ts` 的 `resolveToolLoopLimits` 为准（两处一致）。

**循环上限与并发**：

- 每步：`preCompact` 复检 → `preLLM` → Provider 调用 → `postLLM` → 解析 `toolCalls` → 按 `parallelism` 并发执行工具批次（`executeToolCallsBatch`）→ 结果回灌为 `tool` 消息 → 进入下一步。
- 超过 `maxSteps` 仍未产出终稿 → 抛 `TOOL_LOOP_STEPS_EXHAUSTED`。

**审批协议（`preToolUse`）**：当 `descriptor.requiresApproval === true` 或 `requireApprovalGlobal === true` 时，`ctx.onBeforeToolCall` 回调与 `preToolUse` hook 共同决定是否放行；`deny`/`abort` 会合成一条"用户拒绝"/"hook 拒绝"的 tool 消息回灌 LLM，不计入 `ToolLoopError`，也不中止整条 loop。

**shortTaskRoute 降级路由**：当 `runtime.toolLoop.shortTaskRoute.enabled` 为 true 且本轮 `input.toolNames.length <= maxToolNames` 且 `input.prompt.length <= maxPromptChars` 时，`resolveToolUseRoute` 优先尝试路由到配置的 `capability`（典型 `fast-cheap`），命中失败再回退默认链路 `high-reasoning → intent → fast-cheap`。用于把"单工具调用 + 简短结果总结"场景的模型从强推理档降级，显著降低 wall time。

**失败恢复护栏（`failureRecoveryRetries`）**：当某步是 terminal（模型停止且无 `toolCalls`）、但本轮「有过工具失败且零成功结果」时，向对话注入 `FAILURE_RECOVERY_PROMPT`（system 角色，domain 无关，明确「先用发现/列举类工具确认标识符」「禁止重复刚才失败的同一调用」）并**强制再走一步**，而非直接收下终稿。至多注入 `failureRecoveryRetries` 次（默认 1），每次强制步都计入 `maxSteps` 防死循环；用户主动拒绝（`TOOL_LOOP_APPROVAL_DENIED`）不计入触发条件。

**media passthrough（`onGeneratedImages`/`onGeneratedMedia`）**：文生图/多模态响应的结构化产物透传（迁自已删除的 `direct-answer.ts`，ADR-0006 塌陷为深单 loop 后 `tool-use` 是唯一路径，必须原样吸收该能力）。在每个 loop step 的 `postLLM` mutation 处理完毕、本 step 收尾时一次性调用：`response.images` 非空 → `ctx.onGeneratedImages?.(response.images)`；`response.media` 非空 → `ctx.onGeneratedMedia?.(response.media)`。流式路径的 media chunk 先在 `collectStreamedToolUseStep` 内累积进 `response.media`，非流式路径由 `ChatResponse` 直接携带。

**no-empty-promise（base system prompt 强制条款）**：`TOOL_USE_SYSTEM_PROMPT_BASE`（`subflows/tool-use.ts`）在"Absolutely forbidden"一节写死两条禁令——禁止空承诺（"I'll fetch …"/"稍等我去查一下"，因为本轮无下一轮、无 `await`）与禁止假装已执行动作；若请求需要真实数据但无匹配工具，必须明确告知用户"本轮无匹配工具"并标注答案来自先验知识。此约束落地为**确定性 base 元 prompt 的强制条款**，而非动态 rule——两个候选方案中选择更靠近确定性、无需 rule 匹配开销的一支。

**per-step 自动 compact（`preCompact`）**：每个 step 循环体顶部，先用 `estimateMessagesTokens` 估算当前 `conversation` 的 token 数；超过 `0.85 × maxContextTokensForCompact` 阈值时触发 `preCompact` hook，给 host 一次 `replace` mutation 的机会；host 未处理或 mutation 不合法时套用默认压缩 `compactConversationDefault`——在 loop 自身追加的尾部（seed 长度之后）寻找最老的一个完整 assistant（带 `toolCalls`）+ 对应 tool 消息轮次，整体丢弃并替换为一条摘要 `system` 消息；每 step 至多丢一轮，不做半截截断（避免破坏 `tool_call`/`tool` 配对），压完仍超阈值会在下一 step 再次触发，直到收敛或自然终止。对齐 Claude Code 每 iteration 的 `maybe_auto_compact`。

**`ToolActivator.visibleTools` 工具收窄**：loop 默认工具集 = `tool-routing` 阶段产出的 `visibleTools`（相关性收窄），而非全量 registry；`input.toolNames` 非空时进一步按名单过滤（`filterToolDefinitions`）。

**错误码（`ToolLoopError`）**：

| code | 触发 |
| --- | --- |
| `TOOL_LOOP_STEPS_EXHAUSTED` | 循环超过 `maxSteps` 仍未终止 |
| `TOOL_LOOP_EMPTY_TERMINAL_RESPONSE` | `finishReason=stop` 但 content 空（非首轮） |
| `TOOL_LOOP_PROVIDER_NO_RESPONSE` | 首轮即返回空 content 且无工具请求 |
| `TOOL_LOOP_PRE_LLM_DENIED` | `preLLM` hook 返回 `deny`/`abort` |
| `TOOL_LOOP_UNKNOWN_TOOL` | 模型请求了 Registry 中不存在的工具（反馈给 LLM，不中断） |
| `TOOL_LOOP_TOOL_EXECUTION_FAILED` | 真实执行器抛错（反馈给 LLM，不中断） |
| `TOOL_LOOP_APPROVAL_DENIED` | 审批被拒绝（反馈给 LLM，不中断） |
| `TOOL_LOOP_INTERNAL_TOOL_MISCONFIG` | 内置工具（如 `dispatch_agent`）所需依赖未注入 |

**`terminalDraft` 即终答**：loop 终止时（`status: "ready_for_output"`）产出的 `terminalDraft` 已在完整 `prebuiltPrompt`（persona + rules + active skills + memory + tools）下写就，`candidate-answer.ts` 直接将其作为 `candidateAnswer.content`，不再有独立的 final-answer 写手 LLM 重写它——从根上消除格式漂移。非 `ready_for_output` 状态（`partial`/`exhausted`/`failed`）不在 candidate-answer phase 软性捏造叙述性兜底文案，交由 §7.7 结果验证的 `deterministic.tool-use.status` 规则如实判定失败，`output` phase 的确定性 fallback 模板（`ensureFallbackText`/`buildFallbackTemplate`，见下方 §8.1 兜底说明）接管——validation 未通过时该模板**绝不**调用 LLM，纯本地确定性拼装，保证 100% 可用。

**为什么放在内置而非业务 Sub-flow**：

- 它是引擎唯一主干执行通道，必须由引擎保证存在
- 它需要访问引擎内部的 `Registry` 查工具、统一 TaskExecutor 调度工具、统一 observability/hook 事件；若放在业务侧会割裂语义边界与审批/预算/取消传播
- 工具循环的错误语义必须映射为稳定的 `ToolLoopError` code 才能让 `output` phase 的确定性 fallback、CLI 渲染、SDK 业务消费方协议一致

### 7.12 subagent 派发（`dispatch_agent`）

loop 内 LLM 可自决把可分解的**只读**任务派发给 subagent，复用现有 Agent runtime（`agentRunId` history-scope 隔离、`decideSubAgentBudget`、同一 `toolUseExecutor`），零新增架构面（除 `dispatch_agent` 工具本身外未引入新挂载点）。

**内置 Task-style 工具描述**（`buildAgentDispatchToolDefinition`，`AGENT_DISPATCH_TOOL_NAME = "dispatch_agent"`）：

```typescript
interface AgentDispatchParams {
  agentName: string;
  objective: string;
  input?: Record<string, unknown> | undefined;
}

type AgentDispatchOutcome = AgentRunResult & { agent: string };

type AgentDispatchFn = (
  params: AgentDispatchParams,
  signal: AbortSignal,
) => Promise<AgentDispatchOutcome>;
```

工具的 `inputSchema` 要求 `agent`（枚举已注册 agent 名）与 `objective`（自包含目标描述）必填，`input` 可选。`appendAgentDispatchTool` 只在以下条件全部满足时把该工具追加进工具列表：`ctx.dispatchAgent` 已注入、`subagentDispatch.enabled !== false`、当前派发深度未耗尽、registry 存在 ≥1 个已注册 `agent`、工具列表尚无同名工具（业务自定义同名工具优先）。

**Single-Writer Rule**：`Engine.filterReadonlyToolNames` 对 `descriptor.availableTools` 做确定性过滤——只保留 `registry.getLatest("tool", name)?.sideEffect === "readonly"` 的工具；**对 registry 查不到的工具名一律 fail-closed 排除**，不假定"未注册 = 只读"而放行。写操作留给主 loop，对齐 Cognition Single-Writer Rule。

**summary-only 契约**：`AgentDispatchOutcome`（即 `AgentRunResult` 附加 `agent` 名称）只含 `output`/`evidence`（`status: "completed"` 分支），不回子 loop 全部 transcript；`status: "failed"`/`"cancelled"` 分支同样只回结构化错误/取消原因。

**maxDepth 默认 1**：`DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH = 1`（`engine/agents/types.ts`）是唯一权威定义，同时被 `Engine.resolveAgentDispatchMaxDepth`（写入 `AgentRunConstraints.maxDepth`，与 `descriptor.maxDepth` 取更小值）与 `tool-use.ts` 的同名函数（决定是否在工具列表暴露 `dispatch_agent`）引用，避免同一语义值在两处漂移；对齐 Claude Code「Task 工具不可在子 agent 内再次调用」的默认策略——主 loop（深度 0）可派发一层 sub-agent（深度 1），sub-agent 自身的 loop 内该工具不再可见。`task.type === "agent"`（显式 `@agent` 提及快路径）与 `dispatch_agent` 工具两条路径共用同一个 `Engine.runSubAgent` 实现。

**`preSubagent`/`postSubagent` 触发顺序**：`runSubAgent` 先 fire `preSubagent`（`deny`/`abort` 时短路，不真正 spawn）→ 解析路由/预算 → 调用 `AgentRuntimeAdapter.run()` → fire `postSubagent`（只读订阅/审计，不支持改写 result）。两条派发路径（`task.type === "agent"` 与 `dispatch_agent` 工具）下 fire 顺序一致。

> 0.1.x 曾有 `direct-answer` 内置 Sub-flow，ADR-0006 起已删除，其独有能力（media passthrough / no-empty-promise / cheap route）均已吸收进 `tool-use` loop，详见 §7.2 历史脚注与 ADR-0006 D1。

---

## 八、错误处理与状态流转

### 8.1 重试与降级

> **现状（随 ADR-0006 更新）**：本章历史草案曾把"任务级重试循环"标注为路线图未实现项；该循环已在当前实现中落地为 **turn 级 do-while 重试**（`Engine.run` 内的 turn 循环 + `decideTurnRetry`），受 `runtime.maxTurnRetries` 显式开关（默认 `0`，即默认关闭，等价于线性 `tool-routing → loop → output` 单次执行；设为 `>0` 时启用重试）。Provider 运行时自动降级仍留在路线图，语义不变（见下）。

#### 已实现：turnStop 诊断信号 + turn 级重试

```
触发：turnStop guardrail（结果验证，§7.5/§7.7）判定 outcome.kind === 'retry'
策略：validation 扫描 candidateAnswer/evidence/claims 或 taskResults 状态，产出诊断
      （ValidationOutcome.reason/target），target === 'retry-turn' 表示回 tool-routing 重跑整个 turn；
      decideTurnRetry({ outcome, retryCount, maxTurnRetries }) 决定是否 continue 整个 turn
后续：`runtime.maxTurnRetries > 0` 时，Engine 主循环回到 tool-routing 重新构造 route 并重新进入 loop，
      通过 previousAttempt 把上一轮失败摘要透传给下一轮（供观测/诊断使用，不改变路由本身的确定性）
上限：达到 maxTurnRetries 后不再重试，进入 output 阶段的诚实兜底文案；
      同一 outcome.kind 连续两轮重复也会提前 exit（反死循环）
```

实现入口：`packages/core/src/engine/engine.ts`（turn 级 do-while 循环）、`packages/core/src/engine/turn-retry.ts`（`decideTurnRetry`）、`packages/core/src/engine/orchestrator.ts`（预算 / 计时追踪）。

**幂等性与副作用回放（仍未实现）**：turn 级重试目前**不**做工具副作用的幂等判定或回放保护——重试会重新进入 `tool-routing → loop`，若上一轮已产生过写副作用（如文件写入、外部 API 调用），重试可能重复执行。基于 `ExecutionTraits.idempotent` + `BackendInput.idempotencyKey` 的幂等判定仍是未来工作项，启用 `maxTurnRetries > 0` 前业务应自行评估该风险。

**兜底说明**：`validation` 未通过且无可展示的 `candidateAnswer`/`observations` 时，`output` phase 的 `ensureFallbackText()` 产出用户友好兜底文案——**始终返回本地确定性模板**（`buildFallbackTemplate`：一句承认 + 可能原因 + 下一步建议），过一遍 `sanitizeInternalTerms()` 屏蔽内部术语，**不向 LLM 发起任何调用**。这一约束是硬性契约：任何"LLM best-effort summary"式的兜底思路已经退役——若未来仍需 LLM 产出友好兜底，应在 `validation` **之前**把它合成为 `CandidateAnswer`（带 claims + evidence），让 validation 一并把关，而不是在 validation 失败之后再临时补救。

#### 预留：`Provider` 运行时降级（后续路线图）

> **诚实状态（当前代码树）**：下列行为为**设计目标**，**不是**当前实现。请勿按本节配置期望 LLM 失败时自动换 provider。

```
触发（规划）：内置 Provider Adapter 抛 ProviderError（PROVIDER_UNAVAILABLE / PROVIDER_CALL_FAILED）
策略（规划）：按 EngineConfig.models.providerFallbackOrder 顺序切换到下一个已注册 Provider
        |--- 当前任务节点继续执行（不重新规划）
兜底（规划）：所有 Provider 全部失败 → 透传 ProviderError；用户侧见 userMessage
```

**`models.providerFallbackOrder` 当前实际用途：**

1. Host `inferProviders()` —— 启动时额外注册列表中的 provider（与 `capabilityMapping` 并集）
2. CLI —— `providerFallbackOrder[0]` 作为 `--api-key` / `--api-base` 默认 target

**未实现：** `DefaultModelRouter` 不遍历该列表；无 `provider_fallback` 事件 emit（`EventType` 中该字面量仍保留但从未 emit）；LLM 失败时各 phase 走启发式 / 抛错 / 用户可见错误文案。

### 8.2 预算熔断

- 编排控制面持续追踪全局 token/时间消耗
- 任意时刻预算耗尽 → 立即终止所有执行
- 输出已完成的步骤状态 + 熔断原因

### 8.3 错误传递通道

| 通道 | 时机 | 内容 |
| --- | --- | --- |
| 流式 StreamChunk `error` | 实时 | 错误摘要 |
| Hook 事件 | 实时 | 错误详情 |
| EngineOutput `status` + `steps` | 最终 | 完整步骤状态 |

---

## 九、核心模块

### 9.1 会话管理

```typescript
interface SessionManager {
  // —— 基础生命周期
  resolve(sessionId: string): Promise<Session>;            // 新建或恢复
  suspend(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;

  // —— 取消传播（当前必需）
  beginRun(sessionId: string, requestId: string): RunHandle;
  cancel(sessionId: string, reason?: string): Promise<void>;
  clear(sessionId: string): Promise<void>;                 // 清空 history + RuntimeState

  // —— 运维 / 可观测
  getSession(sessionId: string): Session | undefined;
  listSessions(filter?: { status?: SessionStatus }): Session[];
  removeSession(sessionId: string): Promise<void>;
  cleanupInactive(olderThanMs: number): Promise<number>;   // 返回清理条数
}

interface Session {
  id: string;
  status: SessionStatus;                                    // 'active' | 'suspended' | 'closed'
  createdAt: number;
  lastActiveAt: number;
}

interface RunHandle {
  signal: AbortSignal;                                      // 由 cancel 触发
  requestId: string;
  release(): void;                                          // 主流程结束后释放运行句柄
}

type SessionStatus = 'active' | 'suspended' | 'closed';
```

**生命周期**：`created → active → suspended → closed`

**并发输入（last-message-wins）**：

- `SessionManager.beginRun(sessionId, requestId)` 在每次 `runStream` 入口调用，返回 `RunHandle.signal`
- 同一 session 再次 `beginRun` 时，`SessionManager` 自动对前一个 RunHandle 调用 `cancel('superseded')`，触发其 signal abort
- 所有正在执行的子任务（含 LLM 调用 / Tool 调用）通过 `createLinkedAbortController` 链式传播 signal，尽快终止
- 新输入在已有上下文（含未压缩的 ContextWindow）基础上继续运行

**清理与运维**：

- `cancel(sessionId)` 仅取消当前 run，不清空 history；`clear(sessionId)` 在 `close` 前重置 RuntimeState 与 ContextWindow
- `cleanupInactive(olderThanMs)` 由长驻 CLI 进程定期调用，回收超时未活跃的 session

### 9.2 记忆系统

```typescript
interface MemorySystem {
  // —— 基础读写
  load(sessionId: string): Promise<ContextWindow>;
  append(sessionId: string, entry: MemoryEntry): Promise<void>;
  compress(sessionId: string): Promise<void>;             // 触发压缩
  recall(sessionId: string, query: string): Promise<MemoryEntry[]>;  // 长期记忆召回
  archive(sessionId: string): Promise<void>;              // 归档到磁盘 JSONL

  // —— 运维 / 状态查询（当前必需）
  getSize(sessionId: string): Promise<{ entries: number; tokens: number }>;
  trim(sessionId: string, options: { keepHead?: number; keepTail?: number }): Promise<void>;
}

interface ContextWindow {
  entries: MemoryEntry[];
  tokenCount: number;
  limit: number;
}

interface MemoryEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  timestamp: number;
  anchored: boolean;              // 结构化锚点，不参与压缩
}
```

#### 压缩策略接口

```typescript
interface CompressionStrategy {
  compress(entries: MemoryEntry[], targetTokens: number): Promise<MemoryEntry[]>;
}
```

**默认实现（Head-Middle-Tail）**：

- Head：保留最早 N 条（任务起点、关键设定）
- Middle：中间部分 → LLM 摘要压缩
- Tail：保留最近 M 条（当前工作焦点）

**引擎级约束（不随策略改变）**：

- archive-before-summarize：压缩前先调用 `archive` 保存原始内容
- `anchored: true` 的条目跳过压缩

### 9.3 运行状态

```typescript
interface RuntimeState {
  get(sessionId: string): Promise<ExecutionState | null>;
  update(sessionId: string, state: Partial<ExecutionState>): Promise<void>;
  cleanup(sessionId: string): Promise<void>;
}

interface ExecutionState {
  currentPhase: string;
  activeRoute: ExecutionRoute | null;
  taskProgress: Map<string, TaskStatus>;  // taskId → status
  retryCount: { task: number; system: number };
  budgetUsed: { tokens: number; durationMs: number };
  checkpoints: Checkpoint[];
}
```

- 结构化数据，非语义化
- 任务完成后自动清理
- 存储方式由引擎内部决定（内存 / SQLite / 文件）

### 9.4 模型路由

```typescript
interface ModelRouter {
  /**
   * 解析能力标签或任务要求到具体 ModelRoute。
   *  - 字符串入参：直接查 `models.capabilityMapping[tag]`
   *  - 对象入参：根据任务名优先匹配 `models.capabilityMapping['task:<task>']`，
   *    再回退到能力标签；`override` 可强制指定 provider/model。
   * 命中失败抛 `RegistryError.modelNotFound(...)`。
   */
  resolve(input: string | { task: string; override?: ModelRoute }): ModelRoute;

  /**
   * 通过给定 Provider Adapter 集合，异步拉取每个 Provider 的可用模型清单 +
   * 各模型的能力标签覆盖矩阵，便于启动期能力体检。
   */
  checkCapabilities(providerAdapters: ProviderAdapter[]): Promise<CapabilityCheckResult>;
}

/** 路由解析结果。*/
interface ModelRoute {
  provider: string;
  model: string;
  params?: Record<string, unknown>;
}

/** 单个模型能力 fingerprint。*/
interface ModelCapabilities {
  supportedModalities: string[];           // 'text' / 'image' / 'audio' / ...
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
}

/** 能力体检的批量结果（per provider × per capability tag）。*/
interface CapabilityCheckResult {
  providers: Array<{
    providerId: string;                    // ProviderAdapter.id
    name: string;                          // ProviderAdapter.name
    models: ModelInfo[];                   // listAvailableModels 的结果
  }>;
  capabilityCoverage: Record<string, {     // capabilityTag → 哪些 provider/model 满足
    matched: Array<{ providerId: string; modelName: string }>;
    missing: boolean;                      // 当前配置下该 capability 无人响应
  }>;
}
```

**能力标签示例**：`high-reasoning`、`fast-cheap`、`vision`、`long-context`

**覆盖机制**：业务在 `EngineConfig.models.capabilityMapping` 中以 `'task:<task>'` 为键可为特定任务指定模型；调用 `resolve({ task: 'plan-tasks', override: ... })` 时 override 优先于映射表。

**实现备注**：默认实现 `DefaultModelRouter`（`packages/core/src/modules/model-router.ts`）每次 `checkCapabilities` 都会重新拉取 Provider 的 `listAvailableModels()`，**当前不做模型清单缓存**；后续路线图拟增加按 `provider.id` 的 in-memory 缓存（命中过期 30s）。

### 9.5 模型接入（Provider/Adapter）

```typescript
interface ProviderAdapter {
  /** 实例 id（区分同一类 Provider 的多实例，例如两个不同 baseURL 的 OpenAI 端点）*/
  readonly id: string;
  /** Provider 类型名（'openai' / 'anthropic' / ...）*/
  readonly name: string;

  listAvailableModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  chatStream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamChunk>;
}

interface ModelInfo {
  modelName: string;
  capabilities: ModelCapabilities;
}

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}
```

**Provider 降级（v1.x+ 规划）**：

- 配置字段 `providerFallbackOrder` **已存在**，当前仅用于 host 注册 provider 列表与 CLI 默认连接 target
- **无**运行时按序切换；`provider_fallback` 事件类型预留
- 设计目标见 §8.1「预留：Provider 运行时降级」

### 9.6 安全模块

```typescript
interface SafetyModule {
  /**
   * 基线检查：当前含 5 项硬编码规则（详见下表），不可禁用。
   */
  checkBaseline(input: InputEnvelope, context: ExecutionContext): Promise<SafetyResult>;

  /**
   * 业务策略链：执行所有通过 registerPolicy 注入的 SafetyPolicy。
   */
  checkBusiness(input: InputEnvelope, context: ExecutionContext): Promise<SafetyResult>;

  /**
   * 动态注册业务安全策略；返回取消函数。
   * 同 id 重复注册视为更新（覆盖）。
   */
  registerPolicy(policy: SafetyPolicy): () => void;
}

interface SafetyPolicy {
  id: string;                               // 唯一 id，用于覆盖与日志
  scope: 'input' | 'execution' | 'output';  // 仅在对应阶段触发
  check(
    input: InputEnvelope,
    context: ExecutionContext,
  ): Promise<SafetyResult>;
}

interface SafetyResult {
  passed: boolean;
  violations: SafetyViolation[];            // passed=false 时至少 1 条
}

interface SafetyViolation {
  policyId: string;                         // 'baseline:input-too-large' / 业务策略 id
  severity: 'warning' | 'error';
  message: string;
  context?: Record<string, unknown>;
}
```

#### 引擎固有基线（5 项，不可关闭）

| # | 检查 | 实现位置 | 触发条件 | 严重度 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| 1 | 输入大小 | `safety.maxInputSizeBytes` | `Buffer.byteLength(JSON.stringify(input.content)) > maxInputSizeBytes` | error | `SAFETY_INPUT_TOO_LARGE` |
| 2 | 递归深度 | `safety.maxRecursionDepth` | `context.recursionDepth > maxRecursionDepth` | error | `SAFETY_RECURSION_TOO_DEEP` |
| 3 | 预算熔断（token / toolCall / wallTime） | `BudgetConstraint` 三项 | 任意预算耗尽（持续追踪） | error | `BUDGET_TOKEN_EXHAUSTED` / `BUDGET_TOOL_CALL_EXHAUSTED` / `BUDGET_WALL_TIME_EXHAUSTED` |
| 4 | 路径遍历防护 | `safety.workspaceRoot` | 文件后端访问的 `path` 解析后超出 workspaceRoot | error | `SAFETY_PATH_TRAVERSAL` |
| 5 | Prompt 注入告警 | `safety.promptInjectionPatterns` | 输入文本匹配任一正则 | **warning（不阻断）** | 无（仅 ObservabilityEmitter 发 `warning` 事件 `prompt_injection_warning`） |

> 第 5 项是"软告警"：默认 `promptInjectionPatterns: []` 不触发；业务可通过配置注入正则（例如 `["ignore previous instructions", "system prompt:"]`）以追踪可疑输入。命中只发 warning，不会让 `checkBaseline` 返回 `passed: false`。

#### 业务策略注入

```typescript
// 例：审计所有写文件操作
const cancel = engine.safety.registerPolicy({
  id: 'audit:write-file',
  scope: 'execution',
  async check(input, context) {
    if (input.metadata?.toolRef === 'fs.write') {
      console.log('[audit]', context.requestId, input.content);
    }
    return { passed: true, violations: [] };
  },
});
```

业务策略支持 input / execution / output 三个 scope；ADR-0006 起分别对应 `turnStart`（前置守卫，SafetyModule baseline 所在）/ `preToolUse`（工具调用前）/ `turnStop`（后置守卫，与结果验证同一挂载点）触发。

### 9.7 可观测性

```typescript
type EventHandler = (event: EngineEvent) => void;

interface ObservabilityEmitter {
  on(type: EngineEvent['type'] | '*', handler: EventHandler): () => void;
  off(type: EngineEvent['type'] | '*', handler: EventHandler): void;
  emit(event: EngineEvent): void;
  setMasker(masker: (payload: unknown) => unknown): void;
}

interface EngineEvent {
  timestamp: number;
  correlation: ExecutionCorrelation;   // { traceId, requestId, sessionId, turnId }
  subject?: ExecutionSubject | undefined;
  type: EventType;
  phase: string;
  payload: Record<string, unknown>;
}

type EventType =
  | 'phase_enter' | 'phase_exit'                        // 6 个 EnginePhase 的宏观边界（§7.1）
  | 'progress'                                           // 阶段/loop 内部状态快照（如 tool-routing 的路由决策）
  | 'llm_call_start' | 'llm_call_end'
  | 'tool_call_start' | 'tool_call_end'
  | 'hook_fired'                                         // 每次 HookRegistry.fire() 无条件发出（ADR-0006 D2）
  | 'retry' | 'degrade' | 'handoff'
  | 'provider_fallback'
  | 'plan_switched'
  | 'budget_warning' | 'budget_exhausted'
  | 'context_budget'
  | 'skill_activation' | 'skill_activation_strategy_failed' | 'skill_sticky_change'
  | 'memory_recall' | 'memory_recall_failed'
  | 'tool_activation' | 'tool_activation_strategy_failed'
  | 'warning' | 'error'
  | 'tool_loop_step_start' | 'tool_loop_step_end'         // loop per-step 扁平事件
  | 'tool_loop_failure_recovery_injected';
```

**ADR-0006 D5 落地现状**：`EnginePhase` 由 9 个收敛为 6 个（session/safety/tool-routing/execution/validation/output）后，`phase_enter`/`phase_exit` 依然存在，但只标记这 6 个宏观阶段的边界（不再有 intent/precheck/planning/graph-check 各自的进入/退出事件）；`tool-use` loop 内部不再重新发明"子阶段边界"，而是复用 loop 已有的**扁平 per-step 事件**：`tool_loop_step_start`/`tool_loop_step_end`（每个 loop step）、`tool_call_start`/`tool_call_end`（每次工具调用）、`llm_call_start`/`llm_call_end`（每次 LLM 请求）、`hook_fired`（每次 9 个 loop-lifecycle HookPoint 触发，见 §9.8）。这些事件通过 `parentStepId` 相互关联（例如一次工具调用的 `tool_call_start`/`tool_call_end` 携带发起它的 loop step 的 `stepId` 作为 `parentStepId`），下游可据此重建"某个 loop step 内发生了哪些工具调用/hook 触发"的树状关系，而不依赖额外的子阶段命名。

**双通道消费**：

| 通道 | 消费方式 | 用途 |
| --- | --- | --- |
| 实时进度流 | 订阅 `ObservabilityEmitter`，过滤关键事件推送 | UI 展示 |
| 结构化追踪 | 全量事件写入 Trace Log | 排查/审计 |

**脱敏**：`DefaultObservabilityEmitter.emit()` 在分发给 handler 前统一调用 `setMasker()` 注入的脱敏函数处理 `payload`；业务可覆盖默认的 `maskSensitiveData` 实现。

### 9.8 Hooks

```typescript
type HookPoint =
  | "turnStart" | "preLLM" | "postLLM" | "preToolUse" | "postToolUse"
  | "turnStop" | "preSubagent" | "postSubagent" | "preCompact";

interface HookRegistry {
  /**
   * 注册只读订阅处理器。返回取消函数（调用即移除）。
   * 适用于审计、日志、metrics 收集等"不影响流程"的场景。
   */
  subscribe(
    point: HookPoint,
    handler: SubscribeHandler,
    options?: { id?: string },
  ): () => void;

  /**
   * 注册可写处理器。返回取消函数（调用即移除）。
   * 可通过 HookAction 修改主流程数据、批准/拒绝执行、替换内容等。
   */
  register(
    point: HookPoint,
    handler: RegisterHandler,
    options?: { id?: string; priority?: number; timeout?: number },
  ): () => void;

  /** 触发指定挂载点；返回第一个改变主流程的 action，若无则 undefined。 */
  fire(point: HookPoint, event: HookEvent): Promise<HookAction | undefined>;

  /** 清空所有订阅与注册处理器。 */
  clear(): void;
}

type SubscribeHandler<TData = unknown> = (event: HookEvent<TData>) => void | Promise<void>;
type RegisterHandler<TData = unknown> = (event: HookEvent<TData>) => Promise<HookAction | void>;

type HookAction =
  | { type: 'continue' }                        // 默认值；保持原有数据流
  | { type: 'abort'; reason: string }           // 立即中止当前执行（throw EngineError）
  | { type: 'modify'; patch: unknown }          // free-mutation 点用差量补丁改写数据（受 Engine Seatbelt 约束，见 §7.4）
  | { type: 'approve' }                         // 显式放行需要审批的操作（preToolUse）
  | { type: 'deny'; reason: string }            // 显式拒绝需要审批的操作（同上）
  | { type: 'replace'; data: unknown }          // 用 data 整体替换事件数据（同受 Engine Seatbelt 约束）
  | { type: 'enrich'; data: Record<string, unknown> };   // 仅向 metadata 追加字段（不影响主数据）
```

**9 个 HookPoint 的适用 Action 矩阵**（详见 §7.3 的逐点 fire 位 + payload 表）：

| HookPoint | 适用 Action 类型 | 备注 |
| --- | --- | --- |
| `turnStart` | `continue` / `deny` / `abort` / `modify` / `replace` | pre-guard；`modify`/`replace` 改写 `input`；额外挂一套 `Guardrail`（§7.5） |
| `preLLM` / `postLLM` | `continue` / `deny`（仅 `preLLM`） / `abort` / `modify` / `replace` | free-mutation，受 Engine Seatbelt 约束（§7.4）；`postLLM` 的 mutation 不能覆盖 `usage` |
| `preToolUse` | `continue` / `approve` / `deny` / `abort` | 归位既有 `onBeforeToolCall` 审批语义 |
| `postToolUse` | `continue` / `modify` / `replace` | 仅当 mutation 含合法 `content: string` 时生效 |
| `preCompact` | `continue` / `replace` | host 可自定义压缩策略；未处理/mutation 不合法时套用默认压缩 |
| `turnStop` | `continue` / `deny` / `abort` / `modify` / `replace` | post-guard + 结果验证，恒最后跑、fail-closed；额外挂一套 `Guardrail`（§7.5） |
| `preSubagent` | `continue` / `deny` / `abort` | `deny`/`abort` 时短路，不真正 spawn |
| `postSubagent` | `continue` | 只读订阅/审计用途，不支持改写 result |

`subscribe` 注册的处理器始终视为只读订阅（其返回值被忽略，异常不影响主流程但会记入 `error` 事件）。

**运行约束**（`DefaultHookRegistry`，`modules/hooks.ts`）：

- 同 point 内 `register` 的处理器按 `priority` 数字**升序**执行；缺省 `priority = 100`；`fire()` 遇到第一个返回非 `continue` 的 action 即短路，不再执行后续处理器
- 可写处理器默认超时 = 构造时传入的 `writeHookTimeout`（默认 5000ms），可由 `register(..., { timeout })` 覆盖；超时抛 `TimeoutError.hookTimeout(point, timeoutMs)`
- 单个处理器**抛错/超时时**按 `HookFailureBehavior` 处理：`'continue'`（默认）吞错并通过 `ObservabilityEmitter` 发一条 `error` 事件（`payload: { source, point, handlerId, error }`），主流程继续；`'abort'` 额外抛出 `EngineError.fromUnknown(...)`
- 每次 `fire()` 调用无条件发一条 `hook_fired` observability 事件（`payload: { point, subscriberCount, registrarCount, action? }`），即使当前无人订阅/注册——ADR-0006 D2 的纪律：每个挂载点必须留下可观测痕迹，防止"定义了却查不出是否真被触发"的死面问题重演
- 同 point 同 `id` 的新 `subscribe`/`register` 调用会覆盖已有 handler（而非追加）

**取消注册**：

```typescript
const unregister = hooks.register('preToolUse', myApproval);
// ... 业务逻辑 ...
unregister(); // 移除该 handler
```

---

## 十、向量化能力

```typescript
interface VectorStore {
  /** 文本 → 向量；批量调用以充分利用 batch endpoint。*/
  embed(texts: string[]): Promise<number[][]>;

  /**
   * 写入或更新一条向量记录。
   * 第二参数支持两种形态：
   *   - `number[]`：调用方已自己 embed 得到向量
   *   - `string`：让 VectorStore 自己 embed（内部调用 this.embed([text])）
   * 同 id 重复 upsert 视为更新（向量与 metadata 整体替换）。
   */
  upsert(
    id: string,
    vectorOrText: number[] | string,
    metadata: Record<string, unknown>,
  ): Promise<void>;

  /**
   * 语义检索 topK；query 同样支持 number[] 或 string 两种形态。
   */
  search(
    query: number[] | string,
    topK: number,
  ): Promise<VectorSearchResult[]>;

  /** 按 id 删除单条；不存在视为 no-op。*/
  delete(id: string): Promise<void>;

  /** 清空所有条目（不影响 embed 模型）。*/
  clear(): Promise<void>;

  /** 当前条目数（同步快查）。*/
  size(): number;
}

interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}
```

**应用场景对应**：

| 场景 | 索引内容 | 调用时机 |
| --- | --- | --- |
| 语义发现 | 四大核心抽象的 `description` | 各阶段匹配激活 |
| 记忆归档 | 超限上下文的压缩内容 | 上下文召回 |
| 长期记忆 | 跨会话历史 | `turnStart` 前置阶段 |

**层级实现**：

- 引擎核心：只定义 `VectorStore` 接口 + 内置轻量实现 `InMemoryVectorStore`（`packages/core/src/vector/in-memory-store.ts`），单进程内存、开箱即用、生产慎用
- 扩展库：`packages/extensions/src/vector/` 提供 `LocalFsVectorIndexAdapter`（持久化到 JSON）与 `QdrantVectorIndexAdapter`（生产推荐）两种 Adapter
- 业务：可自行实现以接入其它向量数据库（pgvector / Pinecone / Weaviate ...）

**条目上限与内存管理（内置 InMemoryVectorStore）**：

- 默认上限 = `EngineConfig.memory.vectorIndexLimit`（10 000）
- 写入超限时拒绝并通过 `ObservabilityEmitter` 发 `warning` 事件 `vector_index_full { current, limit }`，**不自动驱逐**任何条目（避免静默丢失语义匹配）
- 业务可在 warning 触发后调用 `clear()` 或按 metadata 选择性 `delete()`
- `size()` 同步返回当前条目数，便于运维监控

---

## 十一、Prompt 组装

### 11.1 组装输入清单

| 来源 | 内容 | 优先级/位置 |
| --- | --- | --- |
| Rules（`type: 'rule'`） | 硬约束 | 最高，System Prompt 头部 |
| Rules（`type: 'preference'`） | 软偏好 | System Prompt 中部 |
| Skills | 知识/指令 | System Prompt 中部 |
| Tool 定义 | 可用 Tool 的描述和 Schema | Tool 定义区 |
| 会话上下文 | 经记忆系统管理的历史 | Messages 区 |
| 当前输入 | 本轮用户输入 | Messages 末尾 |

### 11.2 Token 预算分配策略

```
总预算 = 模型 maxContextTokens
  ├── System Prompt 区（Rules + Skills + Tool 定义）
  ├── 会话上下文区
  └── 预留输出空间
```

- 各区预算可配置比例
- 超预算时：压缩会话上下文 → 裁剪低优先级 Skills → 裁剪 Tool 定义

### 11.3 组装接口

```typescript
interface PromptAssembler {
  assemble(params: AssembleParams): Promise<AssembleResult>;
}

interface AssembleParams {
  // —— 阶段与匹配元素（必填）
  phase: RuleScope;                          // 当前阶段（决定 Rules scope 筛选）
  activeRules: RuleDescriptor[];
  activeSkills: SkillDescriptor[];
  availableTools: ToolDescriptor[];
  contextWindow: ContextWindow;
  currentInput: InputEnvelope;
  modelCapabilities: ModelCapabilities;

  // —— 模型与 Tokenizer（必填）
  model: ModelRoute;                         // 目标模型（决定 system prompt 风格 + token 计数 encoding）
  tokenizer: Tokenizer;                      // Token 计数器（当前默认 tiktoken，详见 §11.4）

  // —— 长期记忆与任务上下文（可选）
  recalledEntries?: MemoryEntry[];           // 长期记忆召回结果（拼到 system 末尾）
  currentTaskContext?: Record<string, unknown>;  // ContextDistributor 分发的任务级上下文
  toolCallHistory?: ToolCallRecord[];        // 已发生的 Tool 调用，避免重复推理

  // —— 输出预算与回收（可选）
  finalOutputConstraint?: OutputConstraint;  // 终态输出约束（schema / 长度上限 / format）
  reserveOutputTokens?: number;              // 必须为响应预留的 token 数（默认 1024）

  // —— 注入与回调（可选）
  systemInstruction?: string;                // 业务追加的 system 段（最高位置注入）
  onCompressContext?: (window: ContextWindow) => Promise<ContextWindow>;
                                             // token 超限时调用：让上层执行压缩
}

interface AssembleResult {
  systemPrompt: string;                      // 拼接好的 system prompt
  userPrompt: Message[];                     // 用户/助手历史消息序列
  tokenCount: number;                        // 估算的总 token（含 reserveOutputTokens 之外）
  availableTools: ToolDefinition[];          // function-calling 形式的 tool 列表（已按模型能力裁剪）
}
```

> **字段语义**：所有新增字段均与 `packages/core/src/prompt/assembler.ts` 实现一致；`reserveOutputTokens` 缺省值由 `DEFAULT_ENGINE_CONFIG` 控制；`onCompressContext` 仅在 `tokenCount > model.maxContextTokens - reserveOutputTokens` 时被回调一次。

### 11.4 Tokenizer 接口与 encoding 选择策略

`PromptAssembler` 不直接依赖 `tiktoken`，而是通过 `Tokenizer` 接口注入：

```typescript
interface Tokenizer {
  /** 同步精确计数（推荐；底层使用 tiktoken WASM）。*/
  count(text: string): number;
  /** 编码为 token id 数组（用于精细切片）。*/
  encode(text: string): number[];
  /** token id → 文本（用于 token 级流式还原）。*/
  decode(tokens: number[]): string;
  /** 释放底层 WASM 资源；进程退出前调用。*/
  dispose(): void;
}
```

**当前内置实现**：`packages/core/src/prompt/tokenizer.ts` 提供 `createTiktokenTokenizer(model: string)` 工厂；模型名 → encoding 选择策略如下：

| 模型 family（按 `model.startsWith` 判定） | tiktoken encoding | 说明 |
| --- | --- | --- |
| `gpt-4o*` / `o1*` / `o3*` | `o200k_base` | OpenAI 2024+ 系列原生 encoding |
| `gpt-4*` / `gpt-3.5*` | `cl100k_base` | OpenAI 经典系列 |
| `claude*` | `cl100k_base` | Anthropic 未公开官方 tokenizer，使用 cl100k 作为近似（误差 < 5%） |
| 其它 / 未知 | `cl100k_base` | 默认回退（与 OpenAI 经典系列对齐） |

**`encoding_for_model` 失败时的兜底策略**：tiktoken 的 `encoding_for_model(name)` 在遇到未知模型时会抛错；`createTiktokenTokenizer` 捕获后改用 `get_encoding('cl100k_base')`，并通过 `ObservabilityEmitter` 发出 `warning` 事件（`type: 'tokenizer_fallback'`），便于后续按模型新增映射。

**WASM 加载失败兜底**：若 tiktoken WASM 模块加载失败（极端 IO / 平台不兼容场景），回退到 `ByteEstimateTokenizer`（按 `text.length / 4` 近似，误差较大）；同样发 warning 事件并附带 `cause`。

---

## 十二、上下文分发策略

编排控制面裁剪规则：

```typescript
interface ContextDistributor {
  distribute(
    globalContext: unknown,
    tasks: TaskNode[],
    edges: TaskEdge[]
  ): Map<string, unknown>;   // taskId → 裁剪后的上下文
}
```

**裁剪原则**：

- 每个子任务只收到与其直接相关的上下文
- 父任务结果向依赖的子任务传递
- 全局约束（Rules、安全策略）始终传递

---

## 十三、执行后端与 MCP 适配

### 13.1 执行后端接口

```typescript
interface ExecutionBackend extends ExecutionUnit<BackendInput, BackendOutput> {
  readonly name: string;
  readonly traits: ExecutionTraits;
}
```

引擎核心只定义接口。扩展库提供：`TerminalBackend`、`WebBackend`、`FileBackend` 等。

### 13.2 MCP 适配

```typescript
interface McpToolAdapter {
  connect(serverUri: string): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;   // MCP 工具 → 引擎 ToolDescriptor
  executeTool(name: string, input: unknown): Promise<unknown>;
  cancel(requestId: string): Promise<void>; // 取消传播
}
```

**适配职责**：

| 职责 | 说明 |
| --- | --- |
| Session 管理 | MCP 连接生命周期与引擎 Session 对齐 |
| 能力协商 | 发现 MCP 服务端能力，映射为 ToolDescriptor |
| 进度/取消传播 | 引擎取消信号 → MCP 服务端 |

---

## 十四、配置体系

### 14.1 配置结构

`EngineConfig` 由九个顶级键构成（`providers` 为可选），与 `packages/core/src/types/config.ts` 完全一致：

```typescript
interface EngineConfig {
  registry: {
    descriptorPaths: string[];       // 描述符根目录列表（CLI 默认 ['.tachu']）
    enableVectorIndexing: boolean;   // 启动期自动把 descriptor 写入向量索引
  };
  runtime: {
    planMode: boolean;               // Plan 模式（只规划不执行），默认 false
    maxConcurrency: number;          // 子任务最大并行度，默认 4
    defaultTaskTimeoutMs: number;    // 单任务默认超时 ms，默认 120_000
    failFast: boolean;               // 任意子任务失败立即中止，默认 false
  };
  memory: {
    contextTokenLimit: number;       // 上下文窗口 token 上限，默认 8000
    compressionThreshold: number;    // 压缩触发阈值（0-1），默认 0.8
    headKeep: number;                // 压缩时保留的最早消息条数，默认 4
    tailKeep: number;                // 压缩时保留的最新消息条数，默认 12
    archivePath: string;             // 归档 JSONL 路径，默认 '.tachu/archive.jsonl'
    vectorIndexLimit: number;        // 内置向量索引最大条目数，默认 10000
  };
  budget: {
    maxTokens: number;               // 单次执行总 token 预算，默认 50_000
    maxToolCalls: number;            // 单次执行最大 tool 调用次数，默认 50
    maxWallTimeMs: number;           // 单次执行墙钟时间上限 ms，默认 300_000
  };
  safety: {
    maxInputSizeBytes: number;       // 输入大小上限（字节），默认 1_000_000
    maxRecursionDepth: number;       // Agent 嵌套递归深度上限，默认 10
    workspaceRoot: string;           // 文件后端根目录（用于路径遍历防护），默认 process.cwd()
    promptInjectionPatterns: string[]; // 注入告警的正则模式列表（仅 warning，不阻断）
  };
  models: {
    capabilityMapping: Record<string, ModelRoute>;  // 能力标签 → ModelRoute（含 provider/model/params?）
    providerFallbackOrder: string[];                // Provider id 列表：启动注册 + CLI 默认 target；runtime 自动降级 reserved v1.x+（§8.1）
  };
  /**
   * Provider 连接配置（可选）。仅影响内置 Provider Adapter（OpenAI / Anthropic 等）。
   * 自定义 Provider 通过 `createEngine(config, { providers: [...] })` 注入。
   */
  providers?: ProvidersConfig;
  observability: {
    enabled: boolean;                // 是否启用事件 emit，默认 true
    maskSensitiveData: boolean;      // 是否对 payload 自动脱敏，默认 true
  };
  hooks: {
    writeHookTimeout: number;        // 可写 Hook 超时 ms，默认 5000
    failureBehavior: 'continue' | 'abort';  // 单个 Hook 失败默认行为，默认 'continue'
  };
}

/** 路由到具体模型的解析结果。*/
interface ModelRoute {
  provider: string;
  model: string;
  params?: Record<string, unknown>;
}

/** 单个 Provider 的连接配置；所有字段均为可选，未填回退到环境变量与 SDK 默认。*/
interface ProviderConnectionConfig {
  apiKey?: string;        // 缺省回退到 OPENAI_API_KEY / ANTHROPIC_API_KEY 等
  baseURL?: string;       // 缺省回退到 SDK 默认或 OPENAI_BASE_URL / ANTHROPIC_BASE_URL
  organization?: string;  // 仅 OpenAI
  project?: string;       // 仅 OpenAI
  timeoutMs?: number;     // Provider 级请求超时
  extra?: Record<string, unknown>;  // 透传给底层 SDK 的原始选项（结构由 adapter 解释）
}

/** 已知 Provider 的连接配置集合，键名必须与 `models.capabilityMapping[*].provider` 一致。*/
interface ProvidersConfig {
  openai?: ProviderConnectionConfig;
  anthropic?: ProviderConnectionConfig;
  [provider: string]: ProviderConnectionConfig | undefined;
}
```

> **Tachu v1 配置为九键结构（设计说明）**：顶级配置固定为本节九键结构，相关设计取舍：
>
> 1. 任务级 / 系统级重试循环当前未实现（详见 §8.1），故不设 `retry` 顶级键；
> 2. `planning.planCount` 在当前实现中固定为 1（单方案），未提供切换开关；
> 3. Agent 嵌套深度由 `safety.maxRecursionDepth` 统一控制；
> 4. 上下文压缩策略由内置策略硬编码，不暴露替换接口；
> 5. 任务默认超时键为 `runtime.defaultTaskTimeoutMs`；
> 6. archive / vector 存储改为依赖注入（`createEngine` 第二参数），不走配置文件。
>
> 任何对外文档（README、`tachu init` 模板）必须使用本节的九键结构，否则 `validateConfig` 会在引擎启动时抛 `VALIDATION_INVALID_CONFIG`。

### 14.2 优先级模型

```
硬规则（type: 'rule'）：引擎内置 > 业务配置 → 不可覆盖
软配置（type: 'preference' / EngineConfig）：业务配置 > 引擎默认值 → 业务优先
```

### 14.3 校验规则

- 引擎启动时校验配置完整性
- 缺失的非必填项使用默认值
- 不合法的值（如 `taskMaxRetries < 0`）→ 引擎拒绝启动

---

## 十五、技术选型

具体技术选型、工程结构及落地方案见 [技术设计说明书](./technical-design.md)。

---

## 附录：概要设计 → 详细设计章节对照

| 概要设计章节 | 详细设计章节 |
| --- | --- |
| 一、项目定位 | 一（无需细化） |
| 二、三层发布结构 | 二 |
| 三、四大核心抽象 | 三 |
| 四、执行上下文 | 四 |
| 五、执行单元规格 | 五 |
| 六、输入输出设计 | 六 |
| 七、主干流程 | 七 |
| 八、错误处理与状态流转 | 八 |
| 九、核心模块 | 九 |
| 十、向量化能力 | 十 |
| 十一、Prompt 组装 | 十一 |
| 十二、上下文分发策略 | 十二 |
| 十三、执行后端与 MCP | 十三 |
| 十四、配置体系 | 十四 |
| 十五、技术选型 | 十五（待定） |
| 十六、参考资料 | —（不需细化） |
