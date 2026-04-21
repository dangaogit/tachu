# ADR 0002 — 引入 `tool-use` 内置 Sub-flow：完整 Agentic Loop

- Status: Accepted
- Date: 2026-04-20
- Target Release: `1.0.0-alpha.1`
- Applies to: `@tachu/core`, `@tachu/extensions`, `@tachu/cli`
- Complements: [ADR-0001](./0001-direct-answer-as-builtin-subflow.md)（`direct-answer` 保留不变）
- Supersedes: `architecture-design.md` §七「alpha 过渡态说明（complex-matched 分支）」—— 由机械组合升级为真正的 LLM-driven tool-use loop

## 背景

ADR-0001 落地了「Phase 1-9 主干同构 + `direct-answer` 兜底」，但**复杂任务路径（`complexity === 'complex'` 且注册表中存在可用工具）在此之前仍是占位实现**：

```ts
// packages/core/src/engine/phases/planning.ts:67-76
const candidateTools = env.registry.list("tool");
if (candidateTools.length > 0) {
  tasks = candidateTools.slice(0, COMPLEX_TOOL_PLAN_LIMIT).map((tool, index) => ({
    id: `task-tool-${index + 1}`,
    type: "tool",
    ref: tool.name,
    input: { prompt },           // ← 无结构化参数
  }));
}
```

这条"盲取前 3 个工具、用 `{ prompt }` 喂进去"的分支无法承担真实 Agent 能力：

1. **LLM 没有选择权**：Planning 阶段的工具顺序完全由 `registry.list("tool")` 的注册顺序决定，LLM 根本不参与 tool selection。用户输入 `"使用 fetch-url 总结 https://..."` 时，真正被执行的是 `read-file / write-file / list-dir`（注册顺序前三），`fetch-url` 排第 5，永远进不了 plan。
2. **参数无法生成**：`TaskNode.input = { prompt }` 不符合任何工具的 `inputSchema`（如 `read-file` 需要 `path`、`fetch-url` 需要 `url`），执行必然失败 schema 校验或产生无意义结果。
3. **工具结果无法回灌 LLM**：即便工具侥幸执行成功，Phase 9 的 `output.ts` 也只是把 `taskResults` 序列化成 JSON 交差，不会再喂回 LLM 做总结或决定下一步。
4. **Provider 能力浪费**：`OpenAIProviderAdapter` / `AnthropicProviderAdapter` 早就实现了 `tools` 参数映射与流式 `tool_calls` 解析（见 `packages/extensions/src/providers/openai.ts:279, 374`），但引擎主干**从未在 `ChatRequest` 里填 `tools`，也从未消费响应里的 `tool_calls`** —— `ChatResponse` 只保留了 `content` 字段，结构化 tool call 信息在 adapter 层被直接丢弃。
5. **Prompt 层事倍功半**：`PromptAssembler` 会把工具描述以**纯文本**形式塞进 system prompt（`renderSystemPrompt({ tools })`），LLM 只能用自然语言假装自己"调用了工具"，引擎既无法解析也不会执行，呈现给用户就是"未能成功总结"这类幻觉式答复。

结果：**引擎注册了 7 个真实可用的工具、3 个具备 function-calling 能力的 Provider，却没有任何一条用户请求能触发真正的 LLM-driven tool use**。

## 决定

新增一个内置 Sub-flow `tool-use`，承载完整的 Agentic Loop：**LLM 自主选择工具 → 引擎结构化执行 → 工具结果回灌 → 再次 LLM 推理 → 直至 LLM 输出终版自然语言答复或命中终止条件**。整条循环封装在单个 Phase 7 子任务内，不破坏现有 9 阶段主干。

### 决定 1：扩展 Provider Adapter 协议，让 `ChatResponse` 携带结构化 `tool_calls`

`@tachu/core` 的 `provider.ts` 扩展：

