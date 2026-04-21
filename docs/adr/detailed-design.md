# Agentic Engine 详细设计文档

> 状态：初稿（基于概要设计展开，待逐节评审） 最后更新：2026-04-16

本文档严格对齐 [概要设计](./architecture-design.md) 各章节，逐一细化为可落地执行的规格。

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
  tags?: string[];           // 标签（过滤和分类）
  trigger?: TriggerCondition; // 激活条件
  requires?: DependencyRef[]; // 显式依赖引用
}
```

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

type RuleScope =
  | 'safety'           // 最小安全准入
  | 'intent'           // 意图分析
  | 'precheck'         // 前置校验
  | 'planning'         // 任务拆分
  | 'execution'        // 任务执行
  | 'validation'       // 结果验证
  | 'output'           // 输出规范
  | '*';               // 全部阶段
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
  instructions: string;            // Markdown 正文（激活后注入 LLM 上下文）
  resources?: SkillResource[];     // 附属资源声明
}

interface SkillResource {
  path: string;                    // 资源相对路径
  type: 'script' | 'reference' | 'asset';
  loadHint?: string;               // 何时加载的自然语言提示（供 LLM 判断）
}
```

**文件约定**（与行业标准对齐）：

```
skill-name/
├── SKILL.md              # 必须，YAML frontmatter（元信息）+ Markdown body（指令）
└── resources/            # 可选
    ├── scripts/          # 可执行脚本（确定性/重复性任务）
    ├── references/       # 参考文档（按需加载到上下文）
    └── assets/           # 输出用素材（模板、图标等）
```

- 激活后，`instructions` + `requires` 引用的依赖内容一起注入 LLM 上下文
- 资源层内容不自动加载，由 LLM 根据 `loadHint` 按需读取
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

```typescript
type StreamChunk =
  | { type: 'progress';     phase: string; message: string }
  | { type: 'plan-preview'; phase: 'planning'; plan: RankedPlan }
  | { type: 'delta';        content: string }
  | { type: 'artifact';     artifact: Artifact }
  | { type: 'error';        error: EngineError }
  | { type: 'done';         output: EngineOutput };
```

**chunk 类型语义**：

| `type` | 触发时机 | 生产者 | 消费提示 |
| --- | --- | --- | --- |
| `progress` | 每个 Phase 进入时 / 关键里程碑（"开始注入安全策略"等） | Engine 主循环 | UI 显示阶段提示，不影响最终输出 |
| `plan-preview` | Phase 5 (Planning) 完成、Phase 6 (graph-check) 通过后 | `phases/planning.ts` | UI 可在执行前先展示规划结果给用户审阅；Plan 模式下消费完即可结束 |
| `delta` | 任何 Phase 产出 LLM token 流时（主要是 `direct-answer` Sub-flow 与 Tool 调用结果回填） | `subflows/direct-answer.ts` / Tool executor | UI 增量渲染 |
| `artifact` | 子任务产出文件 / 二进制内容 | TaskExecutor / Backends | UI 提供下载或预览 |
| `error` | 任意未捕获错误（含预算熔断、Provider 失败） | Engine 主循环 catch | UI 提示并停止后续渲染 |
| `done` | 流末尾（成功或失败的最终 EngineOutput） | Engine 主循环 finally | UI 解锁输入；`output.status` 决定后续行为 |

**注意**：`plan-preview` 仅在 `runtime.planMode === false` 且至少一个 plan 通过 graph-check 时发出；Plan 模式（`planMode: true`）下流以 `plan-preview` 之后立刻 `done` 结束，不进入 Phase 7。

---

## 七、主干流程

### 7.1 阶段定义

> **流水线同构契约**：所有请求（无论 `complexity` 为 `simple` 或 `complex`）必须依次穿过 Phase 1–9，不存在"simple → 直接跳到 Phase 9"的快速通道。Phase 3 仅产生分类与上下文门卫判定，不产出最终答复；Phase 5 必须输出至少 1 个可执行任务；Phase 7 通过内置 Sub-flow `direct-answer` 兑现"直接回答"契约。

