# ADR 0001 — 直接回答统一下沉为内置 Sub-flow

- Status: Accepted
- Date: 2026-04-17
- Target Release: `1.0.0-alpha.1`
- Applies to: `@tachu/core`, `@tachu/extensions`, `@tachu/cli`
- Supersedes: 概要设计 §七（"快速通道"相关描述）、详细设计 §7.2（`IntentResult.directAnswer` 字段）

## 背景

本 ADR 之前的原型实现曾在 Phase 3（意图分析）直接让 LLM 产出 `directAnswer`，并在 Engine 主流程中对 `complexity === 'simple'` 的请求跳过 Phase 4–8，直通 Phase 9 输出。该设计带来了两个长期隐患：

1. **职责越界**：Phase 3 被要求同时做"分类 + 产出最终答复"，System Prompt 约束急剧膨胀，且 creative 类请求（"写代码"、"写教案"、"讲笑话"）在模型不严格遵守 JSON 协议时，整条响应被视为解析失败，回落到 `"已识别请求：xxx"` 的模板字符串。
2. **架构异构**：simple 路径绕过前置校验、依赖图校验、结果验证、预算记账、Hook 扩展、可观测事件，最终使"同一套引擎"在两条路径上呈现出两种质量保障基线。业务在 simple 路径上挂载 Rules / Policies / Observer 会出现"看似挂上实则不生效"的哑失败。

## 决定

将"直接回答"**下沉为引擎内置 Sub-flow** `direct-answer`，并让所有请求统一穿过 Phase 1–9：

1. **Phase 3 纯分类化**：`IntentResult` 精简为 `{ complexity, intent, contextRelevance, relevantContext? }`，不再包含 `directAnswer` 字段。`INTENT_SYSTEM_PROMPT` 同步删除答复产出约束，保留复杂度判定规则与 few-shot 示例。
2. **Phase 5 兜底契约**：任务拆分阶段必须输出 `plans[0].tasks.length >= 1`。`simple` 意图或 `complex` 未匹配到工具/模板时，引擎构造单步 Plan：`{ type: 'sub-flow', ref: 'direct-answer', input: { prompt, warn? } }`。
3. **内置 Sub-flow 保留名**：`Registry` 在启动期通过 `reservedNames` 机制将 `direct-answer` 锁定为引擎保留名；业务侧任何 `register('xxx', { name: 'direct-answer', ... })` 或 `unregister('xxx', 'direct-answer')` 都会抛 `RegistryError.reservedName('direct-answer')`。**关键点**：`direct-answer` **不进入** `DescriptorRegistry` 的四类 descriptor 表（Rules / Skills / Tools / Agents），而是由独立的 `InternalSubflowRegistry`（`packages/core/src/engine/subflows/registry.ts`）维护执行函数。
4. **独立执行通道**：引擎新增 `InternalSubflowRegistry`，持有内置 Sub-flow 的执行函数；默认 `TaskExecutor`（通过 `buildLayeredTaskExecutor` 组合）识别 `task.type === 'sub-flow' && InternalSubflowRegistry.has(task.ref)` 时转交 `InternalSubflowRegistry.execute`；未命中再回落到业务/默认 TaskExecutor。业务自定义 `TaskExecutor` 通过引擎暴露的 helper（`createLayeredTaskExecutor(fallback)`）委托到同一通道。
5. **Phase 9 输出简化**：从 `taskResults['task-direct-answer']` 提取 `content` 作为主体；执行失败时回落到 Phase 8 既有的 honest-fallback 文案。

## 不采取的方案

| 方案 | 简述 | 弃用原因 |
| --- | --- | --- |
| A：保留 `directAnswer` 字段但改由 Phase 9 装配 | Phase 3 依旧产答复，Phase 9 收口 | 未解决架构异构问题；Rules/Hooks 对 simple 路径仍失效 |
| C：新增独立 Phase `direct-answer`，与 Phase 7 并列 | 不走 Sub-flow，新增一条专用阶段 | 破坏阶段编号稳定性，且语义与"任务执行"等价，会导致 Hook 集合/Observability 事件分叉 |

## 影响

### 破坏性变更

- `IntentResult.directAnswer` 字段移除（类型级 breaking）
- 业务若在 `Registry` 中注册过 `direct-answer` 同名描述符，将在启动期抛 `RegistryError.reservedName`；需改名
- 默认 `TaskExecutor` 行为变化：`sub-flow` 任务优先路由到 `InternalSubflowRegistry`

### 性能影响

- `simple` 请求从"一次 Phase 3 LLM 调用"升级为"Phase 3 分类 + Phase 7 direct-answer LLM 调用"两次 LLM 往返
- 对应的 Phase 4/5/6/8 均为纯确定性逻辑（前置校验、单步拆分、单节点依赖图校验、结构化验证），开销 < 5ms
- 推荐将 `capabilityMapping.intent` 与 `capabilityMapping.fast-cheap` 配置为同一低价模型以降低成本

### 非破坏性收益

- Rules / Policies / Hooks / Observability 在 `simple` 路径上与 `complex` 路径完全等效
- 预算熔断机制覆盖所有请求
- Phase 3 可以在后续迭代引入"轻量分类模型"（如微调小模型），进一步压缩 intent 分类的成本与延迟，而无需担心影响答复质量

## 回滚策略

- 将 Phase 5 兜底分支短路为直接返回空 `taskResults`，并在 Phase 9 使用旧逻辑拼接 `"已识别请求：xxx"` 文案
- `InternalSubflowRegistry` 保留，仅停用 `direct-answer` 条目
- `Registry` 保留名机制可独立保留，与回滚无耦合

## 关联文档

- 概要设计 `docs/adr/architecture-design.md` §七、§八
- 详细设计 `docs/adr/detailed-design.md` §7.1–§7.4、§7.11
- 技术设计 `docs/adr/technical-design.md` §3.2、§4.2–§4.4
- CHANGELOG `1.0.0-alpha.1` 条目