```ts
// packages/core/src/types/message.ts（新增）
export interface ToolCallRequest {
  id: string;                              // provider 返回的 call id（tool_call_id）
  name: string;                            // 工具名（对齐 ToolDescriptor.name）
  arguments: Record<string, unknown>;      // 已解析为对象的参数（LLM 常返回 JSON 字符串，adapter 负责 parse）
}

// packages/core/src/modules/provider.ts（扩展 ChatResponse）
export interface ChatResponse {
  content: string;
  toolCalls?: ToolCallRequest[];           // NEW：LLM 请求的工具调用；未请求则为空数组或 undefined
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | string;  // NEW
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ChatStreamChunk 扩展为 tagged union
export type ChatStreamChunk =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool-call-complete"; call: ToolCallRequest }
  | { type: "finish"; finishReason: string; usage?: ChatResponse["usage"] };
```

`@tachu/extensions` 对应改造：

- `openai.ts::chat`：从 `response.choices[0]?.message?.tool_calls` 解析，`arguments` 用 `JSON.parse` + try-catch，失败单独抛 `ProviderError.toolCallArgumentsInvalid(name, raw, err)`
- `openai.ts::chatStream`：按 `index` 聚合 `tool_calls` 分片（provider 通过 index 投递），在 `finish_reason === 'tool_calls'` 时发射 `tool-call-complete` 事件；**删除当前把 tool_call 塞进 `delta: JSON.stringify(...)` 的临时 hack**
- `anthropic.ts`：对齐 `content.blocks` 里 `type === 'tool_use'` 的块，提取 `id / name / input`；`finish_reason` 映射 `end_turn` / `tool_use` / `max_tokens`
- `mock.ts`：新增可配置的 `toolCalls` 脚本位，便于测试断言 `tool-use` 循环

**向后兼容**：`content` / `usage` 字段保留不变；`toolCalls` / `finishReason` 为可选字段，老消费者（如 `direct-answer`）无感知。

### 决定 2：新增内置 Sub-flow `tool-use`（`packages/core/src/engine/subflows/tool-use.ts`）

与 `direct-answer.ts` 同级注册到 `InternalSubflowRegistry`，`reservedNames` 增补 `tool-use`。执行契约：

```ts
export interface ToolUseInput {
  prompt: string;                          // 来自 Phase 5 的 intent 摘要
  hint?: string;                           // 宿主附加指令（如角色、语气）
}

export interface ToolUseContext {
  config: EngineConfig;
  providers: Map<string, ProviderAdapter>;
  modelRouter: ModelRouter;
  memorySystem: MemorySystem;
  observability: ObservabilityEmitter;
  signal: AbortSignal;
  traceId: string;
  sessionId: string;
  prebuiltPrompt: AssembledPrompt;         // 必填：带有 ToolDefinition[] 的完整 Prompt
  taskExecutor: (
    task: TaskNode,
    context: ExecutionContext,
    signal: AbortSignal,
  ) => Promise<unknown>;                    // 由 Engine 从主干注入；见决定 3
  onProviderUsage?: (usage: ChatResponse["usage"]) => void;
  onToolCall?: (record: ToolCallRecord) => void;  // 记入 OutputMetadata.toolCalls
}
```

核心循环（伪代码）：