| # | 阶段 | 入口 | 出口 | LLM 调用 |
| --- | --- | --- | --- | --- |
| 1 | 会话管理 | 业务请求 | 带上下文的请求 | 否 |
| 2 | 最小安全准入 | 带上下文的请求 | 通过/拒绝 | 否 |
| 3 | 意图分析 | 安全检查后的请求 | 分类结果（complexity + intent + contextRelevance） | **是** |
| 4 | 前置校验 | 意图分析结果（所有路径） | 校验通过/拒绝 | 否 |
| 5 | 任务拆分 | 校验通过的意图 | 依赖图 + 方案列表（`tasks.length ≥ 1`） | 视路径 |
| 6 | 依赖图校验 | LLM / 规划产出的依赖图 | 校验后的执行计划 | 否 |
| 7 | 子任务执行 | 执行计划 | 各子任务结果（含内置 `direct-answer` Sub-flow 的自然语言答复） | 视子任务 |
| 8 | 结果验证 | 执行结果 | 通过/不通过 + 诊断 | **是**（complex 时） |
| 9 | 输出规范 | 执行结果 + 验证结论 | 标准输出 | 否 |

### 7.2 意图分析阶段

**输入**：当前用户输入 + 会话历史

**输出**：

```typescript
interface IntentResult {
  complexity: 'simple' | 'complex';
  intent: string;                     // ≤200 字符的意图摘要
  contextRelevance: 'related' | 'unrelated';  // 上下文门卫判定
  relevantContext?: unknown;          // 相关时携带的精简历史
}
```

**重要约束**：`IntentResult` 不包含 `directAnswer` 字段。Phase 3 仅承担分类与门卫判定；所有面向用户的自然语言答复统一由 Phase 7 的内置 Sub-flow `direct-answer` 产出（详见 §7.11）。这一约束同样体现在 `INTENT_SYSTEM_PROMPT` 中，Phase 3 LLM 无需输出答复内容。

**complexity 判定标准（强制）**：

- `simple`：LLM 仅凭自身知识、一次生成即可给出完整答复的请求（问候、事实问答、创造性单轮产出如写代码/写教案/写文章、翻译、概念解释等）。
- `complex`：必须调用真实工具、读写用户文件、联网查询、运行命令或多步协作才能完成的请求。

**模糊场景兜底**：分类 LLM 若判定模糊，一律归为 `simple`，由 Phase 5 路由到 `direct-answer` Sub-flow。

**上下文门卫**：

- `related` → 携带 `relevantContext` 向下传递
- `unrelated` → 仅本轮输入向下，历史仅意图分析层可见

### 7.3 前置校验阶段

校验项（按序执行）：

1. 资源可用性：意图涉及的 Tools/Agents 是否已注册且可用
2. Provider 连通性：目标模型的 Provider 是否可达
3. 深度安全校验：业务注入的安全策略（如 Prompt 注入检测）
4. 业务自定义校验：通过 Rules 或 Hooks 追加

任一校验失败 → 返回明确错误，不进入任务拆分。

> **约束**：前置校验对所有请求（含 `complexity === 'simple'`）同样执行，不因 simple 跳过。对于 simple 意图，资源可用性与 Provider 连通性仅需验证 `direct-answer` Sub-flow 所依赖的 `intent` 或 `fast-cheap` 能力标签的 Provider 是否可达。

### 7.4 任务拆分阶段

**兜底契约（强制）**：任务拆分阶段**必须输出至少 1 条可执行任务**，即 `plans[0].tasks.length >= 1`。没有可用 Tool/Agent/模板匹配时，必须兜底到内置 Sub-flow `direct-answer`（见 §7.11），不允许抛出"no matching plan"错误或产出空 Plan。

分发路径：

| 路径 | 触发条件 | 行为 |
| --- | --- | --- |
| Direct-answer 兜底 | `complexity === 'simple'` 或 `complex` 且 Tool/Agent 匹配为空 | 产出单步 Plan：`{ ref: 'direct-answer', input: { prompt, warn? } }` |
| Plan 模式 | 上层显式指定 `planMode: true` | 进入规划循环 |
| 模板匹配 | 匹配到预定义 Plan 模板 | 按模板生成依赖图 |
| 动态拆分 | `complexity === 'complex'` 且上述均未命中而匹配到具体 Tool/Agent | LLM 动态拆分 |

> **simple 路径实现细则**：`simple` 意图的 Plan 结构固定为单节点、无边的依赖图；调度器执行后产物直接成为 Phase 9 的 `content` 主体。对应子任务如下：
>
> ```typescript
> const directAnswerTask: TaskNode = {
>   id: 'task-direct-answer',
>   type: 'sub-flow',
>   ref: 'direct-answer',
>   input: { prompt: intent.intent, /* 可能附带原始输入切片 */ },
> };
> ```

