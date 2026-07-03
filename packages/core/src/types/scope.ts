import type { ModelRoute } from "./config";
import type {
  RuleDescriptor,
  SkillDescriptor,
  ToolDescriptor,
} from "./descriptor";

/**
 * 每次 `Engine.runStream` / `Engine.run` 的会话级动态配置。
 *
 * 设计意图：Engine 自身保持单例 + 默认配置；会话层
 * 通过本结构把 per-call / per-session 的动态项叠加进当前这一轮执行，不污染单例
 * 状态、不影响并发会话。
 *
 * 字段语义：
 * - `systemInstruction`：替换 PromptAssembler 默认的 "You are Tachu Engine runtime..."
 * 段，承载宿主侧拼装好的 system prompt（如全局 prompt + agent 指令 + session 后缀）。
 * 未提供时回退默认值，与现有行为一致。
 * - `additionalRules` / `additionalTools`：与 `registry.list(...)` **取并集**后传给
 * PromptAssembler。registry 里跨会话的全局基线（如 safety rule）始终生效，session
 * 只**叠加**自己的本轮项；不是替换语义。
 * - `additionalSkills`（ **breaking**）：作为 snapshot-refs 输入；列出的 skill
 * 进入 T0 pinned。Registry 中存在但不在 `additionalSkills` 内的 skill 不再无条件
 * active，需由 retrieval 或 sticky 决定 tier。
 * - `modelOverride`：覆盖 ModelRouter 解析能力标签 → ModelRoute 的结果。`byCapability`
 * 按 tag 精确覆盖；`all` 是简写——对所有 tag 一并覆盖。`byCapability` 优先级高于
 * `all`；都未覆盖的 tag 仍走 `EngineConfig.models.capabilityMapping`。
 *
 * 不放进本结构的（刻意的设计边界）：
 * - `memorySystem` —— 多轮一致性靠按 sessionId 分片，不允许 per-call 替换；
 * - `safetyModule` —— 安全策略应跨 session 一致，不允许 per-call 绕过；
 * - `budget` —— 已经在 `ExecutionContext.budget` 通道里，无需重复；
 * - `onBeforeToolCall` —— 审批回调是 Engine 构造期一次性注入；按 session 切换的需求
 * 暂未出现，避免过早扩面。
 */
export interface SessionScope {
  systemInstruction?: string;
  additionalRules?: RuleDescriptor[];
  additionalSkills?: SkillDescriptor[];
  additionalTools?: ToolDescriptor[];
 /**
 * Host-provided stable id factory for public stream objects. The host application
 * injects its stable-id factory here so reasoning step ids and usage attribution ids
 * keep the public 19-digit id contract.
 */
  idFactory?: () => string;
  modelOverride?: {
 /** 按 capability tag 精确覆盖；未列出的 tag 仍走 `EngineConfig.models.capabilityMapping`。 */
    byCapability?: Record<string, ModelRoute>;
 /** 简写：所有 capability tag 统一覆盖；优先级低于 `byCapability`。 */
    all?: ModelRoute;
  };
 /**
 * When true, ToolActivator bypasses all strategies and exposes the full agentVisibleTools set.
 * Derived by host from agent descriptor `intentRouting.enabled === false`.
 */
  toolRoutingDisabled?: boolean;
 /**
 * Per-turn agent context the host may inject for tool/skill activation hints
 * (e.g. persona summary and visible tool/skill menus). Purely deterministic
 * host gating input — there is no intent-LLM step (see `HostPolicyToolStrategy`).
 */
  activationHints?: {
    systemInstruction?: string;
    tools?: Array<{ name: string; description: string }>;
 /** Agent-visible skills for gating-policy hints (name + description + optional tags). */
    skills?: Array<{ name: string; description: string; tags?: string[] }>;
  };
 /**
 * Host-detected explicit tool invocation (e.g. user wrote "use image.qwen").
 * Planning forces tool-use with these names even when intent is simple.
 */
  explicitToolNames?: string[];
  /**
   * Host-detected explicit skill invocation (e.g. `/chart-output`, @mention, UI pick).
   * Copied to gatingPolicy.explicitSkills during gating normalization; highest pin priority.
   */
  explicitSkillNames?: string[];
  /**
   * 本轮被显式点名的 rule 名称(与 `explicitSkillNames` 对称)。
   *
   * 仅 `activation.mode === "manual"` 的规则在命中此集合时才注入 prompt;
   * `always` 规则始终注入、`manual` 规则未命中则不注入。承载 `@rule` 手动引用、
   * UI 勾选等宿主侧显式激活信号。
   */
  explicitRuleNames?: readonly string[];
}