```ts
export async function executeToolUse(
  input: ToolUseInput,
  ctx: ToolUseContext,
): Promise<string> {
  const messages: Message[] = [...ctx.prebuiltPrompt.messages];
  const tools: ToolDefinition[] = ctx.prebuiltPrompt.tools;
  const route = resolveRoute(ctx.modelRouter); // 优先 "tool-use"，回退 "high-reasoning" → "fast-cheap"
  const adapter = ctx.providers.get(route.provider)!;

  const maxSteps = ctx.config.execution.toolLoopMaxSteps ?? 16;
  const parallelBudget = ctx.config.execution.toolLoopParallelism ?? 4;

  for (let step = 0; step < maxSteps; step++) {
    ctx.signal.throwIfAborted();

    const response = await adapter.chat(
      { model: route.model, messages, tools, tool_choice: "auto" },
      ctx.signal,
    );
    ctx.onProviderUsage?.(response.usage);

    // 终止条件 A：无 tool_calls → LLM 给出终版文本
    if (!response.toolCalls || response.toolCalls.length === 0) {
      if (response.content.trim().length === 0) {
        throw EngineError.toolLoop.emptyTerminalResponse(step);
      }
      return response.content.trim();
    }

    // 写入 assistant 消息（含 tool_calls，Provider 适配器的 mapMessage 需支持）
    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });

    // 并行执行 tool_calls（上限由 parallelBudget 控制）
    const results = await mapLimit(response.toolCalls, parallelBudget, async (call) => {
      const task: TaskNode = { id: `step${step}:${call.id}`, type: "tool", ref: call.name, input: call.arguments };
      try {
        const output = await ctx.taskExecutor(task, toExecContext(ctx), ctx.signal);
        ctx.onToolCall?.({ name: call.name, success: true, durationMs: /* measured */ });
        return { call, output, success: true as const };
      } catch (err) {
        ctx.onToolCall?.({ name: call.name, success: false, errorCode: engineErrorCode(err) });
        // 关键：错误不抛出循环外，而是转成 tool_result 让 LLM 决定如何应对
        return { call, output: formatToolErrorForLLM(err), success: false as const };
      }
    });

    // 回灌 tool 消息
    for (const r of results) {
      messages.push({
        role: "tool",
        toolCallId: r.call.id,
        name: r.call.name,
        content: stringifyToolOutput(r.output),
      });
    }
  }

  // 终止条件 B：步数耗尽 → 让 LLM 在 no-tools 模式下做一次终结总结
  const finalResponse = await adapter.chat(
    { model: route.model, messages: [...messages, toolLoopBudgetExhaustedHint], tools: [] },
    ctx.signal,
  );
  ctx.onProviderUsage?.(finalResponse.usage);
  return finalResponse.content.trim();
}
```

关键性质：

1. **LLM 具有自主权**：每一步都可以选择调工具、并行调多个工具、或不调工具直接出答复
2. **工具错误不逃逸**：失败转为 `role: "tool"` 消息回灌，让 LLM 决定重试 / 换工具 / 放弃并向用户解释
3. **步数与并行度双预算**：`toolLoopMaxSteps` 默认 16，`toolLoopParallelism` 默认 4；超过即强制终结总结
4. **复用 Phase 7 gate**：循环内部的每次工具调用仍通过传入的 `taskExecutor` 执行，这意味着 `withDefaultGate` / 业务自定义 executor / `InternalSubflowRegistry` 全部生效（审批、沙箱、可观测一致）
5. **取消传播**：`ctx.signal` 由 Engine 的 last-message-wins 控制器注入，任意步可被外部打断
6. **Prompt 复用**：`prebuiltPrompt.messages` 和 `prebuiltPrompt.tools` 都来自主干 `PromptAssembler`，Rules / Skills / 记忆召回全部继承，子流程不重复拼装

### 决定 3：Phase 5（Planning）改造

修改 `packages/core/src/engine/phases/planning.ts`：

- `simple` 意图 → 不变，仍产出单步 `direct-answer` 子任务
- `complex` 意图 + **`registry.list("tool").length > 0`** → 产出单步 `{ type: 'sub-flow', ref: 'tool-use', input: { prompt: intentSummary } }`
- `complex` 意图 + **无任何工具** → 不变，仍产出 `direct-answer(warn=true)`

`COMPLEX_TOOL_PLAN_LIMIT` / 多步并行 Plan 的代码移除；**任务拆分不再尝试预选工具**，Plan 的"多步"在 `tool-use` 循环内部体现，Phase 5 的产物永远是单步。这与 ADR-0001 的"兜底契约"（`plans[0].tasks.length >= 1`）完全兼容。