#### 规划循环（Plan 模式）

```
引擎生成/加载 Plan → 返回上层审阅
  ↔ 上层修正 → 引擎调整（可迭代多轮）
  → 确认 → 进入执行
```

#### 动态拆分输出

```typescript
interface PlanningResult {
  plans: RankedPlan[];             // 按排名排序，N ≥ 1 可配置
}

interface RankedPlan {
  rank: number;
  tasks: TaskNode[];               // 约束：tasks.length >= 1
  edges: TaskEdge[];               // 依赖关系，direct-answer 路径下为空数组
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

#### Phase 5 输出约束（强制）

1. `plans.length >= 1`，且 `plans[0].tasks.length >= 1`
2. 任意 `TaskNode.type === 'sub-flow'` 且 `ref === 'direct-answer'` 时，必须带 `input.prompt: string`，允许可选 `input.warn: boolean` 与 `input.hint: string`
3. `edges` 可为空数组（兜底单步 Plan 的典型形态）
4. 任一约束违反视为规划失败，Phase 6 会返回校验错误并触发重规划；达到重规划上限后引擎强制生成 direct-answer 兜底 Plan，绝不输出空计划

### 7.5 依赖图校验

确定性校验（非 LLM）：

1. **环检测**：拓扑排序，发现环则校验失败
2. **节点完整性**：每个 `TaskNode.ref` 引用的 Tool/Agent 必须已注册且可用
3. 校验失败 → 触发重规划或降级

### 7.6 子任务执行

- 依赖调度器根据 `edges` 自动编排：无依赖的任务并行，有依赖的串行等待
- 编排控制面按"需要知道"原则裁剪 `contextSlice`
- 每个子任务遵循统一执行规格（§五）

### 7.7 结果验证

```typescript
interface ValidationResult {
  passed: boolean;
  diagnosis?: {
    type: 'execution_issue' | 'planning_issue';
    reason: string;
    failedTaskIds?: string[];  // v1：仅 execution_issue 时填充
  };
}
```

**v1 实现范围**（详见 §8.1）：

- v1 的 Phase 8 仅做**确定性失败扫描**：遍历 `taskResults`，若任意 task 的 `status === 'failed'`，产出 `diagnosis = { type: 'execution_issue', reason, failedTaskIds }`，否则 `passed: true`
- v1 **不实现 LLM 结果诊断**：不会从语义层判断输出"质量不达标"；`diagnosis.type` 在 v1 永远只取 `execution_issue`
- v1 **不实现自动重试循环**：诊断信号只产出一次，写入 `EngineOutput.steps`；编排控制面 `ExecutionOrchestrator.switchToNextPlan` 可在多方案场景下手动切换，但 Engine 主循环不会自动重走 Phase 7

**v2 计划**：

- LLM 诊断：调用 fast-cheap 模型对 `taskResults` 做语义判定，可产出 `planning_issue`
- 自动重试：`execution_issue` 触发当前方案重执行（≤3 次）；`planning_issue` 触发 `switchToNextPlan`（≤总方案数 - 1 次）
- 详见未来 ADR `decisions/000x-validation-loop-v2.md`

### 7.8 编排控制面

职责清单：

| 职责 | 说明 |
| --- | --- |
| 规划输出管理 | 接收 LLM 产出的拆分方案，传递给依赖图校验 |
| 依赖图校验 | 调用确定性校验逻辑 |
| 方案排名与切换 | 当前方案失败时切换到下一方案 |
| 预算管控 | 追踪全局 token/时间消耗，触发熔断 |
| 降级决策 | 重试耗尽或预算不足时决定终止路径 |
| 上下文裁剪 | 按"需要知道"原则为子任务分发精简上下文 |

### 7.9 取消传播

- 同一 session 新消息到达 → 引擎向当前执行发取消信号
- 所有正在执行的子任务收到取消 → 尽快终止
- 在已有上下文基础上处理新输入（last-message-wins）

### 7.10 生命周期钩子挂载点

```typescript
type HookPoint =
  | 'beforeSafetyCheck'    | 'afterSafetyCheck'
  | 'beforeIntentAnalysis' | 'afterIntentAnalysis'
  | 'beforePreCheck'       | 'afterPreCheck'
  | 'beforePlanning'       | 'afterPlanning'
  | 'beforeExecution'      | 'afterExecution'
  | 'beforeValidation'     | 'afterValidation'
  | 'beforeOutput'         | 'afterOutput';
