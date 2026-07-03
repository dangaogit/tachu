/**
 * 表示可注册实体的显式依赖。
 */
export interface DependencyRef {
  kind: "rule" | "skill" | "tool" | "agent";
  name: string;
}

/**
 * 描述符触发条件。
 */
export type TriggerCondition =
  | { type: "always" }
  | { type: "semantic" }
  | { type: "explicit" };

/**
 * 四类描述符共享的最小公共元信息。
 */
export interface BaseDescriptor {
  name: string;
  description: string;
  version?: string | undefined;
  displayName?: string | undefined;
  deprecated?: boolean | undefined;
  deprecatedMessage?: string | undefined;
  tags?: string[] | undefined;
  trigger?: TriggerCondition | undefined;
  requires?: DependencyRef[] | undefined;
}

/**
 * Rule 激活条件——回答「规则正文**何时**被注入 prompt」,即激活轴。
 *
 * 关键约束:Rule 的唯一产物是 prompt 文本,终点永远是 prompt。它**不是**
 * 生命周期挂载点:block / annotate / validate / modify 这类阶段动作属于
 * `HookPoint` / `Guardrail` / `ValidationRule`,由它们承担,绝不由 Rule 表达。
 * (旧的 `turnStart`/`preLLM`/`turnStop` 生命周期式 scope 已废弃——那是把
 * rule 与 hook 混为一谈。)
 *
 * 语义对齐业界 rule 系统(Cursor / Copilot / Continue / Cline …)的激活模型:
 * - `always`:总是注入(对应 Cursor `alwaysApply: true`)。
 * - `manual`:仅当本轮被显式点名(`SessionScope.explicitRuleNames`)时注入
 *   (对应 `@rule` 手动引用)。
 * - `semantic`:由调用方依据 `description` 判定语义相关后注入(对应
 *   agent-requested);缺省无活跃集时 fail-closed 不注入。
 * - `path`:当命中 `globs` 的文件出现在本轮上下文时注入(对应 `globs` 自动附着)。
 */
export type Activation =
  | { mode: "always" }
  | { mode: "manual" }
  | { mode: "semantic" }
  | { mode: "path"; globs: readonly string[] };

export type RuleActivation = Activation;

/**
 * Rule 描述符。
 */
export interface RuleDescriptor extends BaseDescriptor {
  kind: "rule";
  type: "rule" | "preference";
  activation: RuleActivation;
  content: string;
}

/**
 * Skill 资源声明（agentskills.io 目录约定）。
 *
 * `path` 自带目录前缀（`scripts/x.py` / `references/y.md` / `assets/z.md`），
 * 前缀本身即类型信息——不再有单独的 `type` 字段。由 loader 在加载时扫描技能
 * 目录下的 `scripts/` `references/` `assets/` 子目录自动生成，不接受
 * frontmatter 手写声明。
 */
export interface SkillResource {
  path: string;
}

/**
 * Skill 描述符。
 *
 * `license` / `compatibility` / `metadata` / `allowedTools` 对应
 * agentskills.io 规范的可选 frontmatter 字段（`license` / `compatibility` /
 * `metadata` / `allowed-tools`）。前三者仅透传存储，不接行为；`allowedTools`
 * 在该 skill 处于 Active Skill 状态期间驱动工具调用的预授权豁免
 * （见 tool-use 子流程 `isSkillAllowedToolsMatch`）。
 */
export interface SkillDescriptor extends BaseDescriptor {
  kind: "skill";
  instructions: string;
  resources?: SkillResource[] | undefined;
 /** Loader 写入的 SKILL.md 所在目录（供 read_skill_resource 解析路径）。 */
  sourceDir?: string | undefined;
  license?: string | undefined;
  compatibility?: string | undefined;
  metadata?: Record<string, string> | undefined;
 /** 对应 frontmatter `allowed-tools`：预授权的工具调用模式列表。 */
  allowedTools?: string[] | undefined;
}

/**
 * 数据来源分类。用于驱动 `normalizeExternalSourceRefs` 的确定性
 * 归一化路径，避免在 evidence 流水线里再做关键词匹配。
 *
 * - `"internal"`（缺省）：工具/智能体仅读取或修改本地工程内的数据，
 * 不引入外部世界事实（例如 read-file / write-file / run-shell 本地任务）。
 * - `"external"`：工具/智能体会从 *engine 外部* 拉取事实，例如 web-fetch、
 * web-search、第三方 API、远程数据库查询等。`external-fact` claims 的
 * `same-source` 凭据必须来自此类记录。
 */
export type DescriptorDataSource = "internal" | "external";

/**
 * Tool 描述符。
 */
export interface ToolDescriptor extends BaseDescriptor {
  kind: "tool";
  sideEffect: "readonly" | "write" | "irreversible";
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  execute: string;
 /**
 * 是否引入外部事实。缺省为 `"internal"`，与历史行为一致；
 * 设为 `"external"` 后，descriptor-driven evidence normalization 会把
 * 关联 tool observation 升级为 `external-source` 记录。
 */
  dataSource?: DescriptorDataSource | undefined;
 /**
 * 工具**执行**消费的资源声明。
 *
 * 语义是「该工具运行时需要哪些 kind 的正文资源 / 是否必需」，**不等于**「推理 LLM
 * 选择调用该工具时需要看到什么」。core **绝不**据此自动裁剪推理 prompt——它仅作为
 * `EngineDependencies.resourceDemandRouter` 的输入参考（`candidateTools`）。未注入
 * router 时本字段不产生任何行为变化。
 */
  consumes?:
    | {
        kinds?: ReadonlySet<import("./resource").ResourceKind> | undefined;
        required?: boolean | undefined;
      }
    | undefined;
}

/**
 * Agent 描述符。
 */
export interface AgentDescriptor extends BaseDescriptor {
  kind: "agent";
  sideEffect: "readonly" | "write" | "irreversible";
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;
  maxDepth: number;
  availableTools?: string[] | undefined;
  instructions: string;
 /** @see ToolDescriptor.dataSource */
  dataSource?: DescriptorDataSource | undefined;
}

/**
 * 统一描述符联合类型。
 */
export type AnyDescriptor =
  | RuleDescriptor
  | SkillDescriptor
  | ToolDescriptor
  | AgentDescriptor;

/**
 * 描述符类型到实际接口的映射。
 */
export interface DescriptorMap {
  rule: RuleDescriptor;
  skill: SkillDescriptor;
  tool: ToolDescriptor;
  agent: AgentDescriptor;
}

/**
 * 最小描述符形状守卫。
 */
export const isBaseDescriptor = (input: unknown): input is BaseDescriptor => {
  if (!input || typeof input !== "object") {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string"
  );
};

/**
 * 将描述符元信息字段拼成用于语义索引的文本。
 *
 * 拼接 name + displayName + description + tags，不做归一化——embedding 模型
 * 自带 tokenization；keyword caller 自行后置归一化。
 * 结构化签名而非 `SkillDescriptor | ToolDescriptor` 联合，便于 rule/agent 复用。
 */
export function descriptorMetadataText(d: {
  name: string;
  displayName?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
}): string {
  const parts: string[] = [d.name];
  if (d.displayName) parts.push(d.displayName);
  if (d.description) parts.push(d.description);
  if (d.tags && d.tags.length > 0) parts.push(d.tags.join(" "));
  return parts.join(" ");
}