> 为什么不在 Planning 阶段就调 LLM 做 tool-selection？
>
> 业界共识是「Agentic Loop 内 LLM 自主选工具」优于「Planning 期 LLM 一次性拆分」：
> - 多步决策在拿到前一步工具结果后会改变，一次性 Planning 常常白算
> - 循环式 step-by-step 更容易做审批 / 预算 / 取消
> - 错误处理路径对称（失败 = 回灌 tool_result，让 LLM 继续）
>
> 保留"LLM 显式 Plan 模式"作为未来能力（见架构文档 §七的 Plan 模式），用于业务**主动**要求预规划 + 人工审阅的场景；默认路径永远走 `tool-use` 循环。

### 决定 4：Engine 主干装配

`packages/core/src/engine/engine.ts`:

1. `INTERNAL_SUBFLOW_NAMES` 增加 `"tool-use"`；`InternalSubflowRegistry` 启动期注册 `executeToolUse`
2. `buildLayeredTaskExecutor` 在识别 `task.type === 'sub-flow' && ref === 'tool-use'` 时，**额外把业务 `taskExecutor` 作为 `ctx.taskExecutor` 注入**（`direct-answer` 不需要此字段）—— 这一步保持"子流程拿到的执行器就是主干外层 executor"，保证 `withDefaultGate` 等装饰器对循环内每次工具调用都生效
3. Phase 7 调度器把 `prebuiltPrompt` 传入 ctx（现有 `activeRunPrompts` 机制已就绪，无需新增）
4. `ExecutionOrchestrator.usedBudget` 累加来自 `tool-use` 的 token 消耗与工具调用次数；任一预算触顶抛 `BudgetExhaustedError`

### 决定 5：Config 扩展

`packages/core/src/types/config.ts` 的 `ExecutionConfig` 补：

```ts
export interface ExecutionConfig {
  // ...现有字段
  toolLoopMaxSteps?: number;               // 默认 16
  toolLoopParallelism?: number;            // 默认 4；1 表示严格串行
  toolLoopRequireApprovalGlobal?: boolean; // 默认 false；true 时所有工具统一走审批（叠加在 descriptor 的 requiresApproval 之上）
}
```

`capabilityMapping` 新增保留键 `"tool-use"`：缺省时回退到 `"high-reasoning"`（优先选推理强的模型做循环决策），再无则回退 `"fast-cheap"`（兜底）。

### 决定 6：流式输出事件扩展

`packages/core/src/types/io.ts` 的 `StreamChunk` 扩展：

```ts
export type StreamChunk =
  | { type: "progress"; phase: string; message: string }
  | { type: "delta"; content: string }
  | { type: "tool-call-start"; callId: string; toolName: string; arguments: Record<string, unknown> }  // NEW
  | { type: "tool-call-end";   callId: string; toolName: string; success: boolean; durationMs: number } // NEW
  | { type: "tool-loop-step"; step: number; maxSteps: number }                                         // NEW（可选，便于 CLI 展示进度）
  | { type: "artifact"; artifact: Artifact }
  | { type: "error"; error: EngineError }
  | { type: "plan-preview"; phase: "planning"; plan: RankedPlan }
  | { type: "done"; output: EngineOutput };
```

`@tachu/cli` 的 `stream-renderer.ts` 同步支持：工具调用事件渲染为可折叠的 `→ tool-name(args…)` / `✓ 123ms` 或 `✗ error-message` 段落，所有写/不可逆调用在渲染前插入审批 UI。

### 决定 7：错误体系扩展

`packages/core/src/errors/engine-error.ts` 增补 `EngineError.toolLoop` 族：

| Code | 含义 | 处置 |
|------|------|------|
| `TOOL_LOOP_MAX_STEPS_EXCEEDED` | 步数耗尽仍未收敛 | 进入"终结总结" 分支；输出 `status: 'partial'` |
| `TOOL_LOOP_EMPTY_TERMINAL_RESPONSE` | LLM 终止时 content 为空 | 交 honest-fallback；输出 `status: 'failed'` |
| `TOOL_LOOP_ARGUMENTS_INVALID` | Provider 返回的 `arguments` JSON 解析失败 | 单次重试（同一 step 不计入 maxSteps） |
| `TOOL_LOOP_UNKNOWN_TOOL` | LLM 请求了未注册的工具 | 转成 tool_result 错误消息回灌，让 LLM 换工具 |