```

详见 §9.8。

### 7.11 内置 Sub-flows

为了承载 §7.4 的"兜底契约"与 §7.5 的"Agentic 工具循环"，引擎在启动期向 `InternalSubflowRegistry` 注册一组**内置 Sub-flows**。它们与业务注册的 Tool/Agent/Sub-flow 共享统一的 `TaskNode` 调度契约，但以下约束使其区别于业务条目：

1. **强制注册**：引擎启动期自动写入 `InternalSubflowRegistry`，业务代码无法取消
2. **不可覆盖**：同名业务 Sub-flow 注册时抛出 `RegistryError.reservedName('direct-answer' | 'tool-use')`，防止 silent shadowing
3. **不可注销**：`Registry.unregister('sub-flow', <internal-name>)` 被忽略或抛错
4. **独立调度通道**：默认 `TaskExecutor`（由 `Engine.buildLayeredTaskExecutor` 构造的 layered executor）在分发前优先匹配 `task.type === "sub-flow" && InternalSubflowRegistry.has(task.ref)`；命中后从 `InternalSubflowRegistry` 取函数直接执行，业务侧注入的 `TaskExecutor` 仅作为 fallback 接收非内置任务

当前引擎内置两类 Sub-flow：

| 名称 | 调用时机 | 角色 |
| --- | --- | --- |
| `direct-answer` | Phase 5 判定 simple 意图；或 complex 意图但 Registry 为空 | 一次性 LLM 回复，承担"兜底契约" |
| `tool-use` | Phase 5 判定 complex 意图且 Registry 存在 ≥1 个可见 Tool | 多轮 Agentic 工具循环 |

#### 7.11.1 `direct-answer` Sub-flow

**名称**：`direct-answer`（保留名，业务不可覆盖）
**用途**：兑现"直接回答"契约——在不需要真实工具的场景下，以自然语言 + Markdown 形式回复用户

**输入契约**：

```typescript
interface DirectAnswerInput {
  prompt: string;       // Phase 5 传入的用户诉求摘要（通常为 IntentResult.intent 或原始输入切片）
  warn?: boolean;       // 由 Phase 5 兜底路径置 true：表示意图分类为 complex 但无匹配工具，回复中应坦诚说明
  hint?: string;        // 可选的面向 LLM 的额外指令，用于改写口吻或排版风格
}
```

**执行语义**：

1. 使用 `ModelRouter.resolve('intent')` 解析模型（与 Phase 3 共享能力标签，保证答复口径一致）；未命中时回退到 `fast-cheap`，仍未命中抛 `ModelRouterError`
2. 调用 Provider 的 `chat` 接口；附带当前 session 的 `ContextWindow`（受 `INTENT_HISTORY_LIMIT` 同款限制）与一个内置 System Prompt
3. System Prompt 强制要求：
   - 输出**自然语言 + Markdown**，不再包 JSON
   - 代码必须使用 fenced 代码块并带 language 标签
   - `input.warn === true` 时，以 1–2 句坦诚说明"未能匹配到工具"，随后基于自身知识尽可能给出可用建议
4. 返回的文本作为 `TaskResult.output` 透传给 Phase 9

**错误处理**：

- Provider 失败 → 走系统级重试（2 次）→ 仍失败则升级为 `ProviderError`
- 输出为空 → Phase 8 结果验证捕获并回落到 Phase 9 的 honest-fallback 文案

**为什么放在内置而非业务 Sub-flow**：

- 它是 Phase 5 的兜底终态，若不由引擎强制保证存在，整条流水线会在"没有匹配工具"时陷入规划失败循环
- 它的 Prompt 约束、模型路由、Context 装配方式与 Phase 3 强相关，放在业务侧会破坏语义边界
- 它的失败路径直接决定 Phase 9 的 honest-fallback 行为，引擎必须始终能拿到它的错误码与步骤状态

### 7.12 `tool-use` Sub-flow 执行规格

**名称**：`tool-use`（保留名，业务不可覆盖）
**用途**：兑现"Agentic 工具循环"——在已注册工具的前提下，让 LLM 多轮规划、动态调用工具，直到给出自然语言最终回复。

**输入契约**：

```typescript
interface ToolUseInput {
  prompt: string;   // Phase 5 传入的用户诉求摘要（通常为 IntentResult.intent）
  hint?: string;    // 可选的宿主附加指令，用于引导循环风格
}
```

**运行时配置**：`EngineConfig.runtime.toolLoop`

```typescript
interface ToolLoopConfig {
  maxSteps: number;                  // 最大循环步数（默认 8，范围 1..64）
  parallelism: number;               // 单轮并发工具数（默认 4，范围 1..16）
  requireApprovalGlobal: boolean;    // 全局强制审批开关（默认 false）
}
```

**核心循环语义**：

```
for step in 1..maxSteps:
  llmResponse = Provider.chat({ messages, tools })
  conversation.append(assistant{ content, toolCalls })
  if finishReason !== "tool_calls" or toolCalls 为空:
    if content 非空 → finalContent = content；break
    if step == 1 → throw TOOL_LOOP_PROVIDER_NO_RESPONSE
    else         → throw TOOL_LOOP_EMPTY_TERMINAL_RESPONSE
  batch = executeToolCallsBatch(toolCalls, parallelism)
  for record in batch:
    conversation.append(tool{ content: record.content, toolCallId: call.id })
