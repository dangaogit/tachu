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
  /**
   * 按回合传入、由宿主作用域（如 tenant + user）解析的技能发现 + 加载 provider。
   *
   * 存在的意义：让原生的 `search_skills` / `load_skill` / `read_skill_resource`
   * 与 "Available Skills" 索引能由**宿主**提供数据源，而**不写入进程级共享
   * `registry`**——从而天然避免跨租户/跨会话泄漏与无界累积。三个通道各自独立、
   * 全部可选；任一缺省时对应机制退回「仅 registry」的既有行为，完全向后兼容。
   *
   * 语义分层（对齐渐进式披露三层模型）：
   * - `list`（L2 索引）：只回 name+description(+tags)，并入本轮 `availableSkills`
   *   候选池，仅作为「可发现目录」呈现（元数据级），**不自动激活**、不注入正文。
   * - `search`（L2 检索）：`search_skills` 工具的后端；结果与 registry 命中**取并集、
   *   按 name 去重**后返回。仅当 `runtime.enableSearchSkillsTool === true`（工具已暴露）
   *   时生效。
   * - `load`（L3 正文）：`load_skill` / `read_skill_resource` 在 `registry.get` 未命中
   *   时的回落解析入口，用于把某个技能的完整正文/资源按需取回。
   *
   * 隔离保证：provider 仅在本轮执行内被消费（按 traceId 作用域），回合结束即释放；
   * 并发的其它 runStream（未传或传入各自 provider）互不可见。
   *
   * 生命周期备注：`load` 取回的技能是否**跨回合**持续 Active（sticky 再物化）属于
   * 尚未拍板的产品/架构决策（见交接文档 §7.1 L3 语义、§7.2 生命周期）。当前实现为
   * 「按回合解析」：命中即在本轮返回正文；跨回合再物化不在此改动范围内。
   */
  skillDiscovery?: SkillDiscoveryProvider;
}

/** {@link SkillDiscoveryProvider.list} 的返回项：技能元数据（L2 索引）。 */
export interface SkillDiscoveryEntry {
  name: string;
  description: string;
  tags?: string[] | undefined;
}

/** {@link SkillDiscoveryProvider.search} 的返回项：带相关性分数的命中。 */
export interface SkillDiscoverySearchHit {
  name: string;
  description: string;
  score: number;
}

/**
 * 宿主提供的按回合、租户/用户作用域的技能发现 + 加载 provider。
 *
 * 三个方法全部可选；见 {@link SessionScope.skillDiscovery} 的分层语义说明。
 */
export interface SkillDiscoveryProvider {
  /** L2 索引：仅回 name+description(+tags)，并入 availableSkills（不自动激活）。 */
  list?: () => Promise<SkillDiscoveryEntry[]>;
  /** `search_skills` 后端：与 registry 结果取并集、按 name 去重。 */
  search?: (query: string, topK?: number) => Promise<SkillDiscoverySearchHit[]>;
  /** L3 正文：`registry.get("skill", name)` 未命中时回落到此解析完整描述符。 */
  load?: (name: string) => Promise<SkillDescriptor | null>;
}