所有错误都继承现有 `EngineError`，可观测事件使用 `phase: "tool-use"`。

## 不采取的方案

| 方案 | 简述 | 弃用原因 |
|------|------|----------|
| **A：扩展 Phase 5，使用 LLM 一次性预规划（Plan）+ Phase 7 顺序执行** | Phase 5 调 LLM 产出 `TaskNode[]` 依赖图，Phase 7 按图调度 | 真实 Agent 任务的多步决策依赖前一步结果，预规划成功率低；错误恢复链路冗长；审批 / 预算 / 取消的语义不如 per-step 对称 |
| **B：直接把 `direct-answer` 改造为会调工具的版本** | 复用 `direct-answer.ts`，在其内部加 tool_call 循环 | 违反 ADR-0001 的语义承诺（`direct-answer` 是"无工具纯回答"兜底）；合并后单一子流程承担两种质量契约，维护成本上升 |
| **C：把 Agentic Loop 写进 Engine 主干而非 Sub-flow** | 新增 Phase 7.5 "tool loop" | 破坏 9 阶段稳定性；Hook / Observability 事件分叉；与 ADR-0001 的"同构流水线"精神背离 |
| **D：只做 Planning 改造（LLM 选工具、生成参数），不做循环** | Phase 5 调 LLM 产出一步工具 + 参数，Phase 7 执行，Phase 9 总结 | 无法处理多步依赖（工具 A 的结果决定工具 B 参数）；工具失败无法回灌重试，体验比 `direct-answer(warn)` 强不了多少 |

## 影响

### 破坏性变更

1. **`ChatResponse` 新增可选字段 `toolCalls` / `finishReason`**：类型级非破坏（字段可选），但**依赖 `Object.keys(response).length === 2` 这类反射的消费者需要适配**（代码库内部搜索 `Object.keys\(.*Response.*\)` 确认无此模式后再确认无破坏）
2. **`ChatStreamChunk` 变为 tagged union**：旧形态 `{ delta: string; done?: boolean }` 被替换为 `{ type, ... }`。`@tachu/cli` 的 `stream-renderer.ts` 必须同步升级；外部宿主如果直接消费 `chatStream`，需迁移
3. **`INTERNAL_SUBFLOW_NAMES` 新增 `"tool-use"`**：业务若在 Registry 注册过 `tool-use` 同名描述符，启动期抛 `RegistryError.reservedName("tool-use")`
4. **Phase 5 complex-matched 分支语义改变**：从"盲取前 N 个工具直接执行"变为"委托 `tool-use` 子流程"。任何依赖"Phase 5 产出的 TaskNode 数 === 命中的工具数"这一隐性行为的测试需重写（代码库内部会一并更新）

### 非破坏性收益

- 用户输入 `"用 fetch-url 总结 https://..."` 真正触发 `fetch-url` 调用，而不是模型幻觉
- 多步任务（读文件 → 搜代码 → 改写 → 写回）成为可能
- 工具错误对用户可见、可追溯（事件流 + `OutputMetadata.toolCalls`），不再被静默吞掉
- MCP 工具（通过 `McpToolAdapter` 接入）自动获得 Agentic 能力，无需额外适配
- `withDefaultGate` 的审批 UX 终于有真实触发点（此前由于工具几乎不执行，审批 UI 从未实际出现）

### 性能影响

- **单次 complex 请求的 LLM 调用数**：从"1 次 Intent"升至"1 次 Intent + N 次 tool-use 循环（典型 2-5 次，上限 `toolLoopMaxSteps = 16`）"
- **成本控制手段**：
  - `toolLoopMaxSteps` 硬上限
  - `ExecutionOrchestrator` 的 token / 时间 / 工具调用数三维预算熔断
  - `capabilityMapping.tool-use` 独立模型配置，可选性价比更好的模型
  - 工具并行 (`toolLoopParallelism`) 缩短墙钟时间