if finalContent 为 null:
  throw TOOL_LOOP_STEPS_EXHAUSTED
return finalContent
```

**工具执行路径（`executeSingleToolCall`）**：

1. **描述符查找**：`Registry.get("tool", call.name)`；未命中 → 合成一条错误 tool 消息回灌 LLM（不中断循环），同时上报 `TOOL_LOOP_UNKNOWN_TOOL`
2. **审批协议（可注入 `onBeforeToolCall`）**：当 `descriptor.requiresApproval === true` 或 `requireApprovalGlobal === true` 时触发回调；回调返回 `{ type: "deny", reason }` → 合成"用户拒绝"tool 消息回灌 LLM；回调抛异常 → 视同 deny；未注入回调 → 自动批准（保持旧行为）
3. **统一调度**：构造 `TaskNode { type: "tool", ref, input }`，经 `ctx.taskExecutor` 执行；子任务获得独立的 AbortSignal（外部取消 + 60s 保险超时）
4. **结果序列化**：Tool 输出统一 `JSON.stringify` 为字符串作为 tool 消息的 `content`
5. **失败不中断**：真实执行器抛错时，合成一条错误 tool 消息回灌 LLM，标注 `TOOL_LOOP_TOOL_EXECUTION_FAILED`；LLM 可以基于错误调整后重试或放弃该工具

**流式事件**：

| Chunk type | 时机 | 用途 |
| --- | --- | --- |
| `tool-loop-step` | 每轮思考入口 | 驱动 CLI 的 spinner / 进度条 |
| `tool-call-start` | 发起工具调用前 | 渲染"→ 调用工具 X" |
| `tool-call-end` | 工具调用结束（成功 / 失败 / 被拒绝） | 带 `success` / `durationMs` / `errorMessage` / `errorCode` |
| `tool-loop-final` | 循环结束 | 带 `steps` / `success` |

所有 `tool-call-end` 在失败时都填 `errorCode`：`TOOL_LOOP_APPROVAL_DENIED` / `TOOL_LOOP_UNKNOWN_TOOL` / `TOOL_LOOP_TOOL_EXECUTION_FAILED`，供 UI 层精准渲染。

**观测事件（`ObservabilityEmitter`）**：

```
phase_enter     { provider, model, toolCount, maxSteps, parallelism }
progress        { step, maxSteps }
progress        { stage: "approval-pending" | "approval-granted", tool, callId, triggeredBy }
tool_call_start { tool, callId, argumentsPreview }
tool_call_end   { tool, callId, durationMs, outputLength }
warning         { reason: "unknown-tool" | "tool-execution-failed" | "approval-denied" }
llm_call_end    { step, terminal, finishReason, usage }
```

**错误码（`ToolLoopError`）**：

| code | retryable | 触发 |
| --- | --- | --- |
| `TOOL_LOOP_STEPS_EXHAUSTED` | true | 循环超过 `maxSteps` 仍未终止 |
| `TOOL_LOOP_EMPTY_TERMINAL_RESPONSE` | true | `finishReason=stop` 但 content 空（非首轮） |
| `TOOL_LOOP_PROVIDER_NO_RESPONSE` | true | 首轮即返回空 content 且无工具请求 |
| `TOOL_LOOP_UNKNOWN_TOOL` | false | 模型请求了 Registry 中不存在的工具（反馈给 LLM，不中断） |
| `TOOL_LOOP_TOOL_EXECUTION_FAILED` | false | 真实执行器抛错（反馈给 LLM，不中断） |
| `TOOL_LOOP_APPROVAL_DENIED` | false | 审批被拒绝（反馈给 LLM，不中断） |

**工具调用记录汇总**：每次 `executeSingleToolCall` 结束都会向 `onToolCall(record)` push 一条 `ToolCallRecord { name, durationMs, success, errorCode? }`；主干 `runStream` 收集后写入 `EngineOutput.metadata.toolCalls`，供业务侧做计费、重放或审计。

**Prompt 组装**：

- 优先消费 Phase 6 预热阶段装配的 `AssembledPrompt.messages` 与 `AssembledPrompt.tools`
- 当 `prebuiltPrompt.messages.length === 0` 时，`tool-use` 内部会调用 `buildFallbackMessages` 组装 `{ system: TOOL_USE_SYSTEM_PROMPT, user: input.prompt }`，确保即便 Phase 6 被简化（测试路径）也能独立运转

**预算与取消**：

- 循环顶部 `ctx.signal.aborted` 检查即时退出
- 每轮 Provider.chat 挂 `buildToolUseLlmSignal(signal, 90_000)`；每次 Tool 执行挂 `buildToolExecutionSignal(signal, 60_000)`
- `ExecutionContext.budget` 随 `ctx.executionContext` 透传给 TaskExecutor；预算消耗在主干 `ExecutionOrchestrator` 侧统一记账

**为什么放在内置而非业务 Sub-flow**：

- 它在 Phase 5 路由表里与 `direct-answer` 对等，是 complex 分支的主干执行通道，必须由引擎保证存在
- 它需要访问引擎内部的 `Registry` 查工具、统一 TaskExecutor 调度工具、统一 observability 事件；若放在业务侧会割裂语义边界与审批/预算/取消传播
- 工具循环的错误语义（尤其 steps-exhausted / approval-denied）必须映射为稳定的 `ToolLoopError` code 才能让 Phase 9 的 honest-fallback、CLI 渲染、SDK 业务消费方协议一致

---

## 八、错误处理与状态流转

### 8.1 重试与降级（v1 落地范围）

> **v1 范围声明**：本章历史草案曾设计两套重试循环（系统级 ×2 + 任务级 ×3）。**v1 仅实现 Provider 降级与诊断信号**，不实现自动循环重试；任务级重试 / 系统级重试循环保留到 v2。原因：自动重试涉及幂等性判定、副作用回放、状态回滚等正交问题，需要单独的设计 ADR；v1 优先保证流水线同构与降级的确定性。

#### v1 已实现：Provider 降级（系统级最小回退）

```
触发：内置 Provider Adapter 抛 ProviderError（PROVIDER_UNAVAILABLE / PROVIDER_CALL_FAILED）
策略：按 EngineConfig.models.providerFallbackOrder 顺序切换到下一个可用 Provider
        |--- 当前任务节点继续执行（不重新规划）
兜底：所有 Provider 全部失败 → 透传 ProviderError 给上层；EngineOutput 标记 status='failed'
```

实现入口：`packages/core/src/modules/model-router.ts` 的 `DefaultModelRouter`；降级事件通过 `ObservabilityEmitter` 发出 `provider_fallback`。

#### v1 已实现：Phase 8 诊断信号（任务级最小信号）

```
触发：Phase 7 任意子任务以 status='failed' 结束
策略：Phase 8 validation 扫描 taskResults 的 status 字段，产出 ValidationResult.diagnosis = { type: 'execution_issue', failedTaskIds: [...] }
后续：诊断信号写入 EngineOutput.steps；编排控制面 ExecutionOrchestrator.switchToNextPlan 可在多方案场景下手动切换
注意：v1 并不会自动循环重试 Phase 7；automatic loop 留待 v2 引入。
```

#### v2 计划：自动重试循环

下列能力在 v2 设计 ADR（`docs/adr/decisions/000x-auto-retry-loop.md`）落地后再实现，**v1 不交付，文档不开放配置**：

- 系统级 ×2 重试（同 Provider 内重试，再降级）
- 任务级 ×3 重试（Phase 8 诊断为 `execution_issue` → 自动重走 Phase 7）
- `planning_issue` 自动 `switchToNextPlan` + Phase 5 重新拆分
- 重试间的副作用幂等判定（基于 `ExecutionTraits.idempotent` + `BackendInput.idempotencyKey`）

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

  // —— 取消传播（v1 必需）
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

  // —— 运维 / 状态查询（v1 必需）
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
  activePlan: RankedPlan | null;
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

**实现备注**：默认实现 `DefaultModelRouter`（`packages/core/src/modules/model-router.ts`）每次 `checkCapabilities` 都会重新拉取 Provider 的 `listAvailableModels()`，**v1 不做模型清单缓存**；v2 计划增加按 `provider.id` 的 in-memory 缓存（命中过期 30s）。

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

**Provider 降级**：

- 引擎维护有序 Provider 列表
- 系统级异常触发时按顺序切换
- 降级事件写入可观测性追踪

### 9.6 安全模块

```typescript
interface SafetyModule {
  /**
   * 基线检查：v1 含 5 项硬编码规则（详见下表），不可禁用。
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

业务策略支持 input / execution / output 三个 scope，分别在 Phase 2 (Safety) / Phase 7 (Execution 调用 Tool 前) / Phase 9 (Output) 触发。

### 9.7 可观测性

```typescript
interface ObservabilityEmitter {
  emit(event: EngineEvent): void;
}

interface EngineEvent {
  timestamp: number;
  traceId: string;
  sessionId: string;
  type: EventType;
  phase: string;
  payload: Record<string, unknown>;
}

type EventType =
  | 'phase_enter' | 'phase_exit'
  | 'llm_call_start' | 'llm_call_end'
  | 'tool_call_start' | 'tool_call_end'
  | 'error'
  | 'retry'
  | 'provider_fallback'
  | 'budget_warning' | 'budget_exhausted';
```

**双通道消费**：

| 通道 | 消费方式 | 用途 |
| --- | --- | --- |
| 实时进度流 | 订阅 `ObservabilityEmitter`，过滤关键事件推送 | UI 展示 |
| 结构化追踪 | 全量事件写入 Trace Log | 排查/审计 |

**脱敏**：引擎在 `emit` 前调用已注册的脱敏 Hook，业务注入脱敏策略。

### 9.8 Hooks

```typescript
interface HookRegistry {
  /**
   * 注册只读订阅 Hook。返回取消函数（调用即移除）。
   * 适用于审计、日志、metrics 收集等"不影响流程"的场景。
   */
  subscribe(
    point: HookPoint,
    handler: SubscribeHandler,
    options?: HookOptions,
  ): () => void;