- **与 `direct-answer` 的对比**：`simple` 请求路径完全不变，成本无增量

## 实现路线图

**阶段 1：协议与 Provider 改造（无行为变化，纯扩展）**

1. `@tachu/core`：`ChatResponse.toolCalls` / `finishReason` / `ChatStreamChunk` tagged union / `Message.toolCalls`
2. `@tachu/extensions`：OpenAI / Anthropic / Mock 三家 adapter 同步；`mapMessage` 支持序列化 `role: "assistant"` + `toolCalls` 和 `role: "tool"` + `toolCallId`
3. 单元测试：Mock adapter 模拟 tool_calls 分片、完整、错误参数三种场景；OpenAI 测试用 recorded HTTP fixtures

**阶段 2：`tool-use` Sub-flow 落地**

1. `packages/core/src/engine/subflows/tool-use.ts` + 注册到 `InternalSubflowRegistry`
2. `INTERNAL_SUBFLOW_NAMES` 增补
3. `buildLayeredTaskExecutor` 注入 `ctx.taskExecutor`
4. Engine 测试：Mock adapter 脚本化 3 步循环（调工具 → 回灌 → 终止），断言工具执行次数、最终文本、可观测事件、usage 累加

**阶段 3：Phase 5 切换**

1. 删除 `COMPLEX_TOOL_PLAN_LIMIT` 相关逻辑
2. complex-matched 分支改为单步 `tool-use`
3. 回归测试：确认 `fallback-contract.test.ts` 全绿；新增 `planning.test.ts` 覆盖"有工具 → tool-use"、"无工具 → direct-answer(warn)"两分支

**阶段 4：CLI 体验层**

1. `stream-renderer.ts` 适配新 `StreamChunk` 类型；`tool-call-start/end` 渲染为折叠块
2. 审批 UX：对 `requiresApproval: true` 的工具，在 `tool-call-start` 事件上拦截，终端内 y/N 确认
3. 集成测试：`run-cmd.integration.test.ts` 新增 "LLM 选择 fetch-url 并抓取 URL" 场景（用 Mock Provider + mock HTTP server 模拟）

**阶段 5：文档同步**

1. `architecture-design.md` §七 alpha 过渡态段落移除，替换为 `tool-use` 循环说明
2. `detailed-design.md` 新增 §7.12 "`tool-use` Sub-flow 执行规格"
3. `technical-design.md` §3.2 / §4.4 更新协议契约
4. `CHANGELOG.md` `1.0.0-alpha.1` 条目

## 回滚策略

- 回滚代码路径：还原 Phase 5 的 `COMPLEX_TOOL_PLAN_LIMIT` 分支 + 从 `InternalSubflowRegistry` 移除 `tool-use` 条目
- **协议字段保留**（`ChatResponse.toolCalls` / `ChatStreamChunk` union）：字段级别无需回滚，只要主干不消费即可，未来可独立复用
- 业务宿主的兼容：若外部宿主已依赖 `tool-use` 循环，回滚需同步降级；回滚公告至少提前一个 release 通过 `@deprecated` 标注

## 关联文档

- [ADR-0001](./0001-direct-answer-as-builtin-subflow.md) — `direct-answer` 内置 Sub-flow 的原始契约（本 ADR 与其对称，共同构成 Phase 7 的两个内置子流程）
- 架构设计 `docs/adr/architecture-design.md` §七（主干流程）、§三（Tools 抽象）
- 详细设计 `docs/adr/detailed-design.md` §7.11（`direct-answer` 执行规格，作为 `tool-use` 的对称参考）
- 技术设计 `docs/adr/technical-design.md` §3.2（ProviderAdapter 协议）、§4.4（任务执行）
- 相关源码：
  - `packages/core/src/engine/phases/planning.ts` — 待改造
  - `packages/core/src/engine/subflows/direct-answer.ts` — 对称参考
  - `packages/extensions/src/providers/openai.ts` — `tool_calls` 解析的现有半成品
  - `packages/core/src/prompt/assembler.ts` — `AssembledPrompt.tools` 已就绪