  /**
   * 注册可写 Hook。返回取消函数（调用即移除）。
   * 可通过 HookAction 修改主流程数据、批准/拒绝执行、替换内容等。
   */
  register(
    point: HookPoint,
    handler: RegisterHandler,
    options?: HookOptions,
  ): () => void;
}

interface HookOptions {
  id?: string;          // 用于排查（事件日志中显示）；同 point 同 id 视为更新
  priority?: number;    // 数字升序执行（同 point 内）；默认 100
  timeout?: number;     // 单次 Hook 执行超时 ms，覆盖 EngineConfig.hooks.writeHookTimeout
}

type SubscribeHandler = (event: HookEvent) => void;                   // 只读，不阻塞
type RegisterHandler = (event: HookEvent) => Promise<HookAction>;     // 可写，可修改流程

type HookAction =
  | { type: 'continue' }                        // 默认值；保持原有数据流
  | { type: 'abort'; reason: string }           // 立即中止当前执行（throw EngineError）
  | { type: 'approve' }                         // 显式放行需要审批的操作（适用于 beforeExecution 的 requiresApproval=true Tool）
  | { type: 'deny'; reason: string }            // 显式拒绝需要审批的操作（同上）
  | { type: 'modify'; patch: Record<string, unknown> }   // 浅合并 patch 到事件 data
  | { type: 'replace'; data: unknown }          // 用 data 整体替换事件 data
  | { type: 'enrich'; data: Record<string, unknown> };   // 仅向 metadata 追加字段（不影响 data）
```

**HookAction 与 HookPoint 的适用矩阵**：

| HookPoint | 适用 Action 类型 | 备注 |
| --- | --- | --- |
| `beforeSafetyCheck` / `beforeIntentAnalysis` / `beforePreCheck` / `beforePlanning` / `beforeExecution` / `beforeValidation` / `beforeOutput` | `continue` / `abort` / `modify` / `replace` / `enrich` | 可改 phase 输入（input/messages/plan/...）|
| `beforeExecution` | 额外支持 `approve` / `deny`（仅当目标 task 的 ToolDescriptor 标注 `requiresApproval: true` 时） | 业务在此实现"工具调用前用户审批" |
| `afterSafetyCheck` / `afterIntentAnalysis` / `afterPreCheck` / `afterPlanning` / `afterExecution` / `afterValidation` / `afterOutput` | `continue` / `abort` / `enrich` | 通常不应改 phase 输出，仅做审计；`enrich` 用于追加 metadata |

`subscribe` 注册的 Hook 始终视为 `continue`（其返回值被忽略）。

**运行约束**：

- 同 point 内按 `priority` 数字**升序**执行；缺省 priority = 100
- 可写 Hook 默认超时 = `EngineConfig.hooks.writeHookTimeout`（5000ms），可由 `HookOptions.timeout` 覆盖；超时按 `EngineConfig.hooks.failureBehavior` 处理（`'continue'` 当作 `{ type: 'continue' }` 跳过，`'abort'` 抛 `TimeoutError.hook(...)`）
- 单个 Hook **抛错时**不中断主干（默认）：错误被捕获并通过 `ObservabilityEmitter` 发出 `error` 事件 `{ type: 'hook_failed', hookId, point, cause }`；后续 Hook 与主流程继续
- 当 `failureBehavior === 'abort'` 时：超时 / 抛错都会立即中止整次执行
- 执行顺序：引擎安全基线 → 引擎内置 Hook → 业务注册 Hook（按 priority 升序合并）
- 安全阶段结论对后续 Hook 只读（`afterSafetyCheck` 之后任何 Hook 修改 `safetyResult.passed` 都将被忽略）

**取消注册**：

```typescript
const unregister = hooks.register('beforeExecution', myApproval);
// ... 业务逻辑 ...
unregister(); // 等价于 hooks.unregister('beforeExecution', myApproval)
```

旧版 `unsubscribe(point, handler)` API 仍保留向后兼容，但推荐使用注册时返回的取消函数。

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
| 长期记忆 | 跨会话历史 | 意图分析阶段 |

**层级实现**：

- 引擎核心：只定义 `VectorStore` 接口 + 内置轻量实现 `InMemoryVectorStore`（`packages/core/src/vector/in-memory-store.ts`），单进程内存、开箱即用、生产慎用
- 扩展库：`packages/extensions/src/vector/` 提供 `LocalFsVectorStore`（持久化到 JSON）与 `QdrantVectorStore`（生产推荐）两种 Adapter
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
  tokenizer: Tokenizer;                      // Token 计数器（v1 默认 tiktoken，详见 §11.4）

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

**v1 内置实现**：`packages/core/src/prompt/tokenizer.ts` 提供 `createTiktokenTokenizer(model: string)` 工厂；模型名 → encoding 选择策略如下：

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
    providerFallbackOrder: string[];                // Provider 降级顺序（如 ['openai', 'anthropic']）
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

> **v1 与历史草案的差异**：早期草案曾将顶级键划分为 `retry / planning / agent / context / execution / storage` 等。该草案在 v1 实现中被废弃，理由：
>
> 1. 任务级 / 系统级重试循环在 v1 不实现（详见 §8.1），故移除 `retry` 顶级键；
> 2. `planning.planCount` 在 v1 固定为 1（单方案），未提供切换开关；
> 3. `agent.maxNestingDepth` 合并入 `safety.maxRecursionDepth`；
> 4. `context.compressionStrategy` 由内置策略硬编码，不暴露替换接口；
> 5. `execution.defaultTimeout` 重命名为 `runtime.defaultTaskTimeoutMs`；
> 6. `storage.archive / storage.vector` 改为依赖注入（`createEngine` 第二参数），不再走配置文件。
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
